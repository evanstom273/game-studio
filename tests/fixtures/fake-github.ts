/**
 * An in-memory GitHub for tests: repositories, git data (blobs, trees, commits, refs), branches,
 * pull requests, Actions (workflows, runs, jobs, logs, secrets) and Pages, behind the same REST
 * paths the real API uses. `fetch` is the @gs/git transport; `http` is a fetch()-compatible
 * function for api.github.com that checks the token, for code that talks HTTP.
 */
import nacl from 'tweetnacl';
import { blake2b } from 'blakejs';
import { gitBlobHash, type Fetch } from '@gs/git';

type Tree = Map<string, { sha: string; mode: string }>;

interface Commit {
  tree: string;
  parents: string[];
  message: string;
}

interface Pull {
  number: number;
  title: string;
  head: string;
  base: string;
  body?: string;
  state: 'open' | 'closed';
  merged?: boolean;
  conflict?: boolean;
}

interface Run {
  id: number;
  name: string;
  path: string;
  run_number: number;
  workflow_id: number;
  head_branch: string;
  head_sha: string;
  event: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  jobs: { id: number; name: string; status: string; conclusion: string | null; steps: { name: string; status: string; conclusion: string | null; number: number }[]; log: string }[];
}

export interface FakeRepo {
  owner: string;
  name: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  refs: Map<string, string>;
  pulls: Pull[];
  runs: Run[];
  secrets: Map<string, { encrypted_value: string; key_id: string }>;
  pages: { source: { branch: string; path: string }; build_type: string } | null;
  keys: nacl.BoxKeyPair;
}

export class FakeGitHub {
  blobs = new Map<string, Uint8Array>();
  trees = new Map<string, Tree>();
  commits = new Map<string, Commit>();
  repos = new Map<string, FakeRepo>();
  calls: string[] = [];
  /** The token `http` accepts. */
  token = 'github_pat_test_0123456789abcdefghijklmnop';
  dispatches: { repo: string; workflow: string; ref: string }[] = [];
  private n = 0;

  constructor(
    readonly login = 'lyra',
    name = 'game',
  ) {
    this.addRepo(name);
  }

  private id() {
    return (++this.n).toString(16).padStart(40, '0');
  }

  addRepo(name: string, owner = this.login, opts: { private?: boolean; description?: string } = {}): FakeRepo {
    const r: FakeRepo = { owner, name, private: opts.private ?? true, description: opts.description ?? '', defaultBranch: 'main', refs: new Map(), pulls: [], runs: [], secrets: new Map(), pages: null, keys: nacl.box.keyPair() };
    this.repos.set(`${owner}/${name}`.toLowerCase(), r);
    return r;
  }

  repo(full = `${this.login}/game`) {
    const r = this.repos.get(full.toLowerCase());
    if (!r) throw new Error(`no fake repo ${full}`);
    return r;
  }

  private putTree(tree: Tree) {
    const sha = this.id();
    this.trees.set(sha, tree);
    return sha;
  }

  private putBlob(data: Uint8Array) {
    const sha = gitBlobHash(data);
    this.blobs.set(sha, data);
    return sha;
  }

  /** Make a commit on a branch directly (as if someone pushed from elsewhere). */
  push(branch: string, files: Record<string, string | Uint8Array | null>, message = 'remote change', full?: string) {
    const r = this.repo(full);
    const parent = r.refs.get(branch);
    const tree: Tree = new Map(parent ? this.trees.get(this.commits.get(parent)!.tree) : []);
    for (const [p, c] of Object.entries(files)) {
      if (c === null) tree.delete(p);
      else tree.set(p, { sha: this.putBlob(typeof c === 'string' ? new TextEncoder().encode(c) : c), mode: '100644' });
    }
    const csha = this.id();
    this.commits.set(csha, { tree: this.putTree(tree), parents: parent ? [parent] : [], message });
    r.refs.set(branch, csha);
    return csha;
  }

  /** Text of every file on a branch. */
  files(branch: string, full?: string): Record<string, string> {
    const r = this.repo(full);
    const c = this.commits.get(r.refs.get(branch)!)!;
    return Object.fromEntries([...this.trees.get(c.tree)!].map(([p, e]) => [p, new TextDecoder().decode(this.blobs.get(e.sha))]));
  }

  bytes(branch: string, path: string, full?: string) {
    const r = this.repo(full);
    const c = this.commits.get(r.refs.get(branch)!)!;
    const e = this.trees.get(c.tree)!.get(path);
    return e ? this.blobs.get(e.sha)! : undefined;
  }

