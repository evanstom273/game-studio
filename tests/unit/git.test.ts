import { describe, expect, it } from 'vitest';
import { GameStudioError, jsonEqual, sha256Hex } from '@gs/shared';
import { applyCommands, createProject, fileUpdatesToCommands, parseManifestFile, parseSceneFile, projectFromFiles, projectTextFiles, repoFileRole, serializeScene, REPO_MANIFEST, type ProjectDoc } from '@gs/project';
import {
  BUILD_BRANCH,
  CLOUDFLARE_WORKFLOW,
  GitHub,
  addWorkflow,
  applyAll,
  ciCall,
  cloneProject,
  cloudflareFiles,
  commitAndPush,
  createBranch,
  deployStatus,
  ensurePages,
  gitBlobHash,
  githubCall,
  merge3,
  parseLogProblems,
  publishBuild,
  publishProject,
  pull,
  revertFiles,
  status,
  switchBranch,
} from '@gs/git';
import { FakeGitHub } from '../fixtures/fake-github';

const SCENE = 'scenes/main.scene';
const PLAYER = 'scripts/player.ts';

/** A project plus an in-memory asset store, like the editor's (IndexedDB) or the cloud's. */
async function sample(name = 'Platformer') {
  const { doc, blobs } = await createProject(name, '2d-platformer');
  const store = new Map(blobs);
  return { doc, store, read: async (h: string) => store.get(h) };
}

async function published(fake = new FakeGitHub()) {
  const s = await sample();
  const gh = new GitHub(fake.fetch);
  const r = await publishProject(gh, s.doc, s.read, { name: 'platformer' });
  const doc = applyAll(s.doc, r.commands);
  return { ...s, gh, fake, doc, full: r.repository };
}

const edit = (doc: ProjectDoc, commands: Parameters<typeof applyCommands>[1]) => applyCommands(doc, commands).project;
async function code(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return (e as GameStudioError).code;
  }
  return 'no error';
}

