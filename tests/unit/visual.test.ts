import { afterEach, describe, expect, it } from 'vitest';
import * as esbuildNative from 'esbuild';
import * as shared from '@gs/shared';
import * as core from '@gs/core';
import { CharacterBody2D, Engine, Input, ScriptRegistry, instantiateScene, nodeTypes } from '@gs/core';
import { compileScripts, type EsbuildLike } from '@gs/scripting';
import { createPhysics2D } from '@gs/physics2d';
import type { GraphNode, ScriptDoc, JsonValue } from '@cs/graph-core';
import { compileVisualScript, expandVisualScripts, gameStudioToolchain, newVisualScript, serializeVisualScript, parseVisualScript } from '@gs/visual';

const esbuild = esbuildNative as unknown as EsbuildLike;

function load(js: string) {
  const scripts = new ScriptRegistry();
  (globalThis as Record<string, unknown>).GameStudio = { ...shared, ...core, registerScript: (p: string, c: unknown) => scripts.register(p, c) };
  new Function(js)();
  return scripts;
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).GameStudio;
});

let seq = 0;
const node = (type: string, props: Record<string, JsonValue> = {}, inputs: Record<string, JsonValue> = {}): GraphNode => ({ id: `n${++seq}`, type, position: { x: seq * 10, y: 0 }, props, inputs });
const link = (from: GraphNode, fromPort: string, to: GraphNode, toPort: string) => ({ id: `e${++seq}`, from: { node: from.id, port: fromPort }, to: { node: to.id, port: toPort } });

/** A platformer-ish player built as a graph: reads input, sets velocity, moves. */
function playerGraph(): ScriptDoc {
  const doc = newVisualScript('Player', 'CharacterBody2D', ['_physicsProcess']);
  doc.variables.push({ id: 'v_speed', name: 'speed', type: 'float', default: 200, exported: true });
  const fn = doc.functions[0];
  const entry = fn.graph.nodes[0];
  const dir = node('gs.input.get_vector');
  const speed = node('core.get_var', { variable: 'v_speed' });
  const scaled = node('gs.vector2_scale_op');
  const setVel = node('gs.characterbody2d.set.velocity');
  const move = node('gs.characterbody2d.move_and_slide');
  fn.graph.nodes.push(dir, speed, scaled, setVel, move);
  fn.graph.edges.push(link(entry, 'then', setVel, 'exec'), link(dir, 'result', scaled, 'a'), link(speed, 'value', scaled, 'b'), link(scaled, 'result', setVel, 'value'), link(setVel, 'then', move, 'exec'));
  return doc;
}