  private ancestors(sha: string) {
    const seen = new Set<string>();
    const stack = [sha];
    while (stack.length) {
      const s = stack.pop()!;
      if (seen.has(s)) continue;
      seen.add(s);
      stack.push(...(this.commits.get(s)?.parents ?? []));
    }
    return seen;
  }

  private workflows(r: FakeRepo) {
    const head = r.refs.get(r.defaultBranch);
    const tree = head ? this.trees.get(this.commits.get(head)!.tree)! : new Map();
    return [...tree.keys()].filter((p) => p.startsWith('.github/workflows/')).map((p, i) => ({ id: 100 + i, name: p.split('/').pop()!.replace(/\.ya?ml$/, ''), path: p, state: 'active' }));
  }

  addRun(branch: string, opts: { name?: string; path?: string; conclusion?: string | null; log?: string; event?: string } = {}, full?: string) {
    const r = this.repo(full);
    const id = 5000 + this.n++;
    const done = opts.conclusion !== null;
    const conclusion = done ? (opts.conclusion ?? 'success') : null;
    const run: Run = {
      id,
      name: opts.name ?? 'CI',
      path: opts.path ?? '.github/workflows/check.yml',
      run_number: r.runs.length + 1,
      workflow_id: 100,
      head_branch: branch,
      head_sha: r.refs.get(branch) ?? '0'.repeat(40),
      event: opts.event ?? 'push',
      status: done ? 'completed' : 'in_progress',
      conclusion,
      html_url: `https://github.com/${r.owner}/${r.name}/actions/runs/${id}`,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      jobs: [{ id: id * 10, name: 'check', status: done ? 'completed' : 'in_progress', conclusion, steps: [{ name: 'Scripts compile', status: 'completed', conclusion, number: 1 }], log: opts.log ?? '2026-01-01T00:00:00.0000000Z all good' }],
    };
    r.runs.unshift(run);
    return run;
  }

  finish(id: number, conclusion: string, log?: string, full?: string) {
    const run = this.repo(full).runs.find((x) => x.id === id)!;
    run.status = 'completed';
    run.conclusion = conclusion;
    for (const j of run.jobs) {
      j.status = 'completed';
      j.conclusion = conclusion;
      j.steps.forEach((s) => (s.conclusion = conclusion));
      if (log) j.log = log;
    }
  }

  /** The decrypted value of an Actions secret (what GitHub would hand the workflow). */
  secret(name: string, full?: string): string | null {
    const r = this.repo(full);
    const s = r.secrets.get(name);
    if (!s) return null;
    const sealed = Uint8Array.from(atob(s.encrypted_value), (c) => c.charCodeAt(0));
    // libsodium crypto_box_seal_open
    const eph = sealed.subarray(0, 32);
    const nonceIn = new Uint8Array(64);
    nonceIn.set(eph, 0);
    nonceIn.set(r.keys.publicKey, 32);
    const opened = nacl.box.open(sealed.subarray(32), blake2b(nonceIn, undefined, 24), eph, r.keys.secretKey);
    return opened ? new TextDecoder().decode(opened) : null;
  }

  private info(r: FakeRepo) {
    return { full_name: `${r.owner}/${r.name}`, name: r.name, owner: { login: r.owner }, private: r.private, description: r.description, default_branch: r.defaultBranch, html_url: `https://github.com/${r.owner}/${r.name}`, updated_at: '2026-11-01T00:00:00Z' };
  }

  private create(owner: string, body: Record<string, unknown>) {
    const name = String(body.name);
    if (this.repos.has(`${owner}/${name}`.toLowerCase())) return { status: 422, body: { message: 'Repository creation failed: name already exists on this account' } };
    const r = this.addRepo(name, owner, { private: body.private !== false, description: String(body.description ?? '') });
    if (body.auto_init) this.push('main', { 'README.md': `# ${name}\n` }, 'Initial commit', `${owner}/${name}`);
    return { status: 201, body: this.info(r) };
  }

