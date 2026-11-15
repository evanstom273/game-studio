/**
 * A small GitHub REST client over an injected transport. The editor's transport goes through the
 * site's Worker (`/github/<key>/api/...`), which adds the token kept in the user's Durable Object;
 * the Durable Object itself calls api.github.com directly. Only the endpoints Game Studio needs:
 * git data (blobs, trees, commits, refs), repositories, pull requests, Actions and Pages.
 */
export type Fetch = (path: string, init?: { method?: string; body?: unknown }) => Promise<{ status: number; body: unknown }>;

export class GitHubError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

export interface TreeEntry {
  path: string;
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size?: number;
}

export interface RepoInfo {
  full_name: string;
  name: string;
  owner: { login: string };
  private: boolean;
  default_branch: string;
  description?: string | null;
  updated_at?: string;
  html_url?: string;
  homepage?: string | null;
  archived?: boolean;
}

export interface PullRequest {
  number: number;
  title: string;
  body?: string | null;
  html_url: string;
  state: 'open' | 'closed';
  draft?: boolean;
  merged?: boolean;
  merged_at?: string | null;
  mergeable?: boolean | null;
  mergeable_state?: string;
  head: { ref: string; sha: string };
  base: { ref: string };
  user: { login: string };
  updated_at?: string;
  commits?: number;
  changed_files?: number;
}

export interface Workflow {
  id: number;
  name: string;
  path: string;
  state: string;
}

export interface WorkflowRun {
  id: number;
  name: string;
  run_number: number;
  workflow_id: number;
  head_branch: string;
  head_sha: string;
  event: string;
  status: 'queued' | 'in_progress' | 'completed' | 'waiting' | 'requested' | 'pending';
  conclusion: 'success' | 'failure' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required' | 'neutral' | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  display_title?: string;
  path?: string;
}

export interface Job {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url?: string;
  steps?: { name: string; status: string; conclusion: string | null; number: number }[];
}

export interface PagesSite {
  html_url?: string;
  url?: string;
  status?: string | null;
  build_type?: string;
  source?: { branch: string; path: string };
  public?: boolean;
}

export type NewTreeEntry = { path: string; mode: string; type: 'blob'; sha: string | null };

const enc = (s: string) => s.split('/').map(encodeURIComponent).join('/');

export class GitHub {
  constructor(private readonly f: Fetch) {}

  private async req<T>(path: string, init?: { method?: string; body?: unknown }, ok = [200, 201, 202, 204]): Promise<T> {
    const r = await this.f(path, init);
    if (ok.includes(r.status)) return r.body as T;
    const msg = (r.body as { message?: string } | null)?.message ?? `HTTP ${r.status}`;
    const where = path.split('?')[0];
    if (r.status === 401) throw new GitHubError('E_GITHUB_AUTH', 'GitHub rejected the token (expired or revoked?). Paste a new one in Game Studio → GitHub → Change token.', 401);
    if (r.status === 403 && /rate limit/i.test(msg)) throw new GitHubError('E_GITHUB_RATE_LIMIT', `GitHub rate limit: ${msg}`, 403);
    if ((r.status === 403 || r.status === 404) && /\/actions\/secrets/.test(path)) throw new GitHubError('E_GITHUB_PERMISSION', `The GitHub token can't set repository secrets. Give it "Secrets: Read and write" (GitHub → Settings → Developer settings → your token), then try again. GitHub said: ${msg}`, r.status);
    if ((r.status === 403 || r.status === 404 || r.status === 422) && /workflow/i.test(msg)) throw new GitHubError('E_GITHUB_PERMISSION', `The token works, but it isn't allowed to change GitHub Actions workflow files (.github/workflows). Give it "Workflows: Read and write", or paste a new token in Game Studio → GitHub. GitHub said: ${msg}`, r.status);
    if (r.status === 403 && /\/pages/.test(where)) throw new GitHubError('E_GITHUB_PERMISSION', `The token can't manage GitHub Pages for this repository. Give it "Pages: Read and write". GitHub said: ${msg}`, 403);
    if (r.status === 403) throw new GitHubError('E_GITHUB_PERMISSION', `The token works, but it doesn't have permission for this (${where}). Check its repository access and permissions on GitHub, or paste a new token in Game Studio → GitHub. GitHub said: ${msg}`, 403);
    if (r.status === 404) throw new GitHubError('E_NOT_FOUND', `Not found on GitHub (${where}). Check the name, and that the token can access this repository.`, 404);
    if (r.status === 409 || r.status === 422 || r.status === 405) throw new GitHubError('E_GITHUB_REJECTED', `GitHub refused: ${msg}`, r.status);
    throw new GitHubError('E_GITHUB', `GitHub error ${r.status}: ${msg}`, r.status);
  }

