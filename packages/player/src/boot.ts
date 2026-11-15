/**
 * Boots a game in a page: engine, servers, renderers, input, touch controls, the start scene.
 * Used identically by the editor's play mode (inside a sandboxed iframe) and by exported games.
 */
import { Vector2, errorMessage } from '@gs/shared';
import { Engine, Input, ResourceLoader, instantiateScene, nodeTypes, type InstantiateOptions, type LogEntry, type ScriptRegistry, type Node } from '@gs/core';
import type { Renderer2D } from '@gs/render2d';
import type { Renderer3D } from '@gs/render3d';
import type { createPhysics2D } from '@gs/physics2d';
import type { createPhysics3D } from '@gs/physics3d';
import { WebAudioServer } from '@gs/audio';
import { requiredModules, type GameData } from './game-data';
import { createTouchControls } from './touch-controls';

/** Optional modules, present when their bundles were loaded. */
export interface RuntimeModules {
  Renderer2D?: typeof Renderer2D;
  Renderer3D?: typeof Renderer3D;
  createPhysics2D?: typeof createPhysics2D;
  createPhysics3D?: typeof createPhysics3D;
}

export interface BootOptions {
  container: HTMLElement;
  data: GameData;
  assetUrl(path: string): string | null;
  scripts: ScriptRegistry;
  modules: RuntimeModules;
  onLog?(entry: LogEntry): void;
  /** Draw collision shapes. */
  debugShapes?: boolean;
}

export interface GameHandle {
  engine: Engine;
  pause(): void;
  resume(): void;
  stop(): void;
  /** Number of nodes in the tree (stats). */
  nodeCount(): number;
}

const GAME_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Tab']);

