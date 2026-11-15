/**
 * Animation data: what an AnimationPlayer stores, how it is validated and how values between keys
 * are computed. Pure data and maths (no nodes), so the command layer and MCP validate animations
 * exactly like the runtime plays them.
 *
 * Stored form (the AnimationPlayer's `animations` property):
 *
 *   { "walk": { "length": 1, "loop": true, "tracks": [
 *       { "path": "Sprite", "property": "position", "interpolation": "linear",
 *         "keys": [[0, [0, 0]], [0.5, [0, -12]], [1, [0, 0]]] },
 *       { "path": ".", "method": "footstep", "keys": [[0.5, []]] } ] } }
 *
 * Track paths are relative to the AnimationPlayer's parent (Godot's default root node). Values use
 * the stored JSON form of the property: numbers, [x, y], [x, y, z], "#rrggbb", booleans, strings.
 */
import { Color, Vector2, Vector3, isPlainObject, lerp, type Json } from '@gs/shared';

export type Interpolation = 'linear' | 'nearest' | 'cubic';
export const INTERPOLATIONS: readonly Interpolation[] = ['linear', 'nearest', 'cubic'];

export interface AnimationTrackData {
  /** Node path relative to the player's parent ("." = the parent itself). */
  path: string;
  /** Property to animate (value track)… */
  property?: string;
  /** …or method to call when the playhead passes a key (method track; the key value is the argument list). */
  method?: string;
  interpolation?: Interpolation;
  /** [time in seconds, value] pairs. */
  keys: [number, Json][];
}

export interface AnimationData {
  /** Seconds. */
  length: number;
  loop?: boolean;
  tracks: AnimationTrackData[];
}

export type AnimationLibrary = Record<string, AnimationData>;

const MAX_BYTES = 1_000_000;

/** Returns null when `v` is a valid animation library, otherwise a short reason. */
export function validateAnimationLibrary(v: unknown): string | null {
  if (!isPlainObject(v)) return 'must be an object of animations: { "name": { "length": 1, "loop": false, "tracks": [...] } }';
  try {
    if (JSON.stringify(v).length > MAX_BYTES) return 'is too large (1 MB at most)';
  } catch {
    return 'must be plain JSON';
  }
  for (const [name, anim] of Object.entries(v)) {
    const where = `animation "${name}"`;
    if (!name.trim() || name.length > 100) return `animation names must be 1–100 characters`;
    if (!isPlainObject(anim)) return `${where} must be an object with length, loop and tracks`;
    for (const k of Object.keys(anim)) if (!['length', 'loop', 'tracks'].includes(k)) return `${where} has an unknown field "${k}" (use length, loop, tracks)`;
    if (typeof anim.length !== 'number' || !Number.isFinite(anim.length) || anim.length <= 0 || anim.length > 3600) return `${where}: length must be a number of seconds between 0 and 3600`;
    if (anim.loop !== undefined && typeof anim.loop !== 'boolean') return `${where}: loop must be true or false`;
    if (!Array.isArray(anim.tracks) || anim.tracks.length > 256) return `${where}: tracks must be a list (256 at most)`;
    for (let t = 0; t < anim.tracks.length; t++) {
      const tr = anim.tracks[t];
      const at = `${where}, track ${t}`;
      if (!isPlainObject(tr)) return `${at} must be an object with path, property (or method) and keys`;
      for (const k of Object.keys(tr)) if (!['path', 'property', 'method', 'interpolation', 'keys'].includes(k)) return `${at} has an unknown field "${k}"`;
      if (typeof tr.path !== 'string' || tr.path.length > 1000) return `${at}: path must be a node path relative to the player's parent ("." for the parent)`;
      const hasProp = typeof tr.property === 'string' && tr.property.length > 0;
      const hasMethod = typeof tr.method === 'string' && tr.method.length > 0;
      if (hasProp === hasMethod) return `${at} needs either "property" or "method"`;
      if (tr.interpolation !== undefined && !INTERPOLATIONS.includes(tr.interpolation as Interpolation)) return `${at}: interpolation must be one of ${INTERPOLATIONS.join(', ')}`;
      if (!Array.isArray(tr.keys) || tr.keys.length > 10_000) return `${at}: keys must be a list of [time, value] pairs`;
      for (const key of tr.keys) {
        if (!Array.isArray(key) || key.length !== 2 || typeof key[0] !== 'number' || !Number.isFinite(key[0]) || key[0] < 0) return `${at}: each key must be [time ≥ 0, value]`;
        if (hasMethod && !Array.isArray(key[1])) return `${at}: method keys must be [time, [arguments…]]`;
      }
    }
  }
  return null;
}

