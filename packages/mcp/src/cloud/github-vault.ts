/**
 * GitHub access for one link key. The token lives only in this room's storage (the user's own
 * Durable Object): the browser never stores it — it talks to GitHub through /github/<key>/api/…,
 * which adds the token here — and it is never written into projects or returned by any endpoint.
 */
import { GitHubError, GitHub, type Fetch } from '@gs/git';
import type { KvStore } from './store.ts';

const TOKEN_KEY = 'gh:token';
export const GITHUB_API = 'https://api.github.com';
/** Largest request the proxy forwards (an asset of up to 50 MB, base64-encoded, plus JSON). */
export const PROXY_MAX_BODY = 72 * 1024 * 1024;
/** Job logs are cut to their end (that is where failures are). */
const LOG_LIMIT = 3_000_000;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
const globalFetch: FetchLike = (input, init) => fetch(input, init);

const baseHeaders = (token: string) => ({ authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'game-studio' });

/**
 * Follows a redirect by hand: the token is only ever sent to api.github.com (job logs redirect to
 * a pre-signed storage URL that must not receive it).
 */
async function send(fetchImpl: FetchLike, token: string, url: string, init: RequestInit): Promise<Response> {
  let res = await fetchImpl(url, { ...init, redirect: 'manual' });
  for (let hops = 0; hops < 3 && res.status >= 300 && res.status < 400 && res.headers.get('location'); hops++) {
    const next = new URL(res.headers.get('location')!, url);
    if (next.protocol !== 'https:') break;
    const same = next.origin === GITHUB_API;
    res = await fetchImpl(next.toString(), { method: 'GET', headers: same ? baseHeaders(token) : { 'user-agent': 'game-studio' }, redirect: 'manual' });
  }
  return res;
}

/** A transport for @gs/git that calls api.github.com directly with the token (used in the Durable Object). */
export function githubTransport(token: string, fetchImpl: FetchLike = globalFetch): Fetch {
  return async (path, init = {}) => {
    const r = await send(fetchImpl, token, GITHUB_API + path, {
      method: init.method ?? 'GET',
      headers: { ...baseHeaders(token), ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    const text = await r.text();
    if (r.ok && !(r.headers.get('content-type') ?? '').includes('json')) return { status: r.status, body: { text: text.length > LOG_LIMIT ? text.slice(-LOG_LIMIT) : text } };
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { message: text.slice(0, 300) };
    }
    return { status: r.status, body };
  };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * Which GitHub endpoints the browser may reach through the proxy: the user, their repositories,
 * creating a repository in an organisation, and anything under one repository. Nothing else
 * (gists, keys, other users' settings, other hosts).
 */
export function proxyPathAllowed(method: string, pathname: string): boolean {
  if (pathname === '/user' && method === 'GET') return true;
  if (pathname === '/user/repos') return method === 'GET' || method === 'POST';
  if (/^\/orgs\/[A-Za-z0-9-]{1,39}\/repos$/.test(pathname)) return method === 'POST';
  return /^\/repos\/[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}(\/[A-Za-z0-9._~%@:+,=-]+)*$/.test(pathname);
}

const PROXY_METHODS = new Set(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']);

export class GitHubVault {
  constructor(
    private readonly kv: KvStore,
    private readonly fetchImpl: FetchLike = globalFetch,
  ) {}

  private async token(): Promise<string | undefined> {
    return (await this.kv.get<{ token: string }>(TOKEN_KEY))?.token;
  }

  async status(): Promise<{ connected: boolean; login?: string; since?: number }> {
    const t = await this.kv.get<{ token: string; login: string; at: number }>(TOKEN_KEY);
    return t ? { connected: true, login: t.login, since: t.at } : { connected: false };
  }

  /** Checks the token with GitHub, then keeps it. */
  async set(token: unknown): Promise<{ connected: true; login: string }> {
    const t = typeof token === 'string' ? token.trim() : '';
    if (!/^[A-Za-z0-9_]{20,255}$/.test(t)) throw new GitHubError('E_INVALID', 'That does not look like a GitHub token (it starts with github_pat_ or ghp_).');
    let login: string;
    try {
      login = (await new GitHub(githubTransport(t, this.fetchImpl)).user()).login;
    } catch (e) {
      if (e instanceof GitHubError && e.code === 'E_GITHUB_AUTH') throw new GitHubError('E_GITHUB_AUTH', 'GitHub did not accept that token (mistyped, expired or revoked?).');
      throw e;
    }
    await this.kv.put(TOKEN_KEY, { token: t, login, at: Date.now() });
    return { connected: true, login };
  }

  async clear() {
    await this.kv.delete(TOKEN_KEY);
    return { connected: false };
  }

  async client(): Promise<GitHub> {
    const t = await this.token();
    if (!t) throw new GitHubError('E_GITHUB_NOT_CONNECTED', 'GitHub is not connected. The user connects a token once in Game Studio → Source control (the token stays in their own cloud storage).');
    return new GitHub(githubTransport(t, this.fetchImpl));
  }

  /** Forwards one REST call from the editor to api.github.com with the token. `path` includes the query. */
  async proxy(request: Request, path: string): Promise<Response> {
    const method = request.method.toUpperCase();
    if (!PROXY_METHODS.has(method)) return json(405, { message: 'Method not allowed' });
    let url: URL;
    try {
      url = new URL(path, GITHUB_API);
    } catch {
      return json(400, { message: 'Bad path' });
    }
    if (url.origin !== GITHUB_API || !path.startsWith('/') || !proxyPathAllowed(method, url.pathname)) return json(403, { message: 'Only repository and account endpoints of api.github.com are available here', code: 'E_FORBIDDEN' });
    const hasBody = method !== 'GET' && method !== 'DELETE';
    let body: ArrayBuffer | undefined;
    if (hasBody) {
      const declared = Number(request.headers.get('content-length') ?? NaN);
      if (declared > PROXY_MAX_BODY) return json(413, { message: 'Request too large' });
      body = await request.arrayBuffer();
      if (body.byteLength > PROXY_MAX_BODY) return json(413, { message: 'Request too large' });
    }
    const token = await this.token();
    if (!token) return json(401, { message: 'GitHub is not connected', code: 'E_GITHUB_NOT_CONNECTED' });
    let res: Response;
    try {
      res = await send(this.fetchImpl, token, url.origin + url.pathname + url.search, {
        method,
        headers: { ...baseHeaders(token), ...(hasBody ? { 'content-type': 'application/json' } : {}) },
        ...(hasBody ? { body } : {}),
      });
    } catch (e) {
      return json(502, { message: `Couldn't reach GitHub: ${e instanceof Error ? e.message : String(e)}` });
    }
    const headers = new Headers({ 'cache-control': 'no-store' });
    for (const h of ['content-type', 'link', 'x-ratelimit-remaining', 'x-ratelimit-reset']) {
      const v = res.headers.get(h);
      if (v) headers.set(h, v);
    }
    if (res.status === 204 || res.status === 205 || res.status === 304) return new Response(null, { status: res.status, headers });
    return new Response(res.body, { status: res.status >= 300 && res.status < 400 ? 502 : res.status, headers });
  }
}
