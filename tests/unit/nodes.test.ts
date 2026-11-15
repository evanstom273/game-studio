/** Logic of the extended node set, headless (no renderer, no physics server unless stated). */
import { describe, expect, it } from 'vitest';
import { Color, Transform2D, Vector2, Vector3 } from '@gs/shared';
import {
  AnimationPlayer,
  AudioStreamPlayer2D,
  AudioStreamPlayer3D,
  Button,
  CPUParticles2D,
  CPUParticles3D,
  Camera2D,
  Camera3D,
  CanvasLayer,
  CenterContainer,
  ColorRect,
  Control,
  Engine,
  HBoxContainer,
  Input,
  Label,
  MarginContainer,
  Node,
  Node2D,
  Node3D,
  Parallax2D,
  Path2D,
  Path3D,
  PathFollow2D,
  PathFollow3D,
  ProgressBar,
  TileMapLayer,
  VBoxContainer,
  VisibleOnScreenNotifier2D,
  VisibleOnScreenNotifier3D,
  attenuation2D,
  attenuationDb3D,
  instantiateScene,
  nodeTypes,
  packScene,
  sampleTrack,
  validateAnimationLibrary,
  validatePropValue,
  validateTileCells,
  type InputEvent,
} from '@gs/core';

const step = (engine: Engine, seconds: number, dt = 1 / 60) => {
  for (let t = 0; t < seconds - 1e-9; t += dt) engine.step(dt);
};

describe('CPUParticles2D', () => {
  it('emits evenly over the lifetime, kills particles at the end of their life and keeps a steady count', () => {
    const p = new CPUParticles2D();
    p.amount = 10;
    p.lifetime = 1;
    p.gravity = new Vector2(0, 0);
    p.simulate(0.25);
    // Phases 0, 0.1, 0.2 have come up.
    expect(p.getParticleCount()).toBe(3);
    p.simulate(0.5);
    expect(p.getParticleCount()).toBe(8);
    for (let i = 0; i < 60; i++) p.simulate(1 / 30);
    // Steady state: every slot is re-emitted as it dies.
    expect(p.getParticleCount()).toBeGreaterThanOrEqual(9);
  });

  it('bursts with explosiveness 1, moves particles with velocity and gravity, and finishes one-shots', () => {
    const p = new CPUParticles2D();
    p.amount = 20;
    p.lifetime = 0.5;
    p.explosiveness = 1;
    p.oneShot = true;
    p.direction = new Vector2(1, 0);
    p.spread = 0;
    p.initialVelocityMin = p.initialVelocityMax = 100;
    p.gravity = new Vector2(0, 0);
    let finished = 0;
    p.finished.connect(() => finished++);
    p.simulate(0.1);
    expect(p.getParticleCount()).toBe(20);
    // All moved ~10 px right of the emitter.
    for (let i = 0; i < 20; i++) {
      expect(p.sim.pos[i * 2]).toBeCloseTo(10, 3);
      expect(p.sim.pos[i * 2 + 1]).toBeCloseTo(0, 6);
    }
    for (let i = 0; i < 30; i++) p.simulate(1 / 30);
    expect(p.getParticleCount()).toBe(0);
    expect(p.emitting).toBe(false);
    expect(finished).toBe(1);
    // Turning it back on restarts the burst.
    p.emitting = true;
    p.simulate(0.01);
    expect(p.getParticleCount()).toBe(20);
  });

  it('keeps particles in world space unless localCoords is on, and spreads within the cone', () => {
    const p = new CPUParticles2D();
    p.amount = 50;
    p.explosiveness = 1;
    p.lifetime = 5;
    p.spread = 30;
    p.initialVelocityMin = p.initialVelocityMax = 100;
    p.gravity = new Vector2(0, 0);
    p.position = new Vector2(500, 0);
    p.simulate(0.01);
    p.position = new Vector2(0, 0);
    p.simulate(0.01);
    for (let i = 0; i < 50; i++) {
      const x = p.sim.pos[i * 2] - 500;
      const y = p.sim.pos[i * 2 + 1];
      expect(x).toBeGreaterThan(1);
      expect(Math.abs(Math.atan2(y, x))).toBeLessThanOrEqual((30 * Math.PI) / 180 + 1e-6);
    }
    const local = new CPUParticles2D();
    local.localCoords = true;
    local.explosiveness = 1;
    local.gravity = new Vector2(0, 0);
    local.position = new Vector2(500, 0);
    local.simulate(0.01);
    // Local coordinates: positions are relative to the emitter.
    expect(Math.abs(local.sim.pos[0])).toBeLessThan(1);
  });

  it('simulates in the engine loop and accelerates particles with gravity (3D)', () => {
    const engine = new Engine();
    const root = new Node3D();
    const p = root.addChild(new CPUParticles3D());
    p.amount = 4;
    p.explosiveness = 1;
    p.lifetime = 2;
    engine.tree.setCurrentScene(root);
    step(engine, 1);
    expect(p.getParticleCount()).toBe(4);
    // Free fall under -9.8 m/s² for ~1 s: y ≈ -4.9.
    expect(p.sim.pos[1]).toBeLessThan(-4.5);
    expect(p.sim.pos[1]).toBeGreaterThan(-5.2);
    engine.dispose();
  });
});

