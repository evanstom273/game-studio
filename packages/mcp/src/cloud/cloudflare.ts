/**
 * Cloudflare deploy credentials, kept once (next to the GitHub token, in the user's own Durable
 * Object) and written into a repository's GitHub Actions secrets when a deploy needs them. The
 * values never go to the browser or into any response: GitHub secrets are sealed here with the
 * repository's public key (libsodium's sealed box, which is what GitHub expects).
 */
import nacl from 'tweetnacl';
import { blake2b } from 'blakejs';
import { GitHubError, type GitHub } from '@gs/git';
import type { KvStore } from './store.ts';
import type { FetchLike } from './github-vault.ts';

const KEY = 'cf:deploy';
const CF_API = 'https://api.cloudflare.com/client/v4';

export const SECRET_NAMES = { token: 'CLOUDFLARE_API_TOKEN', account: 'CLOUDFLARE_ACCOUNT_ID' } as const;

/** crypto_box_seal: an ephemeral key pair, nonce = blake2b(ephemeral pk ‖ recipient pk), XSalsa20-Poly1305. */
export function sealedBox(message: Uint8Array, recipient: Uint8Array): Uint8Array {
  if (recipient.length !== nacl.box.publicKeyLength) throw new GitHubError('E_GITHUB', 'The repository public key has the wrong length');
  const eph = nacl.box.keyPair();
  const nonceIn = new Uint8Array(64);
  nonceIn.set(eph.publicKey, 0);
  nonceIn.set(recipient, 32);
  const nonce = blake2b(nonceIn, undefined, 24);
  const ct = nacl.box(message, nonce, recipient, eph.secretKey);
  const out = new Uint8Array(32 + ct.length);
  out.set(eph.publicKey, 0);
  out.set(ct, 32);
  return out;
}

/** crypto_box_seal_open (for tests, and what GitHub does on its side). */
export function openSealedBox(sealed: Uint8Array, publicKey: Uint8Array, secretKey: Uint8Array): Uint8Array | null {
  const eph = sealed.subarray(0, 32);
  const nonceIn = new Uint8Array(64);
  nonceIn.set(eph, 0);
  nonceIn.set(publicKey, 32);
  return nacl.box.open(sealed.subarray(32), blake2b(nonceIn, undefined, 24), eph, secretKey);
}

const b64 = (u: Uint8Array) => {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

interface Stored {
  token: string;
  accountId: string;
  at: number;
}

export class CloudflareVault {
  constructor(
    private readonly kv: KvStore,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
  ) {}

  async status(): Promise<{ configured: boolean; accountId?: string; since?: number }> {
    const v = await this.kv.get<Stored>(KEY);
    return v ? { configured: true, accountId: v.accountId, since: v.at } : { configured: false };
  }

  private async cf(token: string, path: string) {
    const r = await this.fetchImpl(CF_API + path, { headers: { authorization: `Bearer ${token}` } }).catch(() => null);
    if (!r || !r.ok) return null;
    return (await r.json().catch(() => null)) as { success?: boolean; result?: Record<string, unknown> } | null;
  }

  /** Checks the token with Cloudflare, then keeps it with the account id. */
  async set(token: unknown, accountId: unknown) {
    const t = typeof token === 'string' ? token.trim() : '';
    const a = typeof accountId === 'string' ? accountId.trim().toLowerCase() : '';
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(t)) throw new GitHubError('E_INVALID', "That doesn't look like a Cloudflare API token.");
    if (!/^[0-9a-f]{32}$/.test(a)) throw new GitHubError('E_INVALID', 'The account ID is 32 letters and digits (Cloudflare dashboard → Workers & Pages, right-hand side).');
    const active = (j: Awaited<ReturnType<CloudflareVault['cf']>>) => j?.success === true && (j.result?.status ?? 'active') === 'active';
    // User tokens verify at /user/tokens/verify, account-owned tokens under the account.
    if (!active(await this.cf(t, '/user/tokens/verify')) && !active(await this.cf(t, `/accounts/${a}/tokens/verify`))) throw new GitHubError('E_INVALID', 'Cloudflare did not accept that token (expired, or not an API token?). Make one with the "Edit Cloudflare Workers" template.');
    await this.kv.put(KEY, { token: t, accountId: a, at: Date.now() } satisfies Stored);
    return { configured: true, accountId: a };
  }

  async clear() {
    await this.kv.delete(KEY);
    return { configured: false };
  }

  /** The account's workers.dev subdomain (so a deploy can say where the game will be), if Cloudflare tells us. */
  async workersSubdomain(): Promise<string | null> {
    const v = await this.kv.get<Stored>(KEY);
    if (!v) return null;
    const j = await this.cf(v.token, `/accounts/${v.accountId}/workers/subdomain`);
    const s = j?.result?.subdomain;
    return typeof s === 'string' && /^[a-z0-9-]+$/.test(s) ? s : null;
  }

  /** Writes CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID into a repository's Actions secrets (sealed). */
  async setRepoSecrets(gh: GitHub, owner: string, repo: string) {
    const v = await this.kv.get<Stored>(KEY);
    if (!v) throw new GitHubError('E_CLOUDFLARE_NOT_CONNECTED', 'Cloudflare is not connected yet: add your Cloudflare API token and account ID in Game Studio → GitHub → Deploy (once, for all projects).');
    const pk = await gh.actionsPublicKey(owner, repo);
    const key = unb64(pk.key);
    const enc = new TextEncoder();
    for (const [name, value] of [
      [SECRET_NAMES.token, v.token],
      [SECRET_NAMES.account, v.accountId],
    ] as const)
      await gh.putActionsSecret(owner, repo, name, b64(sealedBox(enc.encode(value), key)), pk.key_id);
    const subdomain = await this.workersSubdomain().catch(() => null);
    return { repository: `${owner}/${repo}`, secrets: [SECRET_NAMES.token, SECRET_NAMES.account], ...(subdomain ? { workers_subdomain: subdomain } : {}) };
  }
}
