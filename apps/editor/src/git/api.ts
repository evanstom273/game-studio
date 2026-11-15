/**
 * GitHub from the editor. Every call goes through this site's Worker (`/github/<key>/api/...`),
 * which adds the token kept in the user's own Durable Object: the token never lives in this
 * browser. The link key is the same one the AI connection uses (it always exists, whether or not
 * the AI connection is switched on).
 */
import { GitHub, GitHubError, type Fetch } from '@gs/git';
import { useBridge } from '@editor/bridge/client';

const base = () => `/github/${useBridge.getState().key}`;

async function parse(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  if ((res.headers.get('content-type') ?? '').includes('json')) {
    try {
      return JSON.parse(text);
    } catch {
      return { message: text.slice(0, 300) };
    }
  }
  // Job logs are plain text.
  return res.ok ? { text } : { message: text.slice(0, 300) };
}

const proxy: Fetch = async (path, init = {}) => {
  let res: Response;
  try {
    res = await fetch(`${base()}/api${path}`, {
      method: init.method ?? 'GET',
      headers: init.body !== undefined ? { 'content-type': 'application/json' } : {},
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch {
    throw new GitHubError('E_OFFLINE', "Can't reach GitHub (offline?). Your project is safe in this browser; try again when you're online.");
  }
  const body = await parse(res);
  if (res.status === 401 && (body as { code?: string } | null)?.code === 'E_GITHUB_NOT_CONNECTED') throw new GitHubError('E_GITHUB_NOT_CONNECTED', 'GitHub is not connected. Add a token in GitHub → Connect.');
  return { status: res.status, body };
};

/** A GitHub client for this browser (through the proxy). */
export const github = () => new GitHub(proxy);

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base()}${path}`, { ...init, headers: { 'content-type': 'application/json' } });
  } catch {
    throw new GitHubError('E_OFFLINE', "Can't reach the Game Studio server (offline?).");
  }
  const body = (await parse(res)) as { error?: { code?: string; message?: string } } | null;
  if (!res.ok) throw new GitHubError(body?.error?.code ?? 'E_GITHUB', body?.error?.message ?? `Failed (${res.status})`, res.status);
  return body as T;
}

export interface TokenStatus {
  connected: boolean;
  login?: string;
}

export const tokenStatus = () => call<TokenStatus>('/token');
export const saveToken = (token: string) => call<{ connected: true; login: string }>('/token', { method: 'PUT', body: JSON.stringify({ token }) });
export const forgetToken = () => call<TokenStatus>('/token', { method: 'DELETE' });

// --- Cloudflare deploy credentials (kept next to the GitHub token; only ever written into repository secrets) ---
export interface CloudflareStatus {
  configured: boolean;
  accountId?: string;
}
export const cloudflareStatus = () => call<CloudflareStatus>('/cloudflare');
export const saveCloudflare = (token: string, accountId: string) => call<CloudflareStatus>('/cloudflare', { method: 'PUT', body: JSON.stringify({ token, accountId }) });
export const forgetCloudflare = () => call<CloudflareStatus>('/cloudflare', { method: 'DELETE' });
/** Seal the saved Cloudflare credentials into a repository's Actions secrets (done server-side). */
export const setCloudflareSecrets = (owner: string, repo: string) => call<{ repository: string; secrets: string[]; workers_subdomain?: string }>('/cloudflare/secrets', { method: 'POST', body: JSON.stringify({ owner, repo }) });