describe('project ⇄ repository files', () => {
  it('round-trips a project through its files', async () => {
    const { doc, store } = await sample();
    const files = new Map<string, string | Uint8Array>(projectTextFiles(doc));
    for (const a of Object.values(doc.assets)) files.set(a.path, store.get(a.hash)!);
    expect([...files.keys()].sort()).toEqual(['gamestudio.json', 'icon.png', SCENE, PLAYER].sort());
    const back = await projectFromFiles(files, { id: 'p_round', name: 'ignored' });
    expect(back.issues).toEqual([]);
    expect(back.doc.name).toBe(doc.name);
    expect(jsonEqual(back.doc.settings, doc.settings)).toBe(true);
    expect(jsonEqual(back.doc.scenes, doc.scenes)).toBe(true);
    expect(back.doc.scripts).toEqual(doc.scripts);
    expect(back.doc.assets).toEqual(doc.assets);
    expect([...back.blobs.keys()]).toEqual(Object.values(doc.assets).map((a) => a.hash));
    // The same documents give the same files again (canonical text).
    expect(projectTextFiles(back.doc)).toEqual(projectTextFiles(doc));
  });

  it('writes scenes canonically, whatever the key order in memory', () => {
    const a = { root: { id: 'r', name: 'Main', type: 'Node2D', props: { scale: [2, 2], position: [1, 2] }, children: [{ id: 'c', type: 'Sprite2D', name: 'S' }] } };
    const b = { root: { children: [{ name: 'S', id: 'c', type: 'Sprite2D' }], props: { position: [1, 2], scale: [2, 2] }, type: 'Node2D', name: 'Main', id: 'r' } };
    expect(serializeScene(a as never)).toBe(serializeScene(b as never));
    expect(serializeScene(a as never).startsWith('{\n  "root": {\n    "id": "r",\n    "name": "Main",\n    "type": "Node2D"')).toBe(true);
  });

  it('knows which repository files belong to the project', () => {
    expect(repoFileRole(REPO_MANIFEST)).toBe('manifest');
    expect(repoFileRole('levels/one.scene')).toBe('scene');
    expect(repoFileRole('scripts/a.ts')).toBe('script');
    expect(repoFileRole('art/coin.png')).toBe('asset');
    for (const other of ['README.md', 'LICENSE', '.github/workflows/check.yml', '.gitignore', 'node_modules/x/y.js', 'docs/notes.txt']) expect(repoFileRole(other)).toBe('other');
  });

  it('refuses broken and newer files with clear errors', () => {
    expect(() => parseSceneFile('a.scene', '{ "root": ')).toThrow(/a\.scene: not valid JSON/);
    expect(() => parseSceneFile('a.scene', JSON.stringify({ root: { id: 'x', name: 'A', type: 'Node2D', children: [{ id: 'x', name: 'B', type: 'Node2D' }] } }))).toThrow(/used twice/);
    expect(() => parseManifestFile(JSON.stringify({ format: 'game-studio-repo', version: 9, projectFormatVersion: 1, name: 'x', settings: {} }))).toThrow(/newer version/);
  });

  it('orders file changes so the command layer accepts them (instancing scenes are deleted first)', async () => {
    const { doc } = await sample();
    const withInstances = edit(doc, [
      { op: 'create_scene', path: 'scenes/coin.scene', rootType: 'Node2D' },
      { op: 'create_scene', path: 'scenes/row.scene', rootType: 'Node2D' },
      { op: 'add_node', scene: 'scenes/row.scene', instance: 'scenes/coin.scene' },
    ]);
    const { commands, kept } = fileUpdatesToCommands(withInstances, [
      { path: 'scenes/coin.scene', deleted: true },
      { path: 'scenes/row.scene', deleted: true },
    ]);
    expect(kept).toEqual([]);
    expect(commands.map((c) => (c as { path: string }).path)).toEqual(['scenes/row.scene', 'scenes/coin.scene']);
    const after = applyAll(withInstances, commands);
    expect(Object.keys(after.scenes)).toEqual([SCENE]);
    // A scene another remaining scene instances is kept and reported.
    const r = fileUpdatesToCommands(withInstances, [{ path: 'scenes/coin.scene', deleted: true }]);
    expect(r.kept).toEqual(['scenes/coin.scene']);
    expect(r.commands).toEqual([]);
  });
});

describe('three-way merge', () => {
  it('combines non-overlapping edits and marks overlapping ones', () => {
    const base = 'a\nb\nc\nd\ne';
    expect(merge3(base, 'A\nb\nc\nd\ne', 'a\nb\nc\nd\nE')).toEqual({ text: 'A\nb\nc\nd\nE', conflicts: 0 });
    expect(merge3(base, 'a\nb\nX\nd\ne', 'a\nb\nY\nd\ne')).toEqual({ text: 'a\nb\n<<<<<<< yours\nX\n=======\nY\n>>>>>>> GitHub\nd\ne', conflicts: 1 });
  });
});