describe('paths', () => {
  it('follows a Path2D by distance, wraps when looping and faces along the path', () => {
    const path = new Path2D();
    path.points = [new Vector2(0, 0), new Vector2(100, 0), new Vector2(100, 100)];
    const f = path.addChild(new PathFollow2D());
    expect(path.getBakedLength()).toBeCloseTo(200);
    f.progress = 50;
    expect(f.globalPosition.x).toBeCloseTo(50);
    expect(f.rotation).toBeCloseTo(0);
    f.progress = 150;
    expect(f.globalPosition.x).toBeCloseTo(100);
    expect(f.globalPosition.y).toBeCloseTo(50);
    expect(f.rotation).toBeCloseTo(Math.PI / 2);
    f.progress = 250;
    expect(f.progress).toBeCloseTo(50);
    f.progressRatio = 0.5;
    expect(f.progress).toBeCloseTo(100);
    f.loop = false;
    f.progress = 999;
    expect(f.progress).toBeCloseTo(200);
    expect(f.globalPosition.y).toBeCloseTo(100);
    // Children follow.
    const child = f.addChild(new Node2D());
    child.position = new Vector2(10, 0);
    expect(child.globalPosition.x).toBeCloseTo(100);
    expect(child.globalPosition.y).toBeCloseTo(110);
  });

  it('closes and smooths paths', () => {
    const path = new Path2D();
    path.points = [new Vector2(0, 0), new Vector2(100, 0), new Vector2(100, 100), new Vector2(0, 100)];
    path.closed = true;
    expect(path.getBakedLength()).toBeCloseTo(400);
    path.curved = true;
    const len = path.getBakedLength();
    // A smoothed loop through the corners is a bit shorter than… no: it bulges between them; just sane.
    expect(len).toBeGreaterThan(300);
    expect(len).toBeLessThan(500);
    const p = path.samplePosition(len / 2);
    expect(p.distanceTo(new Vector2(100, 100))).toBeLessThan(40);
  });

  it('follows a Path3D with -Z facing along it', () => {
    const path = new Path3D();
    path.points = [new Vector3(0, 0, 0), new Vector3(0, 0, -10), new Vector3(10, 0, -10)];
    const f = path.addChild(new PathFollow3D());
    f.progress = 5;
    expect(f.globalPosition.equals(new Vector3(0, 0, -5), 1e-6)).toBe(true);
    expect(f.getForward().equals(new Vector3(0, 0, -1), 1e-6)).toBe(true);
    f.progress = 15;
    expect(f.globalPosition.equals(new Vector3(5, 0, -10), 1e-6)).toBe(true);
    expect(f.getForward().equals(new Vector3(1, 0, 0), 1e-6)).toBe(true);
    f.rotationMode = 'y';
    f.progress = 15;
    expect(f.getForward().equals(new Vector3(1, 0, 0), 1e-6)).toBe(true);
  });
});

