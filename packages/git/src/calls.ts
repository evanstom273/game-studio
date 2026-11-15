/**
 * Repository, pull-request and Actions operations with the result shapes the MCP tools return.
 * Shared by the editor (through its GitHub proxy) and the cloud copy (in the Durable Object), so
 * both behave the same.
 */
import { applyCommands, type GitLink, type ProjectDoc } from '@gs/project';
import { GitHub, GitHubError, isValidBranchName, isValidOwnerName, isValidRepoName, type PullRequest } from './github';
import { CHECK_WORKFLOW, WORKFLOW_TEMPLATES, cleanLogLine, parseLogProblems, runState, summarizeRun } from './actions';
import { BUILD_BRANCH, cloudflareFiles, type BuildFile } from './deploy';
import { gitBlobHash } from './hash';
import { status, type Conflict, type PullResult, type SwitchResult } from './sync';

const fail = (code: string, message: string, details?: unknown): never => {
  throw new GitHubError(code, message, undefined, details);
};

const str = (params: Record<string, unknown>, k: string) => (typeof params[k] === 'string' && (params[k] as string).trim() ? (params[k] as string).trim() : undefined);
const bool = (params: Record<string, unknown>, k: string) => (typeof params[k] === 'boolean' ? (params[k] as boolean) : undefined);

export function gitStatusView(doc: ProjectDoc) {
  const link = doc.git;
  if (!link) return { linked: false, note: 'This project is not linked to GitHub. Use git_publish to put it in a new repository, or git_clone to open a repository as a project.' };
  const changes = status(doc, link);
  return { linked: true, repository: `${link.owner}/${link.repo}`, branch: link.branch, commit: link.commit, changes, clean: !changes.length, ...(link.skipped?.length ? { left_out: link.skipped } : {}) };
}

export function pullView(r: Pick<PullResult, 'upToDate' | 'link' | 'updated' | 'merged' | 'conflicts'>) {
  return {
    up_to_date: r.upToDate,
    branch: r.link.branch,
    commit: r.link.commit,
    updated: r.updated,
    merged: r.merged,
    conflicts: r.conflicts,
    ...(r.conflicts.length ? { note: conflictNote(r.conflicts) } : {}),
  };
}

export function conflictNote(conflicts: Conflict[]) {
  const parts: string[] = [];
  if (conflicts.some((c) => c.kind === 'text')) parts.push('scripts marked "text" now contain <<<<<<< / ======= / >>>>>>> conflict markers to resolve (edit them, then commit)');
  if (conflicts.some((c) => c.kind !== 'text')) parts.push('the other files kept the local version (scenes and gamestudio.json are only merged when the result is valid; assets are never merged) — commit to keep yours, or use "Use GitHub\'s version" in the editor');
  return `Conflicts: ${parts.join('; ')}.`;
}

export function switchView(r: SwitchResult) {
  return { from: r.from, branch: r.link.branch, commit: r.link.commit, updated: r.updated, ...(r.kept.length ? { kept_your_changes: r.kept, note: 'These files were changed here and differ on the new branch too: your version was kept and shows as a change.' } : {}) };
}

/** Which repository a call is about: `repository: "owner/name"`, or the project's. */
export function targetRepo(params: Record<string, unknown>, link: GitLink | null | undefined): { owner: string; repo: string } {
  const r = str(params, 'repository');
  if (r) {
    const [owner, repo, extra] = r.split('/');
    if (!owner || !repo || extra !== undefined || !isValidOwnerName(owner) || !isValidRepoName(repo)) fail('E_INVALID', 'repository must be "owner/name"');
    return { owner, repo };
  }
  if (!link) fail('E_NOT_LINKED', 'This project is not linked to a GitHub repository; pass repository: "owner/name".');
  return { owner: link!.owner, repo: link!.repo };
}

export function requireLinkOf(doc: ProjectDoc): GitLink {
  return doc.git ?? fail('E_NOT_LINKED', 'This project is not linked to a GitHub repository.');
}

const prView = (p: PullRequest) => ({
  number: p.number,
  title: p.title,
  url: p.html_url,
  state: p.merged ? 'merged' : p.state,
  ...(p.draft ? { draft: true } : {}),
  head: p.head.ref,
  base: p.base.ref,
  author: p.user.login,
  ...(p.mergeable !== undefined ? { mergeable: p.mergeable, mergeable_state: p.mergeable_state } : {}),
  ...(p.body ? { body: p.body } : {}),
  ...(p.changed_files !== undefined ? { changed_files: p.changed_files, commits: p.commits } : {}),
});

export type PrSummary = ReturnType<typeof prView>;