describe('publish, clone, status, commit', () => {
  it('publishes a project and opens it again from GitHub with nothing to commit', async () => {
    const { doc, fake, gh, full, store } = await published();
    expect(full).toBe('lyra/platformer');
    const files = fake.files('main', full);
    expect(Object.keys(files).sort()).toEqual(['README.md', 'gamestudio.json', 'icon.png', SCENE, PLAYER].sort());
    expect(JSON.parse(files['gamestudio.json'])).toMatchObject({ format: 'game-studio-repo', version: 1, name: 'Platformer' });
    expect(status(doc)).toEqual([]);
    expect(doc.git).toMatchObject({ owner: 'lyra', repo: 'platformer', branch: 'main' });
    expect(fake.bytes('main', 'icon.png', full)).toEqual(store.get(doc.assets['icon.png'].hash));

    const c = await cloneProject(gh, 'lyra', 'platformer', { id: 'p_clone' });
    expect(c.issues).toEqual([]);
    expect(c.doc.id).toBe('p_clone');
    expect(status(c.doc)).toEqual([]);
    expect(jsonEqual(c.doc.scenes, doc.scenes)).toBe(true);
    expect(c.doc.git?.commit).toBe(doc.git?.commit);
    expect([...c.blobs.keys()]).toEqual([doc.assets['icon.png'].hash]);
  });

  it('commits only the changed files and refuses when GitHub moved on', async () => {
    const { doc, fake, gh, full, read, store } = await published();
    let d = edit(doc, [
      { op: 'set_props', scene: SCENE, node: 'Player', props: { position: [100, 200] } },
      { op: 'write_script', path: 'scripts/coin.ts', source: 'export const x = 1;\n' },
    ]);
    expect(status(d).map((c) => `${c.status}:${c.path}`)).toEqual([`modified:${SCENE}`, `added:scripts/coin.ts`]);
    fake.calls = [];
    const r = await commitAndPush(gh, d, read, 'Move the player');
    expect(r.files).toBe(2);
    // Two blobs uploaded (the scene and the new script): the unchanged script, manifest and icon weren't sent.
    expect(fake.calls.filter((c) => c === `POST /repos/${full}/git/blobs`)).toHaveLength(2);
    d = applyAll(d, r.commands);
    expect(status(d)).toEqual([]);
    expect(fake.files('main', full)['scripts/coin.ts']).toBe('export const a = 1;\n'.replace('a', 'x'));
    expect(JSON.parse(fake.files('main', full)[SCENE]).root.children.find((n: { name: string }) => n.name === 'Player').props.position).toEqual([100, 200]);

    // Someone pushes from elsewhere: committing now would not be a fast-forward.
    fake.push('main', { 'README.md': '# changed elsewhere\n' }, 'remote', full);
    d = edit(d, [{ op: 'rename_project', name: 'Renamed' }]);
    expect(await code(commitAndPush(gh, d, read, 'Rename'))).toBe('E_NOT_FAST_FORWARD');

    // A new asset is uploaded once; deleting it is a commit too.
    const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 4, 0, 0, 0, 4, 8, 6, 0, 0, 0]);
    const hash = await sha256Hex(png);
    store.set(hash, png);
    const p = await pull(gh, d, read);
    d = p.doc;
    d = edit(d, [{ op: 'add_asset', path: 'art/dot.png', info: { kind: 'image', mime: 'image/png', size: png.length, hash, width: 4, height: 4 } }]);
    const r2 = await commitAndPush(gh, d, read, 'Add a dot');
    expect(fake.bytes('main', 'art/dot.png', full)).toEqual(png);
    expect(fake.files('main', full)['README.md']).toBe('# changed elsewhere\n');
    d = applyAll(d, r2.commands);
    expect(status(d)).toEqual([]);
  });

  it('asks for the exact number before deleting many files, and can commit to a new branch', async () => {
    const { doc, gh, read, fake, full } = await published();
    const commands = Array.from({ length: 11 }, (_, i) => ({ op: 'write_script' as const, path: `scripts/s${i}.ts`, source: `export const n = ${i};\n` }));
    let d = applyAll(doc, commands);
    d = applyAll(d, (await commitAndPush(gh, d, read, 'Many scripts')).commands);
    const gone = applyAll(d, commands.map((c) => ({ op: 'delete_script' as const, path: c.path })));
    await expect(commitAndPush(gh, gone, read, 'Oops')).rejects.toMatchObject({ code: 'E_MASS_DELETE', details: { deletions: 11 } });
    const r = await commitAndPush(gh, gone, read, 'Delete them', { confirmDeletions: 11, newBranch: 'cleanup' });
    expect(r.branch).toBe('cleanup');
    expect(Object.keys(fake.files('cleanup', full)).filter((p) => p.startsWith('scripts/s'))).toEqual([]);
    expect(Object.keys(fake.files('main', full)).filter((p) => p.startsWith('scripts/s'))).toHaveLength(11);
    expect(await code(commitAndPush(gh, gone, read, 'Again', { newBranch: 'cleanup', confirmDeletions: 11 }))).toBe('E_BRANCH_EXISTS');
  });
});

