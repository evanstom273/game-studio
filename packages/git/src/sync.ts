/**
 * Git operations between a project and a GitHub branch.
 *
 * A project is stored in a repository as files (see @gs/project files.ts). What the project last
 * synced with is kept in the document itself (`doc.git`: the commit, and every project file's git
 * blob SHA at that commit), so it travels with the project through cloud sync and every change to
 * it is an ordinary command. Status compares hashes (nothing is downloaded); commit uploads only
 * changed files and never forces; pull is a per-file three-way merge whose result is applied
 * through the command layer. Files in the repository that aren't part of the project (README,
 * workflows…) are never touched.
 */
import {
  MAX_BATCH,
  REPO_MANIFEST,
  applyCommands,
  assetInfoFromBytes,
  decodeText,
  fileUpdatesToCommands,
  isProjectFile,
  parseManifestFile,
  parseSceneFile,
  projectFromFiles,
  projectTextFiles,
  repoFileRole,
  serializeManifest,
  serializeScene,
  type Command,
  type FileUpdate,
  type GitLink,
  type ProjectDoc,
} from '@gs/project';
import type { AssetInfo } from '@gs/core';
import { GitHub, GitHubError, isValidBranchName, type NewTreeEntry, type TreeEntry } from './github';
import { gitBlobHash } from './hash';
import { merge3 } from './merge';

/** Files larger than this are left out when a repository is opened (the asset limit of the editor). */
export const CLONE_FILE_LIMIT = 50 * 1024 * 1024;
/** Deleting this many files in one commit has to be confirmed with the exact number. */
export const MASS_DELETE_THRESHOLD = 10;

/** Bytes of one of the project's assets, by SHA-256 (undefined when this copy doesn't have them). */
export type AssetReader = (sha256: string) => Promise<Uint8Array | undefined>;

export interface Change {
  path: string;
  status: 'added' | 'modified' | 'deleted';
}

export type ConflictKind = 'text' | 'json' | 'binary' | 'delete' | 'invalid' | 'in-use';

export interface Conflict {
  path: string;
  kind: ConflictKind;
  /** Why it couldn't be taken or merged (for json / invalid / in-use). */
  reason?: string;
}

export type NewBlobs = Map<string, { data: Uint8Array; mime: string }>;

const fail = (code: string, message: string, details?: unknown): never => {
  throw new GitHubError(code, message, undefined, details);
};

export function requireLink(doc: ProjectDoc): GitLink {
  return doc.git ?? fail('E_NOT_LINKED', 'This project is not linked to a GitHub repository. Publish it to a new repository, or open one from GitHub.');
}

const trackable = (e: TreeEntry) => e.type === 'blob' && e.mode !== '120000' && isProjectFile(e.path);

/** Applies any number of commands (in batches the command layer accepts) and returns the result. */
export function applyAll(doc: ProjectDoc, commands: Command[]): ProjectDoc {
  let cur = doc;
  for (let i = 0; i < commands.length; i += MAX_BATCH) cur = applyCommands(cur, commands.slice(i, i + MAX_BATCH)).project;
  return cur;
}

// --- the project's files ---------------------------------------------------------------------------------------------

interface LocalFile {
  text?: string;
  asset?: AssetInfo;
  /** Git blob SHA, when known without reading bytes. */
  sha?: string;
}

function localFiles(doc: ProjectDoc, link: GitLink | undefined): Map<string, LocalFile> {
  const out = new Map<string, LocalFile>();
  for (const [p, text] of projectTextFiles(doc)) out.set(p, { text, sha: gitBlobHash(text) });
  for (const a of Object.values(doc.assets)) out.set(a.path, { asset: a, ...(link?.assets?.[a.path] === a.hash && link.tree[a.path] ? { sha: link.tree[a.path] } : {}) });
  return out;
}

