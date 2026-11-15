/**
 * 2D physics server on Rapier (rapier2d-compat: WebAssembly inlined, works in any bundler and in
 * classic scripts). Loaded only by games that use 2D physics nodes.
 *
 * Units: the engine works in pixels; Rapier in metres (100 px = 1 m) so its tolerances behave.
 * Collision layers: Godot has 32 layers; Rapier's interaction groups have 16, so layers 1–16 are used.
 */
import RAPIER from '@dimforge/rapier2d-compat';
import { Vector2 } from '@gs/shared';
import { Area2D, CharacterBody2D, CollisionObject2D, CollisionShape2D, RigidBody2D, StaticBody2D, type MotionResult, type Node, type PhysicsServer2D, type SceneTree, type SlideCollision } from '@gs/core';

export const PIXELS_PER_METER = 100;
const PPM = PIXELS_PER_METER;

let initPromise: Promise<void> | null = null;
/** Loads the WebAssembly module (once). */
export function initPhysics2D() {
  return (initPromise ??= RAPIER.init());
}

interface BodyRecord {
  node: CollisionObject2D;
  body: RAPIER.RigidBody;
  colliders: RAPIER.Collider[];
  dirty: boolean;
  /** Last transform/velocity written to or read from the node, to detect script changes. */
  lastPos: Vector2;
  lastRot: number;
  lastVel: Vector2;
  lastAngVel: number;
  controller?: RAPIER.KinematicCharacterController;
}

const groups = (layer: number, mask: number) => (((layer & 0xffff) << 16) | (mask & 0xffff)) >>> 0;

export class PhysicsServer2DRapier implements PhysicsServer2D {
  readonly dimension = '2d' as const;
  readonly world: RAPIER.World;
  private readonly events = new RAPIER.EventQueue(true);
  private readonly records = new Map<CollisionObject2D, BodyRecord>();
  private readonly byCollider = new Map<number, BodyRecord>();

  /** Call `await initPhysics2D()` first. `gravity` in px/s² (y down). */
  constructor(
    gravity: [number, number],
    private readonly tree?: SceneTree,
  ) {
    this.world = new RAPIER.World({ x: gravity[0] / PPM, y: gravity[1] / PPM });
  }

  bodyEntered(node: CollisionObject2D) {
    if (this.records.has(node)) return;
    const pos = node.globalPosition;
    const rot = node.globalRotation;
    let desc: RAPIER.RigidBodyDesc;
    if (node instanceof RigidBody2D) {
      desc = node.freeze ? RAPIER.RigidBodyDesc.kinematicPositionBased() : RAPIER.RigidBodyDesc.dynamic();
      desc.setLinvel(node.linearVelocity.x / PPM, node.linearVelocity.y / PPM).setAngvel(node.angularVelocity).setGravityScale(node.gravityScale).setLinearDamping(node.linearDamp).setAngularDamping(node.angularDamp).setCanSleep(true);
      if (node.lockRotation) desc.lockRotations();
    } else if (node instanceof CharacterBody2D || node instanceof Area2D) desc = RAPIER.RigidBodyDesc.kinematicPositionBased();
    else desc = RAPIER.RigidBodyDesc.fixed();
    desc.setTranslation(pos.x / PPM, pos.y / PPM).setRotation(rot);
    const body = this.world.createRigidBody(desc);
    const rec: BodyRecord = { node, body, colliders: [], dirty: true, lastPos: pos, lastRot: rot, lastVel: node instanceof RigidBody2D ? node.linearVelocity.clone() : new Vector2(), lastAngVel: node instanceof RigidBody2D ? node.angularVelocity : 0 };
    if (node instanceof CharacterBody2D) {
      const c = this.world.createCharacterController(0.01);
      c.setSlideEnabled(true);
      // Without a little nudge the character catches on the floor every few ticks (measured: ~14% speed loss).
      c.setNormalNudgeFactor(0.001);
      c.setApplyImpulsesToDynamicBodies(true);
      c.setUp({ x: node.upDirection.x, y: node.upDirection.y });
      c.setMaxSlopeClimbAngle(node.floorMaxAngle);
      c.setMinSlopeSlideAngle(node.floorMaxAngle);
      if (node.floorSnapLength > 0) c.enableSnapToGround(node.floorSnapLength / PPM);
      rec.controller = c;
    }
    this.records.set(node, rec);
  }