describe('pull', () => {
  it('takes remote-only changes, merges scripts line by line, and leaves non-project files alone', async () => {
    const { doc, fake, gh, full, read } = await published();
    const remoteScript = doc.scripts[PLAYER].replace('speed = 320;', 'speed = 400;');
    fake.push('main', { [PLAYER]: remoteScript, 'scripts/enemy.ts': 'export default 1;\n', 'README.md': '# Docs\n' }, 'remote', full);
    // Locally, a different line of the same script and a scene change.
    let d = edit(doc, [
      { op: 'write_script', path: PLAYER, source: doc.scripts[PLAYER].replace('gravity = 1600;', 'gravity = 1800;') },
      { op: 'set_props', scene: SCENE, node: 'Player', props: { position: [10, 10] } },
    ]);
    const r = await pull(gh, d, read);
    expect(r.upToDate).toBe(false);
    expect(r.merged).toEqual([PLAYER]);
    expect(r.updated).toEqual(['scripts/enemy.ts']);
    expect(r.conflicts).toEqual([]);
    d = r.doc;
    expect(d.scripts[PLAYER]).toContain('speed = 400;');
    expect(d.scripts[PLAYER]).toContain('gravity = 1800;');
    expect(d.scripts['scripts/enemy.ts']).toBe('export default 1;\n');
    // Only the local scene change and the merged script are left to commit.
    expect(status(d).map((c) => c.path)).toEqual([SCENE, PLAYER]);
    expect(d.git?.commit).toBe(fake.repo(full).refs.get('main'));
    expect((await pull(gh, d, read)).upToDate).toBe(true);
  });

  it('marks overlapping script changes, merges compatible scene changes, and keeps local scenes when a merge would break them', async () => {
    const { doc, fake, gh, full, read } = await published();
    const base = doc.scenes[SCENE];
    // Remote: change the camera's zoom (another node) and a line of the script.
    const remoteScene = structuredClone(base);
    const remoteFloor = remoteScene.root.children!.find((n) => n.name === 'Floor')!;
    remoteFloor.groups = ['floor'];
    fake.push('main', { [SCENE]: serializeScene(remoteScene), [PLAYER]: doc.scripts[PLAYER].replace('speed = 320;', 'speed = 999;') }, 'remote', full);
    // Local: change the player (a different part of the scene) and the same script line.
    let d = edit(doc, [
      { op: 'set_script_props', scene: SCENE, node: 'Player', values: { speed: 500 } },
      { op: 'write_script', path: PLAYER, source: doc.scripts[PLAYER].replace('speed = 320;', 'speed = 111;') },
    ]);
    const r = await pull(gh, d, read);
    expect(r.merged).toEqual([SCENE]);
    expect(r.conflicts).toEqual([{ path: PLAYER, kind: 'text', reason: expect.stringContaining('conflict markers') }]);
    d = r.doc;
    expect(d.scripts[PLAYER]).toContain('<<<<<<< yours\n  speed = 111;\n=======\n  speed = 999;\n>>>>>>> GitHub');
    const player = d.scenes[SCENE].root.children!.find((n) => n.name === 'Player')!;
    expect(player.scriptProps).toEqual({ speed: 500 });
    expect(d.scenes[SCENE].root.children!.find((n) => n.name === 'Floor')!.groups).toEqual(['floor']);

    // Both sides now change the same property of the same node: the local scene is kept and reported.
    const again = structuredClone(d.scenes[SCENE]);
    again.root.children!.find((n) => n.name === 'Floor')!.groups = ['remote'];
    fake.push('main', { [SCENE]: serializeScene(again) }, 'remote 2', full);
    d = edit(d, [{ op: 'set_groups', scene: SCENE, node: 'Floor', groups: ['local'] }]);
    const r2 = await pull(gh, d, read);
    expect(r2.conflicts).toEqual([{ path: SCENE, kind: 'json', reason: expect.stringContaining('your version was kept') }]);
    expect(r2.doc.scenes[SCENE].root.children!.find((n) => n.name === 'Floor')!.groups).toEqual(['local']);
    // Committing now keeps ours on GitHub (a fast-forward, since the pull moved the base).
    const c = await commitAndPush(gh, r2.doc, read, 'Keep local floor');
    expect(JSON.parse(fake.files('main', full)[SCENE]).root.children.find((n: { name: string }) => n.name === 'Floor').groups).toEqual(['local']);
    expect(c.files).toBeGreaterThan(0);
  });

  it('refuses a merge that would not be valid JSON, takes new assets, deletes removed scenes, skips invalid remote scenes', async () => {
    const { doc, fake, gh, full, read } = await published();
    // Make a second scene and publish it.
    let d = edit(doc, [{ op: 'create_scene', path: 'scenes/extra.scene', rootType: 'Node2D' }]);
    d = applyAll(d, (await commitAndPush(gh, d, read, 'extra')).commands);
    // Remote: valid JSON edit near the end of the manifest, a new asset, the extra scene deleted, and a broken new scene.
    const manifest = JSON.parse(fake.files('main', full)['gamestudio.json']);
    manifest.settings.display.width = 1280;
    const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 2, 0, 0, 0, 3, 8, 6, 0, 0, 0]);
    fake.push('main', { 'gamestudio.json': `${JSON.stringify(manifest, null, 2)}\n`, 'art/new.png': png, 'scenes/extra.scene': null, 'scenes/broken.scene': '{ nope' }, 'remote', full);
    // Local: the same manifest line changed differently.
    d = edit(d, [{ op: 'update_settings', patch: { display: { width: 800 } } }]);
    const r = await pull(gh, d, read);
    expect(r.conflicts).toEqual(
      expect.arrayContaining([
        { path: 'gamestudio.json', kind: 'json', reason: expect.any(String) },
        { path: 'scenes/broken.scene', kind: 'invalid', reason: expect.stringContaining('not valid JSON') },
      ]),
    );
    expect(r.doc.settings.display.width).toBe(800);
    expect(r.doc.scenes['scenes/extra.scene']).toBeUndefined();
    expect(r.doc.assets['art/new.png']).toMatchObject({ kind: 'image', width: 2, height: 3, size: png.length });
    expect(r.blobs.get(r.doc.assets['art/new.png'].hash)?.data).toEqual(png);
    // The broken remote scene isn't in the project and isn't shown as deleted either: it's left for GitHub to fix.
    expect(status(r.doc).map((c) => c.path)).toEqual(['gamestudio.json']);
    expect(r.doc.git?.skipped).toEqual(['scenes/broken.scene']);
    // Once it is fixed on GitHub, the next pull brings it in.
    fake.push('main', { 'scenes/broken.scene': serializeScene({ root: { id: 'fixed', name: 'Fixed', type: 'Node2D' } }) }, 'fix', full);
    const r3 = await pull(gh, r.doc, read);
    expect(r3.doc.scenes['scenes/broken.scene'].root.name).toBe('Fixed');
    expect(r3.doc.git?.skipped).toBeUndefined();
  });

  it('switches branches keeping local changes, and can use GitHub\'s version of a file', async () => {
    const { doc, fake, gh, full, read } = await published();
    const head = fake.repo(full).refs.get('main')!;
    fake.repo(full).refs.set('feature', head);
    fake.push('feature', { 'scripts/feature.ts': 'export const f = 1;\n', [PLAYER]: '// feature version\n' }, 'feature work', full);
    let d = edit(doc, [{ op: 'write_script', path: PLAYER, source: '// mine\n' }, { op: 'rename_project', name: 'Local name' }]);
    const s = await switchBranch(gh, d, 'feature', read);
    expect(s.from).toBe('main');
    expect(s.link.branch).toBe('feature');
    expect(s.updated).toEqual(['scripts/feature.ts']);
    expect(s.kept).toEqual([PLAYER]);
    d = s.doc;
    expect(d.scripts[PLAYER]).toBe('// mine\n');
    expect(d.name).toBe('Local name');
    expect(status(d).map((c) => c.path).sort()).toEqual(['gamestudio.json', PLAYER]);
    const back = await revertFiles(gh, d, [PLAYER]);
    expect(back.doc.scripts[PLAYER]).toBe('// feature version\n');

    const b = await createBranch(gh, back.doc, 'experiment');
    expect(b.doc?.git?.branch).toBe('experiment');
    expect(fake.repo(full).refs.get('experiment')).toBe(fake.repo(full).refs.get('feature'));
    expect(await code(createBranch(gh, back.doc, 'bad..name'))).toBe('E_INVALID');
  });
});