export async function bootGame(opts: BootOptions): Promise<GameHandle> {
  const { container, data, modules } = opts;
  const log = (level: LogEntry['level'], message: string, source?: string) => opts.onLog?.({ level, message, source, time: Date.now() });
  const scene = data.scenes[data.startScene];
  if (!scene) throw new Error(`The start scene "${data.startScene}" does not exist`);
  const settings = data.settings;
  const need = requiredModules(data.scenes);
  for (const m of need) {
    const present = m === 'render2d' ? modules.Renderer2D : m === 'render3d' ? modules.Renderer3D : m === 'physics2d' ? modules.createPhysics2D : modules.createPhysics3D;
    if (!present) throw new Error(`The ${m} runtime module is missing`);
  }

  const engine = new Engine({ physicsTicksPerSecond: settings.physics.ticksPerSecond });
  const tree = engine.tree;
  if (opts.onLog) tree.logged.connect(opts.onLog);
  Input.reset();
  Input.setActions(settings.input.actions);

  const instOpts: InstantiateOptions = {
    registry: nodeTypes,
    scripts: opts.scripts,
    resources: null,
    scene: (p) => data.scenes[p],
    onProblem: (m) => log('error', m),
  };
  const resources = new ResourceLoader({ asset: (p) => data.assets[p], scene: (p) => data.scenes[p] }, (ps) => instantiateScene(ps.doc, instOpts, ps.resourcePath));
  instOpts.resources = resources;
  tree.resources = resources;

  if (need.includes('physics2d')) engine.setPhysics2D(await modules.createPhysics2D!(settings.physics.gravity2d, tree));
  if (need.includes('physics3d')) engine.setPhysics3D(await modules.createPhysics3D!(settings.physics.gravity3d));
  const audio = new WebAudioServer({ url: opts.assetUrl });
  audio.onError = (m) => log('error', m);
  engine.setAudio(audio);

  // Canvases: 3D underneath, 2D on top (transparent when both are used).
  // Only position the container if the page hasn't (inline style alone doesn't show stylesheet rules).
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  container.style.overflow = 'hidden';
  container.style.touchAction = 'none';
  const canvases: HTMLCanvasElement[] = [];
  const makeCanvas = () => {
    const c = document.createElement('canvas');
    c.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;outline:none';
    container.appendChild(c);
    canvases.push(c);
    return c;
  };
  const display = settings.display;
  const assets = { url: opts.assetUrl };
  let r3: Renderer3D | null = null;
  let r2: Renderer2D | null = null;
  if (need.includes('render3d')) {
    r3 = new modules.Renderer3D!({ canvas: makeCanvas(), assets, width: display.width, height: display.height, stretch: display.stretch, background: display.background, pixelArt: display.pixelArt });
    r3.root = tree.root;
    r3.tree = tree;
    engine.addRenderer(r3);
  }
  if (need.includes('render2d') || !r3) {
    if (!modules.Renderer2D) throw new Error('The render2d runtime module is missing');
    r2 = await modules.Renderer2D.create({ canvas: makeCanvas(), assets, width: display.width, height: display.height, stretch: display.stretch, background: display.background, pixelArt: display.pixelArt, transparent: !!r3, showCollisionShapes: opts.debugShapes });
    r2.root = tree.root;
    r2.tree = tree;
    engine.addRenderer(r2);
  }
  const resize = () => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    r3?.resize(w, h);
    r2?.resize(w, h);
  };
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(container);

  // Input.
  const top = canvases[canvases.length - 1];
  top.tabIndex = 0;
  const toViewport = (clientX: number, clientY: number) => {
    const rect = top.getBoundingClientRect();
    const p = new Vector2(clientX - rect.left, clientY - rect.top);
    if (r2) return r2.canvasToViewport(p);
    const vp = r3!.viewport;
    return new Vector2(((p.x - vp.x) / vp.w) * display.width, ((p.y - vp.y) / vp.h) * display.height);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    audio.unlock();
    if (GAME_KEYS.has(e.code)) e.preventDefault();
    Input.feed({ type: 'key', code: e.code, key: e.key, pressed: e.type === 'keydown', echo: e.repeat });
  };
  const pointerType = (e: PointerEvent) => (e.pointerType === 'touch' ? 'touch' : e.pointerType === 'pen' ? 'pen' : 'mouse');
  const onPointer = (e: PointerEvent) => {
    const phase = e.type === 'pointerdown' ? 'down' : e.type === 'pointerup' ? 'up' : e.type === 'pointercancel' ? 'cancel' : 'move';
    if (phase === 'down') {
      audio.unlock();
      top.focus({ preventScroll: true });
      top.setPointerCapture(e.pointerId);
    }
    Input.feed({ type: 'pointer', phase, pointerId: e.pointerId, pointerType: pointerType(e), position: toViewport(e.clientX, e.clientY), button: e.button < 0 ? 0 : e.button });
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    Input.feed({ type: 'wheel', delta: new Vector2(e.deltaX, e.deltaY), position: toViewport(e.clientX, e.clientY) });
  };
  const onBlur = () => Input.reset();
  const onVisibility = () => audio.setSuspended(document.hidden);
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKey);
  window.addEventListener('blur', onBlur);
  document.addEventListener('visibilitychange', onVisibility);
  for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'] as const) top.addEventListener(t, onPointer);
  top.addEventListener('wheel', onWheel, { passive: false });
  top.addEventListener('contextmenu', (e) => e.preventDefault());
  engine.getGamepads = () => (typeof navigator !== 'undefined' && navigator.getGamepads ? (navigator.getGamepads().filter(Boolean) as Gamepad[]) : []);

  const touch = settings.input.touchControls;
  const removeTouch = touch === 'always' || (touch === 'auto' && matchMedia('(pointer: coarse)').matches) ? createTouchControls(container) : null;

  // The start scene.
  let root: Node;
  try {
    root = instantiateScene(scene, instOpts, data.startScene);
  } catch (e) {
    throw new Error(`Could not load ${data.startScene}: ${errorMessage(e)}`);
  }
  tree.setCurrentScene(root);
  engine.start();
  top.focus({ preventScroll: true });

  let stopped = false;
  return {
    engine,
    pause() {
      tree.paused = true;
    },
    resume() {
      tree.paused = false;
    },
    nodeCount() {
      let n = 0;
      tree.root.walk(() => n++);
      return n;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      ro.disconnect();
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
      removeTouch?.();
      engine.dispose();
      for (const c of canvases) c.remove();
    },
  };
}
