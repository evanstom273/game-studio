/**
 * Engine: the main loop. Each frame:
 *   1. input events are applied and dispatched to `_input`;
 *   2. zero or more fixed physics ticks: `_physicsProcess` then the physics servers step;
 *   3. `_process(delta)`, tweens and timers;
 *   4. deferred deletions and scene changes;
 *   5. renderers draw.
 *
 * The loop is driven by requestAnimationFrame when available, or by calling `step()` yourself
 * (tests, headless runs).
 */
import { GameStudioError } from '@gs/shared';
import { Input, type GamepadLike } from './input';
import { SceneTree } from './scene-tree';
import type { AudioServer } from './nodes-misc';
import type { PhysicsServer2D, PhysicsServer3D } from './physics';

export interface RenderServer {
  /** Draws the tree's current state. */
  render(): void;
  dispose(): void;
}

export interface EngineOptions {
  physicsTicksPerSecond?: number;
  /** Physics ticks allowed per frame before time is dropped (prevents the "spiral of death"). */
  maxPhysicsStepsPerFrame?: number;
}

export class Engine {
  /** The engine whose scripts are running (used by print() and load()). */
  static current: Engine | null = null;

  readonly tree = new SceneTree();
  readonly renderers: RenderServer[] = [];
  /** Multiplies game time (slow motion / fast forward). */
  timeScale = 1;
  maxPhysicsStepsPerFrame: number;
  frame = 0;
  physicsTick = 0;
  /** Seconds of game time since start. */
  time = 0;
  /** Frames per second, averaged over the last second. */
  fps = 0;
  getGamepads: () => GamepadLike[] = () => [];

  private accumulator = 0;
  private rafId: number | null = null;
  private last = 0;
  private fpsFrames = 0;
  private fpsTime = 0;
  private disposed = false;

  constructor(opts: EngineOptions = {}) {
    this.tree.physicsDelta = 1 / (opts.physicsTicksPerSecond ?? 60);
    this.maxPhysicsStepsPerFrame = opts.maxPhysicsStepsPerFrame ?? 8;
    Engine.current = this;
  }

  get physicsTicksPerSecond() {
    return Math.round(1 / this.tree.physicsDelta);
  }

  setPhysics2D(server: PhysicsServer2D | null) {
    this.tree.physics2d?.dispose();
    this.tree.physics2d = server;
  }
  setPhysics3D(server: PhysicsServer3D | null) {
    this.tree.physics3d?.dispose();
    this.tree.physics3d = server;
  }
  setAudio(server: AudioServer | null) {
    this.tree.audio?.dispose();
    this.tree.audio = server;
  }
  addRenderer(r: RenderServer) {
    this.renderers.push(r);
  }

  /** Advances the game by `delta` seconds of real time and renders. */
  step(delta: number) {
    if (this.disposed) throw new GameStudioError('E_DISPOSED', 'Engine was disposed');
    Engine.current = this;
    const dt = Math.min(Math.max(delta, 0), 0.25) * this.timeScale;
    this.frame++;
    this.time += dt;
    const tree = this.tree;
    let pads: GamepadLike[] = [];
    try {
      pads = this.getGamepads();
    } catch {
      // Gamepads can be blocked (permissions policy, sandboxing): the game must keep running.
      this.getGamepads = () => [];
    }
    tree.dispatchInput(Input.beginFrame(this.frame, this.physicsTick, pads));

    const fixed = tree.physicsDelta;
    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= fixed - 1e-9 && steps < this.maxPhysicsStepsPerFrame) {
      Input.beginPhysicsTick(++this.physicsTick);
      tree.physicsFrame(fixed);
      if (!tree.paused) {
        try {
          tree.physics2d?.step(fixed);
          tree.physics3d?.step(fixed);
        } catch (e) {
          tree.reportError(e, null, 'physics step');
        }
      }
      this.accumulator -= fixed;
      steps++;
    }
    if (steps === this.maxPhysicsStepsPerFrame) this.accumulator = 0;
    Input.endPhysics();

    tree.processFrame(dt);
    tree.flush();
    for (const r of this.renderers) {
      try {
        r.render();
      } catch (e) {
        tree.reportError(e, null, 'render');
      }
    }

    this.fpsFrames++;
    this.fpsTime += delta;
    if (this.fpsTime >= 1) {
      this.fps = Math.round(this.fpsFrames / this.fpsTime);
      this.fpsFrames = 0;
      this.fpsTime = 0;
    }
  }

  /** Runs the loop with requestAnimationFrame. */
  start() {
    if (this.rafId !== null || typeof requestAnimationFrame === 'undefined') return;
    this.last = performance.now();
    const loop = (now: number) => {
      this.rafId = requestAnimationFrame(loop);
      const delta = (now - this.last) / 1000;
      this.last = now;
      this.step(delta);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop() {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  get running() {
    return this.rafId !== null;
  }

  dispose() {
    if (this.disposed) return;
    this.stop();
    this.tree.dispose();
    for (const r of this.renderers) r.dispose();
    this.renderers.length = 0;
    this.setPhysics2D(null);
    this.setPhysics3D(null);
    this.setAudio(null);
    Input.reset();
    this.disposed = true;
    if (Engine.current === this) Engine.current = null;
  }
}

// --- global helpers for scripts --------------------------------------------------------------------------------------------

function fmt(args: unknown[]) {
  return args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.message : typeof a === 'object' && a !== null && !('toString' in a && a.toString !== Object.prototype.toString) ? safeJson(a) : String(a))).join(' ');
}
function safeJson(v: unknown) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Prints to the game console (and the browser console). */
export function print(...args: unknown[]) {
  const t = Engine.current?.tree;
  if (t) t.log('log', fmt(args));
  else console.log(...args);
}
export function printErr(...args: unknown[]) {
  const t = Engine.current?.tree;
  if (t) t.log('error', fmt(args));
  else console.error(...args);
}
export function pushWarning(...args: unknown[]) {
  const t = Engine.current?.tree;
  if (t) t.log('warn', fmt(args));
  else console.warn(...args);
}

/** Loads a resource by project path: textures, sounds, models, scenes (PackedScene). */
export function load<T = import('./resources').Resource>(path: string): T {
  const loader = Engine.current?.tree.resources;
  if (!loader) throw new GameStudioError('E_NO_ENGINE', 'load() can only be used while a game is running');
  return loader.load(path) as T;
}
export const preload = load;