describe('pull requests and repositories', () => {
  it('opens, lists, edits, merges (deleting the branch) and refuses conflicting pull requests', async () => {
    const { doc, gh, read, fake, full } = await published();
    let d = edit(doc, [{ op: 'write_script', path: PLAYER, source: '// v2\n' }]);
    const c = await commitAndPush(gh, d, read, 'v2', { newBranch: 'feature' });
    d = applyAll(d, c.commands);
    const link = d.git!;
    expect(await code(githubCall('git_create_pr', gh, { head: 'main' }, { ...link, branch: 'main' }))).toBe('E_INVALID');
    const pr = (await githubCall('git_create_pr', gh, { title: 'Version 2', body: 'why' }, link)) as { number: number; base: string };
    expect(pr).toMatchObject({ number: 1, base: 'main' });
    expect(((await githubCall('git_pr_list', gh, {}, link)) as { pull_requests: unknown[] }).pull_requests).toMatchObject([{ number: 1, title: 'Version 2', head: 'feature', base: 'main', state: 'open', mergeable: true }]);
    expect(await githubCall('git_pr_update', gh, { number: 1, title: 'Version two' }, link)).toMatchObject({ title: 'Version two' });
    expect(await githubCall('git_pr_get', gh, { number: 1 }, link)).toMatchObject({ number: 1, files: [{ path: SCENE }] });
    expect(await githubCall('git_pr_merge', gh, { number: 1, method: 'squash', delete_branch: true }, link)).toMatchObject({ merged: true, into: 'main', deleted_branch: 'feature', method: 'squash' });
    expect(fake.files('main', full)[PLAYER]).toBe('// v2\n');
    expect(fake.repo(full).refs.has('feature')).toBe(false);
    expect(await githubCall('git_pr_merge', gh, { number: 1 }, link)).toMatchObject({ merged: true, already: true });

    fake.repo(full).refs.set('other', fake.repo(full).refs.get('main')!);
    await githubCall('git_create_pr', gh, { head: 'other' }, link);
    fake.repo(full).pulls[1].conflict = true;
    expect(await code(githubCall('git_pr_merge', gh, { number: 2 }, link))).toBe('E_MERGE_CONFLICT');
    await githubCall('git_pr_update', gh, { number: 2, state: 'closed' }, link);
    expect(((await githubCall('git_pr_list', gh, {}, link)) as { pull_requests: unknown[] }).pull_requests).toEqual([]);
  });

  it('creates, renames and deletes repositories (deleting needs the exact name and a yes)', async () => {
    const fake = new FakeGitHub();
    const gh = new GitHub(fake.fetch);
    expect(await code(githubCall('git_repo_create', gh, { name: 'bad name!' }, null))).toBe('E_INVALID');
    expect(await githubCall('git_repo_create', gh, { name: 'new-game', description: 'A game' }, null)).toMatchObject({ repository: 'lyra/new-game', private: true, default_branch: 'main' });
    expect(await githubCall('git_repo_create', gh, { name: 'team-game', org: 'studio' }, null)).toMatchObject({ repository: 'studio/team-game' });
    expect(await githubCall('git_repo_update', gh, { repository: 'lyra/new-game', name: 'better-game', private: false, description: 'Renamed' }, null)).toMatchObject({ repository: 'lyra/better-game', private: false, description: 'Renamed' });
    expect(await code(githubCall('git_repo_delete', gh, { repository: 'lyra/better-game' }, null))).toBe('E_CONFIRM');
    expect(await code(githubCall('git_repo_delete', gh, { repository: 'lyra/better-game', confirm_name: 'lyra/better-game' }, null, async () => false))).toBe('E_DECLINED');
    expect(fake.repos.has('lyra/better-game')).toBe(true);
    expect(await githubCall('git_repo_delete', gh, { repository: 'lyra/better-game', confirm_name: 'lyra/better-game' }, null, async () => true)).toEqual({ deleted: 'lyra/better-game' });
    expect(fake.repos.has('lyra/better-game')).toBe(false);
    expect(await code(githubCall('git_pr_list', gh, {}, null))).toBe('E_NOT_LINKED');
    expect(await code(githubCall('git_pr_list', gh, { repository: 'not a repo' }, null))).toBe('E_INVALID');
    // Every branch, past GitHub's 100-per-page limit.
    for (let i = 0; i < 130; i++) fake.repo('lyra/game').refs.set(`b${String(i).padStart(3, '0')}`, '0'.repeat(40));
    fake.repo('lyra/game').refs.set('main', '0'.repeat(40));
    const branches = await gh.branches('lyra', 'game');
    expect(branches).toHaveLength(131);
    expect(branches.some((b) => b.name === 'main')).toBe(true);
  });
});

