/**
 * Physics nodes and the physics server contracts.
 *
 * Like Godot, the nodes are thin: bodies and shapes describe the world, and a physics server
 * (packages/physics2d, physics3d — Rapier) simulates it. When no server is installed, characters
 * still move (velocity is integrated without collisions) and rigid bodies stay put.
 */
import { Signal, Vector2, Vector3, degToRad } from '@gs/shared';
import { Node } from './node';
import { Node2D } from './nodes2d';
import { Node3D } from './nodes3d';
import type { Shape2DData, Shape3DData } from './properties';

// --- server contracts -----------------------------------------------------------------------------------

/** A ray query (global coordinates). */
export interface RayQuery<V> {
  from: V;
  to: V;
  /** Layers the ray can hit. */
  collisionMask: number;
  /** Objects to ignore. */
  exclude?: ReadonlySet<Node>;
  collideWithBodies?: boolean;
  collideWithAreas?: boolean;
  /** Report a hit (at the origin) when the ray starts inside a shape. */
  hitFromInside?: boolean;
}

export interface RayHit<V> {
  collider: Node;
  /** Global hit point. */
  position: V;
  /** Surface normal at the hit point. */
  normal: V;
}

export interface PhysicsServer2D {
  readonly dimension: '2d';
  bodyEntered(body: CollisionObject2D): void;
  bodyExited(body: CollisionObject2D): void;
  shapesChanged(body: CollisionObject2D): void;
  /** Moves a character along its velocity, sliding on surfaces; updates its position, velocity and contact flags. */
  moveAndSlide(body: CharacterBody2D, delta: number): void;
  /** The closest hit along a ray, or null. */
  intersectRay(query: RayQuery<Vector2>): RayHit<Vector2> | null;
  step(delta: number): void;
  dispose(): void;
}

export interface PhysicsServer3D {
  readonly dimension: '3d';
  bodyEntered(body: CollisionObject3D): void;
  bodyExited(body: CollisionObject3D): void;
  shapesChanged(body: CollisionObject3D): void;
  moveAndSlide(body: CharacterBody3D, delta: number): void;
  intersectRay(query: RayQuery<Vector3>): RayHit<Vector3> | null;
  step(delta: number): void;
  dispose(): void;
}

export interface SlideCollision<V> {
  position: V;
  normal: V;
  collider: Node | null;
}

export interface MotionResult<V> {
  onFloor: boolean;
  onWall: boolean;
  onCeiling: boolean;
  floorNormal: V;
  collisions: SlideCollision<V>[];
}

// --- 2D -------------------------------------------------------------------------------------------------------

export abstract class CollisionObject2D extends Node2D {
  collisionLayer = 1;
  collisionMask = 1;

  override __enterTree() {
    super.__enterTree();
    this.tree?.physics2d?.bodyEntered(this);
  }
  override __exitTree() {
    this.tree?.physics2d?.bodyExited(this);
    super.__exitTree();
  }
  /** @internal */
  __shapesChanged() {
    if (this.isInsideTree()) this.tree?.physics2d?.shapesChanged(this);
  }
  getShapes(): CollisionShape2D[] {
    return this.children.filter((c): c is CollisionShape2D => c instanceof CollisionShape2D);
  }
}

export class StaticBody2D extends CollisionObject2D {
  static override readonly typeName: string = 'StaticBody2D';
  friction = 1;
  bounce = 0;
}

/**
 * A body moved by its transform (scripts, tweens, AnimationPlayer, PathFollow2D) rather than by
 * physics: moving platforms, doors, elevators. It pushes rigid bodies and carries characters
 * standing on it.
 */
export class AnimatableBody2D extends StaticBody2D {
  static override readonly typeName: string = 'AnimatableBody2D';
  /** @internal Velocity of the last physics step (px/s), set by the physics server. */
  __platformVelocity = new Vector2();
  /** Velocity of the last physics step in pixels per second. */
  getPlatformVelocity() {
    return this.__platformVelocity.clone();
  }
}

export class RigidBody2D extends CollisionObject2D {
  static override readonly typeName: string = 'RigidBody2D';
  mass = 1;
  gravityScale = 1;
  linearVelocity = new Vector2();
  angularVelocity = 0;
  linearDamp = 0;
  angularDamp = 0;
  friction = 1;
  bounce = 0;
  lockRotation = false;
  /** Frozen bodies don't move (kinematic). */
  freeze = false;
  /** Emit bodyEntered / bodyExited for contacts. */
  contactMonitor = false;
  readonly bodyEntered = new Signal<[body: Node]>('bodyEntered');
  readonly bodyExited = new Signal<[body: Node]>('bodyExited');
  /** @internal impulses waiting for the next physics step. */
  __impulses: { impulse: Vector2; at: Vector2 | null }[] = [];
  /** @internal */
  __torqueImpulse = 0;

