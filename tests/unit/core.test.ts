import { describe, expect, it } from 'vitest';
import { Color, Mat4, Quaternion, Vector2, Vector3, degToRad, jsonEqual } from '@gs/shared';
import {
  CharacterBody2D,
  Engine,
  Input,
  Node,
  Node2D,
  Node3D,
  PackedScene,
  ResourceLoader,
  ScriptRegistry,
  Sprite2D,
  Timer,
  instantiateScene,
  nodeTypes,
  packScene,
  propToJson,
  type InstantiateOptions,
  type SceneDoc,
} from '@gs/core';

class Recorder extends Node {
  static log: string[] = [];
  override _enterTree() {
    Recorder.log.push(`enter:${this.name}`);
  }
  override _ready() {
    Recorder.log.push(`ready:${this.name}`);
  }
  override _exitTree() {
    Recorder.log.push(`exit:${this.name}`);
  }
}

describe('node lifecycle', () => {
  it('enters parents first, readies children first, exits children first', () => {
    Recorder.log = [];
    const engine = new Engine();
    const a = new Recorder('A');
    const b = new Recorder('B');
    const c = new Recorder('C');
    a.addChild(b);
    b.addChild(c);
    engine.tree.setCurrentScene(a);
    expect(Recorder.log).toEqual(['enter:A', 'enter:B', 'enter:C', 'ready:C', 'ready:B', 'ready:A']);
    Recorder.log = [];
    engine.tree.setCurrentScene(null);
    expect(Recorder.log).toEqual(['exit:C', 'exit:B', 'exit:A']);
    engine.dispose();
  });

  it('runs _ready only once even when reparented', () => {
    Recorder.log = [];
    const engine = new Engine();
    const root = new Node('Root');
    const x = new Recorder('X');
    root.addChild(x);
    engine.tree.setCurrentScene(root);
    const other = new Node('Other');
    root.addChild(other);
    x.reparent(other);
    expect(Recorder.log.filter((l) => l.startsWith('ready'))).toEqual(['ready:X']);
    expect(x.getPath()).toBe('/root/Root/Other/X');
    engine.dispose();
  });

  it('keeps sibling names unique and resolves paths', () => {
    const root = new Node('Root');
    const a = root.addChild(new Node('Enemy'));
    const b = root.addChild(new Node('Enemy'));
    expect(b.name).toBe('Enemy2');
    a.addChild(new Node('Gun'));
    expect(b.getNode('../Enemy/Gun').name).toBe('Gun');
    expect(root.getNodeOrNull('Nope')).toBeNull();
    expect(() => root.getNode('Nope')).toThrow(/not found/);
    expect(() => a.addChild(root)).toThrow();
  });

  it('frees queued nodes at the end of the frame', () => {
    const engine = new Engine();
    const root = new Node('Root');
    const doomed = root.addChild(new Node('Doomed'));
    engine.tree.setCurrentScene(root);
    doomed.queueFree();
    expect(doomed.isInsideTree()).toBe(true);
    engine.step(1 / 60);
    expect(doomed.isFreed()).toBe(true);
    expect(root.getChildCount()).toBe(0);
    engine.dispose();
  });

  it('reports script errors without stopping other nodes', () => {
    const engine = new Engine();
    const logs: string[] = [];
    engine.tree.logged.connect((e) => logs.push(`${e.level}:${e.message}`));
    let ticks = 0;
    class Bad extends Node {
      override _process() {
        throw new Error('boom');
      }
    }
    class Good extends Node {
      override _process() {
        ticks++;
      }
    }
    const root = new Node('Root');
    root.addChild(new Bad('Bad'));
    root.addChild(new Good('Good'));
    engine.tree.setCurrentScene(root);
    engine.step(1 / 60);
    engine.step(1 / 60);
    expect(ticks).toBe(2);
    expect(logs).toEqual(['error:boom']);
    engine.dispose();
  });
});