/** What changed since the last commit or pull (no network). */
export function status(doc: ProjectDoc, link: GitLink | undefined = doc.git): Change[] {
  if (!link) return [];
  const out: Change[] = [];
  const local = localFiles(doc, link);
  for (const [p, f] of local) {
    const base = link.tree[p];
    if (!base) out.push({ path: p, status: 'added' });
    else if (f.asset ? link.assets?.[p] !== f.asset.hash : f.sha !== base) out.push({ path: p, status: 'modified' });
  }
  const skipped = new Set(link.skipped ?? []);
  for (const p of Object.keys(link.tree)) if (!local.has(p) && !skipped.has(p) && isProjectFile(p)) out.push({ path: p, status: 'deleted' });
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

function massDeletion(changes: Change[], link: GitLink) {
  const del = changes.filter((c) => c.status === 'deleted');
  if (del.length < MASS_DELETE_THRESHOLD) return null;
  return { count: del.length, tracked: Object.keys(link.tree).length, sample: del.slice(0, 8).map((c) => c.path) };
}

async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(n, queue.length) }, async () => {
    for (let x = queue.shift(); x !== undefined; x = queue.shift()) await fn(x);
  }));
}

async function readAssetBytes(read: AssetReader, a: AssetInfo) {
  return (await read(a.hash)) ?? fail('E_MISSING_ASSETS', `The data of "${a.path}" is missing from this copy of the project`);
}

/** Download blobs (checked against their hashes). */
async function download(gh: GitHub, owner: string, repo: string, shas: string[], onProgress?: (done: number, total: number) => void) {
  const out = new Map<string, Uint8Array>();
  const want = [...new Set(shas)];
  let done = 0;
  await pool(want, 6, async (sha) => {
    const data = await gh.blob(owner, repo, sha);
    if (gitBlobHash(data) !== sha) fail('E_GITHUB', `GitHub sent different content than expected for blob ${sha.slice(0, 7)}`);
    out.set(sha, data);
    onProgress?.(++done, want.length);
  });
  return out;
}

// --- commit & push ------------------------------------------------------------------------------------------------

export interface CommitResult {
  commit: string;
  branch: string;
  files: number;
  link: GitLink;
  /** The project with the new link (apply it with `set_git_link`). */
  commands: Command[];
}

/**
 * Commit every change (or only `paths`) and push. With `newBranch` the commit goes to a new branch
 * made from the current commit. Refused with E_NOT_FAST_FORWARD when GitHub moved on (pull first),
 * and with E_MASS_DELETE when it would delete many files without `confirmDeletions` (a project that
 * didn't load completely looks exactly like one whose files were deleted).
 */