describe('AnimationPlayer', () => {
  function setup(anims: Record<string, unknown>) {
    const engine = new Engine();
    const root = new Node2D('Root');
    const sprite = root.addChild(new Node2D('Sprite'));
    const player = root.addChild(new AnimationPlayer());
    player.animations = anims as AnimationPlayer['animations'];
    engine.tree.setCurrentScene(root);
    return { engine, root, sprite, player };
  }

  it('interpolates numbers, vectors and colours; switches booleans at keys', () => {
    const { engine, sprite, player } = setup({
      move: {
        length: 1,
        tracks: [
          { path: 'Sprite', property: 'position', keys: [[0, [0, 0]], [1, [100, 50]]] },
          { path: 'Sprite', property: 'rotation', keys: [[0, 0], [1, 2]] },
          { path: 'Sprite', property: 'modulate', keys: [[0, '#000000'], [1, '#ffffff']] },
          { path: 'Sprite', property: 'visible', keys: [[0, true], [0.5, false]] },
          { path: 'Sprite', property: 'zIndex', interpolation: 'nearest', keys: [[0, 0], [0.75, 5]] },
        ],
      },
    });
    player.play('move');
    expect(player.isPlaying()).toBe(true);
    player.seek(0.25);
    expect(sprite.position.x).toBeCloseTo(25);
    expect(sprite.position.y).toBeCloseTo(12.5);
    expect(sprite.rotation).toBeCloseTo(0.5);
    expect(sprite.modulate.r).toBeCloseTo(0.25);
    expect(sprite.visible).toBe(true);
    expect(sprite.zIndex).toBe(0);
    player.seek(0.8);
    expect(sprite.visible).toBe(false);
    expect(sprite.zIndex).toBe(5);
    engine.dispose();
  });

  it('plays over time, emits started/finished once, stops at the end; loops without finishing', () => {
    const { engine, sprite, player } = setup({
      once: { length: 0.5, tracks: [{ path: 'Sprite', property: 'position', keys: [[0, [0, 0]], [0.5, [10, 0]]] }] },
      loop: { length: 0.5, loop: true, tracks: [{ path: 'Sprite', property: 'rotation', keys: [[0, 0], [0.5, 1]] }] },
    });
    const started: string[] = [];
    const finished: string[] = [];
    player.animationStarted.connect((n) => started.push(n));
    player.animationFinished.connect((n) => finished.push(n));
    player.play('once');
    step(engine, 0.25);
    expect(sprite.position.x).toBeCloseTo(5, 0);
    step(engine, 0.5);
    expect(sprite.position.x).toBeCloseTo(10);
    expect(player.isPlaying()).toBe(false);
    expect(finished).toEqual(['once']);
    player.play('loop');
    step(engine, 0.6);
    expect(player.isPlaying()).toBe(true);
    expect(player.currentAnimationPosition).toBeCloseTo(0.1, 1);
    expect(finished).toEqual(['once']);
    expect(started).toEqual(['once', 'loop']);
    // speedScale and stop()
    player.speedScale = 2;
    step(engine, 0.1);
    expect(player.currentAnimationPosition).toBeCloseTo(0.3, 1);
    player.stop();
    expect(sprite.rotation).toBeCloseTo(0);
    expect(player.isPlaying()).toBe(false);
    engine.dispose();
  });

  it('calls method keys, plays backwards, queues and autoplays', () => {
    const calls: number[] = [];
    class Target extends Node2D {
      hit(n: number) {
        calls.push(n);
      }
    }
    const engine = new Engine();
    const root = new Node2D('Root');
    root.addChild(new Target('T'));
    const player = new AnimationPlayer();
    player.animations = {
      a: { length: 1, tracks: [{ path: 'T', method: 'hit', keys: [[0, [0]], [0.5, [5]]] }] },
      b: { length: 0.2, tracks: [{ path: 'T', property: 'rotation', keys: [[0, 0], [0.2, 1]] }] },
    };
    player.autoplay = 'a';
    root.addChild(player);
    engine.tree.setCurrentScene(root);
    expect(player.currentAnimation).toBe('a');
    expect(calls).toEqual([0]);
    step(engine, 0.6);
    expect(calls).toEqual([0, 5]);
    player.queue('b');
    step(engine, 0.5);
    expect(player.currentAnimation).toBe('b');
    player.playBackwards('b');
    expect(player.currentAnimationPosition).toBeCloseTo(0.2);
    step(engine, 0.1);
    expect(player.currentAnimationPosition).toBeCloseTo(0.1, 1);
    engine.dispose();
  });

  it('samples cubic tracks smoothly and validates stored animations', () => {
    const keys = [
      { time: 0, value: 0 },
      { time: 1, value: 10 },
      { time: 2, value: 0 },
    ];
    expect(sampleTrack(keys, 0.5, 'linear')).toBeCloseTo(5);
    const cubic = sampleTrack(keys, 0.5, 'cubic') as number;
    expect(cubic).toBeGreaterThan(5);
    expect(sampleTrack(keys, 1, 'cubic')).toBeCloseTo(10);
    expect(sampleTrack([{ time: 0, value: new Color(0, 0, 0) }, { time: 1, value: new Color(1, 1, 1) }], 0.5, 'linear')).toBeInstanceOf(Color);
    expect(validateAnimationLibrary({ a: { length: 1, tracks: [] } })).toBeNull();
    expect(validateAnimationLibrary([])).toMatch(/object/);
    expect(validateAnimationLibrary({ a: { length: -1, tracks: [] } })).toMatch(/length/);
    expect(validateAnimationLibrary({ a: { length: 1, tracks: [{ path: 'X', keys: [] }] } })).toMatch(/property.*method/);
    expect(validateAnimationLibrary({ a: { length: 1, tracks: [{ path: 'X', property: 'p', keys: [[-1, 0]] }] } })).toMatch(/time/);
    expect(validateAnimationLibrary({ a: { length: 1, tracks: [{ path: 'X', property: 'p', interpolation: 'bezier', keys: [] }] } })).toMatch(/interpolation/);
    const def = nodeTypes.property('AnimationPlayer', 'animations')!;
    expect(validatePropValue(def, { walk: { length: 1, loop: true, tracks: [] } })).toBeNull();
    expect(validatePropValue(def, 'nope')).not.toBeNull();
  });
});