describe('GitHub Actions', () => {
  it('adds the check workflow as its own commit and keeps the project in step', async () => {
    const { doc, gh, fake, full } = await published();
    const r = await addWorkflow(gh, doc, 'check');
    expect(r.added).toEqual(['.github/workflows/check.yml']);
    expect(fake.files('main', full)['.github/workflows/check.yml']).toContain('esbuild@');
    expect(r.doc?.git?.commit).toBe(fake.repo(full).refs.get('main'));
    expect(status(r.doc!)).toEqual([]);
    expect((await addWorkflow(gh, r.doc!, 'check')).already).toBe(true);
    expect(await code(addWorkflow(gh, doc, 'cloudflare'))).toBe('E_NO_BUILD');
    expect(await code(addWorkflow(gh, doc, 'nope'))).toBe('E_INVALID');
  });

  it('lists workflows and runs, starts and re-runs them, and links log problems to project files', async () => {
    const { doc, gh, fake, full } = await published();
    const r = await addWorkflow(gh, doc, 'check');
    const link = r.doc!.git!;
    const has = (p: string) => p === PLAYER || p === SCENE;
    const st = (await ciCall('ci_status', gh, link, {}, has)) as { workflows: { path: string }[]; runs: unknown[] };
    expect(st.workflows.map((w) => w.path)).toEqual(['.github/workflows/check.yml']);
    await ciCall('ci_run', gh, link, {}, has);
    expect(fake.dispatches).toEqual([{ repo: full, workflow: '.github/workflows/check.yml', ref: 'main' }]);
    const run = fake.repo(full).runs[0];
    const log = ['2026-01-01T10:00:00.0000000Z ✘ [ERROR] Expected ";" but found "x"', '', `2026-01-01T10:00:00.0000000Z     ${PLAYER}:3:8:`, `2026-01-01T10:00:01.0000000Z ${SCENE}:4:5: error Unexpected token`, '2026-01-01T10:00:02.0000000Z ##[error]Process completed with exit code 1.'].join('\n');
    fake.finish(run.id, 'failure', log, full);
    const details = (await ciCall('ci_run_details', gh, link, { run_id: run.id }, has)) as { state: string; jobs: { failed_steps: string[] }[] };
    expect(details.state).toBe('failed');
    expect(details.jobs[0].failed_steps).toEqual(['Scripts compile']);
    const logs = (await ciCall('ci_logs', gh, link, { run_id: run.id }, has)) as { jobs: { problems: { file?: string; line?: number; message: string }[] }[] };
    expect(logs.jobs[0].problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: PLAYER, line: 3, column: 8, message: 'Expected ";" but found "x"' }),
        expect.objectContaining({ file: SCENE, line: 4, message: 'Unexpected token' }),
        expect.objectContaining({ message: 'Process completed with exit code 1.' }),
      ]),
    );
    await ciCall('ci_rerun', gh, link, { run_id: run.id }, has);
    expect(fake.repo(full).runs[0].status).toBe('in_progress');
    expect(parseLogProblems('node_modules/x/index.js:1:1 Error', has)).toEqual([]);
  });
});

