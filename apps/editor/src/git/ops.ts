/**
 * Git operations on the open project, as undoable editor steps. The work is done by @gs/git (the
 * same code the cloud copy runs for AI assistants); results are applied through the command layer
 * and replace the open document as one history entry, so "Undo" takes a pull back.
 */
import { GameStudioError, newId } from '@gs/shared';
import { projectRevision, type GitLink, type ProjectDoc } from '@gs/project';
import {
  addWorkflow,
  applyAll,
  baseText,
  branchExists,
  cloneProject,
  commitAndPush,
  createBranch,
  publishProject,
  pull,
  revertFiles,
  switchBranch,
  type AssetReader,
  type NewBlobs,
} from '@gs/git';
import { addProject, getBlob, putBlob } from '@editor/db/projects';
import { useEditor } from '@editor/store/editor';
import { assetBlobByHash, loadProjectAssets } from '@editor/services/assets';
import { cloudflareStatus, github, setCloudflareSecrets } from './api';

export type GitSource = 'user' | 'mcp';

/** Largest repository (project files) that can be opened in a browser. */
const BROWSER_CLONE_LIMIT = 400 * 1024 * 1024;

function openProject(): ProjectDoc {
  const p = useEditor.getState().project;
  if (!p) throw new GameStudioError('E_NO_PROJECT', 'No project is open');
  return p;
}

export function linkOf(doc: ProjectDoc | null): GitLink | null {
  return doc?.git ?? null;
}

/** Asset bytes of a project: from memory when loaded, else from browser storage. */
export function assetReader(projectId: string): AssetReader {
  return async (hash) => {
    const b = assetBlobByHash(hash);
    if (b) return new Uint8Array(await b.arrayBuffer());
    return getBlob(projectId, hash);
  };
}

/** Applies a git result to the open project as one undo step (if nobody changed it meanwhile). */
async function apply(before: ProjectDoc, after: ProjectDoc, label: string, source: GitSource, blobs: NewBlobs = new Map()) {
  const ed = useEditor.getState();
  if (!ed.project || ed.project.id !== before.id || (ed.project !== before && projectRevision(ed.project) !== projectRevision(before)))
    throw new GameStudioError('E_CHANGED', 'The project changed while talking to GitHub, so nothing was applied. Try again.');
  for (const [hash, b] of blobs) await putBlob(before.id, hash, b.data, b.mime);
  if (blobs.size) await loadProjectAssets(after);
  if (after !== before) useEditor.getState().replace({ ...after, updatedAt: Date.now() }, label, source);
}

/** Opens a branch of a repository as a new project in this browser. */
export async function cloneRepo(owner: string, repo: string, branch?: string, onProgress?: (done: number, total: number) => void) {
  const c = await cloneProject(github(), owner, repo, { id: newId('p'), branch, maxBytes: BROWSER_CLONE_LIMIT, onProgress });
  await addProject(c.doc, new Map([...c.blobs].map(([h, b]) => [h, b.data])));
  return c;
}

export async function commitOpen(message: string, opts: { paths?: string[]; newBranch?: string; confirmDeletions?: number } = {}, source: GitSource = 'user') {
  const before = openProject();
  const r = await commitAndPush(github(), before, assetReader(before.id), message, opts);
  await apply(before, applyAll(before, r.commands), `Commit "${message.split('\n')[0].slice(0, 60)}"`, source);
  return r;
}

export async function pullOpen(source: GitSource = 'user') {
  const before = openProject();
  const r = await pull(github(), before, assetReader(before.id));
  if (!r.upToDate) await apply(before, r.doc, `Pull from GitHub (${r.link.branch})`, source, r.blobs);
  return r;
}

export async function switchOpen(branch: string, source: GitSource = 'user') {
  const before = openProject();
  const r = await switchBranch(github(), before, branch, assetReader(before.id));
  await apply(before, r.doc, `Switch to branch ${branch}`, source, r.blobs);
  return r;
}

export async function createBranchOpen(name: string, switchTo = true) {
  const before = openProject();
  const r = await createBranch(github(), before, name, { switchTo });
  if (r.doc) await apply(before, r.doc, `New branch ${r.branch}`, 'user');
  return r;
}

export async function publishOpen(p: { name: string; description?: string; private?: boolean; org?: string; message?: string }, source: GitSource = 'user') {
  const before = openProject();
  const r = await publishProject(github(), before, assetReader(before.id), p);
  await apply(before, applyAll(before, r.commands), `Publish to ${r.repository}`, source);
  return r;
}

/** Puts files back to GitHub's version at the last synced commit ("use GitHub's", discard, restore). */
export async function revertOpen(paths: string[], label?: string) {
  const before = openProject();
  const r = await revertFiles(github(), before, paths);
  await apply(before, r.doc, label ?? (paths.length === 1 ? `Use GitHub's ${paths[0]}` : `Restore ${paths.length} files from GitHub`), 'user', r.blobs);
  return r;
}

/** Re-points the link after the repository was renamed, or removes it after it was deleted. */
export function relinkOpen(link: GitLink | null, label: string) {
  useEditor.getState().dispatch([{ op: 'set_git_link', link }], { label });
}

/** If the tracked branch was deleted on GitHub (merged?), move to the repository's default branch. */
export async function recoverDeletedBranch() {
  const doc = openProject();
  const link = doc.git;
  if (!link || (await branchExists(github(), link))) return null;
  const def = (await github().repo(link.owner, link.repo)).default_branch;
  if (def === link.branch) return null;
  return { deleted: link.branch, ...(await switchOpen(def)) };
}

/** Adds a ready-made workflow; for Cloudflare also puts the deploy secrets on the repository. */
export async function addWorkflowOpen(template: 'check' | 'cloudflare') {
  const before = openProject();
  const r = await addWorkflow(github(), before, template);
  if (r.doc) await apply(before, r.doc, `Add workflow ${r.added[0]}`, 'user');
  let secrets: string | null = null;
  if (template === 'cloudflare' && before.git) {
    const cf = await cloudflareStatus();
    secrets = cf.configured ? `Deploy secrets set on ${(await setCloudflareSecrets(before.git.owner, before.git.repo)).repository}` : 'Connect Cloudflare (Deploy tab) and the deploy secrets are set for you.';
  }
  return { ...r, secrets };
}

/** GitHub's version of a file at the last synced commit (for diffs). */
export async function baseVersion(path: string): Promise<string | null> {
  const link = openProject().git;
  return link ? baseText(github(), link, path) : null;
}