describe('TileMapLayer', () => {
  it('sets, gets and erases cells and converts between map and local coordinates', () => {
    const t = new TileMapLayer();
    t.tileSize = new Vector2(32, 32);
    t.setCell(new Vector2(0, 0), new Vector2(1, 2));
    t.setCell(new Vector2(-3, 5));
    expect(t.getCell(new Vector2(0, 0))!.equals(new Vector2(1, 2))).toBe(true);
    expect(t.getCell(new Vector2(-3, 5))!.equals(new Vector2(0, 0))).toBe(true);
    expect(t.getCell(new Vector2(1, 1))).toBeNull();
    expect(t.getCellAtlasCoords(new Vector2(1, 1)).equals(new Vector2(-1, -1))).toBe(true);
    expect(t.getUsedCells()).toHaveLength(2);
    expect(t.localToMap(new Vector2(-1, 33)).equals(new Vector2(-1, 1))).toBe(true);
    expect(t.mapToLocal(new Vector2(2, -1)).equals(new Vector2(80, -16))).toBe(true);
    expect(t.cells).toEqual([0, 0, 1, 2, -3, 5, 0, 0]);
    t.eraseCell(new Vector2(0, 0));
    expect(t.getCellCount()).toBe(1);
    const r = t.getUsedRect();
    expect([r.x, r.y, r.width, r.height]).toEqual([-3, 5, 1, 1]);
  });

  it('stores cells compactly, round-trips through scene documents and merges collision rows', () => {
    const t = new TileMapLayer();
    t.cells = [0, 0, 0, 0, 1, 0, 0, 0, 2, 0, 1, 0, 4, 0, 0, 0, 0, 1, 0, 0];
    const rects = t.getCollisionRects();
    // Row 0: x 0–2 merged, x 4 alone; row 1: x 0.
    expect(rects.map((r) => [r.x, r.y, r.width, r.height]).sort()).toEqual(
      [
        [0, 0, 48, 16],
        [64, 0, 16, 16],
        [0, 16, 16, 16],
      ].sort(),
    );
    t.solidTiles = [new Vector2(1, 0)];
    expect(t.getCollisionRects().map((r) => [r.x, r.width])).toEqual([[32, 16]]);
    const doc = packScene(t, nodeTypes);
    expect(doc.root.props?.cells).toEqual([0, 0, 0, 0, 1, 0, 0, 0, 2, 0, 1, 0, 4, 0, 0, 0, 0, 1, 0, 0]);
    const back = instantiateScene(doc, { registry: nodeTypes, scripts: null, resources: null, scene: () => undefined }) as TileMapLayer;
    expect(back.getCellCount()).toBe(5);
    expect(validateTileCells([1, 2, 3])).toMatch(/four/);
    expect(validateTileCells([0, 0, -1, 0])).toMatch(/atlas/);
    expect(validateTileCells([0, 0, 1.5, 0])).toMatch(/whole/);
    expect(validateTileCells([0, 0, 1, 0])).toBeNull();
  });
});