/**
 * Repository and pull-request calls. `confirmDelete` asks the user (the editor shows a dialog);
 * deleting also always needs `confirm_name` to be the exact "owner/name".
 */
export async function githubCall(method: string, gh: GitHub, params: Record<string, unknown>, link: GitLink | null | undefined, confirmDelete?: (fullName: string) => Promise<boolean>) {
  switch (method) {
    case 'git_repos':
      return { repositories: (await gh.repos()).map((r) => ({ repository: r.full_name, private: r.private, default_branch: r.default_branch, description: r.description ?? undefined, updated: r.updated_at })) };
    case 'git_pr_list': {
      const { owner, repo } = targetRepo(params, link);
      const s = str(params, 'state');
      const state = s === 'closed' || s === 'all' ? s : 'open';
      return { repository: `${owner}/${repo}`, pull_requests: (await gh.pulls(owner, repo, state)).map(prView) };
    }
    case 'git_pr_get': {
      const { owner, repo } = targetRepo(params, link);
      const n = Number(params.number);
      if (!Number.isInteger(n) || n < 1) fail('E_INVALID', 'number must be a pull request number');
      const [p, files] = await Promise.all([gh.pull(owner, repo, n), gh.pullFiles(owner, repo, n)]);
      return { ...prView(p), files: files.map((f) => ({ path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions })) };
    }
    case 'git_create_pr': {
      const { owner, repo } = targetRepo(params, link);
      const head = str(params, 'head') ?? (str(params, 'repository') ? undefined : link?.branch);
      if (!head) fail('E_INVALID', 'head (the branch with the changes) is required');
      const base = str(params, 'base') ?? (await gh.repo(owner, repo)).default_branch;
      if (head === base) fail('E_INVALID', `head and base are both "${base}". Commit to a new branch first (git_commit with new_branch), then open the pull request from it.`);
      const r = await gh.createPull(owner, repo, { title: str(params, 'title') ?? head!.replace(/[-_/]+/g, ' '), head: head!, base, ...(str(params, 'body') ? { body: str(params, 'body') } : {}), ...(bool(params, 'draft') ? { draft: true } : {}) });
      return { number: r.number, url: r.html_url, head, base };
    }
    case 'git_pr_update': {
      const { owner, repo } = targetRepo(params, link);
      const s = str(params, 'state');
      const p = await gh.updatePull(owner, repo, Number(params.number), { ...(str(params, 'title') ? { title: str(params, 'title') } : {}), ...(typeof params.body === 'string' ? { body: params.body } : {}), ...(str(params, 'base') ? { base: str(params, 'base') } : {}), ...(s === 'closed' || s === 'open' ? { state: s } : {}) });
      return prView(p);
    }
    case 'git_pr_merge': {
      const { owner, repo } = targetRepo(params, link);
      const n = Number(params.number);
      const m = str(params, 'method');
      const how = m === 'squash' || m === 'rebase' ? m : 'merge';
      const pr = await gh.pull(owner, repo, n);
      if (pr.merged) return { merged: true, already: true, number: n, into: pr.base.ref };
      if (pr.state !== 'open') fail('E_INVALID', `Pull request #${n} is closed.`);
      if (pr.mergeable === false) fail('E_MERGE_CONFLICT', `#${n} has conflicts with ${pr.base.ref}. Pull ${pr.base.ref} into ${pr.head.ref} (switch to ${pr.head.ref}, merge, fix the conflicts, commit), then merge.`, { mergeable_state: pr.mergeable_state });
      const r = await gh.mergePull(owner, repo, n, { merge_method: how, ...(str(params, 'commit_title') ? { commit_title: str(params, 'commit_title') } : {}), sha: pr.head.sha });
      let deleted = false;
      if (bool(params, 'delete_branch') && pr.head.ref !== (await gh.repo(owner, repo)).default_branch)
        deleted = await gh.deleteBranch(owner, repo, pr.head.ref).then(
          () => true,
          () => false,
        );
      return { merged: r.merged, sha: r.sha, method: how, number: n, head: pr.head.ref, into: pr.base.ref, ...(deleted ? { deleted_branch: pr.head.ref } : {}) };
    }
    case 'git_repo_create': {
      const name = str(params, 'name');
      if (!name || !isValidRepoName(name)) fail('E_INVALID', 'name is required (letters, digits, - _ .)');
      const org = str(params, 'org');
      if (org && !isValidOwnerName(org)) fail('E_INVALID', `"${org}" is not a valid organisation name`);
      const r = await gh.createRepo({ name: name!, description: str(params, 'description'), private: bool(params, 'private') !== false, auto_init: bool(params, 'auto_init') !== false, org });
      return { repository: r.full_name, url: r.html_url, private: r.private, default_branch: r.default_branch };
    }
    case 'git_repo_update': {
      const { owner, repo } = targetRepo(params, link);
      const name = str(params, 'name');
      if (name && !isValidRepoName(name)) fail('E_INVALID', 'name may contain letters, digits, - _ .');
      const db = str(params, 'default_branch');
      if (db && !isValidBranchName(db)) fail('E_INVALID', `"${db}" is not a valid branch name`);
      const r = await gh.updateRepo(owner, repo, { ...(name ? { name } : {}), ...(typeof params.description === 'string' ? { description: params.description } : {}), ...(bool(params, 'private') !== undefined ? { private: bool(params, 'private') } : {}), ...(db ? { default_branch: db } : {}), ...(typeof params.homepage === 'string' ? { homepage: params.homepage } : {}), ...(bool(params, 'archived') !== undefined ? { archived: bool(params, 'archived') } : {}) });
      return { repository: r.full_name, url: r.html_url, private: r.private, default_branch: r.default_branch, description: r.description ?? '' };
    }
    case 'git_repo_delete': {
      const { owner, repo } = targetRepo(params, link);
      const full = `${owner}/${repo}`;
      if (str(params, 'confirm_name') !== full) fail('E_CONFIRM', `Deleting a repository can't be undone. Pass confirm_name: "${full}" to confirm (the user is asked in Game Studio too).`);
      if (confirmDelete && !(await confirmDelete(full))) fail('E_DECLINED', 'The user declined deleting the repository. Nothing was deleted.');
      await gh.deleteRepo(owner, repo);
      return { deleted: full };
    }
  }
  return fail('E_INVALID', `Unknown GitHub call ${method}`);
}