  applyCentralImpulse(impulse: Vector2) {
    this.__impulses.push({ impulse: impulse.clone(), at: null });
  }
  /** Impulse at a position relative to the body's origin (global orientation). */
  applyImpulse(impulse: Vector2, position = new Vector2()) {
    this.__impulses.push({ impulse: impulse.clone(), at: position.clone() });
  }
  applyTorqueImpulse(torque: number) {
    this.__torqueImpulse += torque;
  }
}

export class CharacterBody2D extends CollisionObject2D {
  static override readonly typeName: string = 'CharacterBody2D';
  velocity = new Vector2();
  upDirection = new Vector2(0, -1);
  /** Steepest slope still counted as floor, in radians. */
  floorMaxAngle = degToRad(45);
  /** Keeps the character glued to slopes/steps below it (pixels). */
  floorSnapLength = 4;
  private motion: MotionResult<Vector2> = { onFloor: false, onWall: false, onCeiling: false, floorNormal: new Vector2(0, -1), collisions: [] };

  /** Moves by `velocity` (pixels/s) over this physics tick, sliding along whatever it hits. Returns true when it collided. */
  moveAndSlide(): boolean {
    const tree = this.tree;
    const delta = tree?.currentDelta ?? 1 / 60;
    if (tree?.physics2d) tree.physics2d.moveAndSlide(this, delta);
    else {
      this.position = this.position.add(this.velocity.scale(delta));
      this.motion = { onFloor: false, onWall: false, onCeiling: false, floorNormal: this.upDirection.clone(), collisions: [] };
    }
    return this.motion.collisions.length > 0;
  }
  /** @internal set by the physics server */
  __setMotion(m: MotionResult<Vector2>) {
    this.motion = m;
  }
  isOnFloor() {
    return this.motion.onFloor;
  }
  isOnWall() {
    return this.motion.onWall;
  }
  isOnCeiling() {
    return this.motion.onCeiling;
  }
  getFloorNormal() {
    return this.motion.floorNormal.clone();
  }
  getSlideCollisionCount() {
    return this.motion.collisions.length;
  }
  getSlideCollision(i: number) {
    return this.motion.collisions[i] ?? null;
  }
  getLastSlideCollision() {
    return this.motion.collisions.at(-1) ?? null;
  }
}

/** Detects bodies and areas overlapping it; doesn't collide. */
export class Area2D extends CollisionObject2D {
  static override readonly typeName: string = 'Area2D';
  monitoring = true;
  readonly bodyEntered = new Signal<[body: Node]>('bodyEntered');
  readonly bodyExited = new Signal<[body: Node]>('bodyExited');
  readonly areaEntered = new Signal<[area: Area2D]>('areaEntered');
  readonly areaExited = new Signal<[area: Area2D]>('areaExited');
  /** @internal maintained by the physics server */
  __overlaps = new Set<Node>();
  getOverlappingBodies(): Node[] {
    return [...this.__overlaps].filter((n) => !(n instanceof Area2D));
  }
  getOverlappingAreas(): Area2D[] {
    return [...this.__overlaps].filter((n): n is Area2D => n instanceof Area2D);
  }
  overlapsBody(body: Node) {
    return this.__overlaps.has(body);
  }
}

/** Gives its parent body a collision shape. Position/rotation are relative to the body. */
export class CollisionShape2D extends Node2D {
  static override readonly typeName: string = 'CollisionShape2D';
  private _shape: Shape2DData | null = { type: 'rectangle', size: [64, 64] };
  private _disabled = false;

  get shape() {
    return this._shape;
  }
  set shape(v: Shape2DData | null) {
    this._shape = v;
    this.notifyBody();
  }
  get disabled() {
    return this._disabled;
  }
  set disabled(v: boolean) {
    this._disabled = v;
    this.notifyBody();
  }
  override __enterTree() {
    super.__enterTree();
    this.notifyBody();
  }
  override __exitTree() {
    this.notifyBody();
    super.__exitTree();
  }
  private notifyBody() {
    if (this.parent instanceof CollisionObject2D) this.parent.__shapesChanged();
  }
}

// --- 3D -------------------------------------------------------------------------------------------------------

export abstract class CollisionObject3D extends Node3D {
  collisionLayer = 1;
  collisionMask = 1;
  override __enterTree() {
    super.__enterTree();
    this.tree?.physics3d?.bodyEntered(this);
  }
  override __exitTree() {
    this.tree?.physics3d?.bodyExited(this);
    super.__exitTree();
  }
  /** @internal */
  __shapesChanged() {
    if (this.isInsideTree()) this.tree?.physics3d?.shapesChanged(this);
  }
  getShapes(): CollisionShape3D[] {
    return this.children.filter((c): c is CollisionShape3D => c instanceof CollisionShape3D);
  }
}