describe('UI', () => {
  const click = (x: number, y: number, phase: 'down' | 'up' | 'move', pointerType: 'mouse' | 'touch' = 'mouse', pointerId = 1) => Input.feed({ type: 'pointer', phase, pointerId, pointerType, position: new Vector2(x, y), button: 0 });

  it('presses buttons with mouse and touch, consumes the press and leaves game actions alone', () => {
    Input.reset();
    Input.setActions({ shoot: [{ type: 'mouseButton', button: 0 }] });
    const engine = new Engine();
    const root = new Node2D('Main');
    const layer = root.addChild(new CanvasLayer());
    const btn = layer.addChild(new Button());
    btn.position = new Vector2(100, 100);
    btn.size = new Vector2(120, 40);
    const seen: InputEvent[] = [];
    class Game extends Node2D {
      override _input(e: InputEvent) {
        seen.push(e);
      }
    }
    root.addChild(new Game());
    const log: string[] = [];
    btn.buttonDown.connect(() => log.push('down'));
    btn.buttonUp.connect(() => log.push('up'));
    btn.pressed.connect(() => log.push('pressed'));
    engine.tree.setCurrentScene(root);

    click(150, 120, 'down');
    engine.step(1 / 60);
    expect(log).toEqual(['down']);
    expect(btn.isPressed()).toBe(true);
    expect(Input.isActionPressed('shoot')).toBe(false);
    expect(Input.isMouseButtonPressed(0)).toBe(false);
    click(150, 120, 'up');
    engine.step(1 / 60);
    expect(log).toEqual(['down', 'up', 'pressed']);
    expect(seen.filter((e) => e.type === 'pointer' && e.phase !== 'move')).toEqual([]);

    // Touch works the same.
    click(110, 110, 'down', 'touch', 7);
    click(110, 110, 'up', 'touch', 7);
    engine.step(1 / 60);
    expect(log.filter((l) => l === 'pressed')).toHaveLength(2);

    // Releasing outside cancels the press.
    click(150, 120, 'down');
    engine.step(1 / 60);
    click(500, 500, 'move');
    click(500, 500, 'up');
    engine.step(1 / 60);
    expect(log.filter((l) => l === 'pressed')).toHaveLength(2);

    // Clicking elsewhere reaches the game.
    click(600, 400, 'down');
    engine.step(1 / 60);
    expect(Input.isActionPressed('shoot')).toBe(true);
    expect(seen.some((e) => e.type === 'pointer' && e.phase === 'down')).toBe(true);
    click(600, 400, 'up');
    engine.step(1 / 60);

    // Disabled buttons swallow clicks without emitting; toggle buttons toggle.
    btn.disabled = true;
    click(150, 120, 'down');
    click(150, 120, 'up');
    engine.step(1 / 60);
    expect(log.filter((l) => l === 'pressed')).toHaveLength(2);
    expect(Input.isActionPressed('shoot')).toBe(false);
    btn.disabled = false;
    btn.toggleMode = true;
    const toggles: boolean[] = [];
    btn.toggled.connect((on) => toggles.push(on));
    click(150, 120, 'down');
    click(150, 120, 'up');
    engine.step(1 / 60);
    expect(toggles).toEqual([true]);
    expect(btn.buttonPressed).toBe(true);
    engine.dispose();
    Input.reset();
    Input.setActions({});
  });

  it('lets clicks through labels (mouse filter ignore), tracks hover and respects layers and offsets', () => {
    Input.reset();
    const engine = new Engine();
    const root = new Node2D('Main');
    const low = root.addChild(new CanvasLayer());
    low.layer = 1;
    const high = root.addChild(new CanvasLayer());
    high.layer = 2;
    high.offset = new Vector2(50, 0);
    const under = low.addChild(new Button('Under'));
    under.position = new Vector2(50, 0);
    under.size = new Vector2(100, 100);
    const over = high.addChild(new Button('Over'));
    over.size = new Vector2(100, 100);
    const label = high.addChild(new Label());
    label.size = new Vector2(400, 400);
    let underPressed = 0;
    let overPressed = 0;
    under.pressed.connect(() => underPressed++);
    over.pressed.connect(() => overPressed++);
    const entered: string[] = [];
    over.mouseEntered.connect(() => entered.push('over'));
    engine.tree.setCurrentScene(root);
    click(60, 50, 'move');
    click(60, 50, 'down');
    click(60, 50, 'up');
    engine.step(1 / 60);
    // The higher layer's button (offset to x 50–150) wins; the label is click-through.
    expect(overPressed).toBe(1);
    expect(underPressed).toBe(0);
    expect(entered).toEqual(['over']);
    expect(over.isHovered()).toBe(true);
    over.hide();
    click(60, 50, 'down');
    click(60, 50, 'up');
    engine.step(1 / 60);
    expect(underPressed).toBe(1);
    engine.dispose();
  });

  it('anchors controls to the parent area with layout presets', () => {
    const engine = new Engine();
    engine.tree.viewportSize = new Vector2(800, 600);
    const root = new Node2D('Main');
    const layer = root.addChild(new CanvasLayer());
    const br = layer.addChild(new ColorRect());
    br.layoutPreset = 'bottomRight';
    br.size = new Vector2(100, 50);
    br.position = new Vector2(-10, -10);
    const center = layer.addChild(new ColorRect());
    center.layoutPreset = 'center';
    center.size = new Vector2(100, 50);
    const bar = layer.addChild(new ColorRect());
    bar.layoutPreset = 'topWide';
    bar.size = new Vector2(1, 40);
    bar.position = new Vector2(20, 0);
    const full = layer.addChild(new Control());
    full.layoutPreset = 'fullRect';
    const inner = full.addChild(new ColorRect());
    inner.layoutPreset = 'bottomLeft';
    inner.size = new Vector2(10, 10);
    engine.tree.setCurrentScene(root);
    const rect = (c: Control) => {
      const r = c.getRect();
      return [r.x, r.y, r.width, r.height];
    };
    expect(rect(br)).toEqual([690, 540, 100, 50]);
    expect(rect(center)).toEqual([350, 275, 100, 50]);
    expect(rect(bar)).toEqual([20, 0, 760, 40]);
    expect(rect(full)).toEqual([0, 0, 800, 600]);
    expect(inner.globalPosition.equals(new Vector2(0, 590))).toBe(true);
    // Moving an anchored control by its global position moves its offset.
    br.globalPosition = new Vector2(600, 500);
    expect(br.position.equals(new Vector2(-100, -50))).toBe(true);
    engine.dispose();
  });

  it('lays out boxes, margins and centring containers', () => {
    const box = new HBoxContainer();
    box.size = new Vector2(300, 50);
    box.separation = 10;
    const a = box.addChild(new ColorRect());
    a.size = new Vector2(50, 20);
    const b = box.addChild(new ColorRect());
    b.size = new Vector2(30, 20);
    b.sizeFlagsHorizontal = 'expandFill';
    b.sizeFlagsVertical = 'shrinkCenter';
    const c = box.addChild(new ColorRect());
    c.size = new Vector2(40, 20);
    const r = (n: Control) => {
      const x = n.getRect();
      return [x.x, x.y, x.width, x.height];
    };
    expect(r(a)).toEqual([0, 0, 50, 50]);
    expect(r(b)).toEqual([60, 15, 190, 20]);
    expect(r(c)).toEqual([260, 0, 40, 50]);
    b.sizeFlagsHorizontal = 'fill';
    box.alignment = 'center';
    // 50 + 30 + 40 + 2×10 = 140 of 300: 80 px each side.
    expect(r(a)[0]).toBe(80);
    c.hide();
    // 50 + 30 + 10 = 90 of 300: 105 px each side.
    expect(r(a)[0]).toBe(105);
    expect(r(b)[0]).toBe(165);
    expect(box.getMinimumSize().equals(new Vector2(90, 20))).toBe(true);

    const v = new VBoxContainer();
    const l1 = v.addChild(new Label());
    l1.text = 'Hello';
    const l2 = v.addChild(new Label());
    l2.text = 'World';
    expect(l2.getRect().y).toBeGreaterThan(l1.getRect().height);
    // Containers grow to fit their content.
    expect(v.getSize().y).toBeCloseTo(l1.getRect().height + l2.getRect().height + 4);

    const m = new MarginContainer();
    m.size = new Vector2(200, 100);
    m.marginLeft = m.marginTop = m.marginRight = m.marginBottom = 10;
    const fill = m.addChild(new ColorRect());
    fill.size = new Vector2(1, 1);
    expect(r(fill)).toEqual([10, 10, 180, 80]);

    const cc = new CenterContainer();
    cc.size = new Vector2(200, 100);
    const mid = cc.addChild(new ColorRect());
    mid.size = new Vector2(20, 10);
    expect(r(mid)).toEqual([90, 45, 20, 10]);
  });

  it('clamps and rounds progress bar values', () => {
    const bar = new ProgressBar();
    const changes: number[] = [];
    bar.valueChanged.connect((v) => changes.push(v));
    bar.value = 150;
    expect(bar.value).toBe(100);
    bar.step = 5;
    bar.value = 42;
    expect(bar.value).toBe(40);
    expect(bar.ratio).toBeCloseTo(0.4);
    bar.ratio = 0.5;
    expect(bar.value).toBe(50);
    expect(changes).toEqual([100, 40, 50]);
  });
});

