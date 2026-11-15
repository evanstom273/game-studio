/**
 * CPU particles (Godot's CPUParticles2D / CPUParticles3D). The simulation runs here, in core, so it
 * works headless and is the same in the editor preview and the game; renderers only draw the
 * particle arrays.
 *
 * Emission follows Godot: `amount` particle slots are emitted once per `lifetime` cycle, spread
 * evenly over the cycle (explosiveness 0) or all at once (explosiveness 1). Particles live in world
 * coordinates unless `localCoords` is on, so a moving emitter leaves a trail.
 */
import { Color, Signal, Transform2D, Vector2, Vector3, clamp, degToRad, lerp } from '@gs/shared';
import { Node2D } from './nodes2d';
import { Node3D } from './nodes3d';
import type { Texture } from './resources';

/** Small fast deterministic PRNG (xorshift32), so tests and replays are reproducible. */
export class Rng {
  private s: number;
  constructor(seed = 0x9e3779b9) {
    this.s = seed >>> 0 || 1;
  }
  next() {
    let x = this.s;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.s = x >>> 0;
    return this.s / 4294967296;
  }
  range(a: number, b: number) {
    return a + (b - a) * this.next();
  }
}

let seedCounter = 1;

export type EmissionShape = 'point' | 'sphere' | 'box';

/** Where a particle starts and where it goes, in the emitter's local space (set by the node). */
interface Spawn {
  pos: number[];
  vel: number[];
}

/** Struct-of-arrays particle storage shared by the 2D and 3D emitters. */
export class ParticleSim {
  alive: Uint8Array = new Uint8Array(0);
  age: Float32Array = new Float32Array(0);
  life: Float32Array = new Float32Array(0);
  scale: Float32Array = new Float32Array(0);
  /** Rotation in radians (2D: random start angle for textured particles). */
  angle: Float32Array = new Float32Array(0);
  pos: Float64Array = new Float64Array(0);
  vel: Float64Array = new Float64Array(0);
  /** Seconds into the current emission cycle (starts just below 0 so phase-0 particles emit on the first step). */
  time = -1e-9;
  cycles = 0;

  constructor(readonly dim: 2 | 3) {}

  resize(amount: number) {
    const n = Math.max(0, Math.floor(amount));
    if (n === this.alive.length) return;
    this.alive = new Uint8Array(n);
    this.age = new Float32Array(n);
    this.life = new Float32Array(n);
    this.scale = new Float32Array(n);
    this.angle = new Float32Array(n);
    this.pos = new Float64Array(n * this.dim);
    this.vel = new Float64Array(n * this.dim);
  }

  get count() {
    return this.alive.length;
  }

  aliveCount() {
    let c = 0;
    for (let i = 0; i < this.alive.length; i++) c += this.alive[i];
    return c;
  }

  restart() {
    this.alive.fill(0);
    this.time = -1e-9;
    this.cycles = 0;
  }

  /**
   * Advances by `delta`: emits the slots whose phase comes up (unless `emitting` is false), then
   * moves every live particle. `spawn(i)` fills in a new particle's start (global or local).
   */
  step(delta: number, p: { emitting: boolean; lifetime: number; explosiveness: number; oneShot: boolean; gravity: readonly number[]; damping: number }, spawn: (i: number) => Spawn & { life: number; scale: number; angle: number }) {
    const n = this.count;
    const L = Math.max(1e-3, p.lifetime);
    // Move the particles that already exist, then emit (new ones only live for part of this step).
    for (let i = 0; i < n; i++) if (this.alive[i]) this.integrate(i, delta, p.gravity, p.damping);
    if (p.emitting && n > 0) {
      const t0 = this.time;
      const t1 = t0 + delta;
      const span = (1 - clamp(p.explosiveness, 0, 1)) * L;
      for (let i = 0; i < n; i++) {
        const phase = (i / n) * span;
        const k0 = Math.floor((t0 - phase) / L);
        const k1 = Math.floor((t1 - phase) / L);
        if (k1 <= k0 || k1 < 0 || (p.oneShot && k1 > 0)) continue;
        const s = spawn(i);
        this.alive[i] = 1;
        // A particle emitted part-way through this step has already lived for the rest of it.
        const late = Math.max(0, t1 - (phase + k1 * L));
        this.age[i] = 0;
        this.life[i] = s.life;
        this.scale[i] = s.scale;
        this.angle[i] = s.angle;
        for (let k = 0; k < this.dim; k++) {
          this.pos[i * this.dim + k] = s.pos[k];
          this.vel[i * this.dim + k] = s.vel[k];
        }
        this.integrate(i, late, p.gravity, p.damping);
      }
      this.time = t1;
      while (this.time >= L) {
        this.time -= L;
        this.cycles++;
      }
    }
  }