describe('visual scripts', () => {
  it('has a big engine node pack', () => {
    const tc = gameStudioToolchain();
    const types = tc.registry.all().map((d) => d.type);
    expect(types.length).toBeGreaterThan(250);
    for (const t of ['gs.get_node', 'gs.connect_signal', 'gs.wait', 'gs.spawn', 'gs.input.is_action_pressed', 'gs.node2d.get.position', 'gs.node2d.set.position', 'gs.characterbody2d.move_and_slide', 'gs.timer.start', 'gs.vector2.normalized', 'core.branch']) expect(types, t).toContain(t);
  });

  it('compiles a graph to an engine script', () => {
    const r = compileVisualScript('scripts/player.vgraph', serializeVisualScript(playerGraph()));
    expect(r.diagnostics).toEqual([]);
    expect(r.code).toContain("import { CharacterBody2D, Input } from 'gamestudio';");
    expect(r.code).toContain('export default class Player extends CharacterBody2D {');
    expect(r.code).toContain("static exports = ['speed'];");
    expect(r.code).toContain('this.velocity = Input.getVector(');
    expect(r.code).toContain('this.moveAndSlide();');
  });

  it('runs: the compiled graph moves a character', async () => {
    const expanded = expandVisualScripts({ 'scripts/player.vgraph': serializeVisualScript(playerGraph()) });
    expect(expanded.ok).toBe(true);
    const compiled = await compileScripts(esbuild, expanded.scripts);
    expect(compiled.diagnostics).toEqual([]);
    const scripts = load(compiled.js);
    expect(scripts.describe('scripts/player.vgraph', nodeTypes)).toMatchObject({ baseType: 'CharacterBody2D', className: 'Player', exports: [{ name: 'speed', default: 200 }] });
    const engine = new Engine();
    engine.setPhysics2D(await createPhysics2D([0, 0]));
    const root = instantiateScene(
      { format: 1, root: { id: 'r', type: 'Node2D', name: 'World', props: {}, children: [{ id: 'p', type: 'CharacterBody2D', name: 'Player', props: {}, script: 'scripts/player.vgraph', children: [{ id: 'c', type: 'CollisionShape2D', name: 'Shape', props: { shape: { type: 'circle', radius: 8 } }, children: [] }] }] } } as never,
      { registry: nodeTypes, scripts, resources: null, scene: () => undefined },
    );
    engine.tree.setCurrentScene(root);
    const player = root.getNode<CharacterBody2D>('Player');
    Input.feed({ type: 'key', code: 'ArrowRight', key: 'ArrowRight', pressed: true, echo: false });
    for (let i = 0; i < 30; i++) engine.step(1 / 60);
    Input.feed({ type: 'key', code: 'ArrowRight', key: 'ArrowRight', pressed: false, echo: false });
    expect(player.position.x).toBeCloseTo(100, 0);
    engine.dispose();
  });

  it('signals, Get Node and Wait compile to readable code', () => {
    const doc = newVisualScript('Spawner', 'Node2D', ['_ready']);
    doc.signals.push({ id: 's_spawned', name: 'spawned', params: [] });
    const handler = { id: 'f_tick', name: 'onTick', kind: 'function' as const, params: [], returnType: 'void', locals: [], graph: { id: 'g_tick', nodes: [node('core.entry')], edges: [] as ReturnType<typeof link>[] } };
    doc.functions.push(handler);
    const ready = doc.functions[0];
    const timer = node('gs.get_node', { path: 'Timer', type: 'Timer' });
    const connect = node('gs.connect_signal', { signal: 'timeout', method: 'f_tick' });
    ready.graph.nodes.push(timer, connect);
    ready.graph.edges.push(link(ready.graph.nodes[0], 'then', connect, 'exec'), link(timer, 'node', connect, 'source'));
    const wait = node('gs.wait', {}, { seconds: 0.5 });
    const emit = node('gs.emit_signal', { signal: 's_spawned' });
    handler.graph.nodes.push(wait, emit);
    handler.graph.edges.push(link(handler.graph.nodes[0], 'then', wait, 'exec'), link(wait, 'then', emit, 'exec'));
    const r = compileVisualScript('scripts/spawner.vgraph', serializeVisualScript(doc));
    expect(r.diagnostics).toEqual([]);
    expect(r.code).toContain("readonly spawned = new Signal<[]>('spawned');");
    expect(r.code).toContain("(this.getNode('Timer') as Timer).timeout.connect((): void => {\n\t\t\tthis.onTick();\n\t\t}, { owner: this });");
    expect(r.code).toContain('async onTick(): Promise<void> {');
    expect(r.code).toContain('await this.getTree().wait(0.5);');
    expect(r.code).toContain('this.spawned.emit();');
  });

  it('explains mistakes in plain terms', () => {
    const doc = newVisualScript('Mover', 'Node2D', ['_process']);
    doc.variables.push({ id: 'v', name: 'position', type: 'Vector2' });
    const fn = doc.functions[0];
    const move = node('gs.characterbody2d.move_and_slide');
    fn.graph.nodes.push(move);
    fn.graph.edges.push(link(fn.graph.nodes[0], 'then', move, 'exec'));
    const r = compileVisualScript('scripts/mover.vgraph', serializeVisualScript(doc));
    expect(r.ok).toBe(false);
    const text = r.diagnostics.map((d) => d.message).join('\n');
    expect(text).toMatch(/"position" is already part of Node2D/);
    expect(text).toMatch(/isn't a CharacterBody2D/);
    expect(() => parseVisualScript('nope')).toThrow(/Not a visual script/);
  });
});

describe('visual script edit operations', () => {
  it('builds a graph with atomic ops (the same ones the editor and AI use)', async () => {
    const { applyVisualOps } = await import('@gs/visual');
    const doc = newVisualScript('Coin', 'Area2D', ['_ready']);
    const ready = doc.functions[0];
    const r = applyVisualOps(doc, [
      { op: 'add_function', ref: 'f', name: 'onBody', params: [{ name: 'body', type: 'Node' }] },
      { op: 'add_node', ref: 'c', graph: ready.id, type: 'gs.connect_signal', props: { signal: 'bodyEntered', method: '$f' } },
      { op: 'connect', graph: ready.id, from: { node: ready.graph.nodes[0].id, port: 'then' }, to: { node: '$c', port: 'exec' } },
      { op: 'add_node', ref: 'free', graph: '$f', type: 'gs.node.queue_free' },
    ]);
    const onBody = r.doc.functions.find((f) => f.name === 'onBody')!;
    const entry = onBody.graph.nodes.find((n) => n.type === 'core.entry')!;
    const r2 = applyVisualOps(r.doc, [{ op: 'connect', graph: onBody.id, from: { node: entry.id, port: 'then' }, to: { node: r.created.free, port: 'exec' } }]);
    const out = compileVisualScript('scripts/coin.vgraph', serializeVisualScript(r2.doc));
    expect(out.diagnostics).toEqual([]);
    expect(out.code).toContain('this.bodyEntered.connect((body: Node): void => {');
    expect(out.code).toContain('this.queueFree();');
    expect(() => applyVisualOps(doc, [{ op: 'add_node', type: 'gs.nope' }])).toThrow();
  });
});