  user() {
    return this.req<{ login: string; name?: string | null }>('/user');
  }
  /** Repositories the token can reach, most recently updated first (up to 1,000). */
  async repos(): Promise<RepoInfo[]> {
    const all: RepoInfo[] = [];
    for (let page = 1; page <= 10; page++) {
      const got = await this.req<RepoInfo[]>(`/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`);
      all.push(...got);
      if (got.length < 100) break;
    }
    return all;
  }
  repo(owner: string, repo: string) {
    return this.req<RepoInfo>(`/repos/${enc(owner)}/${enc(repo)}`);
  }
  /** Every branch (GitHub pages them 100 at a time, alphabetically, so "main" can be far down a busy repository's list). */
  async branches(owner: string, repo: string) {
    const all: { name: string; commit: { sha: string } }[] = [];
    for (let page = 1; page <= 50; page++) {
      const got = await this.req<{ name: string; commit: { sha: string } }[]>(`/repos/${enc(owner)}/${enc(repo)}/branches?per_page=100&page=${page}`);
      all.push(...got);
      if (got.length < 100) break;
    }
    return all;
  }
  async head(owner: string, repo: string, branch: string): Promise<string> {
    return (await this.req<{ object: { sha: string } }>(`/repos/${enc(owner)}/${enc(repo)}/git/ref/heads/${enc(branch)}`)).object.sha;
  }
  /** The branch's head commit, or null when the branch doesn't exist. */
  async headOrNull(owner: string, repo: string, branch: string): Promise<string | null> {
    try {
      return await this.head(owner, repo, branch);
    } catch (e) {
      if (e instanceof GitHubError && e.code === 'E_NOT_FOUND') return null;
      throw e;
    }
  }
  commit(owner: string, repo: string, sha: string) {
    return this.req<{ sha: string; tree: { sha: string }; message: string; parents: { sha: string }[] }>(`/repos/${enc(owner)}/${enc(repo)}/git/commits/${sha}`);
  }
  async tree(owner: string, repo: string, sha: string): Promise<TreeEntry[]> {
    const t = await this.req<{ tree: TreeEntry[]; truncated: boolean }>(`/repos/${enc(owner)}/${enc(repo)}/git/trees/${sha}?recursive=1`);
    if (t.truncated) throw new GitHubError('E_TOO_LARGE', 'This repository is too large for GitHub to list in one go (over ~100,000 files).');
    return t.tree;
  }
  /** The files of a commit. */
  async commitTree(owner: string, repo: string, commit: string): Promise<TreeEntry[]> {
    return this.tree(owner, repo, (await this.commit(owner, repo, commit)).tree.sha);
  }
  async blob(owner: string, repo: string, sha: string): Promise<Uint8Array> {
    const b = await this.req<{ content: string; encoding: string }>(`/repos/${enc(owner)}/${enc(repo)}/git/blobs/${sha}`);
    if (b.encoding !== 'base64') return new TextEncoder().encode(b.content);
    return Uint8Array.from(atob(b.content.replace(/\s/g, '')), (c) => c.charCodeAt(0));
  }
  async createBlob(owner: string, repo: string, data: Uint8Array): Promise<string> {
    let s = '';
    for (let i = 0; i < data.length; i += 0x8000) s += String.fromCharCode(...data.subarray(i, i + 0x8000));
    return (await this.req<{ sha: string }>(`/repos/${enc(owner)}/${enc(repo)}/git/blobs`, { method: 'POST', body: { content: btoa(s), encoding: 'base64' } })).sha;
  }
  /** A new tree: `baseTree` plus these changes (sha null deletes), or exactly these entries when `baseTree` is null. */
  async createTree(owner: string, repo: string, baseTree: string | null, entries: NewTreeEntry[]): Promise<string> {
    return (await this.req<{ sha: string }>(`/repos/${enc(owner)}/${enc(repo)}/git/trees`, { method: 'POST', body: { ...(baseTree ? { base_tree: baseTree } : {}), tree: entries } })).sha;
  }
  async createCommit(owner: string, repo: string, message: string, tree: string, parents: string[]): Promise<string> {
    return (await this.req<{ sha: string }>(`/repos/${enc(owner)}/${enc(repo)}/git/commits`, { method: 'POST', body: { message, tree, parents } })).sha;
  }
  /** Fast-forward a branch; GitHub refuses (422) if it isn't a fast-forward. Never forced. */
  updateRef(owner: string, repo: string, branch: string, sha: string) {
    return this.req(`/repos/${enc(owner)}/${enc(repo)}/git/refs/heads/${enc(branch)}`, { method: 'PATCH', body: { sha, force: false } });
  }
  createRef(owner: string, repo: string, branch: string, sha: string) {
    return this.req(`/repos/${enc(owner)}/${enc(repo)}/git/refs`, { method: 'POST', body: { ref: `refs/heads/${branch}`, sha } });
  }
  deleteBranch(owner: string, repo: string, branch: string) {
    return this.req(`/repos/${enc(owner)}/${enc(repo)}/git/refs/heads/${enc(branch)}`, { method: 'DELETE' });
  }