  private integrate(i: number, dt: number, gravity: readonly number[], damping: number) {
    if (dt <= 0) return;
    this.age[i] += dt;
    if (this.age[i] >= this.life[i]) {
      this.alive[i] = 0;
      return;
    }
    const d = this.dim;
    let speed2 = 0;
    for (let k = 0; k < d; k++) {
      this.vel[i * d + k] += (gravity[k] ?? 0) * dt;
      speed2 += this.vel[i * d + k] ** 2;
    }
    if (damping > 0 && speed2 > 0) {
      const speed = Math.sqrt(speed2);
      const f = Math.max(0, speed - damping * dt) / speed;
      for (let k = 0; k < d; k++) this.vel[i * d + k] *= f;
    }
    for (let k = 0; k < d; k++) this.pos[i * d + k] += this.vel[i * d + k] * dt;
  }

  /** 0 at birth … 1 at death. */
  ageRatio(i: number) {
    return this.life[i] > 0 ? clamp(this.age[i] / this.life[i], 0, 1) : 1;
  }
}

/** Colour of a particle `t` (0–1) through its life: start colour fading to the end colour. */
export function particleColor(start: Color, end: Color, t: number): Color {
  return start.lerp(end, t);
}

// --- 2D ---------------------------------------------------------------------------------------------------------

/** Sparks, smoke, dust, explosions and trails in 2D. Without a texture each particle is an 8 px dot. */
export class CPUParticles2D extends Node2D {
  static override readonly typeName: string = 'CPUParticles2D';
  private _emitting = true;
  private _amount = 8;
  lifetime = 1;
  oneShot = false;
  /** 0 = emit evenly over the lifetime, 1 = all at once. */
  explosiveness = 0;
  /** Random reduction of each particle's lifetime (0–1). */
  randomness = 0;
  /** Seconds to simulate before the first frame (so the effect starts "full"). */
  preprocess = 0;
  speedScale = 1;
  /** Particles move with the emitter instead of staying where they were emitted. */
  localCoords = false;
  emissionShape: EmissionShape = 'point';
  emissionSphereRadius = 16;
  emissionRectExtents = new Vector2(16, 16);
  direction = new Vector2(1, 0);
  /** Degrees either side of `direction`. */
  spread = 45;
  /** Pixels per second² (world space). */
  gravity = new Vector2(0, 980);
  initialVelocityMin = 0;
  initialVelocityMax = 0;
  /** Slows particles down (pixels per second²). */
  damping = 0;
  scaleAmountMin = 1;
  scaleAmountMax = 1;
  color = Color.WHITE;
  /** Colour at the end of a particle's life (fade to transparent with alpha 0). */
  colorEnd = Color.WHITE;
  texture: Texture | null = null;
  readonly finished = new Signal<[]>('finished');

  readonly sim = new ParticleSim(2);
  private rng = new Rng(seedCounter++ * 0x2545f491);
  private preprocessed = false;

  get emitting() {
    return this._emitting;
  }
  set emitting(v: boolean) {
    if (v && !this._emitting && this.oneShot) this.sim.restart();
    this._emitting = v;
  }
  get amount() {
    return this._amount;
  }
  set amount(v: number) {
    this._amount = Math.max(1, Math.floor(v));
    this.sim.resize(this._amount);
  }

  constructor(name?: string) {
    super(name);
    this.sim.resize(this._amount);
  }

  /** Clears all particles and starts emitting from the beginning. */
  restart() {
    this.sim.restart();
    this._emitting = true;
  }
  /** Live particles right now. */
  getParticleCount() {
    return this.sim.aliveCount();
  }

