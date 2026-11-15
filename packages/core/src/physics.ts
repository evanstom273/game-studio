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

export interface PhysicsServer2D {
  readonly dimension: '2d';
  bodyEntered(body: CollisionObject2D): void;
  bodyExited(body: CollisionObject2D): void;
  shapesChanged(body: CollisionObject2D): void;
  /** Moves a character along its velocity, sliding on surfaces; updates its position, velocity and contact flags. */
  moveAndSlide(body: CharacterBody2D, delta: number): void;
  step(delta: number): void;
  dispose(): void;
}

export interface PhysicsServer3D {
  readonly dimension: '3d';
  bodyEntered(body: CollisionObject3D): void;
  bodyExited(body: CollisionObject3D): void;
  shapesChanged(body: CollisionObject3D): void;
  moveAndSlide(body: CharacterBody3D, delta: number): void;
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
