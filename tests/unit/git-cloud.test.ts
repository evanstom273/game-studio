/**
 * GitHub in the cloud copy (the user's Durable Object): the token vault and REST proxy the editor
 * uses, the Cloudflare vault and sealed repository secrets, and the git / CI / deploy MCP tools
 * with the AI-connection permissions. api.github.com is the in-memory fake; nothing leaves the test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import nacl from 'tweetnacl';
import { GameStudioError } from '@gs/shared';
import { CloudRoom, CloudService, CloudStore, GIT_METHODS, GitHubVault, MemoryKv, buildMcpServer, openSealedBox, proxyPathAllowed, sealedBox, type EditorLink, type Permissions } from '@gs/mcp';
import { FakeGitHub } from '../fixtures/fake-github';

const CF_TOKEN = 'cf_token_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
const CF_ACCOUNT = '0123456789abcdef0123456789abcdef';

let fake: FakeGitHub;
let sent: { url: string; auth: string | null }[];

/** fetch() as seen from the Durable Object: api.github.com is the fake, api.cloudflare.com a tiny stand-in. */
function stubNetwork() {
  sent = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    sent.push({ url: req.url, auth: req.headers.get('authorization') });
    if (url.host === 'api.github.com') return fake.http(req);
    if (url.host === 'api.cloudflare.com') {
      if (req.headers.get('authorization') !== `Bearer ${CF_TOKEN}`) return Response.json({ success: false }, { status: 401 });
      if (url.pathname === '/client/v4/user/tokens/verify') return Response.json({ success: true, result: { status: 'active' } });
      if (url.pathname === `/client/v4/accounts/${CF_ACCOUNT}/workers/subdomain`) return Response.json({ success: true, result: { subdomain: 'lyra' } });
      return Response.json({ success: false }, { status: 404 });
    }
    return new Response('blocked in tests', { status: 599 });
  });
}

beforeEach(() => {
  fake = new FakeGitHub();
  stubNetwork();
});
afterEach(() => vi.unstubAllGlobals());

const secrets = () => [fake.token, CF_TOKEN];
function noSecrets(v: unknown) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  for (const secret of secrets()) expect(s).not.toContain(secret);
}

function room() {
  const notices: { type: string; id?: string; label?: string }[] = [];
  const r = new CloudRoom(new MemoryKv(), (t) => notices.push(JSON.parse(t)));
  const gh = async (path: string, init?: RequestInit) => {
    const res = await r.github(new Request(`http://site/github/k${path}`, init), path.split('?')[0]);
    const text = await res.text();
    noSecrets(text);
    return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : null };
  };
  return { r, gh, notices };
}

