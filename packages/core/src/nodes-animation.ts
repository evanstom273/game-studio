/**
 * AnimationPlayer: plays keyframed animations stored as data (see animation-data.ts for the
 * format). Value tracks set properties on nodes relative to the player's parent: numbers, vectors
 * and colours are interpolated (linear, nearest or cubic); booleans, strings, enums and resources
 * switch at keys. Method tracks call a method when the playhead passes a key.
 *
 * There is no timeline editor: animations are edited as JSON in the inspector or through MCP.
 */
import { Color, Signal, Vector2, Vector3, errorMessage, type Json } from '@gs/shared';
import { Node } from './node';
import { Resource } from './resources';
import { sampleTrack, type AnimValue, type AnimationData, type AnimationLibrary, type AnimationTrackData } from './animation-data';

interface CompiledTrack {
  data: AnimationTrackData;
  target: Node | null;
  /** Keys sorted by time, values converted to the property's runtime type. */
  keys: { time: number; value: AnimValue; raw: Json }[];
}

/** Converts a stored key value to the runtime type of the property's current value. */
function toRuntime(current: unknown, value: Json, node: Node): AnimValue {
  if (current instanceof Vector2 && Array.isArray(value)) return Vector2.fromArray(value as number[]);
  if (current instanceof Vector3 && Array.isArray(value)) return Vector3.fromArray(value as number[]);
  if (current instanceof Color && typeof value === 'string') return Color.fromHex(value);
  if (Array.isArray(current) && current[0] instanceof Vector2 && Array.isArray(value)) return (value as number[][]).map((p) => Vector2.fromArray(p));
  if ((current instanceof Resource || current === null) && typeof value === 'string' && /\.\w+$/.test(value)) {
    const loader = node.tree?.resources;
    if (loader?.exists(value)) return loader.load(value);
  }
  return value as AnimValue;
}

const copy = (v: AnimValue): AnimValue => (v instanceof Vector2 || v instanceof Vector3 || v instanceof Color ? v.clone() : Array.isArray(v) ? v.map((x) => (x instanceof Vector2 ? x.clone() : x)) : v);

export class AnimationPlayer extends Node {
  static override readonly typeName: string = 'AnimationPlayer';
  /** name → { length, loop, tracks }. */
  animations: AnimationLibrary = {};
  /** Animation to play when the scene starts ("" = none). */
  autoplay = '';
  speedScale = 1;
  /** Advance on frames (idle) or on physics ticks (for animating physics bodies). */
  callbackMode: 'idle' | 'physics' = 'idle';
  readonly animationStarted = new Signal<[name: string]>('animationStarted');
  readonly animationFinished = new Signal<[name: string]>('animationFinished');

  private current = '';
  private pos = 0;
  private playing = false;
  private customSpeed = 1;
  private queued: string[] = [];
  private compiledFor: AnimationLibrary | null = null;
  private compiled = new Map<string, CompiledTrack[]>();
  private warned = new Set<string>();

  /** Name of the playing (or paused) animation, "" when none. Setting it plays that animation. */
  get currentAnimation() {
    return this.current;
  }
  set currentAnimation(name: string) {
    if (name) this.play(name);
    else this.stop();
  }
  get currentAnimationPosition() {
    return this.pos;
  }
  get currentAnimationLength() {
    return this.animations[this.current]?.length ?? 0;
  }
  isPlaying() {
    return this.playing;
  }
  hasAnimation(name: string) {
    return Object.prototype.hasOwnProperty.call(this.animations, name);
  }
  getAnimationList() {
    return Object.keys(this.animations);
  }
  getAnimation(name: string): AnimationData | null {
    return this.hasAnimation(name) ? this.animations[name] : null;
  }
  /** Adds or replaces an animation (scripts can build animations at runtime). */
  addAnimation(name: string, data: AnimationData) {
    this.animations = { ...this.animations, [name]: data };
  }
  removeAnimation(name: string) {
    const next = { ...this.animations };
    delete next[name];
    this.animations = next;
  }

  /** Plays `name` (default: the current one) from the start, or resumes it if it is the paused current animation. */
  play(name = this.current, customSpeed = 1, fromEnd = false) {
    const anim = this.animations[name];
    if (!anim) {
      this.warnOnce(`missing:${name}`, name ? `AnimationPlayer "${this.name}" has no animation "${name}". It has: ${this.getAnimationList().join(', ') || '(none)'}` : `AnimationPlayer "${this.name}": play() needs an animation name`);
      return;
    }
    const resume = name === this.current && !this.playing && this.pos > 0 && this.pos < anim.length && !fromEnd && customSpeed === this.customSpeed;
    this.customSpeed = customSpeed;
    if (!resume) {
      const changed = name !== this.current;
      this.current = name;
      this.pos = fromEnd || customSpeed < 0 ? anim.length : 0;
      if (changed) this.queued = this.queued.filter((q) => q !== name);
    }
    this.playing = true;
    // Method keys exactly at the starting point fire now (later ones as the playhead passes them).
    if (!resume) {
      if (customSpeed >= 0) this.fireMethods(-1, this.pos, true);
      else this.fireMethods(this.pos, this.pos + 1, false);
    }
    this.apply(this.pos);
    this.animationStarted.emit(name);
  }
  playBackwards(name = this.current) {
    this.play(name, -1, true);
  }
  /** Plays `name` after the current animation finishes. */
  queue(name: string) {
    if (!this.playing) this.play(name);
    else this.queued.push(name);
  }
  clearQueue() {
    this.queued = [];
  }
  pause() {
    this.playing = false;
  }
  /** Stops and rewinds. With keepState the properties keep their current values; otherwise they go back to the start of the animation. */
  stop(keepState = false) {
    const name = this.current;
    this.playing = false;
    this.pos = 0;
    this.customSpeed = 1;
    this.queued = [];
    if (!keepState && name && this.animations[name]) this.apply(0);
  }
  /** Jumps to `seconds` in the current animation (applying it right away when `update`). */
  seek(seconds: number, update = true) {
    const anim = this.animations[this.current];
    if (!anim) return;
    this.pos = Math.min(Math.max(0, seconds), anim.length);
    if (update) this.apply(this.pos);
  }
  /** Advances the current animation by `delta` seconds (also while paused). */
  advance(delta: number) {
    this.step(delta, true);
  }