  // --- pull requests -----------------------------------------------------------------------------
  createPull(owner: string, repo: string, p: { title: string; head: string; base: string; body?: string; draft?: boolean }) {
    return this.req<{ number: number; html_url: string }>(`/repos/${enc(owner)}/${enc(repo)}/pulls`, { method: 'POST', body: p });
  }
  pulls(owner: string, repo: string, state: 'open' | 'closed' | 'all' = 'open') {
    return this.req<PullRequest[]>(`/repos/${enc(owner)}/${enc(repo)}/pulls?state=${state}&per_page=50&sort=updated&direction=desc`);
  }
  pull(owner: string, repo: string, n: number) {
    return this.req<PullRequest>(`/repos/${enc(owner)}/${enc(repo)}/pulls/${n}`);
  }
  pullFiles(owner: string, repo: string, n: number) {
    return this.req<{ filename: string; status: string; additions: number; deletions: number }[]>(`/repos/${enc(owner)}/${enc(repo)}/pulls/${n}/files?per_page=100`);
  }
  updatePull(owner: string, repo: string, n: number, p: { title?: string; body?: string; state?: 'open' | 'closed'; base?: string }) {
    return this.req<PullRequest>(`/repos/${enc(owner)}/${enc(repo)}/pulls/${n}`, { method: 'PATCH', body: p });
  }
  mergePull(owner: string, repo: string, n: number, p: { merge_method?: 'merge' | 'squash' | 'rebase'; commit_title?: string; commit_message?: string; sha?: string } = {}) {
    return this.req<{ sha: string; merged: boolean; message: string }>(`/repos/${enc(owner)}/${enc(repo)}/pulls/${n}/merge`, { method: 'PUT', body: p });
  }

  // --- Actions secrets (values are sealed by the caller with the repository's public key) -------
  actionsPublicKey(owner: string, repo: string) {
    return this.req<{ key_id: string; key: string }>(`/repos/${enc(owner)}/${enc(repo)}/actions/secrets/public-key`);
  }
  putActionsSecret(owner: string, repo: string, name: string, encryptedValue: string, keyId: string) {
    return this.req(`/repos/${enc(owner)}/${enc(repo)}/actions/secrets/${encodeURIComponent(name)}`, { method: 'PUT', body: { encrypted_value: encryptedValue, key_id: keyId } });
  }

  // --- repositories ------------------------------------------------------------------------------
  /** Create a repository for the token's user, or in `org`. auto_init makes a first commit (a README) so it has a branch. */
  createRepo(p: { name: string; description?: string; private?: boolean; auto_init?: boolean; org?: string; homepage?: string }) {
    const { org, ...body } = p;
    return this.req<RepoInfo>(org ? `/orgs/${enc(org)}/repos` : '/user/repos', { method: 'POST', body });
  }
  updateRepo(owner: string, repo: string, p: { name?: string; description?: string; private?: boolean; default_branch?: string; homepage?: string; archived?: boolean }) {
    return this.req<RepoInfo>(`/repos/${enc(owner)}/${enc(repo)}`, { method: 'PATCH', body: p });
  }
  deleteRepo(owner: string, repo: string) {
    return this.req(`/repos/${enc(owner)}/${enc(repo)}`, { method: 'DELETE' });
  }