// --- interpolation ------------------------------------------------------------------------------------

export type AnimValue = number | Vector2 | Vector3 | Color | boolean | string | null | object;

/** Values that blend smoothly; everything else switches at keys. */
export function isBlendable(v: unknown): v is number | Vector2 | Vector3 | Color {
  return typeof v === 'number' || v instanceof Vector2 || v instanceof Vector3 || v instanceof Color;
}

export function blendLinear<T extends number | Vector2 | Vector3 | Color>(a: T, b: T, t: number): T {
  if (typeof a === 'number' && typeof b === 'number') return lerp(a, b, t) as T;
  if (a instanceof Vector2 && b instanceof Vector2) return a.lerp(b, t) as T;
  if (a instanceof Vector3 && b instanceof Vector3) return a.lerp(b, t) as T;
  if (a instanceof Color && b instanceof Color) return a.lerp(b, t) as T;
  return (t < 1 ? a : b) as T;
}

/** Catmull-Rom through p1→p2 with neighbours p0 and p3 (component-wise). */
function catmull(p0: number, p1: number, p2: number, p3: number, t: number) {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

export function blendCubic<T extends number | Vector2 | Vector3 | Color>(p0: T, p1: T, p2: T, p3: T, t: number): T {
  if (typeof p1 === 'number') return catmull(p0 as number, p1, p2 as number, p3 as number, t) as T;
  if (p1 instanceof Vector2) {
    const [a, c, d] = [p0 as Vector2, p2 as Vector2, p3 as Vector2];
    return new Vector2(catmull(a.x, p1.x, c.x, d.x, t), catmull(a.y, p1.y, c.y, d.y, t)) as T;
  }
  if (p1 instanceof Vector3) {
    const [a, c, d] = [p0 as Vector3, p2 as Vector3, p3 as Vector3];
    return new Vector3(catmull(a.x, p1.x, c.x, d.x, t), catmull(a.y, p1.y, c.y, d.y, t), catmull(a.z, p1.z, c.z, d.z, t)) as T;
  }
  if (p1 instanceof Color) {
    const [a, c, d] = [p0 as Color, p2 as Color, p3 as Color];
    const k = (x: number) => Math.min(1, Math.max(0, x));
    return new Color(k(catmull(a.r, p1.r, c.r, d.r, t)), k(catmull(a.g, p1.g, c.g, d.g, t)), k(catmull(a.b, p1.b, c.b, d.b, t)), k(catmull(a.a, p1.a, c.a, d.a, t))) as T;
  }
  return (t < 1 ? p1 : p2) as T;
}

/**
 * The value of a track at `time`. `keys` must be sorted by time; values are already converted to
 * runtime form. Before the first key the first value holds, after the last key the last one.
 */
export function sampleTrack(keys: readonly { time: number; value: AnimValue }[], time: number, interpolation: Interpolation): AnimValue | undefined {
  if (!keys.length) return undefined;
  if (time <= keys[0].time) return keys[0].value;
  const last = keys[keys.length - 1];
  if (time >= last.time) return last.value;
  // Binary search for the segment [i, i+1] containing `time`.
  let lo = 0;
  let hi = keys.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (keys[mid].time <= time) lo = mid;
    else hi = mid;
  }
  const a = keys[lo];
  const b = keys[hi];
  const span = b.time - a.time;
  const t = span > 0 ? (time - a.time) / span : 1;
  if (interpolation === 'nearest' || !isBlendable(a.value) || !isBlendable(b.value) || a.value.constructor !== b.value.constructor) return t < 1 ? a.value : b.value;
  if (interpolation === 'cubic') {
    const p0 = (keys[lo - 1] ?? a).value;
    const p3 = (keys[hi + 1] ?? b).value;
    if (isBlendable(p0) && isBlendable(p3) && p0.constructor === a.value.constructor && p3.constructor === a.value.constructor) return blendCubic(p0, a.value, b.value, p3, t);
  }
  return blendLinear(a.value, b.value, t);
}