  bodyExited(node: CollisionObject2D) {
    const rec = this.records.get(node);
    if (!rec) return;
    for (const c of rec.colliders) this.byCollider.delete(c.handle);
    if (rec.controller) this.world.removeCharacterController(rec.controller);
    this.world.removeRigidBody(rec.body);
    this.records.delete(node);
    if (node instanceof Area2D) node.__overlaps.clear();
    for (const r of this.records.values()) if (r.node instanceof Area2D && r.node.__overlaps.delete(node)) r.node.bodyExited.emit(node);
  }

  shapesChanged(node: CollisionObject2D) {
    const rec = this.records.get(node);
    if (rec) rec.dirty = true;
  }

  private rebuild(rec: BodyRecord) {
    for (const c of rec.colliders) {
      this.byCollider.delete(c.handle);
      this.world.removeCollider(c, false);
    }
    rec.colliders = [];
    const node = rec.node;
    const inv = node.globalTransform.invert();
    const shapes = node.children.filter((c): c is CollisionShape2D => c instanceof CollisionShape2D && c.isInsideTree());
    const totalArea = shapes.reduce((a, s) => a + area(s), 0) || 1;
    for (const shapeNode of shapes) {
      const shape = shapeNode.shape;
      if (!shape || shapeNode.disabled) continue;
      const local = inv.multiply(shapeNode.globalTransform);
      const sc = local.scale;
      let desc: RAPIER.ColliderDesc;
      if (shape.type === 'rectangle') desc = RAPIER.ColliderDesc.cuboid((shape.size[0] * Math.abs(sc.x)) / 2 / PPM, (shape.size[1] * Math.abs(sc.y)) / 2 / PPM);
      else if (shape.type === 'circle') desc = RAPIER.ColliderDesc.ball((shape.radius * Math.max(Math.abs(sc.x), Math.abs(sc.y))) / PPM);
      else {
        const r = (shape.radius * Math.abs(sc.x)) / PPM;
        const half = Math.max(0, (shape.height * Math.abs(sc.y)) / 2 / PPM - r);
        desc = RAPIER.ColliderDesc.capsule(half, r);
      }
      desc.setTranslation(local.tx / PPM, local.ty / PPM).setRotation(local.rotation).setCollisionGroups(groups(node.collisionLayer, node.collisionMask));
      if (node instanceof Area2D) {
        desc.setSensor(true).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS).setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.ALL);
      } else {
        const friction = node instanceof RigidBody2D || node instanceof StaticBody2D ? node.friction : 0;
        const bounce = node instanceof RigidBody2D || node instanceof StaticBody2D ? node.bounce : 0;
        desc.setFriction(friction).setRestitution(bounce);
        if (node instanceof RigidBody2D) {
          desc.setMass((node.mass * area(shapeNode)) / totalArea);
          if (node.contactMonitor) desc.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
        }
        if (node instanceof CharacterBody2D) desc.setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.ALL);
      }
      const collider = this.world.createCollider(desc, rec.body);
      rec.colliders.push(collider);
      this.byCollider.set(collider.handle, rec);
    }
    rec.dirty = false;
  }

  private syncIn(rec: BodyRecord) {
    if (rec.dirty) this.rebuild(rec);
    const n = rec.node;
    const pos = n.globalPosition;
    const rot = n.globalRotation;
    const moved = !pos.equals(rec.lastPos, 1e-6) || Math.abs(rot - rec.lastRot) > 1e-9;
    if (n instanceof RigidBody2D && !n.freeze) {
      if (moved) {
        rec.body.setTranslation({ x: pos.x / PPM, y: pos.y / PPM }, true);
        rec.body.setRotation(rot, true);
      }
      if (!n.linearVelocity.equals(rec.lastVel, 1e-6)) rec.body.setLinvel({ x: n.linearVelocity.x / PPM, y: n.linearVelocity.y / PPM }, true);
      if (Math.abs(n.angularVelocity - rec.lastAngVel) > 1e-9) rec.body.setAngvel(n.angularVelocity, true);
      rec.body.setGravityScale(n.gravityScale, false);
      for (const { impulse, at } of n.__impulses.splice(0)) {
        const imp = { x: impulse.x / PPM, y: impulse.y / PPM };
        if (at) rec.body.applyImpulseAtPoint(imp, { x: (pos.x + at.x) / PPM, y: (pos.y + at.y) / PPM }, true);
        else rec.body.applyImpulse(imp, true);
      }
      if (n.__torqueImpulse) {
        rec.body.applyTorqueImpulse(n.__torqueImpulse / (PPM * PPM), true);
        n.__torqueImpulse = 0;
      }
    } else if (moved) {
      if (rec.body.isKinematic()) {
        rec.body.setNextKinematicTranslation({ x: pos.x / PPM, y: pos.y / PPM });
        rec.body.setNextKinematicRotation(rot);
      } else {
        rec.body.setTranslation({ x: pos.x / PPM, y: pos.y / PPM }, false);
        rec.body.setRotation(rot, false);
      }
    }
    rec.lastPos = pos;
    rec.lastRot = rot;
  }

  moveAndSlide(node: CharacterBody2D, delta: number) {
    const rec = this.records.get(node);
    if (!rec?.controller) {
      node.position = node.position.add(node.velocity.scale(delta));
      return;
    }
    if (rec.dirty) this.rebuild(rec);
    const collider = rec.colliders[0];
    const up = node.upDirection.normalized();
    const result: MotionResult<Vector2> = { onFloor: false, onWall: false, onCeiling: false, floorNormal: up.clone(), collisions: [] };
    const start = node.globalPosition;
    if (!collider) {
      node.globalPosition = start.add(node.velocity.scale(delta));
      node.__setMotion(result);
      return;
    }
    const c = rec.controller;
    c.setUp({ x: up.x, y: up.y });
    c.setMaxSlopeClimbAngle(node.floorMaxAngle);
    c.setMinSlopeSlideAngle(node.floorMaxAngle);
    if (node.floorSnapLength > 0) c.enableSnapToGround(node.floorSnapLength / PPM);
    else c.disableSnapToGround();
    // The collider must be where the node is now (a script may have teleported it).
    if (!start.equals(rec.lastPos, 1e-6)) {
      rec.body.setTranslation({ x: start.x / PPM, y: start.y / PPM }, true);
      this.world.propagateModifiedBodyPositionsToColliders();
    }
    // Like Godot: a grounded character moves along the floor (snapping keeps it attached) instead of
    // being pushed into it, which makes the controller catch on the surface every few ticks.
    let motion = node.velocity.scale(delta);
    if (node.isOnFloor()) {
      const fn = node.getFloorNormal();
      const into = motion.dot(fn);
      if (into < 0) motion = motion.sub(fn.scale(into));
    }
    c.computeColliderMovement(collider, { x: motion.x / PPM, y: motion.y / PPM }, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, groups(node.collisionLayer, node.collisionMask), (other) => other.parent()?.handle !== rec.body.handle);
    const mv = c.computedMovement();
    const end = new Vector2(start.x + mv.x * PPM, start.y + mv.y * PPM);
    const cosMax = Math.cos(node.floorMaxAngle);
    for (let i = 0; i < c.numComputedCollisions(); i++) {
      const col = c.computedCollision(i);
      if (!col) continue;
      const normal = new Vector2(col.normal1.x, col.normal1.y).normalized();
      const d = normal.dot(up);
      if (d >= cosMax - 1e-4) {
        result.onFloor = true;
        result.floorNormal = normal;
      } else if (d <= -cosMax + 1e-4) result.onCeiling = true;
      else result.onWall = true;
      const other = col.collider ? (this.byCollider.get(col.collider.handle)?.node ?? null) : null;
      result.collisions.push({ position: new Vector2(col.witness1.x * PPM, col.witness1.y * PPM), normal, collider: other as Node | null } satisfies SlideCollision<Vector2>);
    }
    if (c.computedGrounded()) result.onFloor = true;
    // Like Godot: stop pushing into what we hit.
    let v = node.velocity.clone();
    const into = v.dot(up);
    if (result.onFloor && into < 0) v = v.sub(up.scale(into));
    if (result.onCeiling && into > 0) v = v.sub(up.scale(into));
    if (result.onWall) {
      for (const col of result.collisions) {
        const dn = v.dot(col.normal);
        if (dn < 0 && Math.abs(col.normal.dot(up)) < cosMax) v = v.sub(col.normal.scale(dn));
      }
    }
    node.velocity = v;
    node.globalPosition = end;
    rec.body.setNextKinematicTranslation({ x: end.x / PPM, y: end.y / PPM });
    rec.lastPos = end;
    node.__setMotion(result);
  }

  step(delta: number) {
    for (const rec of this.records.values()) this.syncIn(rec);
    this.world.timestep = delta;
    this.world.step(this.events);
    // Write simulated bodies back.
    for (const rec of this.records.values()) {
      const n = rec.node;
      if (n instanceof RigidBody2D && !n.freeze) {
        const t = rec.body.translation();
        const pos = new Vector2(t.x * PPM, t.y * PPM);
        n.globalPosition = pos;
        n.globalRotation = rec.body.rotation();
        const lv = rec.body.linvel();
        n.linearVelocity = new Vector2(lv.x * PPM, lv.y * PPM);
        n.angularVelocity = rec.body.angvel();
        rec.lastPos = n.globalPosition;
        rec.lastRot = n.globalRotation;
        rec.lastVel = n.linearVelocity.clone();
        rec.lastAngVel = n.angularVelocity;
      }
    }
    this.events.drainCollisionEvents((h1, h2, started) => this.onContact(h1, h2, started));
  }

  private onContact(h1: number, h2: number, started: boolean) {
    const a = this.byCollider.get(h1);
    const b = this.byCollider.get(h2);
    if (!a || !b || a === b) return;
    const pairs: [BodyRecord, BodyRecord][] = [
      [a, b],
      [b, a],
    ];
    for (const [self, other] of pairs) {
      const n = self.node;
      if (n instanceof Area2D) {
        if (!n.monitoring) continue;
        const has = n.__overlaps.has(other.node);
        if (started && !has) {
          n.__overlaps.add(other.node);
          if (other.node instanceof Area2D) n.areaEntered.emit(other.node);
          else n.bodyEntered.emit(other.node);
        } else if (!started && has) {
          n.__overlaps.delete(other.node);
          if (other.node instanceof Area2D) n.areaExited.emit(other.node);
          else n.bodyExited.emit(other.node);
        }
      } else if (n instanceof RigidBody2D && n.contactMonitor && !(other.node instanceof Area2D)) {
        if (started) n.bodyEntered.emit(other.node);
        else n.bodyExited.emit(other.node);
      }
    }
  }

  dispose() {
    this.records.clear();
    this.byCollider.clear();
    this.world.free();
    this.events.free();
    void this.tree;
  }
}

function area(s: CollisionShape2D) {
  const sh = s.shape;
  if (!sh) return 0;
  if (sh.type === 'rectangle') return sh.size[0] * sh.size[1];
  if (sh.type === 'circle') return Math.PI * sh.radius * sh.radius;
  return Math.PI * sh.radius * sh.radius + 2 * sh.radius * Math.max(0, sh.height - 2 * sh.radius);
}

/** Creates the server once the WebAssembly is ready. */
export async function createPhysics2D(gravity: [number, number], tree?: SceneTree) {
  await initPhysics2D();
  return new PhysicsServer2DRapier(gravity, tree);
}
