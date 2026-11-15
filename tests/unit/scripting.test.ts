import { afterEach, describe, expect, it } from 'vitest';
import * as esbuildNative from 'esbuild';
import * as shared from '@gs/shared';
import * as core from '@gs/core';
import { CharacterBody2D, Engine, Input, ScriptRegistry, instantiateScene, nodeTypes, type Node } from '@gs/core';
import { checkScript, compileScripts, scriptTemplate, type EsbuildLike } from '@gs/scripting';

const esbuild = esbuildNative as unknown as EsbuildLike;
import { createProject } from '@gs/project';
import { createPhysics2D } from '@gs/physics2d';

/** Evaluates a compiled bundle the way the player frame does (it sets up globalThis.GameStudio first). */
function load(js: string) {
  const scripts = new ScriptRegistry();
  (globalThis as Record<string, unknown>).GameStudio = { ...shared, ...core, registerScript: (p: string, c: unknown) => scripts.register(p, c) };
  new Function(js)();
  return scripts;
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).GameStudio;
});

describe('script compilation', () => {
  it('bundles scripts that import the engine and each other', async () => {
    const r = await compileScripts(esbuild, {
      'scripts/util.ts': `export const double = (n: number): number => n * 2;`,
      'scripts/thing.ts': `import { Node2D } from 'gamestudio';\nimport { double } from './util';\nexport default class Thing extends Node2D {\n  static exports = ['size'];\n  size: number = double(21);\n}`,
    });
    expect(r.diagnostics).toEqual([]);
    expect(r.ok).toBe(true);
    const scripts = load(r.js);
    const info = scripts.describe('scripts/thing.ts', nodeTypes);
    expect(info).toMatchObject({ baseType: 'Node2D', className: 'Thing', exports: [{ name: 'size', type: 'float', default: 42 }] });
  });

  it('reports syntax errors with file and line', async () => {
    const r = await compileScripts(esbuild, { 'scripts/bad.ts': `export default class X {\n  oops(: void {}\n}` });
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]).toMatchObject({ severity: 'error', file: 'scripts/bad.ts', line: 2, source: 'script' });
    const quick = await checkScript(esbuild, 'scripts/bad.ts', `const x = ;`);
    expect(quick[0]).toMatchObject({ severity: 'error', line: 1 });
  });

  it('refuses imports outside the project', async () => {
    const r = await compileScripts(esbuild, { 'scripts/a.ts': `import fs from 'node:fs';\nexport default fs;`, 'scripts/b.ts': `import x from './missing';\nexport default x;` });
    expect(r.ok).toBe(false);
    const messages = r.diagnostics.map((d) => d.message).join('\n');
    expect(messages).toMatch(/Only "gamestudio" and other project scripts/);
    expect(messages).toMatch(/Cannot find ".\/missing"/);
  });

  it('generates templates that compile', async () => {
    for (const t of ['Node2D', 'CharacterBody2D', 'CharacterBody3D', 'MeshInstance3D']) {
      const r = await compileScripts(esbuild, { 'scripts/t.ts': scriptTemplate(t, 'MyScript') });
      expect(r.diagnostics, t).toEqual([]);
    }
  });
});

describe('starter games run end to end (compile → load → physics)', () => {
  it('the 2D platformer player lands on the floor and runs', async () => {
    const { doc } = await createProject('Test', '2d-platformer');
    const compiled = await compileScripts(esbuild, doc.scripts);
    expect(compiled.ok).toBe(true);
    const scripts = load(compiled.js);
    const engine = new Engine();
    engine.setPhysics2D(await createPhysics2D(doc.settings.physics.gravity2d));
    const problems: string[] = [];
    const resources = new core.ResourceLoader({ asset: (p) => doc.assets[p], scene: (p) => doc.scenes[p] }, () => {
      throw new Error('unused');
    });
    const root = instantiateScene(doc.scenes['scenes/main.scene'], { registry: nodeTypes, scripts, resources, scene: (p) => doc.scenes[p], onProblem: (m) => problems.push(m) });
    expect(problems).toEqual([]);
    engine.tree.setCurrentScene(root);
    const player = root.getNode<CharacterBody2D & { speed: number }>('Player');
    expect(player.speed).toBe(320);
    for (let i = 0; i < 120; i++) engine.step(1 / 60);
    expect(player.isOnFloor()).toBe(true);
    const x0 = player.position.x;
    Input.feed({ type: 'key', code: 'ArrowLeft', key: 'ArrowLeft', pressed: true, echo: false });
    for (let i = 0; i < 30; i++) engine.step(1 / 60);
    expect(player.position.x).toBeCloseTo(x0 - 160, 0);
    const logs: string[] = [];
    engine.tree.logged.connect((e) => logs.push(e.message));
    engine.step(1 / 60);
    expect(logs).toEqual([]);
    engine.dispose();
  });

  it('the 3D starter compiles and its scripts attach to their nodes', async () => {
    const { doc } = await createProject('Test', '3d-starter');
    const compiled = await compileScripts(esbuild, doc.scripts);
    expect(compiled.ok).toBe(true);
    const scripts = load(compiled.js);
    const root = instantiateScene(doc.scenes['scenes/main.scene'], { registry: nodeTypes, scripts, resources: null, scene: (p) => doc.scenes[p] });
    const gem = root.getNode('Gem') as Node & { degreesPerSecond: number };
    expect(gem).toBeInstanceOf(core.MeshInstance3D);
    expect(gem.degreesPerSecond).toBe(45);
  });
});
