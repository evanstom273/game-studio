/**
 * Tweens: animate properties over time (Godot's Tween).
 *
 *   const t = this.createTween();
 *   t.tweenProperty(this, 'position', new Vector2(200, 100), 0.5).setTrans('sine').setEase('out');
 *   t.tweenInterval(0.2);
 *   t.tweenCallback(() => this.queueFree());
 *
 * Steps run one after another; `parallel()` makes the next step run together with the previous one.
 */
import { Color, Signal, Vector2, Vector3, lerp } from '@gs/shared';
import type { Node } from './node';

export type TransitionType = 'linear' | 'sine' | 'quad' | 'cubic' | 'quart' | 'expo' | 'back' | 'elastic' | 'bounce';
export type EaseType = 'in' | 'out' | 'inOut';

function easeIn(t: number, trans: TransitionType): number {
  switch (trans) {
    case 'linear':
      return t;
    case 'sine':
      return 1 - Math.cos((t * Math.PI) / 2);
    case 'quad':
      return t * t;
    case 'cubic':
      return t * t * t;
    case 'quart':
      return t * t * t * t;
    case 'expo':
      return t === 0 ? 0 : Math.pow(2, 10 * t - 10);
    case 'back': {
      const c1 = 1.70158;
      return (c1 + 1) * t * t * t - c1 * t * t;
    }
    case 'elastic':
      return t === 0 || t === 1 ? t : -Math.pow(2, 10 * t - 10) * Math.sin((t * 10 - 10.75) * ((2 * Math.PI) / 3));
    case 'bounce':
      return 1 - bounceOut(1 - t);
  }
}

function bounceOut(t: number) {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (t < 1 / d1) return n1 * t * t;
  if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
  if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
  return n1 * (t -= 2.625 / d1) * t + 0.984375;
}

export function ease(t: number, trans: TransitionType, type: EaseType): number {
  if (type === 'in') return easeIn(t, trans);
  if (type === 'out') return 1 - easeIn(1 - t, trans);
  return t < 0.5 ? easeIn(t * 2, trans) / 2 : 1 - easeIn((1 - t) * 2, trans) / 2;
}

type Interpolatable = number | Vector2 | Vector3 | Color;

function interpolate(a: Interpolatable, b: Interpolatable, t: number): Interpolatable {
  if (typeof a === 'number' && typeof b === 'number') return lerp(a, b, t);
  if (a instanceof Vector2 && b instanceof Vector2) return a.lerp(b, t);
  if (a instanceof Vector3 && b instanceof Vector3) return a.lerp(b, t);
  if (a instanceof Color && b instanceof Color) return a.lerp(b, t);
  return t < 1 ? a : b;
}

const cloneValue = (v: Interpolatable): Interpolatable => (typeof v === 'number' ? v : v.clone());

abstract class Tweener {
  elapsed = 0;
  abstract readonly duration: number;
  start() {}
  /** Advances; returns leftover time once finished, or -1 while running. */
  abstract step(dt: number): number;
}

export class PropertyTweener extends Tweener {
  private from: Interpolatable | null = null;
  private trans: TransitionType = 'linear';
  private easeType: EaseType = 'inOut';
  private delay = 0;
  private relative = false;
  constructor(
    private readonly target: object,
    private readonly property: string,
    private readonly to: Interpolatable,
    readonly duration: number,
  ) {
    super();
  }
  setTrans(t: TransitionType) {
    this.trans = t;
    return this;
  }
  setEase(e: EaseType) {
    this.easeType = e;
    return this;
  }
  setDelay(seconds: number) {
    this.delay = seconds;
    return this;
  }
  /** Start from this value instead of the property's current value. */
  fromValue(v: Interpolatable) {
    this.from = cloneValue(v);
    return this;
  }
  /** Treat `to` as an offset from the start value. */
  asRelative() {
    this.relative = true;
    return this;
  }
  private start0: Interpolatable | null = null;
  private end: Interpolatable | null = null;
  override start() {
    const cur = (this.target as Record<string, Interpolatable>)[this.property];
    this.start0 = this.from ?? cloneValue(cur);
    this.end = this.relative ? addValues(this.start0, this.to) : this.to;
  }
  step(dt: number) {
    this.elapsed += dt;
    const t = this.elapsed - this.delay;
    if (t < 0) return -1;
    const k = this.duration <= 0 ? 1 : Math.min(1, t / this.duration);
    (this.target as Record<string, unknown>)[this.property] = interpolate(this.start0!, this.end!, ease(k, this.trans, this.easeType));
    return k >= 1 ? t - this.duration : -1;
  }
}