describe('deploying the web build', () => {
  const build = (extra = '') => [
    { path: 'index.html', data: new TextEncoder().encode(`<!doctype html><title>Game</title>${extra}`) },
    { path: 'game.js', data: new TextEncoder().encode('console.log(1)') },
    { path: 'runtime/gs-runtime.js', data: new TextEncoder().encode('/* engine */') },
  ];

  it('publishes to the build branch, uploads only what changed, and turns on GitHub Pages', async () => {
    const fake = new FakeGitHub();
    fake.repo().private = false;
    fake.push('main', { 'gamestudio.json': '{}' });
    const gh = new GitHub(fake.fetch);
    const first = await publishBuild(gh, 'lyra', 'game', build(), { name: 'Game', source: 'main @ abc1234' });
    expect(first).toMatchObject({ branch: BUILD_BRANCH, created: true, unchanged: false });
    expect(Object.keys(fake.files(BUILD_BRANCH)).sort()).toEqual(['README.md', 'docs/.nojekyll', 'docs/game.js', 'docs/index.html', 'docs/runtime/gs-runtime.js']);
    const pages = await ensurePages(gh, 'lyra', 'game');
    expect(pages).toMatchObject({ url: 'https://lyra.github.io/game/', changed: true });
    expect(fake.repo().pages?.source).toEqual({ branch: BUILD_BRANCH, path: '/docs' });
    // Same build again: nothing to do. A changed build: only the changed file is uploaded, old files go.
    expect((await publishBuild(gh, 'lyra', 'game', build(), { name: 'Game', source: 'main @ abc1234' })).unchanged).toBe(true);
    fake.calls = [];
    const next = build('<p>v2</p>').filter((f) => f.path !== 'game.js');
    const second = await publishBuild(gh, 'lyra', 'game', next, { name: 'Game', source: 'main @ def5678' });
    expect(fake.calls.filter((c) => c.endsWith('/git/blobs') && c.startsWith('POST'))).toHaveLength(2); // index.html + README.md
    expect(second.unchanged).toBe(false);
    expect(fake.files(BUILD_BRANCH)['docs/game.js']).toBeUndefined();
    expect(fake.files('main')).toEqual({ 'gamestudio.json': '{}' });
    expect((await ensurePages(gh, 'lyra', 'game')).changed).toBe(false);
    const st = await deployStatus(gh, 'lyra', 'game');
    expect(st).toMatchObject({ exists: true, pages: { enabled: true, serves_build: true }, cloudflare: { workflow: false } });
  });

  it('adds the Cloudflare workflow and Wrangler config next to the build and keeps them on later deploys', async () => {
    const fake = new FakeGitHub();
    const gh = new GitHub(fake.fetch);
    await publishBuild(gh, 'lyra', 'game', build(), { name: 'Game', source: 'x', extra: cloudflareFiles('My Game!') });
    const files = fake.files(BUILD_BRANCH);
    expect(files['wrangler.jsonc']).toContain('"name": "my-game"');
    expect(files['wrangler.jsonc']).toContain('"directory": "./docs"');
    expect(files[CLOUDFLARE_WORKFLOW]).toContain('branches: ["gh-pages"]');
    expect(files[CLOUDFLARE_WORKFLOW]).toContain('${{ secrets.CLOUDFLARE_API_TOKEN }}');
    await publishBuild(gh, 'lyra', 'game', build('again'), { name: 'Game', source: 'y' });
    expect(Object.keys(fake.files(BUILD_BRANCH))).toEqual(expect.arrayContaining([CLOUDFLARE_WORKFLOW, 'wrangler.jsonc']));
    // A private repository on a free plan can't have Pages: GitHub's reason is passed on.
    await expect(ensurePages(gh, 'lyra', 'game')).rejects.toMatchObject({ code: 'E_GITHUB_REJECTED', message: expect.stringContaining('plan does not support') });
  });

  it('hashes files exactly like git', () => {
    expect(gitBlobHash('')).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
    expect(gitBlobHash('hello\n')).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });
});