describe('notifiers', () => {
  it('reports a 2D rectangle entering and leaving the screen', () => {
    const engine = new Engine();
    engine.tree.viewportSize = new Vector2(800, 600);
    const root = new Node2D();
    const n = root.addChild(new VisibleOnScreenNotifier2D());
    n.position = new Vector2(100, 100);
    const log: string[] = [];
    n.screenEntered.connect(() => log.push('in'));
    n.screenExited.connect(() => log.push('out'));
    engine.tree.setCurrentScene(root);
    engine.step(1 / 60);
    expect(n.isOnScreen()).toBe(true);
    n.position = new Vector2(900, 100);
    engine.step(1 / 60);
    expect(log).toEqual(['in', 'out']);
    // The camera (canvas transform) scrolling to it brings it back.
    engine.tree.canvasTransform = new Transform2D(1, 0, 0, 1, -400, 0);
    engine.step(1 / 60);
    expect(log).toEqual(['in', 'out', 'in']);
    engine.dispose();
  });

  it('reports a 3D box entering and leaving the camera frustum', () => {
    const engine = new Engine();
    const root = new Node3D();
    const cam = root.addChild(new Camera3D());
    cam.position = new Vector3(0, 0, 10);
    const n = root.addChild(new VisibleOnScreenNotifier3D());
    const log: string[] = [];
    n.screenEntered.connect(() => log.push('in'));
    n.screenExited.connect(() => log.push('out'));
    engine.tree.setCurrentScene(root);
    engine.step(1 / 60);
    expect(n.isOnScreen()).toBe(true);
    n.position = new Vector3(0, 0, 20); // behind the camera
    engine.step(1 / 60);
    n.position = new Vector3(200, 0, 0); // far to the side
    engine.step(1 / 60);
    n.position = new Vector3(3, 0, 0);
    engine.step(1 / 60);
    expect(log).toEqual(['in', 'out', 'in']);
    // Projection helpers agree with the frustum test.
    const p = cam.unprojectPosition(new Vector3(0, 0, 0));
    expect(p.x).toBeCloseTo(576);
    expect(p.y).toBeCloseTo(324);
    const dir = cam.projectRayNormal(new Vector2(576, 324));
    expect(dir.equals(new Vector3(0, 0, -1), 1e-6)).toBe(true);
    engine.dispose();
  });
});