export async function commitAndPush(gh: GitHub, doc: ProjectDoc, read: AssetReader, message: string, opts: { paths?: string[]; newBranch?: string; confirmDeletions?: number } = {}): Promise<CommitResult> {
  const link = requireLink(doc);
  if (!message.trim()) fail('E_INVALID', 'A commit message is required.');
  const newBranch = opts.newBranch?.trim() || undefined;
  if (newBranch && !isValidBranchName(newBranch)) fail('E_INVALID', `"${newBranch}" is not a valid branch name (letters, digits, - _ . /).`);
  let changes = status(doc, link);
  if (opts.paths) {
    const want = new Set(opts.paths);
    changes = changes.filter((c) => want.has(c.path));
  }
  const mass = massDeletion(changes, link);
  if (mass && opts.confirmDeletions !== mass.count)
    fail(
      'E_MASS_DELETE',
      `Not committed: this would delete ${mass.count} of the repository's ${mass.tracked} project files (${mass.sample.join(', ')}${mass.count > mass.sample.length ? ', …' : ''}). If you didn't delete them yourself, the project probably didn't load completely: don't commit, restore them from GitHub instead. To delete them on purpose, confirm the deletion of exactly ${mass.count} files.`,
      { deletions: mass.count },
    );
  const { owner, repo } = link;
  const branch = newBranch ?? link.branch;
  if (newBranch) {
    if (await gh.headOrNull(owner, repo, newBranch)) fail('E_BRANCH_EXISTS', `There is already a branch "${newBranch}" on GitHub. Pick another name, or switch to it.`);
  } else {
    const remote = await gh.headOrNull(owner, repo, link.branch);
    if (!remote) fail('E_BRANCH_GONE', `The branch "${link.branch}" no longer exists on GitHub (merged and deleted?). Commit to a new branch, or switch to another one.`);
    if (remote !== link.commit) fail('E_NOT_FAST_FORWARD', `${link.branch} has new commits on GitHub. Pull first, then commit.`);
  }
  const local = localFiles(doc, link);
  const entries: NewTreeEntry[] = [];
  const nextAssets: Record<string, string> = { ...link.assets };
  const nextTree: Record<string, string> = { ...link.tree };
  let count = 0;
  await pool(changes, 4, async (c) => {
    const mode = link.modes?.[c.path] ?? '100644';
    if (c.status === 'deleted') {
      entries.push({ path: c.path, mode, type: 'blob', sha: null });
      delete nextTree[c.path];
      delete nextAssets[c.path];
      count++;
      return;
    }
    const f = local.get(c.path)!;
    const data = f.asset ? await readAssetBytes(read, f.asset) : new TextEncoder().encode(f.text ?? '');
    const sha = gitBlobHash(data);
    if (f.asset) nextAssets[c.path] = f.asset.hash;
    // An asset whose bytes are what GitHub already has (its hash just wasn't recorded) isn't a change.
    if (sha === link.tree[c.path]) return;
    const stored = await gh.createBlob(owner, repo, data);
    if (stored !== sha) fail('E_GITHUB', `GitHub stored ${c.path} with an unexpected hash`);
    entries.push({ path: c.path, mode, type: 'blob', sha });
    nextTree[c.path] = sha;
    count++;
  });
  const next: GitLink = { ...link, branch, tree: nextTree, ...(Object.keys(nextAssets).length ? { assets: nextAssets } : {}) };
  if (!entries.length) {
    if (!changes.length) fail('E_NOTHING_TO_COMMIT', 'Nothing to commit: no project files differ from GitHub.');
    // Only bookkeeping changed (asset hashes recorded): nothing to push.
    return { commit: link.commit, branch: link.branch, files: 0, link: { ...next, branch: link.branch }, commands: [{ op: 'set_git_link', link: { ...next, branch: link.branch } }] };
  }
  const base = await gh.commit(owner, repo, link.commit);
  const tree = await gh.createTree(owner, repo, base.tree.sha, entries.sort((a, b) => (a.path < b.path ? -1 : 1)));
  const commit = await gh.createCommit(owner, repo, message.trim(), tree, [link.commit]);
  if (newBranch) await gh.createRef(owner, repo, branch, commit);
  else
    await gh.updateRef(owner, repo, branch, commit).catch((e: unknown) => {
      if (e instanceof GitHubError && e.code === 'E_GITHUB_REJECTED') fail('E_NOT_FAST_FORWARD', `${branch} moved on GitHub while committing. Pull first, then commit.`);
      throw e;
    });
  const done: GitLink = { ...next, commit };
  return { commit, branch, files: count, link: done, commands: [{ op: 'set_git_link', link: done }] };
}

// --- pull & switch ----------------------------------------------------------------------------------------------------

export interface PullResult {
  upToDate: boolean;
  /** The project after the pull (computed with the command layer). */
  doc: ProjectDoc;
  /** The commands that turned the old project into `doc` (the last one sets the new link). */
  commands: Command[];
  /** Asset bytes the project needs now, to store next to it. */
  blobs: NewBlobs;
  link: GitLink;
  /** Files that now have GitHub's version. */
  updated: string[];
  /** Files changed on both sides and merged cleanly. */
  merged: string[];
  /** Files changed on both sides that kept the local version (or got conflict markers, for scripts). */
  conflicts: Conflict[];
}

