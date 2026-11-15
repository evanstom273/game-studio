/**
 * The GitHub, CI and deploy MCP tools, run against the cloud copy of the user's projects (no editor
 * needed, except to build the game for a deploy). The GitHub token and Cloudflare credentials are
 * read from this room's storage and never leave it. Changes to a project (commit bookkeeping, pull,
 * branch switch, publish) are applied through the command layer, are one AI undo step, and open
 * editors are told about them like any other cloud edit.
 */
import { GameStudioError, errorMessage, newId } from '@gs/shared';
import { applyCommands, projectRevision, type ProjectDoc } from '@gs/project';
import {
  GitHubError,
  addWorkflow,
  applyAll,
  ciCall,
  cloneProject,
  commitAndPush,
  createBranch,
  deployStatus,
  githubCall,
  gitStatusView,
  publishProject,
  pull,
  projectFilesOf,
  pullView,
  requireLinkOf,
  status,
  switchBranch,
  switchView,
  type AssetReader,
  type GitHub,
  type NewBlobs,
} from '@gs/git';
import { GIT_LEVEL, type GitLevel, type GitMethod } from '../git-methods.ts';
import type { CloudStore, Permissions } from './store.ts';
import type { CloudNotice, EditorLink } from './service.ts';
import { GitHubVault, type FetchLike } from './github-vault.ts';
import { CloudflareVault } from './cloudflare.ts';

export interface GitContext {
  store: CloudStore;
  editor: EditorLink;
  notify(n: CloudNotice): void;
  /** A project by id or name, else the open one, else the only one (with the connection's scope applied). */
  project(ref?: string): Promise<ProjectDoc>;
}

/** Largest repository (project files) an AI can open into the cloud copy. */
export const CLOUD_CLONE_LIMIT = 60 * 1024 * 1024;

const RANK: Record<GitLevel, number> = { read: 0, edit: 1, full: 2 };
const LEVEL_TEXT: Record<GitLevel, string> = { read: 'reading', edit: 'changing projects and repositories', full: 'deleting repositories, merging, deploying and writing deploy secrets' };

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

export class CloudGit {
  constructor(
    private readonly ctx: GitContext,
    /** Overridable for tests. */
    private readonly fetchImpl?: FetchLike,
  ) {}

  github() {
    return new GitHubVault(this.ctx.store.kv, this.fetchImpl);
  }
  cloudflare() {
    return new CloudflareVault(this.ctx.store.kv, this.fetchImpl);
  }

  private check(method: GitMethod, p: Permissions) {
    const need = GIT_LEVEL[method];
    if (RANK[p.level] < RANK[need]) throw new GameStudioError('E_FORBIDDEN', `This AI connection doesn't allow ${LEVEL_TEXT[need]} (it is set to "${p.level}"). The user can change it in Game Studio → AI connection.`);
    if (method === 'git_clone' && p.scope === 'open-project') throw new GameStudioError('E_FORBIDDEN', 'This AI connection may only work on the project that is open in Game Studio, so it cannot open a repository as a new project.');
  }

  /** Runs one GitHub / CI / deploy tool. */
  async handle(method: GitMethod, params: Record<string, unknown>): Promise<unknown> {
    const perms = (await this.ctx.store.meta()).permissions;
    this.check(method, perms);
    try {
      return await this.dispatch(method, params, perms);
    } catch (e) {
      if (e instanceof GitHubError) throw new GameStudioError(e.code, e.message, e.details);
      throw e;
    }
  }

  private reader(projectId: string): AssetReader {
    return async (hash) => (await this.ctx.store.getBlob(projectId, hash))?.data;
  }

