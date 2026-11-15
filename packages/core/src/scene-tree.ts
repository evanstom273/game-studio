/**
 * SceneTree: the running game world (Godot's SceneTree). Owns the root node, the current scene,
 * groups, pausing, deferred deletion, tweens and scene changes, and runs the per-frame and
 * per-physics-tick callbacks in tree order.
 */
import { GameStudioError, Signal, Transform2D, Vector2, errorMessage } from '@gs/shared';
import { Node } from './node';
import { Camera2D } from './nodes2d';
import { Camera3D } from './nodes3d';
import { Timer, type AudioServer } from './nodes-misc';
import type { PhysicsServer2D, PhysicsServer3D } from './physics';
import { PackedScene, type ResourceLoader } from './resources';
import { Tween } from './tween';
import type { InputEvent } from './input';

export type LogLevel = 'log' | 'info' | 'warn' | 'error';

export interface LogEntry {
  level: LogLevel;
  message: string;
  /** Node path and callback, for script errors. */
  source?: string;
  stack?: string;
  time: number;
}

export class SceneTreeTimer {
  readonly timeout = new Signal<[]>('timeout');
  constructor(
    public timeLeft: number,
    readonly processAlways: boolean,
  ) {}
}

export class SceneTree {
  readonly root = new Node('root');
  currentScene: Node | null = null;
  paused = false;
  /** Delta of the callback being run right now (frame or physics tick). */
  currentDelta = 1 / 60;
  /** Fixed physics step in seconds. */
  physicsDelta = 1 / 60;
  physics2d: PhysicsServer2D | null = null;
  physics3d: PhysicsServer3D | null = null;
  audio: AudioServer | null = null;
  currentCamera2D: Camera2D | null = null;
  currentCamera3D: Camera3D | null = null;
  resources: ResourceLoader | null = null;
  /** World → viewport transform of the 2D canvas (set by the 2D renderer each frame). */
  canvasTransform = Transform2D.identity();
  /** Size of the game viewport in pixels (the project's display size, or more with stretch "expand"). */
  viewportSize = new Vector2(1152, 648);

  readonly nodeAdded = new Signal<[node: Node]>('nodeAdded');
  readonly nodeRemoved = new Signal<[node: Node]>('nodeRemoved');
  readonly sceneChanged = new Signal<[scene: Node | null]>('sceneChanged');
  readonly logged = new Signal<[entry: LogEntry]>('logged');
  readonly quitRequested = new Signal<[code: number]>('quitRequested');

  private groups = new Map<string, Set<Node>>();
  private processList: Node[] | null = null;
  private deleteQueue: Node[] = [];
  private tweens: Tween[] = [];
  private timers: SceneTreeTimer[] = [];
  private pendingScene: (() => Node) | null = null;
  private errorCounts = new Map<string, number>();

  constructor() {
    this.root.propagateEnterTree(this);
    this.root.propagateReady();
    Signal.onError = (e) => this.reportError(e, null, 'signal listener');
  }

  // --- bookkeeping called by nodes --------------------------------------------------------------------------------
  /** @internal */
  structureChanged() {
    this.processList = null;
  }
  /** @internal */
  nodeEntered(n: Node) {
    this.processList = null;
    this.nodeAdded.emit(n);
  }
  /** @internal */
  nodeExited(n: Node) {
    this.processList = null;
    this.nodeRemoved.emit(n);
  }
  /** @internal */
  groupAdd(group: string, n: Node) {
    let s = this.groups.get(group);
    if (!s) this.groups.set(group, (s = new Set()));
    s.add(n);
  }
  /** @internal */
  groupRemove(group: string, n: Node) {
    this.groups.get(group)?.delete(n);
  }
  /** @internal */
  queueDelete(n: Node) {
    this.deleteQueue.push(n);
  }

  findCamera2D(except?: Node): Camera2D | null {
    let hit: Camera2D | null = null;
    this.root.walk((n) => {
      if (!hit && n !== except && n instanceof Camera2D && n.enabled) hit = n;
    });
    return hit;
  }
  findCamera3D(except?: Node): Camera3D | null {
    let hit: Camera3D | null = null;
    this.root.walk((n) => {
      if (!hit && n !== except && n instanceof Camera3D) hit = n;
    });
    return hit;
  }

  // --- groups ----------------------------------------------------------------------------------------------------------
  getNodesInGroup<T extends Node = Node>(group: string): T[] {
    return [...(this.groups.get(group) ?? [])] as T[];
  }
  getFirstNodeInGroup<T extends Node = Node>(group: string): T | null {
    return (this.groups.get(group)?.values().next().value as T | undefined) ?? null;
  }
  /** Calls `method(...args)` on every node in the group that has it. */
  callGroup(group: string, method: string, ...args: unknown[]) {
    for (const n of this.getNodesInGroup(group)) {
      const fn = (n as unknown as Record<string, unknown>)[method];
      if (typeof fn === 'function') {
        try {
          (fn as (...a: unknown[]) => void).apply(n, args);
        } catch (e) {
          this.reportError(e, n, method);
        }
      }
    }
  }

  // --- scenes -------------------------------------------------------------------------------------------------------------
  /** Replaces the current scene immediately (used by the runtime at startup). */
  setCurrentScene(scene: Node | null) {
    if (this.currentScene) {
      const old = this.currentScene;
      this.currentScene = null;
      if (old.parent === this.root) this.root.removeChild(old);
      old.free();
    }
    this.currentScene = scene;
    if (scene) this.root.addChild(scene);
    this.sceneChanged.emit(scene);
  }