export class StaticBody3D extends CollisionObject3D {
  static override readonly typeName: string = 'StaticBody3D';
  friction = 1;
  bounce = 0;
}

/** A body moved by its transform (moving platforms, doors, lifts). Pushes rigid bodies and carries characters. */
export class AnimatableBody3D extends StaticBody3D {
  static override readonly typeName: string = 'AnimatableBody3D';
  /** @internal Velocity of the last physics step (m/s), set by the physics server. */
  __platformVelocity = new Vector3();
  getPlatformVelocity() {
    return this.__platformVelocity.clone();
  }
}

export class RigidBody3D extends CollisionObject3D {
  static override readonly typeName: string = 'RigidBody3D';
  mass = 1;
  gravityScale = 1;
  linearVelocity = new Vector3();
  angularVelocity = new Vector3();
  linearDamp = 0;
  angularDamp = 0;
  friction = 1;
  bounce = 0;
  lockRotation = false;
  freeze = false;
  contactMonitor = false;
  readonly bodyEntered = new Signal<[body: Node]>('bodyEntered');
  readonly bodyExited = new Signal<[body: Node]>('bodyExited');
  /** @internal */
  __impulses: { impulse: Vector3; at: Vector3 | null }[] = [];

  applyCentralImpulse(impulse: Vector3) {
    this.__impulses.push({ impulse: impulse.clone(), at: null });
  }
  applyImpulse(impulse: Vector3, position = new Vector3()) {
    this.__impulses.push({ impulse: impulse.clone(), at: position.clone() });
  }
}

export class CharacterBody3D extends CollisionObject3D {
  static override readonly typeName: string = 'CharacterBody3D';
  velocity = new Vector3();
  upDirection = new Vector3(0, 1, 0);
  floorMaxAngle = degToRad(45);
  floorSnapLength = 0.1;
  private motion: MotionResult<Vector3> = { onFloor: false, onWall: false, onCeiling: false, floorNormal: new Vector3(0, 1, 0), collisions: [] };

  moveAndSlide(): boolean {
    const tree = this.tree;
    const delta = tree?.currentDelta ?? 1 / 60;
    if (tree?.physics3d) tree.physics3d.moveAndSlide(this, delta);
    else {
      this.position = this.position.add(this.velocity.scale(delta));
      this.motion = { onFloor: false, onWall: false, onCeiling: false, floorNormal: this.upDirection.clone(), collisions: [] };
    }
    return this.motion.collisions.length > 0;
  }
  /** @internal */
  __setMotion(m: MotionResult<Vector3>) {
    this.motion = m;
  }
  isOnFloor() {
    return this.motion.onFloor;
  }
  isOnWall() {
    return this.motion.onWall;
  }
  isOnCeiling() {
    return this.motion.onCeiling;
  }
  getFloorNormal() {
    return this.motion.floorNormal.clone();
  }
  getSlideCollisionCount() {
    return this.motion.collisions.length;
  }
  getSlideCollision(i: number) {
    return this.motion.collisions[i] ?? null;
  }
  getLastSlideCollision() {
    return this.motion.collisions.at(-1) ?? null;
  }
}

export class Area3D extends CollisionObject3D {
  static override readonly typeName: string = 'Area3D';
  monitoring = true;
  readonly bodyEntered = new Signal<[body: Node]>('bodyEntered');
  readonly bodyExited = new Signal<[body: Node]>('bodyExited');
  readonly areaEntered = new Signal<[area: Area3D]>('areaEntered');
  readonly areaExited = new Signal<[area: Area3D]>('areaExited');
  /** @internal */
  __overlaps = new Set<Node>();
  getOverlappingBodies(): Node[] {
    return [...this.__overlaps].filter((n) => !(n instanceof Area3D));
  }
  getOverlappingAreas(): Area3D[] {
    return [...this.__overlaps].filter((n): n is Area3D => n instanceof Area3D);
  }
  overlapsBody(body: Node) {
    return this.__overlaps.has(body);
  }
}

export class CollisionShape3D extends Node3D {
  static override readonly typeName: string = 'CollisionShape3D';
  private _shape: Shape3DData | null = { type: 'box', size: [1, 1, 1] };
  private _disabled = false;

  get shape() {
    return this._shape;
  }
  set shape(v: Shape3DData | null) {
    this._shape = v;
    this.notifyBody();
  }
  get disabled() {
    return this._disabled;
  }
  set disabled(v: boolean) {
    this._disabled = v;
    this.notifyBody();
  }
  override __enterTree() {
    super.__enterTree();
    this.notifyBody();
  }
  override __exitTree() {
    this.notifyBody();
    super.__exitTree();
  }
  private notifyBody() {
    if (this.parent instanceof CollisionObject3D) this.parent.__shapesChanged();
  }
}