  /** Stores the result of a git operation as one AI step: blobs, document, undo history, live notice. */
  private async save(before: ProjectDoc, after: ProjectDoc, label: string, blobs: NewBlobs = new Map()) {
    if (after === before) return;
    const current = await this.ctx.store.header(before.id);
    if (current && current.revision !== projectRevision(before)) throw new GameStudioError('E_REVISION_CONFLICT', 'The project changed while talking to GitHub (probably in the editor). Nothing was applied here; run the tool again.');
    for (const [hash, b] of blobs) if (!(await this.ctx.store.hasBlob(before.id, hash))) await this.ctx.store.putBlob(before.id, hash, b.data, b.mime);
    const next = { ...after, updatedAt: Date.now() };
    await this.ctx.store.put(next);
    await this.ctx.store.record(before, next, label);
    this.ctx.notify({ type: 'project-updated', id: before.id, revision: projectRevision(next), label: `AI: ${label}` });
  }

  private async confirm(perms: Permissions, title: string, message: string) {
    if (!perms.confirmDestructive) return;
    if (!this.ctx.editor.connected()) throw new GameStudioError('E_NEEDS_CONFIRMATION', `${title} needs the user's OK in Game Studio, which isn't open. Ask them to open it (or to switch off "Ask me before the AI deletes" in AI connection).`);
    let ok: boolean;
    try {
      ok = (await this.ctx.editor.ask('confirm', { title, message }, 300_000)) === true;
    } catch (e) {
      throw new GameStudioError('E_DECLINED', `Couldn't get the user's confirmation: ${errorMessage(e)}`);
    }
    if (!ok) throw new GameStudioError('E_DECLINED', 'The user declined. Nothing was changed.');
  }

  private async gh(): Promise<GitHub> {
    return this.github().client();
  }