function addValues(a: Interpolatable, b: Interpolatable): Interpolatable {
  if (typeof a === 'number' && typeof b === 'number') return a + b;
  if (a instanceof Vector2 && b instanceof Vector2) return a.add(b);
  if (a instanceof Vector3 && b instanceof Vector3) return a.add(b);
  return b;
}

class IntervalTweener extends Tweener {
  constructor(readonly duration: number) {
    super();
  }
  step(dt: number) {
    this.elapsed += dt;
    return this.elapsed >= this.duration ? this.elapsed - this.duration : -1;
  }
}

class CallbackTweener extends Tweener {
  readonly duration = 0;
  constructor(private readonly fn: () => void) {
    super();
  }
  step(dt: number) {
    this.fn();
    return dt;
  }
}

export class Tween {
  readonly finished = new Signal<[]>('finished');
  readonly stepFinished = new Signal<[index: number]>('stepFinished');
  private steps: Tweener[][] = [];
  private current = 0;
  private started = false;
  private running = true;
  private killed = false;
  private loops = 1;
  private loopsDone = 0;
  private nextParallel = false;
  private allParallel = false;
  speedScale = 1;

  constructor(
    /** Node the tween is bound to: it stops when the node leaves the tree. */
    readonly boundNode: Node | null = null,
  ) {}

  private add<T extends Tweener>(t: T): T {
    if (this.started) throw new Error('Cannot add steps to a tween that has already started');
    if ((this.nextParallel || this.allParallel) && this.steps.length) this.steps[this.steps.length - 1].push(t);
    else this.steps.push([t]);
    this.nextParallel = false;
    return t;
  }

  tweenProperty(target: object, property: string, to: Interpolatable, duration: number) {
    return this.add(new PropertyTweener(target, property, cloneValue(to), duration));
  }
  tweenInterval(seconds: number) {
    this.add(new IntervalTweener(seconds));
    return this;
  }
  tweenCallback(fn: () => void) {
    this.add(new CallbackTweener(fn));
    return this;
  }
  /** The next step runs at the same time as the previous one. */
  parallel() {
    this.nextParallel = true;
    return this;
  }
  setParallel(on = true) {
    this.allParallel = on;
    return this;
  }
  /** 0 = loop forever. */
  setLoops(n = 0) {
    this.loops = n;
    return this;
  }
  kill() {
    this.killed = true;
    this.running = false;
  }
  pause() {
    this.running = false;
  }
  play() {
    if (!this.killed) this.running = true;
  }
  isRunning() {
    return this.running && !this.killed;
  }
  isValid() {
    return !this.killed;
  }

  /** @internal Advances the tween; returns false once it is finished or killed. */
  advance(dt: number): boolean {
    if (this.killed) return false;
    if (!this.running) return true;
    if (this.boundNode && !this.boundNode.isInsideTree()) {
      this.kill();
      return false;
    }
    let left = dt * this.speedScale;
    let guard = 0;
    while (left >= 0 && guard++ < 1000) {
      const group = this.steps[this.current];
      if (!group) {
        this.loopsDone++;
        if (this.loops !== 0 && this.loopsDone >= this.loops) {
          this.killed = true;
          this.finished.emit();
          return false;
        }
        if (!this.steps.length) return false;
        this.current = 0;
        for (const g of this.steps) for (const t of g) t.elapsed = 0;
        continue;
      }
      if (!this.started || group.every((t) => t.elapsed === 0)) {
        this.started = true;
        for (const t of group) if (t.elapsed === 0) t.start();
      }
      let minLeft = Infinity;
      let done = true;
      for (const t of group) {
        const r = t.step(left);
        if (r < 0) done = false;
        else minLeft = Math.min(minLeft, r);
      }
      if (!done) return true;
      this.stepFinished.emit(this.current);
      this.current++;
      left = minLeft === Infinity ? 0 : minLeft;
      if (left === 0 && this.steps[this.current]) {
        // Start the next group now so zero-length steps (callbacks) chain within one frame.
        continue;
      }
      if (left === 0) {
        if (!this.steps[this.current]) continue;
        return true;
      }
    }
    return true;
  }
}