/** CI (GitHub Actions) calls; `hasFile` links log problems to project files. */
export async function ciCall(method: string, gh: GitHub, link: GitLink, params: Record<string, unknown>, hasFile: (p: string) => boolean) {
  const { owner, repo } = link;
  switch (method) {
    case 'ci_status': {
      const branch = str(params, 'branch') ?? link.branch;
      const [workflows, runs] = await Promise.all([gh.workflows(owner, repo), gh.runs(owner, repo, { branch })]);
      return { branch, workflows: workflows.map((w) => ({ id: w.id, name: w.name, path: w.path })), runs: runs.slice(0, 10).map((r) => summarizeRun(r)), ...(workflows.length ? {} : { note: 'No workflows yet. Add one with ci_add_workflow.' }) };
    }
    case 'ci_run': {
      const ref = str(params, 'ref') ?? link.branch;
      const wfs = await gh.workflows(owner, repo);
      const want = str(params, 'workflow') ?? '';
      const wf = wfs.find((w) => String(w.id) === want || w.name === want || w.path === want || w.path.endsWith(`/${want}`)) ?? (wfs.length === 1 && !want ? wfs[0] : undefined);
      if (!wf) fail('E_NOT_FOUND', `Workflow "${want}" not found. Available: ${wfs.map((w) => w.path).join(', ') || 'none'}`);
      await gh.dispatch(owner, repo, wf!.id, ref);
      return { started: wf!.path, ref, note: 'The run appears in ci_status within a few seconds. The workflow must have "on: workflow_dispatch".' };
    }
    case 'ci_run_details': {
      const id = Number(params.run_id);
      const [run, jobs] = await Promise.all([gh.run(owner, repo, id), gh.jobs(owner, repo, id)]);
      return summarizeRun(run, jobs);
    }
    case 'ci_logs': {
      let jobIds: number[];
      if (params.job_id) jobIds = [Number(params.job_id)];
      else {
        if (!params.run_id) fail('E_INVALID', 'Pass run_id (from ci_status) or job_id.');
        const jobs = await gh.jobs(owner, repo, Number(params.run_id));
        const failed = jobs.filter((j) => runState({ status: j.status as never, conclusion: j.conclusion as never }) === 'failed');
        jobIds = (failed.length ? failed : jobs).map((j) => j.id);
      }
      const tail = Math.min(Number(params.tail) || 120, 1000);
      const out = [];
      for (const id of jobIds.slice(0, 5)) {
        const log = await gh.jobLog(owner, repo, id);
        const lines = log.split('\n').map(cleanLogLine);
        out.push({ job_id: id, problems: parseLogProblems(log, hasFile), tail: lines.slice(-tail).join('\n') });
      }
      return { jobs: out };
    }
    case 'ci_rerun':
      await gh.rerun(owner, repo, Number(params.run_id), params.all !== true);
      return { rerunning: Number(params.run_id), failed_only: params.all !== true };
  }
  return fail('E_INVALID', `Unknown CI call ${method}`);
}