// --- ray casts -----------------------------------------------------------------------------------------------

/**
 * Casts a ray from the node to `targetPosition` (local) every physics tick and reports the first
 * thing it hits (ground checks, line of sight, lasers). Needs the physics server of its dimension.
 */
export class RayCast2D extends Node2D {
  static override readonly typeName: string = 'RayCast2D';
  enabled = true;
  targetPosition = new Vector2(0, 50);
  collisionMask = 1;
  /** Ignore the CollisionObject2D this ray is a child of. */
  excludeParent = true;
  collideWithAreas = false;
  collideWithBodies = true;
  hitFromInside = false;
  private hit: RayHit<Vector2> | null = null;
  private exceptions = new Set<Node>();

  override __physicsProcess(delta: number) {
    super.__physicsProcess(delta);
    if (this.enabled) this.forceRaycastUpdate();
  }

  /** Casts now instead of waiting for the next physics tick. */
  forceRaycastUpdate() {
    const server = this.tree?.physics2d;
    if (!server) {
      this.hit = null;
      return;
    }
    const exclude = new Set(this.exceptions);
    if (this.excludeParent && this.parent instanceof CollisionObject2D) exclude.add(this.parent);
    const t = this.globalTransform;
    this.hit = server.intersectRay({ from: t.origin, to: t.apply(this.targetPosition), collisionMask: this.collisionMask, exclude, collideWithAreas: this.collideWithAreas, collideWithBodies: this.collideWithBodies, hitFromInside: this.hitFromInside });
  }

  isColliding() {
    return this.enabled && this.hit !== null && !this.hit.collider.isFreed();
  }
  getCollider<T extends Node = Node>(): T | null {
    return this.isColliding() ? (this.hit!.collider as T) : null;
  }
  /** Global hit point. */
  getCollisionPoint() {
    return this.hit?.position.clone() ?? new Vector2();
  }
  getCollisionNormal() {
    return this.hit?.normal.clone() ?? new Vector2();
  }
  addException(node: Node) {
    this.exceptions.add(node);
  }
  removeException(node: Node) {
    this.exceptions.delete(node);
  }
  clearExceptions() {
    this.exceptions.clear();
  }
  setCollisionMaskValue(layer: number, value: boolean) {
    const bit = 1 << (layer - 1);
    this.collisionMask = value ? (this.collisionMask | bit) >>> 0 : (this.collisionMask & ~bit) >>> 0;
  }
}

/** Casts a ray from the node to `targetPosition` (local, metres) every physics tick. */
export class RayCast3D extends Node3D {
  static override readonly typeName: string = 'RayCast3D';
  enabled = true;
  targetPosition = new Vector3(0, -1, 0);
  collisionMask = 1;
  excludeParent = true;
  collideWithAreas = false;
  collideWithBodies = true;
  hitFromInside = false;
  private hit: RayHit<Vector3> | null = null;
  private exceptions = new Set<Node>();

  override __physicsProcess(delta: number) {
    super.__physicsProcess(delta);
    if (this.enabled) this.forceRaycastUpdate();
  }
  forceRaycastUpdate() {
    const server = this.tree?.physics3d;
    if (!server) {
      this.hit = null;
      return;
    }
    const exclude = new Set(this.exceptions);
    if (this.excludeParent && this.parent instanceof CollisionObject3D) exclude.add(this.parent);
    const t = this.globalTransform;
    this.hit = server.intersectRay({ from: t.getPosition(), to: t.transformPoint(this.targetPosition), collisionMask: this.collisionMask, exclude, collideWithAreas: this.collideWithAreas, collideWithBodies: this.collideWithBodies, hitFromInside: this.hitFromInside });
  }
  isColliding() {
    return this.enabled && this.hit !== null && !this.hit.collider.isFreed();
  }
  getCollider<T extends Node = Node>(): T | null {
    return this.isColliding() ? (this.hit!.collider as T) : null;
  }
  getCollisionPoint() {
    return this.hit?.position.clone() ?? new Vector3();
  }
  getCollisionNormal() {
    return this.hit?.normal.clone() ?? new Vector3();
  }
  addException(node: Node) {
    this.exceptions.add(node);
  }
  removeException(node: Node) {
    this.exceptions.delete(node);
  }
  clearExceptions() {
    this.exceptions.clear();
  }
  setCollisionMaskValue(layer: number, value: boolean) {
    const bit = 1 << (layer - 1);
    this.collisionMask = value ? (this.collisionMask | bit) >>> 0 : (this.collisionMask & ~bit) >>> 0;
  }
}