describe('positional audio', () => {
  it('fades 2D sounds with distance and pans them by side', () => {
    expect(attenuation2D(0, 1000, 1)).toBe(1);
    expect(attenuation2D(500, 1000, 1)).toBeCloseTo(0.5);
    expect(attenuation2D(500, 1000, 2)).toBeCloseTo(0.25);
    expect(attenuation2D(1500, 1000, 1)).toBe(0);
    const engine = new Engine();
    engine.tree.viewportSize = new Vector2(800, 600);
    const root = new Node2D();
    const cam = root.addChild(new Camera2D());
    cam.position = new Vector2(400, 300);
    const s = root.addChild(new AudioStreamPlayer2D());
    s.maxDistance = 1000;
    engine.tree.setCurrentScene(root);
    engine.step(1 / 60);
    s.position = new Vector2(400 + 400, 300);
    let mix = s.getSpatialMix();
    expect(mix.gain).toBeCloseTo(0.6);
    expect(mix.pan).toBeCloseTo(1);
    s.position = new Vector2(400 - 200, 300);
    mix = s.getSpatialMix();
    expect(mix.gain).toBeCloseTo(0.8);
    expect(mix.pan).toBeCloseTo(-0.5);
    engine.dispose();
  });

  it('attenuates 3D sounds by distance model and pans relative to the camera', () => {
    expect(attenuationDb3D(10, 'inverse', 10)).toBeCloseTo(0);
    expect(attenuationDb3D(20, 'inverse', 10)).toBeCloseTo(-6.02, 1);
    expect(attenuationDb3D(20, 'inverseSquare', 10)).toBeCloseTo(-12.04, 1);
    expect(attenuationDb3D(1000, 'disabled', 10)).toBe(0);
    const engine = new Engine();
    const root = new Node3D();
    root.addChild(new Camera3D());
    const s = root.addChild(new AudioStreamPlayer3D());
    s.position = new Vector3(20, 0, 0);
    engine.tree.setCurrentScene(root);
    const mix = s.getSpatialMix();
    expect(mix.gain).toBeCloseTo(0.5, 1);
    expect(mix.pan).toBeCloseTo(1);
    s.maxDistance = 15;
    expect(s.getSpatialMix().gain).toBe(0);
    s.maxDistance = 0;
    s.position = new Vector3(0, 0, -1);
    // Close: capped at maxDb (3 dB).
    expect(s.getSpatialMix().gain).toBeCloseTo(Math.pow(10, 3 / 20));
    engine.dispose();
  });
});

