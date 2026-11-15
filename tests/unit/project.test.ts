import { describe, expect, it } from 'vitest';
import { GameStudioError, sha256Hex } from '@gs/shared';
import { ScriptRegistry, instantiateScene, nodeTypes, docNodeByPath } from '@gs/core';
import {
  TEMPLATES,
  applyCommands,
  createProject,
  emptyProjectDoc,
  encodePng,
  exportArchive,
  importArchive,
  loadProjectDoc,
  projectDiagnostics,
  projectRevision,
  readImageSize,
  type Command,
  type ProjectDoc,
} from '@gs/project';

let n = 0;
const ids = () => `n${++n}`;

function base(): ProjectDoc {
  return applyCommands(emptyProjectDoc('Test'), [{ op: 'create_scene', path: 'scenes/main.scene', rootType: 'Node2D', rootName: 'Main' }], { newId: ids }).project;
}

function expectError(fn: () => unknown, code: string, message?: RegExp) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(GameStudioError);
    expect((e as GameStudioError).code).toBe(code);
    if (message) expect((e as Error).message).toMatch(message);
    return e as GameStudioError;
  }
  throw new Error('expected an error');
}

describe('command layer', () => {
  it('adds nested nodes in one batch using $refs and returns their ids', () => {
    const p = base();
    const r = applyCommands(p, [
      { op: 'add_node', scene: 'scenes/main.scene', type: 'CharacterBody2D', name: 'Player', ref: 'p', props: { position: [10, 20] } },
      { op: 'add_node', scene: 'scenes/main.scene', parent: '$p', type: 'CollisionShape2D' },
      { op: 'add_node', scene: 'scenes/main.scene', parent: 'Player', type: 'Sprite2D', name: 'Sprite' },
    ]);
    const root = r.project.scenes['scenes/main.scene'].root;
    expect(root.children![0].name).toBe('Player');
    expect(root.children![0].children!.map((c) => c.type)).toEqual(['CollisionShape2D', 'Sprite2D']);
    expect(r.results[0].id).toBe(r.refs.p);
    expect(r.results[2].path).toBe('Player/Sprite');
    expect(p.scenes['scenes/main.scene'].root.children).toBeUndefined();
  });

  it('is atomic: a failing command leaves the project untouched', () => {
    const p = base();
    const e = expectError(
      () =>
        applyCommands(p, [
          { op: 'add_node', scene: 'scenes/main.scene', type: 'Sprite2D' },
          { op: 'add_node', scene: 'scenes/main.scene', type: 'NoSuchType' },
        ]),
      'E_UNKNOWN_TYPE',
      /Command 2 \(add_node\)/,
    );
    expect((e.details as { index: number }).index).toBe(1);
    expect(p.scenes['scenes/main.scene'].root.children).toBeUndefined();
  });

  it('validates property names, values and resource references', () => {
    const p = base();
    expectError(() => applyCommands(p, [{ op: 'add_node', scene: 'scenes/main.scene', type: 'Sprite2D', props: { colour: '#fff' } }]), 'E_UNKNOWN_PROPERTY', /has no property "colour"/);
    expectError(() => applyCommands(p, [{ op: 'add_node', scene: 'scenes/main.scene', type: 'Sprite2D', props: { position: [1] } }]), 'E_INVALID_VALUE', /\[x, y\]/);
    expectError(() => applyCommands(p, [{ op: 'add_node', scene: 'scenes/main.scene', type: 'Sprite2D', props: { hframes: 0 } }]), 'E_INVALID_VALUE', /≥ 1/);
    expectError(() => applyCommands(p, [{ op: 'add_node', scene: 'scenes/main.scene', type: 'Sprite2D', props: { texture: 'nope.png' } }]), 'E_NOT_FOUND', /Import it first/);
    expectError(() => applyCommands(p, [{ op: 'frobnicate' }]), 'E_INVALID_COMMAND', /unknown op/);
    expectError(() => applyCommands(p, [{ op: 'add_node', scene: 'scenes/main.scene', type: 'Node2D', name: 'a/b' }]), 'E_BAD_NAME');
  });

  it('stores only non-default values and accepts rotationDegrees', () => {
    const p = base();
    const r = applyCommands(p, [
      { op: 'add_node', scene: 'scenes/main.scene', type: 'Node2D', ref: 'a', props: { position: [0, 0], rotationDegrees: 90 } },
      { op: 'add_node', scene: 'scenes/main.scene', type: 'Node3D', ref: 'b', props: { rotationDegrees: [0, 180, 0] } },
    ]);
    const [a, b] = r.project.scenes['scenes/main.scene'].root.children!;
    expect(a.props).toEqual({ rotation: Math.PI / 2 });
    expect((b.props!.rotation as number[])[1]).toBeCloseTo(Math.PI);
  });

  it('auto-suffixes duplicate sibling names like Godot', () => {
    const r = applyCommands(base(), [
      { op: 'add_node', scene: 'scenes/main.scene', type: 'Node2D', name: 'Enemy' },
      { op: 'add_node', scene: 'scenes/main.scene', type: 'Node2D', name: 'Enemy' },
    ]);
    expect(r.results.map((x) => x.name)).toEqual(['Enemy', 'Enemy2']);
  });

  it('keeps the global transform when reparenting if asked', () => {
    const r = applyCommands(base(), [
      { op: 'add_node', scene: 'scenes/main.scene', type: 'Node2D', name: 'A', ref: 'a', props: { position: [100, 0], rotationDegrees: 90 } },
      { op: 'add_node', scene: 'scenes/main.scene', type: 'Node2D', name: 'B', ref: 'b', props: { position: [100, 50] } },
      { op: 'reparent_node', scene: 'scenes/main.scene', node: '$b', parent: '$a', keepGlobalTransform: true },
    ]);
    const b = docNodeByPath(r.project.scenes['scenes/main.scene'], 'A/B')!;
    expect((b.props!.position as number[])[0]).toBeCloseTo(50);
    expect((b.props!.position as number[])[1]).toBeCloseTo(0);
    expect(b.props!.rotation as number).toBeCloseTo(-Math.PI / 2);
    expectError(() => applyCommands(r.project, [{ op: 'reparent_node', scene: 'scenes/main.scene', node: 'A', parent: 'A/B' }]), 'E_CYCLE');
  });

  it('removes nodes with their connections and refuses to remove the root', () => {
    const r = applyCommands(base(), [
      { op: 'add_node', scene: 'scenes/main.scene', type: 'Timer', ref: 't' },
      { op: 'add_node', scene: 'scenes/main.scene', type: 'Node', ref: 'h' },
      { op: 'connect_signal', scene: 'scenes/main.scene', from: '$t', signal: 'timeout', to: '$h', method: 'onTimeout' },
    ]);
    expect(r.project.scenes['scenes/main.scene'].connections).toHaveLength(1);
    expectError(() => applyCommands(r.project, [{ op: 'connect_signal', scene: 'scenes/main.scene', from: 'Timer', signal: 'nope', to: '.', method: 'x' }]), 'E_UNKNOWN_SIGNAL', /timeout/);
    const r2 = applyCommands(r.project, [{ op: 'remove_node', scene: 'scenes/main.scene', node: 'Timer' }]);
    expect(r2.project.scenes['scenes/main.scene'].connections).toBeUndefined();
    expectError(() => applyCommands(r2.project, [{ op: 'remove_node', scene: 'scenes/main.scene', node: '.' }]), 'E_ROOT');
  });

  it('duplicates subtrees with fresh ids', () => {
    const r = applyCommands(base(), [
      { op: 'add_node', scene: 'scenes/main.scene', type: 'StaticBody2D', name: 'Wall', ref: 'w' },
      { op: 'add_node', scene: 'scenes/main.scene', parent: '$w', type: 'CollisionShape2D' },
      { op: 'duplicate_node', scene: 'scenes/main.scene', node: '$w', ref: 'w2' },
    ]);
    const kids = r.project.scenes['scenes/main.scene'].root.children!;
    expect(kids.map((k) => k.name)).toEqual(['Wall', 'Wall2']);
    expect(kids[1].id).not.toBe(kids[0].id);
    expect(kids[1].children![0].id).not.toBe(kids[0].children![0].id);
  });

  it('refuses recursive instancing and scenes in use', () => {
    let p = applyCommands(base(), [
      { op: 'create_scene', path: 'scenes/enemy.scene', rootType: 'Node2D' },
      { op: 'add_node', scene: 'scenes/main.scene', instance: 'scenes/enemy.scene' },
    ]).project;
    expect(p.scenes['scenes/main.scene'].root.children![0]).toMatchObject({ name: 'Enemy', type: 'Node2D', instance: 'scenes/enemy.scene' });
    expectError(() => applyCommands(p, [{ op: 'add_node', scene: 'scenes/enemy.scene', instance: 'scenes/main.scene' }]), 'E_RECURSIVE_SCENE');
    expectError(() => applyCommands(p, [{ op: 'delete_scene', path: 'scenes/enemy.scene' }]), 'E_IN_USE');
    p = applyCommands(p, [{ op: 'rename_path', from: 'scenes/enemy.scene', to: 'scenes/foe.scene' }]).project;
    expect(p.scenes['scenes/main.scene'].root.children![0].instance).toBe('scenes/foe.scene');
  });

  it('updates and clears references when scripts and assets move or go', async () => {
    const png = encodePng(2, 2, new Uint8Array(16).fill(255));
    const hash = await sha256Hex(png);
    let p = applyCommands(base(), [
      { op: 'add_asset', path: 'art/a.png', info: { kind: 'image', mime: 'image/png', size: png.length, hash, width: 2, height: 2 } },
      { op: 'write_script', path: 'scripts/s.ts', source: 'export default class S {}' },
      { op: 'add_node', scene: 'scenes/main.scene', type: 'Sprite2D', name: 'S', script: 'scripts/s.ts', props: { texture: 'art/a.png' } },
      { op: 'set_main_scene', path: 'scenes/main.scene' },
    ]).project;
    p = applyCommands(p, [
      { op: 'rename_path', from: 'art/a.png', to: 'art/b.png' },
      { op: 'rename_path', from: 'scripts/s.ts', to: 'scripts/t.ts' },
    ]).project;
    let s = p.scenes['scenes/main.scene'].root.children![0];
    expect(s.props!.texture).toBe('art/b.png');
    expect(s.script).toBe('scripts/t.ts');
    expectError(() => applyCommands(p, [{ op: 'rename_path', from: 'art/b.png', to: 'art/b.mp3' }]), 'E_BAD_PATH');
    const r = applyCommands(p, [{ op: 'delete_asset', path: 'art/b.png' }, { op: 'delete_script', path: 'scripts/t.ts' }]);
    s = r.project.scenes['scenes/main.scene'].root.children![0];
    expect(s.props!.texture).toBeNull();
    expect(s.script).toBeUndefined();
    expect(r.results.map((x) => x.note)).toEqual(['cleared 1 reference(s)', 'detached from 1 node(s)']);
    expect(projectDiagnostics(r.project).filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('shares untouched scenes between versions (cheap snapshots)', () => {
    const p = applyCommands(base(), [{ op: 'create_scene', path: 'scenes/other.scene', rootType: 'Node3D' }]).project;
    const r = applyCommands(p, [{ op: 'add_node', scene: 'scenes/main.scene', type: 'Node2D' }]);
    expect(r.project.scenes['scenes/other.scene']).toBe(p.scenes['scenes/other.scene']);
    expect(r.project.scenes['scenes/main.scene']).not.toBe(p.scenes['scenes/main.scene']);
    expect(r.changedScenes).toEqual(['scenes/main.scene']);
    expect(projectRevision(r.project)).not.toBe(projectRevision(p));
  });

  it('validates settings patches', () => {
    const p = base();
    const r = applyCommands(p, [{ op: 'update_settings', patch: { display: { width: 640, height: 360 } } }, { op: 'set_input_action', name: 'jump', bindings: [{ type: 'key', code: 'Space' }] }]);
    expect(r.project.settings.display).toMatchObject({ width: 640, height: 360, stretch: 'fit' });
    expect(r.project.settings.input.actions.jump).toHaveLength(1);
    expectError(() => applyCommands(p, [{ op: 'update_settings', patch: { display: { width: -1 } } }]), 'E_INVALID_VALUE', /display.width/);
  });
});

describe('templates', () => {
  for (const t of TEMPLATES) {
    it(`"${t.name}" is valid, error-free and instantiates`, async () => {
      const { doc, blobs } = await createProject('Game', t.id);
      expect(blobs.size).toBe(1);
      const diags = projectDiagnostics(doc);
      expect(diags.filter((d) => d.severity === 'error')).toEqual([]);
      expect(diags.filter((d) => d.severity === 'warning')).toEqual([]);
      expect(loadProjectDoc(JSON.parse(JSON.stringify(doc))).issues).toEqual([]);
      const scene = doc.scenes[doc.settings.mainScene!];
      const problems: string[] = [];
      const root = instantiateScene(scene, { registry: nodeTypes, scripts: new ScriptRegistry(), resources: null, scene: (p) => doc.scenes[p], onProblem: (m) => problems.push(m) });
      expect(root.name).toBe('Main');
    });
  }
});

describe('archives and loading', () => {
  it('round-trips a project with assets', async () => {
    const { doc, blobs } = await createProject('Archive me', '2d-platformer');
    const zip = await exportArchive(doc, async (h) => blobs.get(h));
    const back = await importArchive(zip);
    expect(back.issues).toEqual([]);
    expect(back.doc.id).not.toBe(doc.id);
    expect({ ...back.doc, id: doc.id }).toEqual(doc);
    expect([...back.blobs.keys()]).toEqual([...blobs.keys()]);
  });

  it('refuses newer formats and damaged documents', () => {
    const p = base();
    expectError(() => loadProjectDoc({ ...p, formatVersion: 99 }), 'E_NEWER_FORMAT');
    expectError(() => loadProjectDoc({ ...p, scenes: { 'x.scene': { root: { id: 'bad id!', name: 'X', type: 'Node' } } } }), 'E_BAD_PROJECT', /damaged/);
    expectError(() => loadProjectDoc({ hello: 1 }), 'E_BAD_PROJECT');
  });

  it('rejects things that are not archives', async () => {
    await expect(importArchive(new Uint8Array([1, 2, 3]))).rejects.toMatchObject({ code: 'E_BAD_ARCHIVE' });
  });

  it('encodes PNGs and reads image sizes', () => {
    const png = encodePng(3, 5, new Uint8Array(3 * 5 * 4));
    expect(readImageSize(png)).toEqual({ width: 3, height: 5 });
  });
});

describe('command typing', () => {
  it('exposes every op in the schema', () => {
    const ops: Command['op'][] = ['add_node', 'set_props', 'write_script', 'update_settings'];
    expect(ops).toHaveLength(4);
  });
});
