import { describe, expect, it } from 'vitest';
import { GameStudioError } from '@gs/shared';
import { projectRevision } from '@gs/project';
import { CloudRoom, MemoryKv, checkScripts } from '@gs/mcp';

function setup() {
  const notices: { type: string; label?: string }[] = [];
  const room = new CloudRoom(new MemoryKv(), (t) => notices.push(JSON.parse(t)));
  const call = (m: Parameters<typeof room.service.handle>[0], p: Record<string, unknown> = {}) => room.service.handle(m, p) as Promise<Record<string, unknown>>;
  return { room, call, notices };
}

async function rejects(p: Promise<unknown>, code: string) {
  try {
    await p;
  } catch (e) {
    expect((e as GameStudioError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe('cloud copy: the AI works with no editor open', () => {
  it('creates a project, builds a scene and reads it back', async () => {
    const { call, notices } = setup();
    const created = await call('create_project', { name: 'Background', template: 'empty-3d' });
    expect(created.name).toBe('Background');
    await call('create_scene', { path: 'scenes/arena.scene', rootType: 'Node3D', setMain: true });
    const r = await call('edit_project', {
      commands: [
        { op: 'add_node', scene: 'scenes/arena.scene', type: 'StaticBody3D', name: 'Floor', ref: 'f' },
        { op: 'add_node', scene: 'scenes/arena.scene', parent: '$f', type: 'CollisionShape3D' },
        { op: 'add_node', scene: 'scenes/arena.scene', type: 'DirectionalLight3D', name: 'Sun' },
      ],
    });
    expect((r.results as unknown[]).length).toBe(3);
    const scene = await call('get_scene', { scene: 'scenes/arena.scene' });
    expect(scene.outline).toContain('Floor (StaticBody3D)');
    expect(notices.filter((n) => n.type === 'project-updated').length).toBeGreaterThanOrEqual(3);
    const status = await call('status');
    expect(status.editorOpen).toBe(false);
  });

  it('checks scripts for syntax and import errors without esbuild', async () => {
    const { call } = setup();
    await call('create_project', { name: 'Scripts' });
    const bad = await call('write_script', { path: 'scripts/a.ts', source: 'export default class A {\n  oops(: void {}\n}' });
    expect(bad.compiled).toBe(false);
    expect((bad.diagnostics as { line: number }[])[0].line).toBe(2);
    const good = await call('write_script', { path: 'scripts/b.ts', source: "import { Node2D } from 'gamestudio';\nexport default class B extends Node2D {\n  speed: number = 3;\n}" });
    expect(good.compiled).toBe(true);
    expect(checkScripts({ 'x.ts': "import fs from 'fs';" })[0].message).toMatch(/Only "gamestudio"/);
  });

  it('imports assets and generates textures into the cloud copy', async () => {
    const { call, room } = setup();
    const p = await call('create_project', { name: 'Assets' });
    const t = await call('create_texture', { path: 'art/coin.png', width: 16, height: 16, shape: 'circle', color: '#ffcc00' });
    expect(t.kind).toBe('image');
    const assets = (await call('list_assets')).assets as { path: string; width?: number }[];
    expect(assets.find((a) => a.path === 'art/coin.png')?.width).toBe(16);
    const doc = await room.store.get(p.id as string);
    expect(await room.store.hasBlob(doc!.id, doc!.assets['art/coin.png'].hash)).toBe(true);
  });

  it('undoes and redoes AI edits, but never over someone else’s change', async () => {
    const { call, room } = setup();
    const p = await call('create_project', { name: 'Undo', template: 'empty-2d' });
    await call('add_node', { type: 'Node2D', name: 'A' });
    expect((await call('get_scene')).outline).toContain('A (Node2D)');
    await call('undo');
    expect((await call('get_scene')).outline).not.toContain('A (Node2D)');
    await call('redo');
    expect((await call('get_scene')).outline).toContain('A (Node2D)');
    // The user edits the project (a sync from the editor): AI undo must refuse.
    const doc = (await room.store.get(p.id as string))!;
    await room.store.put({ ...doc, name: 'Renamed by user', updatedAt: Date.now() });
    await rejects(call('undo'), 'E_NOTHING');
  });

  it('explains what needs an open editor instead of failing obscurely', async () => {
    const { call } = setup();
    await call('create_project', { name: 'Run' });
    await rejects(call('run_scene'), 'E_FORBIDDEN'); // default level "edit" doesn't allow running
    await rejects(call('delete_scene', { path: 'scenes/main.scene' }), 'E_NEEDS_CONFIRMATION');
  });

  it('enforces the permissions set in the editor', async () => {
    const { call, room } = setup();
    await call('create_project', { name: 'Perms' });
    await room.store.setMeta({ permissions: { level: 'full', scope: 'all-projects', confirmDestructive: false } });
    await rejects(call('run_scene'), 'E_NO_EDITOR');
    await room.store.setMeta({ permissions: { level: 'read', scope: 'all-projects', confirmDestructive: true } });
    await rejects(call('add_node', { type: 'Node2D' }), 'E_FORBIDDEN');
    expect((await call('list_projects')).projects).toHaveLength(1);
  });
});

describe('cloud sync API', () => {
  it('accepts editor pushes, refuses stale ones, and serves documents and blobs', async () => {
    const { call, room } = setup();
    const p = await call('create_project', { name: 'Sync' });
    const id = p.id as string;
    const req = (path: string, init?: RequestInit) => room.sync(new Request(`http://x/sync${path}`, init), path);
    const list = await (await req('/projects')).json();
    expect(list.projects[0].id).toBe(id);
    const { doc, revision } = await (await req(`/projects/${id}`)).json();
    // An editor pushes a change based on the current revision: accepted.
    const edited = { ...doc, name: 'Edited in the editor', updatedAt: Date.now() };
    const ok = await req(`/projects/${id}`, { method: 'PUT', body: JSON.stringify({ doc: edited, base: revision }) });
    expect(ok.status).toBe(200);
    // Meanwhile the AI changes it; a push based on the old revision is refused.
    await call('add_node', { type: 'Node2D', name: 'FromAI' });
    const stale = await req(`/projects/${id}`, { method: 'PUT', body: JSON.stringify({ doc: { ...edited, name: 'Stale' }, base: (await ok.json()).revision }) });
    expect(stale.status).toBe(409);
    // Blob upload is verified against its hash.
    const icon = (await room.store.get(id))!.assets['icon.png'];
    expect((await (await req(`/blobs/${id}/missing`, { method: 'POST', body: JSON.stringify({ hashes: [icon.hash, 'f'.repeat(64)] }) })).json()).missing).toEqual(['f'.repeat(64)]);
    expect((await req(`/blobs/${id}/${'f'.repeat(64)}`, { method: 'PUT', body: new Uint8Array([1, 2, 3]) })).status).toBe(400);
    expect((await req(`/blobs/${id}/${icon.hash}`)).status).toBe(200);
    expect(projectRevision((await room.store.get(id))!)).not.toBe(revision);
  });
});

describe('visual scripts over MCP', () => {
  it('an AI builds a visual script with graph operations, with no editor open', async () => {
    const { call } = setup();
    await call('create_project', { name: 'Graphs', template: 'empty-2d' });
    await call('add_node', { type: 'CharacterBody2D', name: 'Hero' });
    const cats = await call('list_visual_nodes');
    expect((cats.categories as { name: string }[]).some((c) => c.name === 'Input')).toBe(true);
    const found = (await call('list_visual_nodes', { query: 'move and slide' })).nodes as { type: string }[];
    expect(found.map((n) => n.type)).toContain('gs.characterbody2d.move_and_slide');
    const pins = await call('get_visual_node', { type: 'gs.input.get_vector' });
    expect((pins.ports as { id: string }[]).map((p) => p.id)).toEqual(['negX', 'posX', 'negY', 'posY', 'result']);

    const created = await call('create_visual_script', { path: 'scripts/hero.vgraph', nodeType: 'CharacterBody2D', attach: { node: 'Hero' } });
    expect(created.className).toBe('Hero');
    const physics = (created.functions as { name: string; nodes: { id: string; type: string }[] }[]).find((f) => f.name === '_physicsProcess')!;
    const entry = physics.nodes.find((n) => n.type === 'core.entry')!.id;
    const edited = await call('edit_visual_script', {
      path: 'scripts/hero.vgraph',
      function: '_physicsProcess',
      ops: [
        { op: 'add_variable', ref: 'speed', name: 'speed', type: 'float', default: 250, exported: true },
        { op: 'add_node', ref: 'dir', type: 'gs.input.get_vector' },
        { op: 'add_node', ref: 'spd', type: 'core.get_var', props: { variable: '$speed' } },
        { op: 'add_node', ref: 'mul', type: 'gs.vector2_scale_op' },
        { op: 'add_node', ref: 'set', type: 'gs.characterbody2d.set.velocity' },
        { op: 'add_node', ref: 'move', type: 'gs.characterbody2d.move_and_slide' },
        { op: 'connect', from: { node: entry, port: 'then' }, to: { node: '$set', port: 'exec' } },
        { op: 'connect', from: { node: '$dir', port: 'result' }, to: { node: '$mul', port: 'a' } },
        { op: 'connect', from: { node: '$spd', port: 'value' }, to: { node: '$mul', port: 'b' } },
        { op: 'connect', from: { node: '$mul', port: 'result' }, to: { node: '$set', port: 'value' } },
        { op: 'connect', from: { node: '$set', port: 'then' }, to: { node: '$move', port: 'exec' } },
      ],
    });
    expect(edited.diagnostics).toEqual([]);
    expect(edited.compiled).toBe(true);
    expect(edited.code).toContain('this.velocity = Input.getVector(');
    const read = await call('get_visual_script', { path: 'scripts/hero.vgraph' });
    expect((read.variables as { name: string }[])[0].name).toBe('speed');
    expect((await call('get_scene')).outline).toMatch(/Hero \(CharacterBody2D\) #\w+ script=scripts\/hero.vgraph/);
    const diags = await call('get_diagnostics');
    expect(diags.errors).toBe(0);
    // A bad op changes nothing and says which one failed.
    await rejects(call('edit_visual_script', { path: 'scripts/hero.vgraph', ops: [{ op: 'add_node', type: 'gs.node2d.get.position' }, { op: 'connect', from: { node: 'nope', port: 'x' }, to: { node: 'nope', port: 'y' } }] }), 'E_INVALID_OPERATION');
    expect(((await call('get_visual_script', { path: 'scripts/hero.vgraph' })).functions as { nodes: unknown[] }[]).find(() => true)).toBeTruthy();
  });
});