describe('transforms', () => {
  it('composes 2D transforms through Node2D parents only', () => {
    const p = new Node2D('P');
    p.position = new Vector2(100, 0);
    p.rotation = Math.PI / 2;
    const c = p.addChild(new Node2D('C'));
    c.position = new Vector2(10, 0);
    expect(c.globalPosition.equals(new Vector2(100, 10), 1e-9)).toBe(true);
    c.globalPosition = new Vector2(0, 0);
    expect(c.globalPosition.equals(new Vector2(0, 0), 1e-9)).toBe(true);
    // A plain Node breaks the chain.
    const plain = p.addChild(new Node('Plain'));
    const d = plain.addChild(new Node2D('D'));
    d.position = new Vector2(5, 5);
    expect(d.globalPosition.equals(new Vector2(5, 5))).toBe(true);
  });

  it('round-trips Mat4 compose/decompose with YXZ Euler angles', () => {
    const rot = new Vector3(degToRad(20), degToRad(-35), degToRad(10));
    const m = Mat4.compose(new Vector3(1, 2, 3), rot, new Vector3(2, 1, 0.5));
    const d = m.decompose();
    expect(d.position.equals(new Vector3(1, 2, 3), 1e-9)).toBe(true);
    expect(d.rotation.equals(rot, 1e-9)).toBe(true);
    expect(d.scale.equals(new Vector3(2, 1, 0.5), 1e-9)).toBe(true);
    const q = Quaternion.fromEuler(rot);
    expect(q.toEuler().equals(rot, 1e-9)).toBe(true);
    const back = m.multiply(m.invert());
    expect(back.m.map((v) => Math.round(v * 1e9) / 1e9 + 0)).toEqual(Mat4.identity().m);
  });

  it('keeps the global 3D transform when reparenting', () => {
    const engine = new Engine();
    const root = new Node3D('Root');
    const a = root.addChild(new Node3D('A'));
    a.position = new Vector3(5, 0, 0);
    a.rotation = new Vector3(0, Math.PI / 2, 0);
    const b = root.addChild(new Node3D('B'));
    b.position = new Vector3(0, 1, 0);
    engine.tree.setCurrentScene(root);
    const before = b.globalPosition;
    b.reparent(a);
    expect(b.globalPosition.equals(before, 1e-9)).toBe(true);
    engine.dispose();
  });

  it('points -Z at the target with lookAt', () => {
    const n = new Node3D();
    n.position = new Vector3(0, 0, 5);
    n.lookAt(new Vector3(0, 0, 0));
    expect(n.getForward().equals(new Vector3(0, 0, -1), 1e-9)).toBe(true);
    n.lookAt(new Vector3(5, 0, 5));
    expect(n.getForward().equals(new Vector3(1, 0, 0), 1e-9)).toBe(true);
  });
});

describe('engine loop', () => {
  it('runs fixed physics ticks independent of frame rate', () => {
    const engine = new Engine({ physicsTicksPerSecond: 60 });
    let physics = 0;
    let frames = 0;
    class Counter extends Node {
      override _physicsProcess() {
        physics++;
      }
      override _process() {
        frames++;
      }
    }
    engine.tree.setCurrentScene(new Counter());
    for (let i = 0; i < 30; i++) engine.step(1 / 30);
    expect(frames).toBe(30);
    expect(physics).toBe(60);
    engine.dispose();
  });

  it('fires timers and pauses pausable nodes', () => {
    const engine = new Engine();
    const t = new Timer();
    t.waitTime = 0.5;
    t.autostart = true;
    let fired = 0;
    t.timeout.connect(() => fired++);
    engine.tree.setCurrentScene(t);
    for (let i = 0; i < 60; i++) engine.step(1 / 60);
    expect(fired).toBe(2);
    engine.tree.paused = true;
    for (let i = 0; i < 60; i++) engine.step(1 / 60);
    expect(fired).toBe(2);
    t.processMode = 'always';
    for (let i = 0; i < 60; i++) engine.step(1 / 60);
    expect(fired).toBe(4);
    engine.dispose();
  });

  it('tweens properties with easing and callbacks', () => {
    const engine = new Engine();
    const n = new Node2D();
    engine.tree.setCurrentScene(n);
    let done = false;
    const tw = n.createTween();
    tw.tweenProperty(n, 'position', new Vector2(100, 0), 1);
    tw.tweenCallback(() => (done = true));
    for (let i = 0; i < 30; i++) engine.step(1 / 60);
    expect(n.position.x).toBeGreaterThan(30);
    expect(n.position.x).toBeLessThan(70);
    for (let i = 0; i < 31; i++) engine.step(1 / 60);
    expect(n.position.x).toBeCloseTo(100, 6);
    expect(done).toBe(true);
    engine.dispose();
  });

  it('reports just-pressed actions once per idle frame and once per physics tick', () => {
    const engine = new Engine();
    const seen = { idle: 0, physics: 0 };
    class P extends Node {
      override _process() {
        if (Input.isActionJustPressed('ui_accept')) seen.idle++;
      }
      override _physicsProcess() {
        if (Input.isActionJustPressed('ui_accept')) seen.physics++;
      }
    }
    engine.tree.setCurrentScene(new P());
    Input.feed({ type: 'key', code: 'Space', key: ' ', pressed: true, echo: false });
    for (let i = 0; i < 5; i++) engine.step(1 / 30);
    expect(seen).toEqual({ idle: 1, physics: 1 });
    expect(Input.isActionPressed('ui_accept')).toBe(true);
    Input.feed({ type: 'key', code: 'Space', key: ' ', pressed: false, echo: false });
    engine.step(1 / 60);
    expect(Input.isActionPressed('ui_accept')).toBe(false);
    expect(Input.getVector('ui_left', 'ui_right', 'ui_up', 'ui_down').length()).toBe(0);
    engine.dispose();
  });

  it('moves characters without a physics server by integrating velocity', () => {
    const engine = new Engine();
    class Mover extends CharacterBody2D {
      override _physicsProcess() {
        this.velocity = new Vector2(60, 0);
        this.moveAndSlide();
      }
    }
    const m = new Mover();
    engine.tree.setCurrentScene(m);
    for (let i = 0; i < 60; i++) engine.step(1 / 60);
    expect(m.position.x).toBeCloseTo(60, 6);
    engine.dispose();
  });
});