  private async dispatch(method: GitMethod, params: Record<string, unknown>, perms: Permissions): Promise<unknown> {
    const projectRef = str(params.project);
    switch (method) {
      case 'git_repos':
        return githubCall('git_repos', await this.gh(), params, null);

      case 'git_clone': {
        const [owner, repo, extra] = String(params.repository ?? '').trim().split('/');
        if (!owner || !repo || extra !== undefined) throw new GameStudioError('E_INVALID', 'repository must be "owner/name"');
        const c = await cloneProject(await this.gh(), owner, repo, { id: newId('p'), branch: str(params.branch), maxBytes: CLOUD_CLONE_LIMIT });
        for (const [hash, b] of c.blobs) await this.ctx.store.putBlob(c.doc.id, hash, b.data, b.mime);
        await this.ctx.store.put(c.doc);
        await this.ctx.store.setMeta({ active: c.doc.id });
        this.ctx.notify({ type: 'project-updated', id: c.doc.id, revision: projectRevision(c.doc), label: `AI: Open ${c.fullName} from GitHub` });
        return { project: c.doc.id, name: c.doc.name, repository: c.fullName, branch: c.doc.git!.branch, scenes: Object.keys(c.doc.scenes).length, scripts: Object.keys(c.doc.scripts).length, assets: Object.keys(c.doc.assets).length, ...(c.issues.length ? { issues: c.issues } : {}), note: 'Opened as a new project (now the open one). It appears in Game Studio the next time it syncs (live if it is open).' };
      }

      case 'git_status':
        return gitStatusView(await this.ctx.project(projectRef));

      case 'git_commit': {
        const doc = await this.ctx.project(projectRef);
        const confirmDeletions = typeof params.confirm_deletions === 'number' ? params.confirm_deletions : undefined;
        if (confirmDeletions !== undefined) {
          const link = requireLinkOf(doc);
          const deletions = status(doc).filter((c) => c.status === 'deleted').length;
          if (deletions === confirmDeletions) await this.confirm(perms, 'Delete files on GitHub?', `An AI assistant wants to commit the deletion of ${deletions} files from ${link.owner}/${link.repo}.`);
        }
        const r = await commitAndPush(await this.gh(), doc, this.reader(doc.id), String(params.message ?? ''), { paths: Array.isArray(params.paths) ? params.paths.map(String) : undefined, newBranch: str(params.new_branch), confirmDeletions });
        await this.save(doc, applyAll(doc, r.commands), `Commit "${String(params.message).split('\n')[0].slice(0, 80)}"`);
        return { commit: r.commit, branch: r.branch, files: r.files, repository: `${r.link.owner}/${r.link.repo}` };
      }

      case 'git_pull': {
        const doc = await this.ctx.project(projectRef);
        const r = await pull(await this.gh(), doc, this.reader(doc.id));
        if (!r.upToDate) await this.save(doc, r.doc, `Pull ${r.link.branch}`, r.blobs);
        return pullView(r);
      }

      case 'git_branches': {
        const doc = await this.ctx.project(projectRef);
        const link = requireLinkOf(doc);
        const gh = await this.gh();
        const [bs, info] = await Promise.all([gh.branches(link.owner, link.repo), gh.repo(link.owner, link.repo)]);
        return { repository: `${link.owner}/${link.repo}`, current: link.branch, default: info.default_branch, current_exists: bs.some((b) => b.name === link.branch), branches: bs.map((b) => b.name) };
      }

      case 'git_switch_branch': {
        const doc = await this.ctx.project(projectRef);
        const branch = str(params.branch) ?? '';
        const r = await switchBranch(await this.gh(), doc, branch, this.reader(doc.id));
        await this.save(doc, r.doc, `Switch to branch ${branch}`, r.blobs);
        return switchView(r);
      }

      case 'git_create_branch': {
        const doc = await this.ctx.project(projectRef);
        const r = await createBranch(await this.gh(), doc, String(params.name ?? ''), { switchTo: params.switch !== false });
        if (r.doc) await this.save(doc, r.doc, `Create branch ${r.branch}`);
        return { branch: r.branch, from: r.from, commit: r.commit, switched: r.switched };
      }

      case 'git_create_pr':
      case 'git_pr_list':
      case 'git_pr_get':
      case 'git_pr_update':
      case 'git_pr_merge':
      case 'git_repo_create':
      case 'git_repo_update':
      case 'git_repo_delete': {
        // Repository-level calls work without a project; without "repository" they use the project's.
        const own = !str(params.repository) && method !== 'git_repo_create';
        const doc = own ? await this.ctx.project(projectRef) : null;
        const link = doc?.git ?? null;
        const gh = await this.gh();
        if (method === 'git_repo_delete') {
          const r = (await githubCall(method, gh, params, link, async (full) => {
            await this.confirm(perms, 'Delete a GitHub repository?', `An AI assistant wants to permanently delete the repository ${full} on GitHub. This can't be undone.`);
            return true;
          })) as { deleted: string };
          // The project stays, unlinked from the repository that no longer exists.
          const linked = await this.linkedTo(r.deleted, doc);
          if (linked) await this.save(linked, applyCommands(linked, [{ op: 'set_git_link', link: null }]).project, `Unlink from ${r.deleted}`);
          return r;
        }
        if (method === 'git_repo_update') {
          const before = targetName(params, link);
          const r = (await githubCall(method, gh, params, link)) as { repository: string };
          const linked = before && before !== r.repository ? await this.linkedTo(before, doc) : null;
          if (linked?.git) {
            const [owner, repo] = r.repository.split('/');
            await this.save(linked, applyCommands(linked, [{ op: 'set_git_link', link: { ...linked.git, owner, repo } }]).project, `Repository renamed to ${r.repository}`);
          }
          return r;
        }
        if (method === 'git_pr_merge') {
          const r = (await githubCall(method, gh, params, link)) as { into: string; head?: string; deleted_branch?: string };
          if (doc && link && own && r.deleted_branch === link.branch) {
            const s = await switchBranch(gh, doc, r.into, this.reader(doc.id));
            await this.save(doc, s.doc, `Switch to branch ${r.into}`, s.blobs);
            return { ...r, switched_project_to: switchView(s) };
          }
          return r;
        }
        return githubCall(method, gh, params, link);
      }

      case 'git_publish': {
        const doc = await this.ctx.project(projectRef);
        const name = str(params.name) ?? '';
        const r = await publishProject(await this.gh(), doc, this.reader(doc.id), { name, description: str(params.description), private: params.private !== false, org: str(params.org), message: str(params.message) });
        await this.save(doc, applyAll(doc, r.commands), `Publish to ${r.repository}`);
        return { repository: r.repository, url: r.url, branch: r.branch, commit: r.commit, files: r.files };
      }

      case 'ci_status':
      case 'ci_run':
      case 'ci_run_details':
      case 'ci_logs':
      case 'ci_rerun': {
        const doc = await this.ctx.project(projectRef);
        const link = requireLinkOf(doc);
        const files = projectFilesOf(doc);
        return ciCall(method, await this.gh(), link, params, (p) => files.has(p));
      }

      case 'ci_add_workflow': {
        const doc = await this.ctx.project(projectRef);
        const gh = await this.gh();
        const r = await addWorkflow(gh, doc, params.template);
        if (r.doc) await this.save(doc, r.doc, `Add workflow ${r.added[0]}`);
        // The Cloudflare deploy needs its two repository secrets: set them from the saved credentials.
        let secrets: unknown;
        if (params.template === 'cloudflare') {
          const link = requireLinkOf(doc);
          secrets = perms.level === 'full' ? await this.cloudflare().setRepoSecrets(gh, link.owner, link.repo).catch((e: Error & { code?: string }) => ({ not_set: e.code ?? 'E_CLOUDFLARE', reason: e.message })) : { not_set: 'E_FORBIDDEN', reason: 'Setting deploy secrets needs the "full" level (ci_cloudflare_secrets).' };
        }
        const { doc: _d, ...rest } = r;
        return { ...rest, ...(secrets ? { secrets } : {}) };
      }

      case 'ci_cloudflare_secrets': {
        const doc = await this.ctx.project(projectRef);
        const link = requireLinkOf(doc);
        return this.cloudflare().setRepoSecrets(await this.gh(), link.owner, link.repo);
      }

      case 'deploy_status': {
        const doc = await this.ctx.project(projectRef);
        const link = requireLinkOf(doc);
        return deployStatus(await this.gh(), link.owner, link.repo, str(params.branch));
      }

      case 'deploy_game': {
        const doc = await this.ctx.project(projectRef);
        const link = requireLinkOf(doc);
        const target = params.target === 'cloudflare' ? 'cloudflare' : params.target === 'github-pages' ? 'github-pages' : null;
        if (!target) throw new GameStudioError('E_INVALID', 'target must be "github-pages" or "cloudflare"');
        await this.github().client(); // fail early when GitHub isn't connected
        if (target === 'cloudflare' && !(await this.cloudflare().status()).configured) throw new GameStudioError('E_CLOUDFLARE_NOT_CONNECTED', 'Cloudflare is not connected yet: the user adds a Cloudflare API token and account ID once, in Game Studio → Source control → Deploy.');
        if (!this.ctx.editor.connected())
          throw new GameStudioError('E_NO_EDITOR', `Deploying builds the game's web export, which happens in Game Studio in a browser (it compiles the scripts and packs the engine). Ask the user to open Game Studio on any device, then try again. ${link.owner}/${link.repo} was not changed.`);
        return this.ctx.editor.ask('git_deploy', { project: doc.id, revision: projectRevision(doc), target, ...(str(params.branch) ? { branch: str(params.branch) } : {}), ...(str(params.worker_name) ? { worker_name: str(params.worker_name) } : {}) }, 600_000);
      }
    }
  }

  /** The project linked to `fullName`: the given one when it is, else none. */
  private async linkedTo(fullName: string, doc: ProjectDoc | null): Promise<ProjectDoc | null> {
    if (doc?.git && `${doc.git.owner}/${doc.git.repo}`.toLowerCase() === fullName.toLowerCase()) return (await this.ctx.store.get(doc.id)) ?? doc;
    return null;
  }
}

function targetName(params: Record<string, unknown>, link: ProjectDoc['git'] | null): string | null {
  const r = str(params.repository);
  if (r) return r;
  return link ? `${link.owner}/${link.repo}` : null;
}