  /** Advances the simulation (the engine calls this every frame; the editor calls it for previews). */
  simulate(delta: number) {
    if (this.sim.count !== this._amount) this.sim.resize(this._amount);
    const dt = delta * Math.max(0, this.speedScale);
    if (dt <= 0) return;
    const wasRunning = this._emitting || this.sim.aliveCount() > 0;
    const t = this.globalTransform;
    const local = this.localCoords;
    this.sim.step(dt, { emitting: this._emitting, lifetime: this.lifetime, explosiveness: this.explosiveness, oneShot: this.oneShot, gravity: local ? this.localGravity(t) : [this.gravity.x, this.gravity.y], damping: this.damping }, () => {
      const r = this.rng;
      let ox = 0;
      let oy = 0;
      if (this.emissionShape === 'sphere') {
        const a = r.next() * Math.PI * 2;
        const d = Math.sqrt(r.next()) * this.emissionSphereRadius;
        ox = Math.cos(a) * d;
        oy = Math.sin(a) * d;
      } else if (this.emissionShape === 'box') {
        ox = r.range(-1, 1) * this.emissionRectExtents.x;
        oy = r.range(-1, 1) * this.emissionRectExtents.y;
      }
      const base = this.direction.lengthSquared() > 0 ? this.direction.angle() : 0;
      const ang = base + degToRad(r.range(-this.spread, this.spread));
      const speed = r.range(this.initialVelocityMin, this.initialVelocityMax);
      let pos = new Vector2(ox, oy);
      let vel = Vector2.fromAngle(ang).scale(speed);
      if (!local) {
        pos = t.apply(pos);
        vel = t.applyVector(vel);
      }
      return { pos: [pos.x, pos.y], vel: [vel.x, vel.y], life: this.lifetime * (1 - clamp(this.randomness, 0, 1) * r.next()), scale: lerp(this.scaleAmountMin, this.scaleAmountMax, r.next()), angle: r.next() * Math.PI * 2 };
    });
    this.checkFinished(wasRunning);
  }

  private localGravity(t: Transform2D) {
    const g = t.invert().applyVector(this.gravity);
    return [g.x, g.y];
  }

  private checkFinished(wasRunning: boolean) {
    if (!this.oneShot || !wasRunning) return;
    if (this.sim.cycles > 0 && this._emitting) this._emitting = false;
    if (!this._emitting && this.sim.aliveCount() === 0) this.finished.emit();
  }

  override __ready() {
    super.__ready();
    if (this.preprocess > 0 && !this.preprocessed) {
      this.preprocessed = true;
      const step = 1 / 30;
      for (let left = Math.min(this.preprocess, 60); left > 0; left -= step) this.simulate(Math.min(step, left));
    }
  }
  override __process(delta: number) {
    super.__process(delta);
    this.simulate(delta);
  }
}

// --- 3D ---------------------------------------------------------------------------------------------------------

/** Sparks, smoke, fire and magic effects in 3D. Particles are camera-facing dots (or the texture), `particleSize` metres wide. */
export class CPUParticles3D extends Node3D {
  static override readonly typeName: string = 'CPUParticles3D';
  private _emitting = true;
  private _amount = 8;
  lifetime = 1;
  oneShot = false;
  explosiveness = 0;
  randomness = 0;
  preprocess = 0;
  speedScale = 1;
  localCoords = false;
  emissionShape: EmissionShape = 'point';
  emissionSphereRadius = 1;
  emissionBoxExtents = new Vector3(1, 1, 1);
  direction = new Vector3(1, 0, 0);
  /** Degrees around `direction` (a cone). */
  spread = 45;
  /** Metres per second² (world space). */
  gravity = new Vector3(0, -9.8, 0);
  initialVelocityMin = 0;
  initialVelocityMax = 0;
  damping = 0;
  scaleAmountMin = 1;
  scaleAmountMax = 1;
  /** Width of a particle at scale 1, in metres. */
  particleSize = 0.1;
  color = Color.WHITE;
  colorEnd = Color.WHITE;
  texture: Texture | null = null;
  readonly finished = new Signal<[]>('finished');