  fetch: Fetch = async (path, init = {}) => {
    const method = init.method ?? 'GET';
    this.calls.push(`${method} ${path}`);
    const body = (init.body ?? {}) as Record<string, unknown>;
    const ok = (b: unknown, status = 200) => ({ status, body: b });
    const nf = { status: 404, body: { message: 'Not Found' } };
    const [p, query = ''] = path.split('?');
    const q = new URLSearchParams(query);
    let m: RegExpExecArray | null;
    if (p === '/user' && method === 'GET') return ok({ login: this.login });
    if (p === '/user/repos' && method === 'POST') return this.create(this.login, body);
    if ((m = /^\/orgs\/([^/]+)\/repos$/.exec(p)) && method === 'POST') return this.create(m[1], body);
    if (p === '/user/repos') {
      const all = [...this.repos.values()].map((r) => this.info(r));
      const per = Number(q.get('per_page') ?? 30);
      const page = Number(q.get('page') ?? 1);
      return ok(all.slice((page - 1) * per, page * per));
    }
    m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(p);
    if (!m) return nf;
    const r = this.repos.get(`${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`.toLowerCase());
    if (!r) return nf;
    const rest = m[3] ?? '';
    if (rest === '') {
      if (method === 'GET') return ok(this.info(r));
      if (method === 'DELETE') {
        this.repos.delete(`${r.owner}/${r.name}`.toLowerCase());
        return { status: 204, body: null };
      }
      if (method === 'PATCH') {
        if (body.name) {
          this.repos.delete(`${r.owner}/${r.name}`.toLowerCase());
          r.name = String(body.name);
          this.repos.set(`${r.owner}/${r.name}`.toLowerCase(), r);
        }
        if (typeof body.private === 'boolean') r.private = body.private;
        if (typeof body.description === 'string') r.description = body.description;
        if (typeof body.default_branch === 'string') r.defaultBranch = body.default_branch;
        return ok(this.info(r));
      }
    }
    if (rest === '/branches') {
      const per = Number(q.get('per_page') ?? 30);
      const page = Number(q.get('page') ?? 1);
      const all = [...r.refs].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, sha]) => ({ name, commit: { sha } }));
      return ok(all.slice((page - 1) * per, page * per));
    }
    if ((m = /^\/git\/ref\/heads\/(.+)$/.exec(rest))) {
      const sha = r.refs.get(decodeURIComponent(m[1]));
      return sha ? ok({ object: { sha } }) : nf;
    }
    if ((m = /^\/git\/refs\/heads\/(.+)$/.exec(rest))) {
      const br = decodeURIComponent(m[1]);
      if (method === 'DELETE') {
        if (!r.refs.delete(br)) return { status: 422, body: { message: 'Reference does not exist' } };
        return { status: 204, body: null };
      }
      if (method === 'PATCH') {
        const cur = r.refs.get(br);
        if (!cur) return { status: 422, body: { message: 'Reference does not exist' } };
        const next = String(body.sha);
        if (!this.commits.has(next)) return { status: 422, body: { message: 'Object does not exist' } };
        if (!body.force && !this.ancestors(next).has(cur)) return { status: 422, body: { message: 'Update is not a fast forward' } };
        r.refs.set(br, next);
        return ok({ object: { sha: next } });
      }
    }
    if (rest === '/git/refs' && method === 'POST') {
      const br = String(body.ref).replace(/^refs\/heads\//, '');
      if (r.refs.has(br)) return { status: 422, body: { message: 'Reference already exists' } };
      if (!this.commits.has(String(body.sha))) return { status: 422, body: { message: 'Object does not exist' } };
      r.refs.set(br, String(body.sha));
      return ok({ ref: `refs/heads/${br}` }, 201);
    }
    if ((m = /^\/git\/commits\/([0-9a-f]{40})$/.exec(rest))) {
      const c = this.commits.get(m[1]);
      return c ? ok({ sha: m[1], tree: { sha: c.tree }, message: c.message, parents: c.parents.map((sha) => ({ sha })) }) : nf;
    }
    if (rest === '/git/commits' && method === 'POST') {
      if (!this.trees.has(String(body.tree))) return { status: 422, body: { message: 'Tree does not exist' } };
      const sha = this.id();
      this.commits.set(sha, { tree: String(body.tree), parents: (body.parents as string[]) ?? [], message: String(body.message) });
      return ok({ sha }, 201);
    }
    if ((m = /^\/git\/trees\/([0-9a-f]{40})$/.exec(rest))) {
      const t = this.trees.get(m[1]);
      return t ? ok({ sha: m[1], truncated: false, tree: [...t].map(([path, e]) => ({ path, mode: e.mode, type: 'blob', sha: e.sha, size: this.blobs.get(e.sha)!.length })) }) : nf;
    }
    if (rest === '/git/trees' && method === 'POST') {
      const t: Tree = new Map(body.base_tree ? this.trees.get(String(body.base_tree)) : []);
      for (const e of body.tree as { path: string; mode: string; sha: string | null }[]) {
        if (e.sha === null) t.delete(e.path);
        else {
          if (!this.blobs.has(e.sha)) return { status: 422, body: { message: `Blob ${e.sha} does not exist` } };
          t.set(e.path, { sha: e.sha, mode: e.mode });
        }
      }
      // Same content, same tree (like git).
      for (const [sha, other] of this.trees) if (other.size === t.size && [...t].every(([k, v]) => other.get(k)?.sha === v.sha && other.get(k)?.mode === v.mode)) return ok({ sha }, 201);
      return ok({ sha: this.putTree(t) }, 201);
    }
    if ((m = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(rest))) {
      const b = this.blobs.get(m[1]);
      if (!b) return nf;
      let s = '';
      b.forEach((x) => (s += String.fromCharCode(x)));
      return ok({ content: btoa(s), encoding: 'base64', size: b.length });
    }
    if (rest === '/git/blobs' && method === 'POST') {
      const data = Uint8Array.from(atob(String(body.content)), (c) => c.charCodeAt(0));
      return ok({ sha: this.putBlob(data) }, 201);
    }
    // --- pull requests
    const prJson = (pr: Pull) => ({ number: pr.number, title: pr.title, body: pr.body ?? null, html_url: `https://github.com/${r.owner}/${r.name}/pull/${pr.number}`, state: pr.state, merged: !!pr.merged, mergeable: pr.merged || pr.state !== 'open' ? null : !pr.conflict, mergeable_state: pr.conflict ? 'dirty' : 'clean', head: { ref: pr.head, sha: r.refs.get(pr.head) ?? '' }, base: { ref: pr.base }, user: { login: this.login }, changed_files: 1, commits: 1 });
    if (rest === '/pulls' && method === 'POST') {
      if (!r.refs.has(String(body.head))) return { status: 422, body: { message: 'Validation Failed: head does not exist' } };
      const pr: Pull = { number: r.pulls.length + 1, title: String(body.title), head: String(body.head), base: String(body.base), body: body.body as string | undefined, state: 'open' };
      r.pulls.push(pr);
      return ok({ number: pr.number, html_url: `https://github.com/${r.owner}/${r.name}/pull/${pr.number}` }, 201);
    }
    if (rest === '/pulls') {
      const state = q.get('state') ?? 'open';
      return ok(r.pulls.filter((x) => state === 'all' || x.state === state).map(prJson));
    }
    if ((m = /^\/pulls\/(\d+)\/files$/.exec(rest))) return ok([{ filename: 'scenes/main.scene', status: 'modified', additions: 1, deletions: 0 }]);
    if ((m = /^\/pulls\/(\d+)\/merge$/.exec(rest)) && method === 'PUT') {
      const pr = r.pulls.find((x) => x.number === +m![1]);
      if (!pr) return nf;
      if (pr.conflict) return { status: 405, body: { message: 'Pull Request is not mergeable' } };
      const head = r.refs.get(pr.head)!;
      const base = r.refs.get(pr.base)!;
      const csha = this.id();
      this.commits.set(csha, { tree: this.commits.get(head)!.tree, parents: body.merge_method === 'merge' ? [base, head] : [base], message: String(body.commit_title ?? `Merge pull request #${pr.number}`) });
      r.refs.set(pr.base, csha);
      pr.merged = true;
      pr.state = 'closed';
      return ok({ sha: csha, merged: true, message: 'Pull Request successfully merged' });
    }
    if ((m = /^\/pulls\/(\d+)$/.exec(rest))) {
      const pr = r.pulls.find((x) => x.number === +m![1]);
      if (!pr) return nf;
      if (method === 'PATCH') {
        if (body.title) pr.title = String(body.title);
        if (typeof body.body === 'string') pr.body = body.body;
        if (body.state === 'open' || body.state === 'closed') pr.state = body.state;
        if (typeof body.base === 'string') pr.base = body.base;
      }
      return ok(prJson(pr));
    }
    // --- Actions
    if (rest === '/actions/secrets/public-key') return ok({ key_id: 'key-1', key: btoa(String.fromCharCode(...r.keys.publicKey)) });
    if ((m = /^\/actions\/secrets\/([A-Z_]+)$/.exec(rest)) && method === 'PUT') {
      if (body.key_id !== 'key-1') return { status: 422, body: { message: 'Bad key id' } };
      r.secrets.set(m[1], { encrypted_value: String(body.encrypted_value), key_id: String(body.key_id) });
      return { status: 201, body: null };
    }
    if (rest === '/actions/workflows') return ok({ workflows: this.workflows(r) });
    if ((m = /^\/actions\/workflows\/([^/]+)\/dispatches$/.exec(rest)) && method === 'POST') {
      const want = decodeURIComponent(m[1]);
      const wf = this.workflows(r).find((w) => String(w.id) === want || w.path.endsWith(want));
      if (!wf) return { status: 404, body: { message: 'Not Found' } };
      this.dispatches.push({ repo: `${r.owner}/${r.name}`, workflow: wf.path, ref: String(body.ref) });
      this.addRun(String(body.ref), { name: wf.name, path: wf.path, conclusion: null, event: 'workflow_dispatch' }, `${r.owner}/${r.name}`);
      return { status: 204, body: null };
    }
    if (rest === '/actions/runs') {
      const strip = ({ jobs: _j, ...run }: Run) => run;
      return ok({ workflow_runs: r.runs.filter((x) => (!q.get('branch') || x.head_branch === q.get('branch')) && (!q.get('head_sha') || x.head_sha === q.get('head_sha'))).map(strip) });
    }
    if ((m = /^\/actions\/runs\/(\d+)\/jobs$/.exec(rest))) {
      const run = r.runs.find((x) => x.id === +m![1]);
      return run ? ok({ jobs: run.jobs.map(({ log: _l, ...j }) => j) }) : nf;
    }
    if ((m = /^\/actions\/runs\/(\d+)\/(rerun-failed-jobs|rerun)$/.exec(rest)) && method === 'POST') {
      const run = r.runs.find((x) => x.id === +m![1]);
      if (!run) return nf;
      run.status = 'in_progress';
      run.conclusion = null;
      return ok({}, 201);
    }
    if ((m = /^\/actions\/runs\/(\d+)$/.exec(rest))) {
      const run = r.runs.find((x) => x.id === +m![1]);
      if (!run) return nf;
      const { jobs: _j, ...plain } = run;
      return ok(plain);
    }
    if ((m = /^\/actions\/jobs\/(\d+)\/logs$/.exec(rest))) {
      const j = r.runs.flatMap((x) => x.jobs).find((x) => x.id === +m![1]);
      return j ? ok({ text: j.log }) : nf;
    }
    // --- Pages
    if (rest === '/pages') {
      const site = () => ({ html_url: `https://${r.owner.toLowerCase()}.github.io/${r.name}/`, status: 'built', build_type: r.pages!.build_type, source: r.pages!.source, public: true });
      if (method === 'GET') return r.pages ? ok(site()) : nf;
      if (method === 'POST') {
        if (r.pages) return { status: 409, body: { message: 'GitHub Pages is already enabled.' } };
        if (r.private) return { status: 422, body: { message: 'Your current plan does not support GitHub Pages for this repository.' } };
        const src = body.source as { branch: string; path: string };
        if (!r.refs.has(src.branch)) return { status: 422, body: { message: 'The branch does not exist' } };
        r.pages = { source: src, build_type: String(body.build_type ?? 'legacy') };
        return ok(site(), 201);
      }
      if (method === 'PUT') {
        if (!r.pages) return nf;
        r.pages = { source: body.source as { branch: string; path: string }, build_type: String(body.build_type ?? 'legacy') };
        return { status: 204, body: null };
      }
    }
    return nf;
  };

  /** fetch() for https://api.github.com/… that requires the token, like the real API. */
  http = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.origin !== 'https://api.github.com') return new Response('not found', { status: 404 });
    if (req.headers.get('authorization') !== `Bearer ${this.token}`) return Response.json({ message: 'Bad credentials' }, { status: 401 });
    const text = req.method === 'GET' || req.method === 'HEAD' ? '' : await req.text();
    const r = await this.fetch(url.pathname + url.search, { method: req.method, ...(text ? { body: JSON.parse(text) } : {}) });
    if (r.status === 204) return new Response(null, { status: 204 });
    if (r.body && typeof r.body === 'object' && 'text' in (r.body as object) && /\/logs$/.test(url.pathname)) return new Response((r.body as { text: string }).text, { status: 200, headers: { 'content-type': 'text/plain' } });
    return Response.json(r.body, { status: r.status });
  };
}