  override __ready() {
    super.__ready();
    if (this.autoplay && this.hasAnimation(this.autoplay)) this.play(this.autoplay);
  }
  override __process(delta: number) {
    super.__process(delta);
    if (this.callbackMode === 'idle') this.step(delta * this.speedScale, false);
  }
  override __physicsProcess(delta: number) {
    super.__physicsProcess(delta);
    if (this.callbackMode === 'physics') this.step(delta * this.speedScale, false);
  }

  private step(delta: number, force: boolean) {
    if (!this.playing && !force) return;
    const name = this.current;
    const anim = this.animations[name];
    if (!anim) {
      this.playing = false;
      return;
    }
    const len = anim.length;
    const d = delta * this.customSpeed;
    const from = this.pos;
    let to = from + d;
    let finished = false;
    if (d >= 0) {
      if (to >= len) {
        if (anim.loop && len > 0) {
          this.fireMethods(from, len, true);
          to %= len;
          this.fireMethods(-1, to, true);
        } else {
          to = len;
          this.fireMethods(from, to, true);
          finished = true;
        }
      } else this.fireMethods(from, to, true);
    } else if (to <= 0) {
      if (anim.loop && len > 0) {
        this.fireMethods(0, from, false);
        to = len + (to % len);
        this.fireMethods(to, len + 1, false);
      } else {
        to = 0;
        this.fireMethods(to, from, false);
        finished = true;
      }
    } else this.fireMethods(to, from, false);
    this.pos = to;
    this.apply(to);
    if (finished && this.playing) {
      this.playing = false;
      this.animationFinished.emit(name);
      const next = this.queued.shift();
      if (next) this.play(next);
    }
  }

  private animRoot(): Node {
    return this.parent ?? this;
  }

  private tracks(name: string): CompiledTrack[] {
    if (this.compiledFor !== this.animations) {
      this.compiled.clear();
      this.compiledFor = this.animations;
    }
    let list = this.compiled.get(name);
    if (!list) {
      const anim = this.animations[name];
      list = (anim?.tracks ?? []).map((data) => ({ data, target: null, keys: [] }));
      this.compiled.set(name, list);
    }
    // (Re)resolve targets: nodes may have been added, freed or replaced since.
    for (const t of list) {
      if (t.target && t.target.isInsideTree() === this.isInsideTree() && !t.target.isFreed()) continue;
      t.target = this.animRoot().getNodeOrNull(t.data.path || '.');
      t.keys = [];
      if (!t.target) {
        this.warnOnce(`path:${name}:${t.data.path}`, `AnimationPlayer "${this.name}", animation "${name}": no node at "${t.data.path}" (paths are relative to ${this.animRoot().name})`);
        continue;
      }
      if (t.data.property) {
        const target = t.target as unknown as Record<string, unknown>;
        if (!(t.data.property in target)) {
          this.warnOnce(`prop:${name}:${t.data.path}:${t.data.property}`, `AnimationPlayer "${this.name}", animation "${name}": ${t.target.name} has no property "${t.data.property}"`);
          t.target = null;
          continue;
        }
        const current = target[t.data.property];
        t.keys = t.data.keys
          .map(([time, raw]) => ({ time, raw, value: toRuntime(current, raw, t.target!) }))
          .sort((a, b) => a.time - b.time);
      } else t.keys = t.data.keys.map(([time, raw]) => ({ time, raw, value: raw as AnimValue })).sort((a, b) => a.time - b.time);
    }
    return list;
  }

  /** Sets every value track's property to its value at `time`. */
  private apply(time: number) {
    for (const t of this.tracks(this.current)) {
      if (!t.target || !t.data.property) continue;
      const v = sampleTrack(t.keys, time, t.data.interpolation ?? 'linear');
      if (v === undefined) continue;
      try {
        (t.target as unknown as Record<string, unknown>)[t.data.property] = copy(v);
      } catch (e) {
        this.warnOnce(`set:${t.data.path}:${t.data.property}`, `AnimationPlayer "${this.name}": setting ${t.target.name}.${t.data.property} failed: ${errorMessage(e)}`);
      }
    }
  }

  /** Calls method-track keys with time in (a, b] (forward) or [a, b) (backward). */
  private fireMethods(a: number, b: number, forward: boolean) {
    for (const t of this.tracks(this.current)) {
      if (!t.target || !t.data.method) continue;
      for (const k of t.keys) {
        const hit = forward ? k.time > a && k.time <= b : k.time >= a && k.time < b;
        if (!hit) continue;
        const fn = (t.target as unknown as Record<string, unknown>)[t.data.method];
        if (typeof fn !== 'function') {
          this.warnOnce(`method:${t.data.path}:${t.data.method}`, `AnimationPlayer "${this.name}": ${t.target.name} has no method "${t.data.method}"`);
          continue;
        }
        try {
          (fn as (...args: unknown[]) => void).apply(t.target, Array.isArray(k.raw) ? k.raw : []);
        } catch (e) {
          this.tree?.reportError(e, t.target, `animation method ${t.data.method}`);
        }
      }
    }
  }

  private warnOnce(key: string, message: string) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.tree?.log('warn', message, this.getPath());
  }
}