/**
 * Commit files on top of a branch's head on GitHub (no project involved). Returns the new commit
 * and the head it replaced, or nothing when the files were already there.
 */
export async function commitFilesToBranch(gh: GitHub, owner: string, repo: string, branch: string, files: BuildFile[], message: string): Promise<{ commit: string; previous: string } | null> {
  const head = (await gh.headOrNull(owner, repo, branch)) ?? fail('E_NOT_FOUND', `There is no branch "${branch}" on GitHub.`);
  const c = await gh.commit(owner, repo, head);
  const tree = await gh.tree(owner, repo, c.tree.sha);
  const have = new Map(tree.map((e) => [e.path, e.sha]));
  const changed = files.filter((f) => have.get(f.path) !== gitBlobHash(f.data));
  if (!changed.length) return null;
  const entries = [];
  for (const f of changed) entries.push({ path: f.path, mode: '100644', type: 'blob' as const, sha: await gh.createBlob(owner, repo, f.data) });
  const t = await gh.createTree(owner, repo, c.tree.sha, entries);
  const commit = await gh.createCommit(owner, repo, message, t, [head]);
  await gh.updateRef(owner, repo, branch, commit).catch((e: unknown) => {
    if (e instanceof GitHubError && e.code === 'E_GITHUB_REJECTED') fail('E_NOT_FAST_FORWARD', `${branch} moved on GitHub at the same time. Try again.`);
    throw e;
  });
  return { commit, previous: head };
}

/**
 * Add a ready-made workflow. "check" goes on the project's branch as its own commit (workflow files
 * aren't project files, so the project doesn't change; if the project was at the branch's head, its
 * link moves to the new commit). "cloudflare" goes on the web build branch next to the build.
 */
export async function addWorkflow(gh: GitHub, doc: ProjectDoc, template: unknown, opts: { buildBranch?: string } = {}) {
  const t = WORKFLOW_TEMPLATES.find((x) => x.id === template) ?? fail('E_INVALID', `Unknown template "${String(template)}". Available: ${WORKFLOW_TEMPLATES.map((x) => `${x.id} (${x.title})`).join(', ')}`);
  const link = requireLinkOf(doc);
  const enc = new TextEncoder();
  if (t.id === 'check') {
    const r = await commitFilesToBranch(gh, link.owner, link.repo, link.branch, [{ path: t.path, data: enc.encode(CHECK_WORKFLOW) }], 'Add the Game Studio check workflow');
    // The project was at the old head: it is in step with the new one too (only the workflow changed).
    const next = r && r.previous === link.commit ? applyCommands(doc, [{ op: 'set_git_link', link: { ...link, commit: r.commit } }]).project : null;
    return { added: [t.path], branch: link.branch, commit: r?.commit ?? null, already: !r, doc: next, note: r ? 'The workflow is on GitHub: it runs on every push and pull request (see ci_status).' : 'The workflow was already there.' };
  }
  const branch = opts.buildBranch ?? BUILD_BRANCH;
  if (!(await gh.headOrNull(link.owner, link.repo, branch))) fail('E_NO_BUILD', `There is no web build (branch "${branch}") yet. Deploy to Cloudflare once (deploy_game with target "cloudflare", or Deploy in Game Studio): that publishes the build and adds this workflow.`);
  const files = cloudflareFiles(link.repo, branch);
  const r = await commitFilesToBranch(gh, link.owner, link.repo, branch, files, 'Deploy the web build to Cloudflare');
  return { added: files.map((f) => f.path), branch, commit: r?.commit ?? null, already: !r, doc: null, note: 'The workflow deploys every web build to Cloudflare Workers; it needs the CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID repository secrets (ci_cloudflare_secrets).' };
}

/** Create a branch at the project's commit (so switching to it keeps every local change). */
export async function createBranch(gh: GitHub, doc: ProjectDoc, name: string, opts: { switchTo?: boolean } = {}) {
  const link = requireLinkOf(doc);
  const branch = name.trim();
  if (!isValidBranchName(branch)) fail('E_INVALID', `"${name}" is not a valid branch name (letters, digits, - _ . /).`);
  if (await gh.headOrNull(link.owner, link.repo, branch)) fail('E_BRANCH_EXISTS', `There is already a branch "${branch}" on GitHub.`);
  await gh.createRef(link.owner, link.repo, branch, link.commit);
  const doc2 = opts.switchTo !== false ? applyCommands(doc, [{ op: 'set_git_link', link: { ...link, branch } }]).project : null;
  return { branch, from: link.branch, commit: link.commit, switched: !!doc2, doc: doc2 };
}