const put = (body: unknown): RequestInit => ({ method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function code(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return (e as GameStudioError).code;
  }
  return 'no error';
}

describe('GitHub token vault and proxy', () => {
  it('checks and keeps the token, never returns it, and proxies only GitHub repository endpoints', async () => {
    const { gh } = room();
    expect((await gh('/token')).body).toEqual({ connected: false });
    expect((await gh('/api/user')).status).toBe(401);
    const bad = await gh('/token', put({ token: 'github_pat_wrongwrongwrongwrong' }));
    expect(bad.status).toBe(400);
    expect((bad.body!.error as { code: string }).code).toBe('E_GITHUB_AUTH');
    expect((await gh('/token', put({ token: 'not a token' }))).body!.error).toMatchObject({ code: 'E_INVALID' });
    const connectedAt = sent.length;
    const ok = await gh('/token', put({ token: fake.token }));
    expect(ok.body).toEqual({ connected: true, login: 'lyra' });
    expect((await gh('/token')).body).toMatchObject({ connected: true, login: 'lyra', since: expect.any(Number) });

    // The proxy adds the token (the fake GitHub rejects calls without it).
    expect((await gh('/api/user')).body).toEqual({ login: 'lyra' });
    expect((await gh('/api/repos/lyra/game')).body).toMatchObject({ full_name: 'lyra/game' });
    const blob = await gh('/api/repos/lyra/game/git/blobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: btoa('hi'), encoding: 'base64' }) });
    expect(blob.status).toBe(201);
    expect((await gh('/api/user/repos?per_page=100&page=1')).body).toEqual([expect.objectContaining({ full_name: 'lyra/game' })]);
    // Anything else is refused before it reaches GitHub.
    const before = sent.length;
    for (const path of ['/api/gists', '/api/user/emails', '/api/user/keys', '/api/applications/x/token', '/api/repos/lyra', '/api//evil.example/x']) expect((await gh(path)).status).toBe(403);
    expect((await gh('/api/user', { method: 'DELETE' })).status).toBe(403);
    expect(sent.length).toBe(before);
    expect(sent.every((s) => new URL(s.url).host === 'api.github.com')).toBe(true);
    expect(sent.slice(connectedAt).every((s) => s.auth === `Bearer ${fake.token}`)).toBe(true);

    expect((await gh('/token', { method: 'DELETE' })).body).toEqual({ connected: false });
    expect((await gh('/api/user')).body).toMatchObject({ code: 'E_GITHUB_NOT_CONNECTED' });
  });

  it('follows redirects to log storage without sending the token there', async () => {
    const kv = new MemoryKv();
    const calls: { url: string; auth: string | null }[] = [];
    const vault = new GitHubVault(kv, async (input, init) => {
      const req = new Request(input, init);
      calls.push({ url: req.url, auth: req.headers.get('authorization') });
      if (req.url.endsWith('/user')) return Response.json({ login: 'lyra' });
      if (req.url.includes('/actions/jobs/7/logs')) return new Response(null, { status: 302, headers: { location: 'https://logs.example.net/job7.txt?sig=abc' } });
      if (req.url.startsWith('https://logs.example.net/')) return new Response('2026-01-01T00:00:00Z hello\n', { headers: { 'content-type': 'text/plain' } });
      return new Response('{}', { status: 404 });
    });
    await vault.set('ghp_0123456789abcdefghijklmnop');
    const res = await vault.proxy(new Request('http://site/github/k/api/repos/lyra/game/actions/jobs/7/logs'), '/repos/lyra/game/actions/jobs/7/logs');
    expect(await res.text()).toContain('hello');
    expect(calls.find((c) => c.url.startsWith('https://logs.example.net/'))?.auth).toBeNull();
    const client = await vault.client();
    expect(await client.jobLog('lyra', 'game', 7)).toContain('hello');
    expect(calls.filter((c) => c.url.startsWith('https://logs.example.net/')).every((c) => c.auth === null)).toBe(true);
  });

  it('allows exactly the repository and account endpoints', () => {
    expect(proxyPathAllowed('GET', '/user')).toBe(true);
    expect(proxyPathAllowed('POST', '/user/repos')).toBe(true);
    expect(proxyPathAllowed('POST', '/orgs/studio/repos')).toBe(true);
    expect(proxyPathAllowed('GET', '/orgs/studio/members')).toBe(false);
    expect(proxyPathAllowed('PUT', '/repos/lyra/game/actions/secrets/X')).toBe(true);
    expect(proxyPathAllowed('GET', '/repos/lyra/game/git/ref/heads/feature/x')).toBe(true);
    expect(proxyPathAllowed('GET', '/user/emails')).toBe(false);
    expect(proxyPathAllowed('PATCH', '/user')).toBe(false);
  });
});

describe('Cloudflare deploy credentials', () => {
  it('seals values the way GitHub opens them', async () => {
    const keys = nacl.box.keyPair();
    const sealed = await sealedBox(new TextEncoder().encode('secret value'), keys.publicKey);
    expect(sealed.length).toBe(32 + 16 + 12);
    expect(new TextDecoder().decode((await openSealedBox(sealed, keys.publicKey, keys.secretKey))!)).toBe('secret value');
    // Every sealing uses a fresh key, so the same value never looks the same twice.
    expect(await sealedBox(new TextEncoder().encode('secret value'), keys.publicKey)).not.toEqual(sealed);
    expect(await openSealedBox(sealed, nacl.box.keyPair().publicKey, keys.secretKey)).toBeNull();
  });

  it('checks the Cloudflare token, keeps it, and writes it into repository secrets without ever returning it', async () => {
    const { gh } = room();
    expect((await gh('/cloudflare')).body).toEqual({ configured: false });
    expect((await gh('/cloudflare', put({ token: 'cf_wrong_token_00000000000000', accountId: CF_ACCOUNT }))).body!.error).toMatchObject({ code: 'E_INVALID' });
    expect((await gh('/cloudflare', put({ token: CF_TOKEN, accountId: 'nope' }))).body!.error).toMatchObject({ code: 'E_INVALID' });
    expect((await gh('/cloudflare', put({ token: CF_TOKEN, accountId: CF_ACCOUNT.toUpperCase() }))).body).toEqual({ configured: true, accountId: CF_ACCOUNT });
    // Secrets need GitHub too.
    expect((await gh('/cloudflare/secrets', { method: 'POST', body: JSON.stringify({ owner: 'lyra', repo: 'game' }) })).body!.error).toMatchObject({ code: 'E_GITHUB_NOT_CONNECTED' });
    await gh('/token', put({ token: fake.token }));
    const r = await gh('/cloudflare/secrets', { method: 'POST', body: JSON.stringify({ owner: 'lyra', repo: 'game' }) });
    expect(r.body).toEqual({ repository: 'lyra/game', secrets: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'], workers_subdomain: 'lyra' });
    expect(fake.secret('CLOUDFLARE_API_TOKEN')).toBe(CF_TOKEN);
    expect(fake.secret('CLOUDFLARE_ACCOUNT_ID')).toBe(CF_ACCOUNT);
    expect(fake.repo().secrets.get('CLOUDFLARE_API_TOKEN')!.encrypted_value).not.toContain(CF_TOKEN);
    expect((await gh('/cloudflare', { method: 'DELETE' })).body).toEqual({ configured: false });
  });
});

describe('git, CI and deploy MCP tools on the cloud copy', () => {
  function service(level: Permissions['level'] = 'edit', editor: Partial<EditorLink> = {}) {
    const store = new CloudStore(new MemoryKv());
    const notices: { type: string; id?: string; label?: string }[] = [];
    const asked: { method: string; params: Record<string, unknown> }[] = [];
    const link: EditorLink = {
      connected: () => false,
      ask: async (method, params) => {
        asked.push({ method, params });
        return method === 'confirm' ? true : { deployed: true };
      },
      ...editor,
    };
    const svc = new CloudService(store, link, (n) => notices.push(n));
    const results: unknown[] = [];
    const call = async (m: Parameters<CloudService['handle']>[0], p: Record<string, unknown> = {}) => {
      const r = (await svc.handle(m, p)) as Record<string, unknown>;
      results.push(r);
      return r;
    };
    const setLevel = (l: Permissions['level'], confirmDestructive = true) => store.setMeta({ permissions: { scope: 'all-projects', level: l, confirmDestructive } });
    return { store, svc, call, notices, asked, results, setLevel, ready: async () => { await setLevel(level); await svc.git().github().set(fake.token); } };
  }

  it('publishes a cloud project, commits, pulls (telling open editors), clones and switches branches', async () => {
    const t = service();
    await t.ready();
    const p = await t.call('create_project', { name: 'Cloud Game', template: '2d-platformer' });
    expect(await t.call('git_status')).toMatchObject({ linked: false });
    const pub = await t.call('git_publish', { name: 'cloud-game', private: true });
    expect(pub).toMatchObject({ repository: 'lyra/cloud-game', branch: 'main', files: 4 });
    expect(Object.keys(fake.files('main', 'lyra/cloud-game'))).toContain('scenes/main.scene');
    expect(await t.call('git_status')).toMatchObject({ linked: true, repository: 'lyra/cloud-game', clean: true });
    expect(t.notices.at(-1)).toMatchObject({ type: 'project-updated', id: p.id, label: 'AI: Publish to lyra/cloud-game' });

    await t.call('edit_project', { commands: [{ op: 'rename_project', name: 'Cloud Game 2' }] });
    expect(((await t.call('git_status')).changes as unknown[]).length).toBe(1);
    expect(await t.call('git_commit', { message: 'Rename' })).toMatchObject({ branch: 'main', files: 1 });
    expect(JSON.parse(fake.files('main', 'lyra/cloud-game')['gamestudio.json']).name).toBe('Cloud Game 2');
    // The AI can undo the bookkeeping like any other step, but the commit stays on GitHub.
    expect(await t.call('git_status')).toMatchObject({ clean: true });

    fake.push('main', { 'scripts/remote.ts': 'export const r = 1;\n' }, 'from elsewhere', 'lyra/cloud-game');
    const pulled = await t.call('git_pull');
    expect(pulled).toMatchObject({ up_to_date: false, updated: ['scripts/remote.ts'], conflicts: [] });
    expect(t.notices.at(-1)).toMatchObject({ type: 'project-updated', id: p.id, label: 'AI: Pull main' });
    expect((await t.store.get(p.id as string))!.scripts['scripts/remote.ts']).toBe('export const r = 1;\n');

    expect(await t.call('git_branches')).toMatchObject({ current: 'main', default: 'main', current_exists: true, branches: ['main'] });
    expect(await t.call('git_create_branch', { name: 'level-two' })).toMatchObject({ branch: 'level-two', switched: true });
    expect(await t.call('git_switch_branch', { branch: 'main' })).toMatchObject({ from: 'level-two', branch: 'main' });

    // Open another repository as a new project.
    fake.push('main', { 'gamestudio.json': JSON.stringify({ format: 'game-studio-repo', version: 1, projectFormatVersion: 1, name: 'From GitHub', settings: (await t.store.get(p.id as string))!.settings }), 'scenes/main.scene': JSON.stringify({ root: { id: 'r', name: 'Main', type: 'Node2D' } }), 'README.md': '# hi' });
    const c = await t.call('git_clone', { repository: 'lyra/game' });
    expect(c).toMatchObject({ name: 'From GitHub', repository: 'lyra/game', scenes: 1 });
    expect((await t.call('list_projects')).projects).toHaveLength(2);
    expect(await t.call('git_status', { project: c.project })).toMatchObject({ linked: true, repository: 'lyra/game' });
    for (const r of [...t.results, ...t.notices]) noSecrets(r);
  });

  it('runs repository, pull-request, CI and deploy tools at the levels the user allowed', async () => {
    let connected = false;
    const t = service('read', { connected: () => connected });
    await t.ready();
    await t.setLevel('edit');
    await t.call('create_project', { name: 'Levels', template: 'empty-2d' });
    await t.call('git_publish', { name: 'levels' });
    await t.setLevel('read');
    expect(await t.call('git_status')).toMatchObject({ clean: true });
    expect((await t.call('git_repos')).repositories).toEqual(expect.arrayContaining([expect.objectContaining({ repository: 'lyra/levels' })]));
    expect(await code(t.call('git_commit', { message: 'x' }))).toBe('E_FORBIDDEN');
    expect(await code(t.call('git_pull'))).toBe('E_FORBIDDEN');

    await t.setLevel('edit');
    expect(await t.call('ci_add_workflow', { template: 'check' })).toMatchObject({ added: ['.github/workflows/check.yml'] });
    expect(await t.call('ci_status')).toMatchObject({ workflows: [{ path: '.github/workflows/check.yml' }] });
    expect(await t.call('git_create_branch', { name: 'feature', switch: false })).toMatchObject({ switched: false });
    fake.push('feature', { 'scripts/f.ts': 'export {};\n' }, 'feature', 'lyra/levels');
    expect(await t.call('git_create_pr', { head: 'feature', title: 'Feature' })).toMatchObject({ number: 1, base: 'main' });
    expect(await code(t.call('git_pr_merge', { number: 1 }))).toBe('E_FORBIDDEN');
    expect(await code(t.call('git_repo_delete', { confirm_name: 'lyra/levels' }))).toBe('E_FORBIDDEN');
    expect(await code(t.call('deploy_game', { target: 'github-pages' }))).toBe('E_FORBIDDEN');
    expect(await code(t.call('ci_cloudflare_secrets'))).toBe('E_FORBIDDEN');

    await t.setLevel('full');
    expect(await t.call('git_pr_merge', { number: 1, delete_branch: true })).toMatchObject({ merged: true, into: 'main', deleted_branch: 'feature' });
    // Deploying builds the game in an open editor.
    expect(await code(t.call('deploy_game', { target: 'github-pages' }))).toBe('E_NO_EDITOR');
    expect(await code(t.call('deploy_game', { target: 'cloudflare' }))).toBe('E_CLOUDFLARE_NOT_CONNECTED');
    connected = true;
    expect(await t.call('deploy_game', { target: 'github-pages', branch: 'site' })).toEqual({ deployed: true });
    expect(t.asked.at(-1)).toMatchObject({ method: 'git_deploy', params: { target: 'github-pages', branch: 'site', project: expect.any(String), revision: expect.any(String) } });
    expect(await t.call('deploy_status')).toMatchObject({ branch: 'gh-pages', exists: false, pages: { enabled: false } });

    // Deleting a repository needs the exact name and the user's OK in the editor.
    connected = false;
    expect(await code(t.call('git_repo_delete', { confirm_name: 'lyra/wrong' }))).toBe('E_CONFIRM');
    expect(await code(t.call('git_repo_delete', { confirm_name: 'lyra/levels' }))).toBe('E_NEEDS_CONFIRMATION');
    connected = true;
    expect(await t.call('git_repo_delete', { confirm_name: 'lyra/levels' })).toEqual({ deleted: 'lyra/levels' });
    expect(t.asked.at(-1)).toMatchObject({ method: 'confirm' });
    expect(fake.repos.has('lyra/levels')).toBe(false);
    expect(await t.call('git_status')).toMatchObject({ linked: false });
    for (const r of [...t.results, ...t.notices]) noSecrets(r);
  });

  it('sets the Cloudflare secrets for the project repository from MCP', async () => {
    const t = service('full');
    await t.ready();
    await t.svc.git().cloudflare().set(CF_TOKEN, CF_ACCOUNT);
    await t.call('create_project', { name: 'Deploy', template: 'empty-2d' });
    await t.call('git_publish', { name: 'deploy' });
    const r = await t.call('ci_cloudflare_secrets');
    expect(r).toMatchObject({ repository: 'lyra/deploy', secrets: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'] });
    expect(fake.secret('CLOUDFLARE_API_TOKEN', 'lyra/deploy')).toBe(CF_TOKEN);
    noSecrets(r);
  });

  it('says what to do when GitHub is not connected', async () => {
    const t = service();
    await t.call('create_project', { name: 'No token' });
    expect(await code(t.call('git_repos'))).toBe('E_GITHUB_NOT_CONNECTED');
    expect(await code(t.call('git_publish', { name: 'x' }))).toBe('E_GITHUB_NOT_CONNECTED');
  });

  it('serves every git tool over MCP with validated arguments', async () => {
    const { r } = room();
    await r.store.setMeta({ permissions: { scope: 'all-projects', level: 'edit', confirmDestructive: true } });
    await r.service.git().github().set(fake.token);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await buildMcpServer({ request: (m, p = {}) => r.service.handle(m, p) }).connect(a);
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(b);
    const { tools } = await client.listTools();
    for (const m of GIT_METHODS) expect(tools.map((x) => x.name)).toContain(m);
    expect(tools.find((x) => x.name === 'git_status')!.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((x) => x.name === 'git_repo_delete')!.annotations?.destructiveHint).toBe(true);
    const repos = await client.callTool({ name: 'git_repos', arguments: {} });
    expect(JSON.parse((repos.content as { text: string }[])[0].text).repositories[0].repository).toBe('lyra/game');
    noSecrets(repos);
    const bad = await client.callTool({ name: 'deploy_game', arguments: { target: 'ftp' } });
    expect(bad.isError).toBe(true);
  });
});