  readonly sim = new ParticleSim(3);
  private rng = new Rng(seedCounter++ * 0x2545f491);
  private preprocessed = false;

  get emitting() {
    return this._emitting;
  }
  set emitting(v: boolean) {
    if (v && !this._emitting && this.oneShot) this.sim.restart();
    this._emitting = v;
  }
  get amount() {
    return this._amount;
  }
  set amount(v: number) {
    this._amount = Math.max(1, Math.floor(v));
    this.sim.resize(this._amount);
  }

  constructor(name?: string) {
    super(name);
    this.sim.resize(this._amount);
  }

  restart() {
    this.sim.restart();
    this._emitting = true;
  }
  getParticleCount() {
    return this.sim.aliveCount();
  }

  simulate(delta: number) {
    if (this.sim.count !== this._amount) this.sim.resize(this._amount);
    const dt = delta * Math.max(0, this.speedScale);
    if (dt <= 0) return;
    const wasRunning = this._emitting || this.sim.aliveCount() > 0;
    const t = this.globalTransform;
    const local = this.localCoords;
    const g = local ? t.invert().transformDirection(this.gravity) : this.gravity;
    this.sim.step(dt, { emitting: this._emitting, lifetime: this.lifetime, explosiveness: this.explosiveness, oneShot: this.oneShot, gravity: [g.x, g.y, g.z], damping: this.damping }, () => {
      const r = this.rng;
      let o = new Vector3();
      if (this.emissionShape === 'sphere') {
        // Uniform in a ball.
        const u = r.next() * 2 - 1;
        const a = r.next() * Math.PI * 2;
        const s = Math.sqrt(1 - u * u);
        const d = Math.cbrt(r.next()) * this.emissionSphereRadius;
        o = new Vector3(s * Math.cos(a) * d, u * d, s * Math.sin(a) * d);
      } else if (this.emissionShape === 'box') {
        const e = this.emissionBoxExtents;
        o = new Vector3(r.range(-1, 1) * e.x, r.range(-1, 1) * e.y, r.range(-1, 1) * e.z);
      }
      const dir = coneDirection(this.direction.lengthSquared() > 0 ? this.direction.normalized() : new Vector3(1, 0, 0), degToRad(clamp(this.spread, 0, 180)), r);
      let vel = dir.scale(r.range(this.initialVelocityMin, this.initialVelocityMax));
      let pos = o;
      if (!local) {
        pos = t.transformPoint(pos);
        vel = t.transformDirection(vel);
      }
      return { pos: [pos.x, pos.y, pos.z], vel: [vel.x, vel.y, vel.z], life: this.lifetime * (1 - clamp(this.randomness, 0, 1) * r.next()), scale: lerp(this.scaleAmountMin, this.scaleAmountMax, r.next()), angle: 0 };
    });
    if (this.oneShot && wasRunning) {
      if (this.sim.cycles > 0 && this._emitting) this._emitting = false;
      if (!this._emitting && this.sim.aliveCount() === 0) this.finished.emit();
    }
  }

  override __ready() {
    super.__ready();
    if (this.preprocess > 0 && !this.preprocessed) {
      this.preprocessed = true;
      const step = 1 / 30;
      for (let left = Math.min(this.preprocess, 60); left > 0; left -= step) this.simulate(Math.min(step, left));
    }
  }
  override __process(delta: number) {
    super.__process(delta);
    this.simulate(delta);
  }
}

/** A random unit vector within `halfAngle` radians of `axis` (uniform over the cone's cap). */
function coneDirection(axis: Vector3, halfAngle: number, r: Rng): Vector3 {
  const cosMax = Math.cos(halfAngle);
  const z = lerp(cosMax, 1, r.next());
  const phi = r.next() * Math.PI * 2;
  const s = Math.sqrt(Math.max(0, 1 - z * z));
  // Orthonormal basis around the axis.
  const helper = Math.abs(axis.y) < 0.99 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0);
  const u = axis.cross(helper).normalized();
  const v = axis.cross(u);
  return axis.scale(z).add(u.scale(Math.cos(phi) * s)).add(v.scale(Math.sin(phi) * s));
}
