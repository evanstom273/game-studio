/**
 * Baked curves for Path2D / Path3D: a polyline through the control points (optionally smoothed
 * with a Catmull-Rom spline), measured by arc length so followers move at a constant speed.
 * Works on plain number tuples so the 2D and 3D nodes share it.
 */
import { clamp } from '@gs/shared';

export type Tuple = readonly number[];

/** Segments a smoothed curve is split into, per control-point span. */
const SUBDIVISIONS = 12;

export interface CurveSample {
  /** Point on the curve. */
  point: number[];
  /** Unit direction of travel at that point (zero for degenerate curves). */
  tangent: number[];
}

export class BakedCurve {
  /** The polyline actually followed. */
  readonly points: number[][];
  /** Arc length from the start to each point. */
  private readonly lengths: number[];

  constructor(control: readonly Tuple[], closed = false, curved = false) {
    const pts = control.map((p) => [...p]);
    if (closed && pts.length > 2) pts.push([...pts[0]]);
    this.points = curved && pts.length > 2 ? smooth(pts, closed) : pts;
    this.lengths = [0];
    for (let i = 1; i < this.points.length; i++) this.lengths.push(this.lengths[i - 1] + dist(this.points[i - 1], this.points[i]));
  }

  get length(): number {
    return this.lengths[this.lengths.length - 1] ?? 0;
  }

  /** The point and direction `offset` units along the curve (clamped to its ends). */
  sample(offset: number): CurveSample {
    const pts = this.points;
    const dim = pts[0]?.length ?? 2;
    if (pts.length === 0) return { point: new Array(dim).fill(0), tangent: new Array(dim).fill(0) };
    if (pts.length === 1) return { point: [...pts[0]], tangent: new Array(dim).fill(0) };
    const d = clamp(offset, 0, this.length);
    // Binary search for the segment containing d.
    let lo = 0;
    let hi = pts.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.lengths[mid] <= d) lo = mid;
      else hi = mid;
    }
    const seg = this.lengths[hi] - this.lengths[lo];
    const t = seg > 0 ? (d - this.lengths[lo]) / seg : 0;
    const a = pts[lo];
    const b = pts[hi];
    const point = a.map((v, k) => v + (b[k] - v) * t);
    // Zero-length segments have no direction: use the nearest one that does.
    let tangent = direction(a, b);
    for (let i = lo; tangent.every((v) => v === 0) && i > 0; i--) tangent = direction(pts[i - 1], pts[i]);
    for (let i = hi; tangent.every((v) => v === 0) && i < pts.length - 1; i++) tangent = direction(pts[i], pts[i + 1]);
    return { point, tangent };
  }

  /** Offset of the curve point closest to `p`. */
  closestOffset(p: Tuple): number {
    let best = 0;
    let bestD = Infinity;
    for (let i = 1; i < this.points.length; i++) {
      const a = this.points[i - 1];
      const b = this.points[i];
      const ab = b.map((v, k) => v - a[k]);
      const len2 = ab.reduce((s, v) => s + v * v, 0);
      const t = len2 > 0 ? clamp(ab.reduce((s, v, k) => s + v * (p[k] - a[k]), 0) / len2, 0, 1) : 0;
      const q = a.map((v, k) => v + ab[k] * t);
      const d = dist(q, p);
      if (d < bestD) {
        bestD = d;
        best = this.lengths[i - 1] + t * Math.sqrt(len2);
      }
    }
    return best;
  }
}

function dist(a: Tuple, b: Tuple) {
  let s = 0;
  for (let k = 0; k < a.length; k++) s += (b[k] - a[k]) ** 2;
  return Math.sqrt(s);
}

function direction(a: Tuple, b: Tuple) {
  const d = dist(a, b);
  return d > 0 ? a.map((v, k) => (b[k] - v) / d) : a.map(() => 0);
}

/** Centripetal-free (uniform) Catmull-Rom through all points. */
function smooth(pts: number[][], closed: boolean): number[][] {
  const n = pts.length;
  const at = (i: number) => {
    if (closed) return pts[((i % (n - 1)) + (n - 1)) % (n - 1)];
    return pts[clamp(i, 0, n - 1)];
  };
  const out: number[][] = [];
  for (let i = 0; i < n - 1; i++) {
    const p0 = at(i - 1);
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = at(i + 2);
    for (let s = 0; s < SUBDIVISIONS; s++) {
      const t = s / SUBDIVISIONS;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push(p1.map((v, k) => 0.5 * (2 * v + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * v + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * v - 3 * p2[k] + p3[k]) * t3)));
    }
  }
  out.push([...pts[n - 1]]);
  return out;
}

/** Godot's fposmod: a modulo that is never negative. */
export function fposmod(x: number, m: number) {
  if (m <= 0) return 0;
  const r = x % m;
  return r < 0 ? r + m : r;
}