interface Plan {
  /** path → what to do */
  take: Map<string, string | null>;
  merge: Map<string, { base: string; theirs: string }>;
  conflicts: Conflict[];
  /** New `assets` entries for paths whose remote bytes equal ours. */
  sameAssets: Map<string, string>;
}

/** Turns downloaded and merged files into file updates (validated), then commands and the new project. */
async function finish(gh: GitHub, doc: ProjectDoc, link: GitLink, plan: Plan, remote: { commit: string; branch: string; tree: TreeEntry[] }, labels: { theirs: string }) {
  const { owner, repo } = link;
  const remoteFiles = remote.tree.filter(trackable);
  const small = remoteFiles.filter((e) => (e.size ?? 0) <= CLONE_FILE_LIMIT);
  const theirs = new Map(small.map((e) => [e.path, e.sha]));
  const shas = [...plan.take.values()].filter((s): s is string => !!s);
  for (const m of plan.merge.values()) shas.push(m.theirs, m.base);
  const blobs = await download(gh, owner, repo, shas);
  const local = localFiles(doc, link);
  const updates: FileUpdate[] = [];
  const updated: string[] = [];
  const merged: string[] = [];
  const conflicts = [...plan.conflicts];
  const newBlobs: NewBlobs = new Map();
  const assetHashes: Record<string, string> = {};
  const manifestSizes = (() => {
    const m = theirs.get(REPO_MANIFEST);
    try {
      return m && blobs.has(m) ? parseManifestFile(decodeText(REPO_MANIFEST, blobs.get(m)!)).imageSizes : undefined;
    } catch {
      return undefined;
    }
  })();
  const keepLocal = (path: string, kind: ConflictKind, reason?: string) => conflicts.push({ path, kind, ...(reason ? { reason } : {}) });
  for (const [path, sha] of plan.take) {
    const role = repoFileRole(path);
    if (sha === null) {
      updates.push({ path, deleted: true });
      updated.push(path);
      continue;
    }
    const data = blobs.get(sha)!;
    try {
      if (role === 'asset') {
        const prev = doc.assets[path];
        const s = manifestSizes?.[path];
        const info = await assetInfoFromBytes(path, data, s ? { width: s[0], height: s[1] } : prev);
        updates.push({ path, asset: info });
        newBlobs.set(info.hash, { data, mime: info.mime });
        assetHashes[path] = info.hash;
      } else {
        const text = decodeText(path, data);
        if (role === 'scene') parseSceneFile(path, text);
        if (role === 'manifest') parseManifestFile(text);
        updates.push({ path, text });
      }
      updated.push(path);
    } catch (e) {
      keepLocal(path, 'invalid', `GitHub's version can't be used: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  for (const [path, m] of plan.merge) {
    const role = repoFileRole(path);
    const mine = local.get(path)!.text ?? '';
    let baseText: string;
    let theirText: string;
    try {
      baseText = decodeText(path, blobs.get(m.base)!);
      theirText = decodeText(path, blobs.get(m.theirs)!);
    } catch (e) {
      keepLocal(path, 'invalid', e instanceof Error ? e.message : String(e));
      continue;
    }
    if (role === 'script') {
      const r = merge3(baseText, mine, theirText, { ours: 'yours', theirs: labels.theirs });
      updates.push({ path, text: r.text });
      if (r.conflicts) keepLocal(path, 'text', `${r.conflicts} place(s) changed on both sides: conflict markers were added`);
      else merged.push(path);
      continue;
    }
    // Scenes and gamestudio.json: compare and merge their canonical forms, and only accept a merge
    // that is still a valid file. Otherwise the local version is kept and reported.
    const canon = (text: string) => {
      try {
        return role === 'scene' ? serializeScene(parseSceneFile(path, text)) : text;
      } catch {
        return text;
      }
    };
    const b = canon(baseText);
    const t = canon(theirText);
    if (b === mine) {
      // Only reformatted here: take GitHub's version.
      try {
        if (role === 'scene') parseSceneFile(path, theirText);
        else parseManifestFile(theirText);
        updates.push({ path, text: theirText });
        updated.push(path);
      } catch (e) {
        keepLocal(path, 'invalid', `GitHub's version can't be used: ${e instanceof Error ? e.message : String(e)}`);
      }
      continue;
    }
    const r = merge3(b, mine, t);
    if (r.conflicts) {
      keepLocal(path, 'json', 'changed in the same places on both sides; your version was kept');
      continue;
    }
    try {
      if (role === 'scene') parseSceneFile(path, r.text);
      else parseManifestFile(r.text);
      updates.push({ path, text: r.text });
      merged.push(path);
    } catch (e) {
      keepLocal(path, 'json', `merging both versions would not be a valid file (${e instanceof Error ? e.message : String(e)}); your version was kept`);
    }
  }
  const { commands, kept } = fileUpdatesToCommands(doc, updates);
  for (const p of kept) keepLocal(p, 'in-use', 'deleted on GitHub, but another scene here still instances it');
  // The new link: GitHub's files at the new commit, and the asset hashes we know for them.
  const assets: Record<string, string> = {};
  for (const [p, sha] of theirs) {
    if (repoFileRole(p) !== 'asset') continue;
    if (assetHashes[p] && plan.take.get(p) === sha) assets[p] = assetHashes[p];
    else if (plan.sameAssets.has(p)) assets[p] = plan.sameAssets.get(p)!;
    else if (link.tree[p] === sha && link.assets?.[p]) assets[p] = link.assets[p];
  }
  const modes = Object.fromEntries(small.filter((e) => e.mode !== '100644').map((e) => [e.path, e.mode]));
  // Too large to open, or GitHub's version is unusable and there is none here: leave them to GitHub
  // (a commit must not delete them).
  const skipped = [...remoteFiles.filter((e) => (e.size ?? 0) > CLONE_FILE_LIMIT).map((e) => e.path), ...conflicts.filter((c) => c.kind === 'invalid' && !local.has(c.path) && theirs.has(c.path)).map((c) => c.path)].sort();
  const next: GitLink = { provider: 'github', owner, repo, branch: remote.branch, commit: remote.commit, tree: Object.fromEntries(theirs), ...(Object.keys(assets).length ? { assets } : {}), ...(Object.keys(modes).length ? { modes } : {}), ...(skipped.length ? { skipped } : {}) };
  commands.push({ op: 'set_git_link', link: next });
  const result = applyAll(doc, commands);
  return { doc: result, commands, blobs: newBlobs, link: next, updated: updated.sort(), merged: merged.sort(), conflicts };
}

async function localSha(f: LocalFile | undefined, read: AssetReader): Promise<string | undefined> {
  if (!f) return undefined;
  if (f.sha) return f.sha;
  if (f.asset) {
    f.sha = gitBlobHash(await readAssetBytes(read, f.asset));
    return f.sha;
  }
  return gitBlobHash(f.text ?? '');
}

/**
 * Bring GitHub's new commits into the project. Files changed only on GitHub are taken; files changed
 * only here are kept; scripts changed on both sides are merged line by line (conflict markers where
 * they overlap); scenes and gamestudio.json changed on both sides are merged only when the result is
 * still valid, otherwise the local version is kept and reported, as are assets changed on both sides.
 */
export async function pull(gh: GitHub, doc: ProjectDoc, read: AssetReader): Promise<PullResult> {
  const link = requireLink(doc);
  const { owner, repo } = link;
  const remote = (await gh.headOrNull(owner, repo, link.branch)) ?? fail('E_BRANCH_GONE', `The branch "${link.branch}" no longer exists on GitHub (merged and deleted?). Switch to another branch.`);
  if (remote === link.commit) return { upToDate: true, doc, commands: [], blobs: new Map(), link, updated: [], merged: [], conflicts: [] };
  const tree = await gh.commitTree(owner, repo, remote);
  const theirs = new Map(tree.filter(trackable).filter((e) => (e.size ?? 0) <= CLONE_FILE_LIMIT).map((e) => [e.path, e.sha]));
  const local = localFiles(doc, link);
  const plan: Plan = { take: new Map(), merge: new Map(), conflicts: [], sameAssets: new Map() };
  for (const p of new Set([...Object.keys(link.tree), ...theirs.keys()])) {
    if (!isProjectFile(p)) continue;
    const base = link.tree[p];
    const t = theirs.get(p);
    const l = local.get(p);
    if (t === base) continue; // unchanged on GitHub: keep whatever is here
    if ((link.skipped ?? []).includes(p) && !l) {
      plan.take.set(p, t ?? null);
      continue;
    }
    const lsha = await localSha(l, read);
    if (lsha === t) {
      if (l?.asset && t) plan.sameAssets.set(p, l.asset.hash);
      continue; // the same change on both sides
    }
    if (lsha === base) {
      plan.take.set(p, t ?? null);
      continue;
    }
    // Changed on both sides.
    if (!t || !l) plan.conflicts.push({ path: p, kind: 'delete', reason: t ? 'deleted here, changed on GitHub; it stays deleted here' : 'changed here, deleted on GitHub; your version was kept' });
    else if (l.asset) plan.conflicts.push({ path: p, kind: 'binary', reason: 'changed on both sides; your version was kept' });
    else if (!base) plan.conflicts.push({ path: p, kind: repoFileRole(p) === 'script' ? 'text' : 'json', reason: 'added on both sides with different content; your version was kept' });
    else plan.merge.set(p, { base, theirs: t });
  }
  const r = await finish(gh, doc, link, plan, { commit: remote, branch: link.branch, tree }, { theirs: 'GitHub' });
  return { upToDate: false, ...r };
}

export interface SwitchResult extends Omit<PullResult, 'upToDate' | 'merged'> {
  from: string;
  /** Files changed here that the other branch also has differently: your version was kept. */
  kept: string[];
}

/**
 * Switch the project to another branch on GitHub. Files you haven't changed become that branch's
 * version (added, changed or removed); files you have changed keep your version, so nothing is lost
 * (they show as changes against the new branch).
 */
export async function switchBranch(gh: GitHub, doc: ProjectDoc, branch: string, read: AssetReader): Promise<SwitchResult> {
  const link = requireLink(doc);
  const { owner, repo } = link;
  const head = (await gh.headOrNull(owner, repo, branch)) ?? fail('E_NOT_FOUND', `There is no branch "${branch}" on GitHub.`);
  const tree = await gh.commitTree(owner, repo, head);
  const theirs = new Map(tree.filter(trackable).filter((e) => (e.size ?? 0) <= CLONE_FILE_LIMIT).map((e) => [e.path, e.sha]));
  const local = localFiles(doc, link);
  const plan: Plan = { take: new Map(), merge: new Map(), conflicts: [], sameAssets: new Map() };
  const kept: string[] = [];
  for (const p of new Set([...Object.keys(link.tree), ...theirs.keys(), ...local.keys()])) {
    if (!isProjectFile(p)) continue;
    const base = link.tree[p];
    const t = theirs.get(p);
    const l = local.get(p);
    const lsha = await localSha(l, read);
    if (lsha === t) {
      if (l?.asset && t) plan.sameAssets.set(p, l.asset.hash);
      continue;
    }
    if (lsha !== base && !(link.skipped ?? []).includes(p)) {
      if (t !== base) kept.push(p); // both differ: keep yours
      continue;
    }
    plan.take.set(p, t ?? null);
  }
  const r = await finish(gh, doc, link, plan, { commit: head, branch, tree }, { theirs: branch });
  return { ...r, from: link.branch, kept: [...kept, ...r.conflicts.map((c) => c.path)].sort() };
}

/**
 * Put files back to their version at the last synced commit (or delete them if they weren't
 * there): "use GitHub's version" after a conflict, discard a change, restore missing files.
 */
export async function revertFiles(gh: GitHub, doc: ProjectDoc, paths: string[]): Promise<{ doc: ProjectDoc; commands: Command[]; blobs: NewBlobs; reverted: string[] }> {
  const link = requireLink(doc);
  const want = paths.filter((p) => isProjectFile(p));
  const blobs = await download(gh, link.owner, link.repo, want.map((p) => link.tree[p]).filter((s): s is string => !!s));
  const updates: FileUpdate[] = [];
  const newBlobs: NewBlobs = new Map();
  for (const p of want) {
    const sha = link.tree[p];
    if (!sha) {
      updates.push({ path: p, deleted: true });
      continue;
    }
    const data = blobs.get(sha)!;
    if (repoFileRole(p) === 'asset') {
      const info = await assetInfoFromBytes(p, data, doc.assets[p]);
      updates.push({ path: p, asset: info });
      newBlobs.set(info.hash, { data, mime: info.mime });
    } else updates.push({ path: p, text: decodeText(p, data) });
  }
  const { commands } = fileUpdatesToCommands(doc, updates);
  const assets = { ...link.assets };
  for (const u of updates) if ('asset' in u) assets[u.path] = u.asset.hash;
  if (Object.keys(assets).length) commands.push({ op: 'set_git_link', link: { ...link, assets } });
  return { doc: applyAll(doc, commands), commands, blobs: newBlobs, reverted: want };
}

/** GitHub's version of a file at the last synced commit (for diffs), or null if it wasn't there. */
export async function baseText(gh: GitHub, link: GitLink, path: string): Promise<string | null> {
  const sha = link.tree[path];
  if (!sha) return null;
  const data = await gh.blob(link.owner, link.repo, sha);
  return new TextDecoder().decode(data);
}

/** The project's current text of a file (for diffs), or null for assets and missing files. */
export function localText(doc: ProjectDoc, path: string): string | null {
  return projectTextFiles(doc).get(path) ?? null;
}

// --- clone & publish ----------------------------------------------------------------------------------------------

export interface CloneResult {
  doc: ProjectDoc;
  blobs: NewBlobs;
  issues: string[];
  fullName: string;
  private: boolean;
}

/** Download a branch of a repository as a new project (linked to it). */
export async function cloneProject(gh: GitHub, owner: string, repo: string, opts: { id: string; branch?: string; maxBytes?: number; onProgress?: (done: number, total: number) => void }): Promise<CloneResult> {
  const info = await gh.repo(owner, repo);
  const branch = opts.branch || info.default_branch;
  const commit = (await gh.headOrNull(info.owner.login, info.name, branch)) ?? fail('E_NOT_FOUND', `There is no branch "${branch}" in ${info.full_name}${branch === info.default_branch ? ' (the repository is empty)' : ''}.`);
  const tree = await gh.commitTree(info.owner.login, info.name, commit);
  const files = tree.filter(trackable);
  const tooLarge = files.filter((e) => (e.size ?? 0) > CLONE_FILE_LIMIT);
  const wanted = files.filter((e) => (e.size ?? 0) <= CLONE_FILE_LIMIT);
  const total = wanted.reduce((n, e) => n + (e.size ?? 0), 0);
  if (opts.maxBytes && total > opts.maxBytes) fail('E_TOO_LARGE', `${info.full_name} has ${Math.round(total / 1024 / 1024)} MB of project files, more than can be opened here (${Math.round(opts.maxBytes / 1024 / 1024)} MB).`);
  const data = await download(gh, info.owner.login, info.name, wanted.map((e) => e.sha), opts.onProgress);
  const byPath = new Map<string, string | Uint8Array>();
  const issues: string[] = tooLarge.map((e) => `${e.path}: larger than ${CLONE_FILE_LIMIT / 1024 / 1024} MB, left out`);
  const skipped = tooLarge.map((e) => e.path);
  for (const e of wanted) {
    const bytes = data.get(e.sha)!;
    const role = repoFileRole(e.path);
    if (role === 'asset') {
      byPath.set(e.path, bytes);
      continue;
    }
    try {
      const text = decodeText(e.path, bytes);
      if (role === 'scene') parseSceneFile(e.path, text);
      byPath.set(e.path, text);
    } catch (err) {
      if (role === 'manifest') throw err;
      issues.push(`${err instanceof Error ? err.message : String(err)} — left out`);
      skipped.push(e.path);
    }
  }
  const built = await projectFromFiles(byPath, { id: opts.id, name: info.name });
  for (const p of byPath.keys()) if (repoFileRole(p) === 'script' && built.doc.scripts[p] === undefined) skipped.push(p);
  const link: GitLink = {
    provider: 'github',
    owner: info.owner.login,
    repo: info.name,
    branch,
    commit,
    tree: Object.fromEntries(wanted.map((e) => [e.path, e.sha])),
    ...(Object.keys(built.doc.assets).length ? { assets: Object.fromEntries(Object.values(built.doc.assets).map((a) => [a.path, a.hash])) } : {}),
    ...(wanted.some((e) => e.mode !== '100644') ? { modes: Object.fromEntries(wanted.filter((e) => e.mode !== '100644').map((e) => [e.path, e.mode])) } : {}),
    ...(skipped.length ? { skipped: [...new Set(skipped)].sort() } : {}),
  };
  return { doc: { ...built.doc, git: link }, blobs: built.blobs, issues: [...issues, ...built.issues], fullName: info.full_name, private: info.private };
}

/**
 * Create a GitHub repository for a project that isn't linked to one (GitHub makes a first commit,
 * a README, so the repository has a branch) and return the link to it. Committing then pushes
 * every project file.
 */
export async function createRepoFor(gh: GitHub, p: { name: string; description?: string; private?: boolean; org?: string }): Promise<{ link: GitLink; url?: string; fullName: string }> {
  const r = await gh.createRepo({ name: p.name, description: p.description, private: p.private !== false, auto_init: true, org: p.org });
  const owner = r.owner.login;
  let commit: string | null = null;
  // GitHub makes the first commit asynchronously; wait for the branch to exist.
  for (let i = 0; i < 20 && !commit; i++) {
    commit = await gh.headOrNull(owner, r.name, r.default_branch).catch(() => null);
    if (!commit) await new Promise((res) => setTimeout(res, 500));
  }
  if (!commit) fail('E_GITHUB', `${r.full_name} was created, but its first commit did not appear. Open it with “Open from GitHub”.`);
  return { link: { provider: 'github', owner, repo: r.name, branch: r.default_branch, commit: commit!, tree: {} }, url: r.html_url, fullName: r.full_name };
}

/** Publish an unlinked project: create the repository, link the project and push every file. */
export async function publishProject(gh: GitHub, doc: ProjectDoc, read: AssetReader, p: { name: string; description?: string; private?: boolean; org?: string; message?: string }) {
  if (doc.git) fail('E_ALREADY_LINKED', `This project is already linked to ${doc.git.owner}/${doc.git.repo}.`);
  // Check the assets can be read before creating anything.
  for (const a of Object.values(doc.assets)) await readAssetBytes(read, a);
  const { link, url, fullName } = await createRepoFor(gh, p);
  const linked = applyCommands(doc, [{ op: 'set_git_link', link }]).project;
  const r = await commitAndPush(gh, linked, read, p.message?.trim() || 'First commit from Game Studio');
  return { repository: fullName, url, branch: r.branch, commit: r.commit, files: r.files, link: r.link, commands: r.commands };
}

/** Does the branch the project tracks still exist on GitHub (it may have been deleted after its PR was merged)? */
export async function branchExists(gh: GitHub, link: GitLink): Promise<boolean> {
  return (await gh.headOrNull(link.owner, link.repo, link.branch)) !== null;
}

/** The manifest text a project would have (for tests and diffs). */
export const manifestText = serializeManifest;