describe('registry', () => {
  it('has class field defaults that match the registered defaults (no drift)', () => {
    for (const info of nodeTypes.list()) {
      const node = new info.ctor() as unknown as Record<string, unknown>;
      for (const def of nodeTypes.properties(info.name)) {
        const actual = propToJson(def, node[def.name]);
        expect(jsonEqual(actual, def.default), `${info.name}.${def.name}: class has ${JSON.stringify(actual)}, registry ${JSON.stringify(def.default)}`).toBe(true);
      }
    }
  });

  it('reports configuration warnings', () => {
    const w = nodeTypes.warnings({ node: { id: 'a', name: 'Body', type: 'CharacterBody2D' }, parentType: 'Node2D', childTypes: [] });
    expect(w[0]).toMatch(/CollisionShape2D/);
    const s = nodeTypes.warnings({ node: { id: 'b', name: 'Shape', type: 'CollisionShape2D' }, parentType: 'Node2D', childTypes: [] });
    expect(s[0]).toMatch(/direct child/);
    expect(nodeTypes.warnings({ node: { id: 'b', name: 'Shape', type: 'CollisionShape2D' }, parentType: 'StaticBody2D', childTypes: [] })).toEqual([]);
  });
});

describe('scenes', () => {
  const enemy: SceneDoc = {
    root: {
      id: 'e1',
      name: 'Enemy',
      type: 'Node2D',
      props: { position: [10, 20] },
      children: [{ id: 'e2', name: 'Sprite', type: 'Sprite2D', props: { texture: 'art/enemy.png', flipH: true } }],
    },
  };
  const main: SceneDoc = {
    root: {
      id: 'm1',
      name: 'Main',
      type: 'Node2D',
      children: [
        { id: 'm2', name: 'Enemy', type: 'Node2D', instance: 'scenes/enemy.scene', props: { position: [300, 40] } },
        { id: 'm3', name: 'Clock', type: 'Timer', props: { waitTime: 0.25, autostart: true } },
        { id: 'm4', name: 'Hud', type: 'Node', script: 'scripts/hud.ts', scriptProps: { label: 'Score', offset: [4, 5] } },
      ],
    },
    connections: [{ from: 'm3', signal: 'timeout', to: 'm4', method: 'onTick' }],
  };
  const scenes: Record<string, SceneDoc> = { 'scenes/enemy.scene': enemy, 'scenes/main.scene': main };

  function setup() {
    const scripts = new ScriptRegistry();
    class Hud extends Node {
      static exports = ['label', 'offset'];
      label = 'Default';
      offset = new Vector2();
      ticks = 0;
      onTick() {
        this.ticks++;
      }
    }
    scripts.register('scripts/hud.ts', Hud);
    const resources: ResourceLoader = new ResourceLoader(
      { asset: (p) => (p === 'art/enemy.png' ? { path: p, kind: 'image', mime: 'image/png', size: 1, hash: 'x', width: 32, height: 16 } : undefined), scene: (p) => scenes[p] },
      (ps) => instantiateScene(ps.doc, opts, ps.resourcePath),
    );
    const problems: string[] = [];
    const opts: InstantiateOptions = { registry: nodeTypes, scripts, resources, scene: (p: string) => scenes[p], onProblem: (m: string) => problems.push(m) };
    return { opts, scripts, resources, problems };
  }

  it('instantiates nested scenes, scripts, script props and connections', () => {
    const { opts, problems } = setup();
    const engine = new Engine();
    const root = instantiateScene(main, opts, 'scenes/main.scene');
    engine.tree.setCurrentScene(root);
    const e = root.getNode<Node2D>('Enemy');
    expect(e.position.toArray()).toEqual([300, 40]);
    expect(e.sceneFilePath).toBe('scenes/enemy.scene');
    const sprite = e.getNode<Sprite2D>('Sprite');
    expect(sprite.flipH).toBe(true);
    expect(sprite.texture?.width).toBe(32);
    expect(sprite.id).toBe('m2/e2');
    const hud = root.getNode('Hud') as Node & { label: string; offset: Vector2; ticks: number };
    expect(hud.label).toBe('Score');
    expect(hud.offset).toBeInstanceOf(Vector2);
    for (let i = 0; i < 60; i++) engine.step(1 / 60);
    expect(hud.ticks).toBe(4);
    expect(problems).toEqual([]);
    engine.dispose();
  });

  it('builds base types only when scripts are off (editor mode)', () => {
    const { opts } = setup();
    const root = instantiateScene(main, { ...opts, scripts: null }, 'scenes/main.scene');
    const hud = root.getNode('Hud');
    expect(hud.constructor).toBe(Node);
    expect(hud.scriptPath).toBe('scripts/hud.ts');
  });

  it('lets a script extend an ancestor of the node type (like Godot)', () => {
    const { opts, problems } = setup();
    const doc: SceneDoc = { root: { id: 'r', name: 'R', type: 'Sprite2D', script: 'scripts/hud.ts', props: { texture: 'art/enemy.png' }, scriptProps: { label: 'X' } } };
    const n = instantiateScene(doc, opts) as Sprite2D & { label: string; onTick(): void; ticks: number };
    expect(n).toBeInstanceOf(Sprite2D);
    expect(n.typeName).toBe('Sprite2D');
    expect(n.texture?.width).toBe(32);
    expect(n.centered).toBe(true);
    expect(n.label).toBe('X');
    n.onTick();
    expect(n.ticks).toBe(1);
    expect(problems).toEqual([]);
  });

  it('reports a script whose base is not an ancestor of the node type and still builds the node', () => {
    const { opts, scripts, problems } = setup();
    class Spin extends Node3D {}
    scripts.register('scripts/spin.ts', Spin);
    const doc: SceneDoc = { root: { id: 'r', name: 'R', type: 'Sprite2D', script: 'scripts/spin.ts' } };
    const n = instantiateScene(doc, opts);
    expect(n).toBeInstanceOf(Sprite2D);
    expect(problems[0]).toMatch(/extends Node3D, which a Sprite2D is not/);
  });

  it('refuses recursive instancing', () => {
    const { opts } = setup();
    const loop: SceneDoc = { root: { id: 'a', name: 'A', type: 'Node', children: [{ id: 'b', name: 'B', type: 'Node', instance: 'loop.scene' }] } };
    expect(() => instantiateScene(loop, { ...opts, scene: () => loop }, 'loop.scene')).toThrow(/instances itself/);
  });

  it('instantiates PackedScenes from scripts via the resource loader', () => {
    const { resources } = setup();
    const packed = resources.load('scenes/enemy.scene') as PackedScene;
    const a = packed.instantiate<Node2D>();
    const b = packed.instantiate<Node2D>();
    expect(a).not.toBe(b);
    expect(a.position.toArray()).toEqual([10, 20]);
  });

  it('packs a live tree back to a document with only non-default props', () => {
    const root = new Node2D('Main');
    const s = root.addChild(new Sprite2D('Hero'));
    s.position = new Vector2(1, 2);
    s.modulate = Color.fromHex('#ff0000');
    const doc = packScene(root, nodeTypes);
    expect(doc.root.type).toBe('Node2D');
    expect(doc.root.props).toBeUndefined();
    expect(doc.root.children![0]).toMatchObject({ name: 'Hero', type: 'Sprite2D', props: { position: [1, 2], modulate: '#ff0000' } });
  });
});

describe('robustness', () => {
  it('keeps running when the gamepad API throws (blocked by a permissions policy)', () => {
    const engine = new Engine();
    let ticks = 0;
    class T extends Node {
      override _physicsProcess() {
        ticks++;
      }
    }
    engine.tree.setCurrentScene(new T());
    engine.getGamepads = () => {
      throw new Error('Access to the feature "gamepad" is disallowed by permissions policy.');
    };
    for (let i = 0; i < 10; i++) engine.step(1 / 60);
    expect(ticks).toBe(10);
    engine.dispose();
  });
});