  /** Changes to another scene file at the end of the frame. */
  changeSceneToFile(path: string) {
    const res = this.resources?.load(path);
    if (!(res instanceof PackedScene)) throw new GameStudioError('E_NOT_SCENE', `"${path}" is not a scene`);
    this.changeSceneToPacked(res);
  }
  changeSceneToPacked(scene: PackedScene) {
    this.pendingScene = () => scene.instantiate();
  }
  /** Restarts the current scene at the end of the frame. */
  reloadCurrentScene() {
    const path = this.currentScene?.sceneFilePath;
    if (path) this.changeSceneToFile(path);
  }

  // --- tweens & timers ---------------------------------------------------------------------------------------------------
  createTween(boundNode: Node | null = null) {
    const t = new Tween(boundNode);
    this.tweens.push(t);
    return t;
  }
  createTimer(seconds: number, processAlways = true) {
    const t = new SceneTreeTimer(seconds, processAlways);
    this.timers.push(t);
    return t;
  }
  /** `await tree.wait(0.5)` */
  wait(seconds: number) {
    return new Promise<void>((resolve) => this.createTimer(seconds).timeout.once(() => resolve()));
  }

  // --- the loop ---------------------------------------------------------------------------------------------------------
  private list(): Node[] {
    if (!this.processList) {
      const out: Node[] = [];
      this.root.walk((n) => out.push(n));
      this.processList = out;
    }
    return this.processList;
  }

  /** @internal */
  dispatchInput(events: InputEvent[]) {
    if (!events.length) return;
    const nodes = this.list().slice().reverse();
    for (const e of events) {
      for (const n of nodes) {
        if (e.handled) break;
        if (n._input === Node.prototype._input || !n.isInsideTree() || !n.canProcess()) continue;
        try {
          n._input(e);
        } catch (err) {
          this.reportError(err, n, '_input');
        }
      }
    }
  }

  /** @internal One physics tick. */
  physicsFrame(delta: number) {
    this.currentDelta = delta;
    for (const n of this.list().slice()) {
      if (!n.isInsideTree() || !n.canProcess()) continue;
      if (n instanceof Timer) n.__physicsTick(delta);
      if (n._physicsProcess === Node.prototype._physicsProcess) continue;
      try {
        n._physicsProcess(delta);
      } catch (e) {
        this.reportError(e, n, '_physicsProcess');
      }
    }
  }

  /** @internal One frame. */
  processFrame(delta: number) {
    this.currentDelta = delta;
    for (const n of this.list().slice()) {
      if (!n.isInsideTree() || !n.canProcess()) continue;
      try {
        n.__process(delta);
        if (n._process !== Node.prototype._process) n._process(delta);
      } catch (e) {
        this.reportError(e, n, '_process');
      }
    }
    if (this.tweens.length) {
      const live: Tween[] = [];
      const current = this.tweens;
      this.tweens = [];
      for (const t of current) {
        const bound = t.boundNode;
        const step = bound && bound.isInsideTree() && !bound.canProcess() ? 0 : this.paused && !bound ? 0 : delta;
        try {
          if (t.advance(step)) live.push(t);
        } catch (e) {
          this.reportError(e, bound, 'tween');
        }
      }
      // Tweens created during this loop start next frame.
      this.tweens = live.concat(this.tweens);
    }
    if (this.timers.length) {
      const live: SceneTreeTimer[] = [];
      for (const t of this.timers) {
        if (!this.paused || t.processAlways) t.timeLeft -= delta;
        if (t.timeLeft <= 1e-9) t.timeout.emit();
        else live.push(t);
      }
      this.timers = live;
    }
  }

  /** @internal End of frame: deletions and scene changes. */
  flush() {
    while (this.deleteQueue.length) {
      const batch = this.deleteQueue.splice(0);
      for (const n of batch) {
        if (n === this.currentScene) this.currentScene = null;
        n.free();
      }
    }
    if (this.pendingScene) {
      const make = this.pendingScene;
      this.pendingScene = null;
      try {
        this.setCurrentScene(make());
      } catch (e) {
        this.reportError(e, null, 'changeScene');
      }
    }
  }

  quit(code = 0) {
    this.quitRequested.emit(code);
  }

  // --- logging -------------------------------------------------------------------------------------------------------------
  log(level: LogLevel, message: string, source?: string, stack?: string) {
    this.logged.emit({ level, message, source, stack, time: Date.now() });
  }

  /** Reports a script/runtime error with the node and callback it came from. Repeats are rate-limited. */
  reportError(e: unknown, node: Node | null, where: string) {
    const message = errorMessage(e);
    const source = node ? `${node.getPath()} (${node.scriptPath ?? node.typeName}) in ${where}` : where;
    const key = `${source}|${message}`;
    const n = (this.errorCounts.get(key) ?? 0) + 1;
    this.errorCounts.set(key, n);
    if (n === 1 || n % 120 === 0) this.log('error', n > 1 ? `${message} (repeated ${n}×)` : message, source, e instanceof Error ? e.stack : undefined);
  }

  /** Frees everything (engine shutdown). */
  dispose() {
    this.setCurrentScene(null);
    this.tweens = [];
    this.timers = [];
    this.groups.clear();
  }
}
