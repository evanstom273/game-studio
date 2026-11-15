/**
 * Engine math types. Value-like classes with public mutable fields (so `node.position.x += 1`
 * works, as in Godot) and non-mutating operators that return new instances (`a.add(b)`).
 *
 * Conventions:
 *  - 2D is y-down (screen space), rotation in radians, positive = clockwise on screen.
 *  - 3D is right-handed, y-up, -z forward. Euler angles are radians in YXZ order (Godot's and
 *    three.js' 'YXZ'), so the renderer and the core always agree.
 *  - Matrices are column-major arrays of 16 numbers (three.js compatible).
 */

export const EPSILON = 1e-6;

export const clamp = (v: number, min: number, max: number) => (v < min ? min : v > max ? max : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const degToRad = (d: number) => (d * Math.PI) / 180;
export const radToDeg = (r: number) => (r * 180) / Math.PI;
/** Moves `from` towards `to` by at most `delta` (Godot's move_toward). */
export const moveToward = (from: number, to: number, delta: number) => (Math.abs(to - from) <= delta ? to : from + Math.sign(to - from) * delta);
export const approxEqual = (a: number, b: number, eps = EPSILON) => Math.abs(a - b) <= eps;

export class Vector2 {
  constructor(
    public x = 0,
    public y = 0,
  ) {}

  static get ZERO() {
    return new Vector2(0, 0);
  }
  static get ONE() {
    return new Vector2(1, 1);
  }
  static get UP() {
    return new Vector2(0, -1);
  }
  static get DOWN() {
    return new Vector2(0, 1);
  }
  static get LEFT() {
    return new Vector2(-1, 0);
  }
  static get RIGHT() {
    return new Vector2(1, 0);
  }
  static fromAngle(rad: number) {
    return new Vector2(Math.cos(rad), Math.sin(rad));
  }
  static fromArray(a: readonly number[]) {
    return new Vector2(a[0] ?? 0, a[1] ?? 0);
  }

  set(x: number, y: number) {
    this.x = x;
    this.y = y;
    return this;
  }
  copy(v: { x: number; y: number }) {
    this.x = v.x;
    this.y = v.y;
    return this;
  }
  clone() {
    return new Vector2(this.x, this.y);
  }
  add(v: Vector2) {
    return new Vector2(this.x + v.x, this.y + v.y);
  }
  sub(v: Vector2) {
    return new Vector2(this.x - v.x, this.y - v.y);
  }
  mul(v: Vector2) {
    return new Vector2(this.x * v.x, this.y * v.y);
  }
  scale(s: number) {
    return new Vector2(this.x * s, this.y * s);
  }
  neg() {
    return new Vector2(-this.x, -this.y);
  }
  dot(v: Vector2) {
    return this.x * v.x + this.y * v.y;
  }
  cross(v: Vector2) {
    return this.x * v.y - this.y * v.x;
  }
  length() {
    return Math.hypot(this.x, this.y);
  }
  lengthSquared() {
    return this.x * this.x + this.y * this.y;
  }
  normalized() {
    const l = this.length();
    return l < EPSILON ? new Vector2() : new Vector2(this.x / l, this.y / l);
  }
  distanceTo(v: Vector2) {
    return Math.hypot(v.x - this.x, v.y - this.y);
  }
  angle() {
    return Math.atan2(this.y, this.x);
  }
  angleTo(v: Vector2) {
    return Math.atan2(this.cross(v), this.dot(v));
  }
  rotated(rad: number) {
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    return new Vector2(this.x * c - this.y * s, this.x * s + this.y * c);
  }
  lerp(v: Vector2, t: number) {
    return new Vector2(lerp(this.x, v.x, t), lerp(this.y, v.y, t));
  }
  moveToward(to: Vector2, delta: number) {
    const d = to.sub(this);
    const len = d.length();
    return len <= delta || len < EPSILON ? to.clone() : this.add(d.scale(delta / len));
  }
  limitLength(max: number) {
    const l = this.length();
    return l > max && l > 0 ? this.scale(max / l) : this.clone();
  }
  equals(v: Vector2, eps = EPSILON) {
    return approxEqual(this.x, v.x, eps) && approxEqual(this.y, v.y, eps);
  }
  toArray(): [number, number] {
    return [this.x, this.y];
  }
  toString() {
    return `(${this.x}, ${this.y})`;
  }
}

export class Vector3 {
  constructor(
    public x = 0,
    public y = 0,
    public z = 0,
  ) {}

  static get ZERO() {
    return new Vector3(0, 0, 0);
  }
  static get ONE() {
    return new Vector3(1, 1, 1);
  }
  static get UP() {
    return new Vector3(0, 1, 0);
  }
  static get DOWN() {
    return new Vector3(0, -1, 0);
  }
  static get FORWARD() {
    return new Vector3(0, 0, -1);
  }
  static get BACK() {
    return new Vector3(0, 0, 1);
  }
  static get LEFT() {
    return new Vector3(-1, 0, 0);
  }
  static get RIGHT() {
    return new Vector3(1, 0, 0);
  }
  static fromArray(a: readonly number[]) {
    return new Vector3(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0);
  }

  set(x: number, y: number, z: number) {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }
  copy(v: { x: number; y: number; z: number }) {
    this.x = v.x;
    this.y = v.y;
    this.z = v.z;
    return this;
  }
  clone() {
    return new Vector3(this.x, this.y, this.z);
  }
  add(v: Vector3) {
    return new Vector3(this.x + v.x, this.y + v.y, this.z + v.z);
  }
  sub(v: Vector3) {
    return new Vector3(this.x - v.x, this.y - v.y, this.z - v.z);
  }
  mul(v: Vector3) {
    return new Vector3(this.x * v.x, this.y * v.y, this.z * v.z);
  }
  scale(s: number) {
    return new Vector3(this.x * s, this.y * s, this.z * s);
  }
  neg() {
    return new Vector3(-this.x, -this.y, -this.z);
  }
  dot(v: Vector3) {
    return this.x * v.x + this.y * v.y + this.z * v.z;
  }
  cross(v: Vector3) {
    return new Vector3(this.y * v.z - this.z * v.y, this.z * v.x - this.x * v.z, this.x * v.y - this.y * v.x);
  }
  length() {
    return Math.hypot(this.x, this.y, this.z);
  }
  lengthSquared() {
    return this.x * this.x + this.y * this.y + this.z * this.z;
  }
  normalized() {
    const l = this.length();
    return l < EPSILON ? new Vector3() : new Vector3(this.x / l, this.y / l, this.z / l);
  }
  distanceTo(v: Vector3) {
    return Math.hypot(v.x - this.x, v.y - this.y, v.z - this.z);
  }
  lerp(v: Vector3, t: number) {
    return new Vector3(lerp(this.x, v.x, t), lerp(this.y, v.y, t), lerp(this.z, v.z, t));
  }
  moveToward(to: Vector3, delta: number) {
    const d = to.sub(this);
    const len = d.length();
    return len <= delta || len < EPSILON ? to.clone() : this.add(d.scale(delta / len));
  }
  limitLength(max: number) {
    const l = this.length();
    return l > max && l > 0 ? this.scale(max / l) : this.clone();
  }
  /** Rotates this vector by `q`. */
  rotated(q: Quaternion) {
    return q.rotate(this);
  }
  equals(v: Vector3, eps = EPSILON) {
    return approxEqual(this.x, v.x, eps) && approxEqual(this.y, v.y, eps) && approxEqual(this.z, v.z, eps);
  }
  toArray(): [number, number, number] {
    return [this.x, this.y, this.z];
  }
  toString() {
    return `(${this.x}, ${this.y}, ${this.z})`;
  }
}

export class Quaternion {
  constructor(
    public x = 0,
    public y = 0,
    public z = 0,
    public w = 1,
  ) {}

  static get IDENTITY() {
    return new Quaternion();
  }

  /** From Euler angles (radians, YXZ order). */
  static fromEuler(e: { x: number; y: number; z: number }) {
    const c1 = Math.cos(e.x / 2);
    const c2 = Math.cos(e.y / 2);
    const c3 = Math.cos(e.z / 2);
    const s1 = Math.sin(e.x / 2);
    const s2 = Math.sin(e.y / 2);
    const s3 = Math.sin(e.z / 2);
    return new Quaternion(s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 - s1 * s2 * c3, c1 * c2 * c3 + s1 * s2 * s3);
  }

  static fromAxisAngle(axis: Vector3, angle: number) {
    const a = axis.normalized();
    const s = Math.sin(angle / 2);
    return new Quaternion(a.x * s, a.y * s, a.z * s, Math.cos(angle / 2));
  }

  /** Euler angles (radians, YXZ order). */
  toEuler(): Vector3 {
    return Mat4.compose(Vector3.ZERO, this, Vector3.ONE).decompose().rotation;
  }

  multiply(q: Quaternion) {
    const { x: ax, y: ay, z: az, w: aw } = this;
    const { x: bx, y: by, z: bz, w: bw } = q;
    return new Quaternion(ax * bw + aw * bx + ay * bz - az * by, ay * bw + aw * by + az * bx - ax * bz, az * bw + aw * bz + ax * by - ay * bx, aw * bw - ax * bx - ay * by - az * bz);
  }

  inverse() {
    const l = this.x * this.x + this.y * this.y + this.z * this.z + this.w * this.w || 1;
    return new Quaternion(-this.x / l, -this.y / l, -this.z / l, this.w / l);
  }

  normalized() {
    const l = Math.hypot(this.x, this.y, this.z, this.w) || 1;
    return new Quaternion(this.x / l, this.y / l, this.z / l, this.w / l);
  }

  rotate(v: Vector3) {
    // v' = q * v * q^-1, expanded.
    const { x, y, z, w } = this;
    const ix = w * v.x + y * v.z - z * v.y;
    const iy = w * v.y + z * v.x - x * v.z;
    const iz = w * v.z + x * v.y - y * v.x;
    const iw = -x * v.x - y * v.y - z * v.z;
    return new Vector3(ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x);
  }

  slerp(q: Quaternion, t: number) {
    let { x, y, z, w } = q;
    let cos = this.x * x + this.y * y + this.z * z + this.w * w;
    if (cos < 0) {
      cos = -cos;
      x = -x;
      y = -y;
      z = -z;
      w = -w;
    }
    if (cos > 1 - EPSILON) return new Quaternion(lerp(this.x, x, t), lerp(this.y, y, t), lerp(this.z, z, t), lerp(this.w, w, t)).normalized();
    const theta = Math.acos(cos);
    const sin = Math.sin(theta);
    const a = Math.sin((1 - t) * theta) / sin;
    const b = Math.sin(t * theta) / sin;
    return new Quaternion(this.x * a + x * b, this.y * a + y * b, this.z * a + z * b, this.w * a + w * b);
  }

  clone() {
    return new Quaternion(this.x, this.y, this.z, this.w);
  }
  toArray(): [number, number, number, number] {
    return [this.x, this.y, this.z, this.w];
  }
}

/** Column-major 4x4 matrix (affine use). */
export class Mat4 {
  readonly m: number[];
  constructor(m?: readonly number[]) {
    this.m = m ? [...m] : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  }

  static identity() {
    return new Mat4();
  }

  /** position · rotation (Euler YXZ radians, or a quaternion) · scale. */
  static compose(position: Vector3, rotation: { x: number; y: number; z: number } | Quaternion, scale: Vector3) {
    const q = rotation instanceof Quaternion ? rotation : Quaternion.fromEuler(rotation);
    const { x, y, z, w } = q;
    const x2 = x + x;
    const y2 = y + y;
    const z2 = z + z;
    const xx = x * x2;
    const xy = x * y2;
    const xz = x * z2;
    const yy = y * y2;
    const yz = y * z2;
    const zz = z * z2;
    const wx = w * x2;
    const wy = w * y2;
    const wz = w * z2;
    const { x: sx, y: sy, z: sz } = scale;
    return new Mat4([
      (1 - (yy + zz)) * sx,
      (xy + wz) * sx,
      (xz - wy) * sx,
      0,
      (xy - wz) * sy,
      (1 - (xx + zz)) * sy,
      (yz + wx) * sy,
      0,
      (xz + wy) * sz,
      (yz - wx) * sz,
      (1 - (xx + yy)) * sz,
      0,
      position.x,
      position.y,
      position.z,
      1,
    ]);
  }

  multiply(b: Mat4) {
    const a = this.m;
    const o = b.m;
    const r = new Array<number>(16);
    for (let col = 0; col < 4; col++) {
      for (let row = 0; row < 4; row++) {
        r[col * 4 + row] = a[row] * o[col * 4] + a[4 + row] * o[col * 4 + 1] + a[8 + row] * o[col * 4 + 2] + a[12 + row] * o[col * 4 + 3];
      }
    }
    return new Mat4(r);
  }

  invert() {
    const m = this.m;
    const [n11, n21, n31, n41, n12, n22, n32, n42, n13, n23, n33, n43, n14, n24, n34, n44] = m;
    const t11 = n23 * n34 * n42 - n24 * n33 * n42 + n24 * n32 * n43 - n22 * n34 * n43 - n23 * n32 * n44 + n22 * n33 * n44;
    const t12 = n14 * n33 * n42 - n13 * n34 * n42 - n14 * n32 * n43 + n12 * n34 * n43 + n13 * n32 * n44 - n12 * n33 * n44;
    const t13 = n13 * n24 * n42 - n14 * n23 * n42 + n14 * n22 * n43 - n12 * n24 * n43 - n13 * n22 * n44 + n12 * n23 * n44;
    const t14 = n14 * n23 * n32 - n13 * n24 * n32 - n14 * n22 * n33 + n12 * n24 * n33 + n13 * n22 * n34 - n12 * n23 * n34;
    const det = n11 * t11 + n21 * t12 + n31 * t13 + n41 * t14;
    if (det === 0) return new Mat4([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const d = 1 / det;
    return new Mat4([
      t11 * d,
      (n24 * n33 * n41 - n23 * n34 * n41 - n24 * n31 * n43 + n21 * n34 * n43 + n23 * n31 * n44 - n21 * n33 * n44) * d,
      (n22 * n34 * n41 - n24 * n32 * n41 + n24 * n31 * n42 - n21 * n34 * n42 - n22 * n31 * n44 + n21 * n32 * n44) * d,
      (n23 * n32 * n41 - n22 * n33 * n41 - n23 * n31 * n42 + n21 * n33 * n42 + n22 * n31 * n43 - n21 * n32 * n43) * d,
      t12 * d,
      (n13 * n34 * n41 - n14 * n33 * n41 + n14 * n31 * n43 - n11 * n34 * n43 - n13 * n31 * n44 + n11 * n33 * n44) * d,
      (n14 * n32 * n41 - n12 * n34 * n41 - n14 * n31 * n42 + n11 * n34 * n42 + n12 * n31 * n44 - n11 * n32 * n44) * d,
      (n12 * n33 * n41 - n13 * n32 * n41 + n13 * n31 * n42 - n11 * n33 * n42 - n12 * n31 * n43 + n11 * n32 * n43) * d,
      t13 * d,
      (n14 * n23 * n41 - n13 * n24 * n41 - n14 * n21 * n43 + n11 * n24 * n43 + n13 * n21 * n44 - n11 * n23 * n44) * d,
      (n12 * n24 * n41 - n14 * n22 * n41 + n14 * n21 * n42 - n11 * n24 * n42 - n12 * n21 * n44 + n11 * n22 * n44) * d,
      (n13 * n22 * n41 - n12 * n23 * n41 - n13 * n21 * n42 + n11 * n23 * n42 + n12 * n21 * n43 - n11 * n22 * n43) * d,
      t14 * d,
      (n13 * n24 * n31 - n14 * n23 * n31 + n14 * n21 * n33 - n11 * n24 * n33 - n13 * n21 * n34 + n11 * n23 * n34) * d,
      (n14 * n22 * n31 - n12 * n24 * n31 - n14 * n21 * n32 + n11 * n24 * n32 + n12 * n21 * n34 - n11 * n22 * n34) * d,
      (n12 * n23 * n31 - n13 * n22 * n31 + n13 * n21 * n32 - n11 * n23 * n32 - n12 * n21 * n33 + n11 * n22 * n33) * d,
    ]);
  }

  transformPoint(v: Vector3) {
    const m = this.m;
    return new Vector3(m[0] * v.x + m[4] * v.y + m[8] * v.z + m[12], m[1] * v.x + m[5] * v.y + m[9] * v.z + m[13], m[2] * v.x + m[6] * v.y + m[10] * v.z + m[14]);
  }

  transformDirection(v: Vector3) {
    const m = this.m;
    return new Vector3(m[0] * v.x + m[4] * v.y + m[8] * v.z, m[1] * v.x + m[5] * v.y + m[9] * v.z, m[2] * v.x + m[6] * v.y + m[10] * v.z);
  }

  getPosition() {
    return new Vector3(this.m[12], this.m[13], this.m[14]);
  }

  /** Splits into position, Euler rotation (YXZ, radians), quaternion and scale. */
  decompose(): { position: Vector3; rotation: Vector3; quaternion: Quaternion; scale: Vector3 } {
    const m = this.m;
    let sx = Math.hypot(m[0], m[1], m[2]);
    const sy = Math.hypot(m[4], m[5], m[6]);
    const sz = Math.hypot(m[8], m[9], m[10]);
    const det = m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
    if (det < 0) sx = -sx;
    const ix = sx ? 1 / sx : 0;
    const iy = sy ? 1 / sy : 0;
    const iz = sz ? 1 / sz : 0;
    const m11 = m[0] * ix;
    const m21 = m[1] * ix;
    const m31 = m[2] * ix;
    const m12 = m[4] * iy;
    const m22 = m[5] * iy;
    const m32 = m[6] * iy;
    const m13 = m[8] * iz;
    const m23 = m[9] * iz;
    const m33 = m[10] * iz;
    // Euler YXZ from the rotation matrix.
    const rx = Math.asin(-clamp(m23, -1, 1));
    let ry: number;
    let rz: number;
    if (Math.abs(m23) < 0.9999999) {
      ry = Math.atan2(m13, m33);
      rz = Math.atan2(m21, m22);
    } else {
      ry = Math.atan2(-m31, m11);
      rz = 0;
    }
    // Quaternion from the rotation matrix.
    const trace = m11 + m22 + m33;
    let q: Quaternion;
    if (trace > 0) {
      const s = 0.5 / Math.sqrt(trace + 1);
      q = new Quaternion((m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s);
    } else if (m11 > m22 && m11 > m33) {
      const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
      q = new Quaternion(0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s);
    } else if (m22 > m33) {
      const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
      q = new Quaternion((m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s);
    } else {
      const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
      q = new Quaternion((m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s);
    }
    return { position: new Vector3(m[12], m[13], m[14]), rotation: new Vector3(rx, ry, rz), quaternion: q, scale: new Vector3(sx, sy, sz) };
  }
}

/** 2D affine transform: x' = a·x + c·y + tx, y' = b·x + d·y + ty (same layout as PixiJS' Matrix). */
export class Transform2D {
  constructor(
    public a = 1,
    public b = 0,
    public c = 0,
    public d = 1,
    public tx = 0,
    public ty = 0,
  ) {}

  static identity() {
    return new Transform2D();
  }

  static compose(position: Vector2, rotation: number, scale: Vector2) {
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    return new Transform2D(cos * scale.x, sin * scale.x, -sin * scale.y, cos * scale.y, position.x, position.y);
  }

  /** this ∘ t: applies `t` first, then this. */
  multiply(t: Transform2D) {
    return new Transform2D(
      this.a * t.a + this.c * t.b,
      this.b * t.a + this.d * t.b,
      this.a * t.c + this.c * t.d,
      this.b * t.c + this.d * t.d,
      this.a * t.tx + this.c * t.ty + this.tx,
      this.b * t.tx + this.d * t.ty + this.ty,
    );
  }

  invert() {
    const det = this.a * this.d - this.b * this.c;
    if (det === 0) return new Transform2D(0, 0, 0, 0, 0, 0);
    const id = 1 / det;
    return new Transform2D(this.d * id, -this.b * id, -this.c * id, this.a * id, (this.c * this.ty - this.d * this.tx) * id, (this.b * this.tx - this.a * this.ty) * id);
  }

  apply(p: { x: number; y: number }) {
    return new Vector2(this.a * p.x + this.c * p.y + this.tx, this.b * p.x + this.d * p.y + this.ty);
  }

  applyVector(p: { x: number; y: number }) {
    return new Vector2(this.a * p.x + this.c * p.y, this.b * p.x + this.d * p.y);
  }

  get origin() {
    return new Vector2(this.tx, this.ty);
  }
  get rotation() {
    return Math.atan2(this.b, this.a);
  }
  get scale() {
    const det = this.a * this.d - this.b * this.c;
    return new Vector2(Math.hypot(this.a, this.b), Math.sign(det || 1) * Math.hypot(this.c, this.d));
  }
}

export class Color {
  constructor(
    public r = 1,
    public g = 1,
    public b = 1,
    public a = 1,
  ) {}

  static get WHITE() {
    return new Color(1, 1, 1, 1);
  }
  static get BLACK() {
    return new Color(0, 0, 0, 1);
  }
  static get TRANSPARENT() {
    return new Color(0, 0, 0, 0);
  }

  /** Parses '#rgb', '#rgba', '#rrggbb' or '#rrggbbaa'. Throws on anything else. */
  static fromHex(hex: string) {
    const parsed = parseHexColor(hex);
    if (!parsed) throw new Error(`Invalid colour "${hex}" (expected #rgb, #rrggbb or #rrggbbaa)`);
    return parsed;
  }

  static fromNumber(n: number, alpha = 1) {
    return new Color(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, alpha);
  }

  toHex(includeAlpha = this.a < 1) {
    const h = (v: number) =>
      Math.round(clamp(v, 0, 1) * 255)
        .toString(16)
        .padStart(2, '0');
    return `#${h(this.r)}${h(this.g)}${h(this.b)}${includeAlpha ? h(this.a) : ''}`;
  }

  /** 0xRRGGBB, for renderers. */
  toNumber() {
    return (Math.round(clamp(this.r, 0, 1) * 255) << 16) | (Math.round(clamp(this.g, 0, 1) * 255) << 8) | Math.round(clamp(this.b, 0, 1) * 255);
  }

  lerp(c: Color, t: number) {
    return new Color(lerp(this.r, c.r, t), lerp(this.g, c.g, t), lerp(this.b, c.b, t), lerp(this.a, c.a, t));
  }
  clone() {
    return new Color(this.r, this.g, this.b, this.a);
  }
  equals(c: Color, eps = 1 / 512) {
    return approxEqual(this.r, c.r, eps) && approxEqual(this.g, c.g, eps) && approxEqual(this.b, c.b, eps) && approxEqual(this.a, c.a, eps);
  }
  toString() {
    return this.toHex(true);
  }
}

export function parseHexColor(hex: string): Color | null {
  const m = /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex.trim());
  if (!m) return null;
  let s = m[1];
  if (s.length <= 4) s = [...s].map((ch) => ch + ch).join('');
  const n = (i: number) => parseInt(s.slice(i, i + 2), 16) / 255;
  return new Color(n(0), n(2), n(4), s.length === 8 ? n(6) : 1);
}

/** Axis-aligned rectangle. */
export class Rect2 {
  constructor(
    public x = 0,
    public y = 0,
    public width = 0,
    public height = 0,
  ) {}

  static fromPoints(points: readonly { x: number; y: number }[]) {
    if (!points.length) return new Rect2();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of points) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    return new Rect2(minX, minY, maxX - minX, maxY - minY);
  }

  get end() {
    return new Vector2(this.x + this.width, this.y + this.height);
  }
  get center() {
    return new Vector2(this.x + this.width / 2, this.y + this.height / 2);
  }
  hasPoint(p: { x: number; y: number }) {
    return p.x >= this.x && p.y >= this.y && p.x <= this.x + this.width && p.y <= this.y + this.height;
  }
  intersects(r: Rect2) {
    return this.x < r.x + r.width && r.x < this.x + this.width && this.y < r.y + r.height && r.y < this.y + this.height;
  }
}