describe('parallax', () => {
  it('scrolls slower than the camera and wraps repeating layers around the view', () => {
    const engine = new Engine();
    engine.tree.viewportSize = new Vector2(800, 600);
    const root = new Node2D();
    const far = root.addChild(new Parallax2D());
    far.scrollScale = new Vector2(0.5, 1);
    engine.tree.setCurrentScene(root);
    // Camera scrolled 1000 px right.
    engine.tree.canvasTransform = new Transform2D(1, 0, 0, 1, -1000, 0);
    expect(far.globalPosition.x).toBeCloseTo(500);
    far.repeatSize = new Vector2(300, 0);
    // Origin wraps to just left of the view's left edge (1000): 500 + k·300 ∈ (700, 1000].
    expect(far.globalPosition.x).toBeCloseTo(800);
    far.autoscroll = new Vector2(-60, 0);
    far.repeatSize = new Vector2(0, 0);
    engine.step(0.25);
    engine.step(0.25);
    expect(far.globalPosition.x).toBeCloseTo(470);
    engine.dispose();
  });
});

describe('registry (extended nodes)', () => {
  it('reports configuration warnings and per-type defaults', () => {
    const w = (type: string, parentType: string | null, props: Record<string, unknown> = {}) => nodeTypes.warnings({ node: { id: 'x', name: 'X', type, props: props as never }, parentType, childTypes: [] });
    expect(w('PathFollow2D', 'Node2D')[0]).toMatch(/Path2D/);
    expect(w('PathFollow2D', 'Path2D')).toEqual([]);
    expect(w('PathFollow3D', 'Node3D')[0]).toMatch(/Path3D/);
    expect(w('RayCast2D', 'Node2D', { collisionMask: 0 })[0]).toMatch(/collisionMask/);
    expect(w('RayCast3D', 'Node3D')).toEqual([]);
    expect(w('Button', 'Node2D')[0]).toMatch(/CanvasLayer/);
    expect(w('Button', 'CanvasLayer')).toEqual([]);
    expect(w('Button', 'VBoxContainer')).toEqual([]);
    expect(w('AnimationPlayer', 'Node', { autoplay: 'run', animations: { walk: { length: 1, tracks: [] } } })[0]).toMatch(/run/);
    expect(w('AnimatableBody2D', 'Node2D')[0]).toMatch(/CollisionShape2D/);
    expect(nodeTypes.property('Label', 'mouseFilter')!.default).toBe('ignore');
    expect(nodeTypes.property('Control', 'mouseFilter')!.default).toBe('stop');
    expect(nodeTypes.property('HBoxContainer', 'mouseFilter')!.default).toBe('pass');
    expect(nodeTypes.property('ColorRect', 'size')!.default).toEqual([100, 100]);
    expect(nodeTypes.property('Label3D', 'pixelSize')!.default).toBe(0.005);
    // Every creatable node constructs headless and is either a Node2D, a Node3D or dimensionless.
    for (const t of nodeTypes.list()) {
      const n = new t.ctor();
      expect(n).toBeInstanceOf(Node);
      n.free();
    }
  });
});