  // --- Actions ---------------------------------------------------------------------------------
  workflows(owner: string, repo: string) {
    return this.req<{ workflows: Workflow[] }>(`/repos/${enc(owner)}/${enc(repo)}/actions/workflows?per_page=100`).then((r) => r.workflows);
  }
  runs(owner: string, repo: string, opts: { branch?: string; sha?: string } = {}) {
    const q = ['per_page=20', opts.branch ? `branch=${encodeURIComponent(opts.branch)}` : '', opts.sha ? `head_sha=${opts.sha}` : ''].filter(Boolean).join('&');
    return this.req<{ workflow_runs: WorkflowRun[] }>(`/repos/${enc(owner)}/${enc(repo)}/actions/runs?${q}`).then((r) => r.workflow_runs);
  }
  run(owner: string, repo: string, id: number) {
    return this.req<WorkflowRun>(`/repos/${enc(owner)}/${enc(repo)}/actions/runs/${id}`);
  }
  jobs(owner: string, repo: string, runId: number) {
    return this.req<{ jobs: Job[] }>(`/repos/${enc(owner)}/${enc(repo)}/actions/runs/${runId}/jobs?per_page=100`).then((r) => r.jobs);
  }
  async jobLog(owner: string, repo: string, jobId: number): Promise<string> {
    const r = await this.req<{ text?: string } | string>(`/repos/${enc(owner)}/${enc(repo)}/actions/jobs/${jobId}/logs`);
    return typeof r === 'string' ? r : (r?.text ?? '');
  }
  /** Start a workflow that has `on: workflow_dispatch`. */
  dispatch(owner: string, repo: string, workflow: number | string, ref: string, inputs?: Record<string, string>) {
    return this.req(`/repos/${enc(owner)}/${enc(repo)}/actions/workflows/${encodeURIComponent(String(workflow))}/dispatches`, { method: 'POST', body: { ref, ...(inputs ? { inputs } : {}) } });
  }
  rerun(owner: string, repo: string, runId: number, failedOnly = true) {
    return this.req(`/repos/${enc(owner)}/${enc(repo)}/actions/runs/${runId}/${failedOnly ? 'rerun-failed-jobs' : 'rerun'}`, { method: 'POST', body: {} });
  }

  // --- Pages ---------------------------------------------------------------------------------------
  /** The repository's GitHub Pages site, or null when Pages is off. */
  async pages(owner: string, repo: string): Promise<PagesSite | null> {
    try {
      return await this.req<PagesSite>(`/repos/${enc(owner)}/${enc(repo)}/pages`);
    } catch (e) {
      if (e instanceof GitHubError && e.code === 'E_NOT_FOUND') return null;
      throw e;
    }
  }
  createPages(owner: string, repo: string, source: { branch: string; path: '/' | '/docs' }) {
    return this.req<PagesSite>(`/repos/${enc(owner)}/${enc(repo)}/pages`, { method: 'POST', body: { build_type: 'legacy', source } });
  }
  updatePages(owner: string, repo: string, source: { branch: string; path: '/' | '/docs' }) {
    return this.req(`/repos/${enc(owner)}/${enc(repo)}/pages`, { method: 'PUT', body: { build_type: 'legacy', source } });
  }
}

/** Is this a usable branch name (git's ref-name rules, the parts that matter here)? */
export function isValidBranchName(name: string) {
  return /^[A-Za-z0-9._/-]{1,200}$/.test(name) && !/(^[/.-]|\/$|\.\.|\/\/|\.lock$|\/\.|@\{)/.test(name) && !name.endsWith('.');
}

export const isValidRepoName = (name: string) => /^[A-Za-z0-9._-]{1,100}$/.test(name) && name !== '.' && name !== '..';
export const isValidOwnerName = (name: string) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(name);
