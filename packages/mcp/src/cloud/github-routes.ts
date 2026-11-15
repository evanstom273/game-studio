/**
 * The editor's GitHub endpoints, under /github/<key>/… (same origin only, like /sync):
 *
 *   GET|PUT|DELETE /token                 GitHub connection: status, connect {token}, disconnect
 *   *              /api/<path>            REST proxy to api.github.com (the token is added here)
 *   GET|PUT|DELETE /cloudflare            Cloudflare deploy credentials: status, save {token, accountId}, forget
 *   POST           /cloudflare/secrets    write them into a repository's Actions secrets {owner, repo}
 *
 * No endpoint ever returns a token or the Cloudflare credentials.
 */
import { toErrorPayload } from '@gs/shared';
import { isValidOwnerName, isValidRepoName } from '@gs/git';
import type { KvStore } from './store.ts';
import { GitHubVault, type FetchLike } from './github-vault.ts';
import { CloudflareVault } from './cloudflare.ts';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

async function body(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > 64 * 1024) throw Object.assign(new Error('Request too large'), { code: 'E_TOO_LARGE' });
  try {
    const v = JSON.parse(text || '{}') as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    throw Object.assign(new Error('The request body is not JSON'), { code: 'E_INVALID' });
  }
}

export async function handleGithubRoute(kv: KvStore, request: Request, path: string, fetchImpl?: FetchLike): Promise<Response> {
  const vault = new GitHubVault(kv, fetchImpl);
  const m = request.method;
  try {
    if (path.startsWith('/api/')) {
      const url = new URL(request.url);
      return await vault.proxy(request, path.slice('/api'.length) + url.search);
    }
    if (path === '/token') {
      if (m === 'GET') return json(200, await vault.status());
      if (m === 'PUT') return json(200, await vault.set((await body(request)).token));
      if (m === 'DELETE') return json(200, await vault.clear());
    }
    if (path === '/cloudflare' || path === '/cloudflare/secrets') {
      const cf = new CloudflareVault(kv, fetchImpl);
      if (path === '/cloudflare/secrets' && m === 'POST') {
        const b = await body(request);
        const owner = String(b.owner ?? '');
        const repo = String(b.repo ?? '');
        if (!isValidOwnerName(owner) || !isValidRepoName(repo)) return json(400, { error: { code: 'E_INVALID', message: 'owner and repo are required' } });
        return json(200, await cf.setRepoSecrets(await vault.client(), owner, repo));
      }
      if (path === '/cloudflare') {
        if (m === 'GET') return json(200, await cf.status());
        if (m === 'DELETE') return json(200, await cf.clear());
        if (m === 'PUT') {
          const b = await body(request);
          return json(200, await cf.set(b.token, b.accountId));
        }
      }
    }
    return json(404, { error: { code: 'E_NOT_FOUND', message: 'not found' } });
  } catch (e) {
    return json(400, { error: toErrorPayload(e) });
  }
}
