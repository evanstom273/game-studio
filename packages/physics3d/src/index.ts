/**
 * 3D physics server on Rapier (rapier3d-compat). Units are metres. Loaded only by games that use
 * 3D physics nodes. Collision layers 1–16 are used (Rapier interaction groups have 16 bits).
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { Mat4, Quaternion, Vector3 } from '@gs/shared';
import { AnimatableBody3D, Area3D, CharacterBody3D, CollisionObject3D, CollisionShape3D, RigidBody3D, StaticBody3D, type MotionResult, type Node, type PhysicsServer3D, type RayHit, type RayQuery } from '@gs/core';

let initPromise: Promise<void> | null = null;
export function initPhysics3D() {
  return (initPromise ??= RAPIER.init());
}

interface BodyRecord {
  node: CollisionObject3D;
  body: RAPIER.RigidBody;
  colliders: RAPIER.Collider[];
  dirty: boolean;
  lastMatrix: number[];
  lastVel: Vector3;
  lastAngVel: Vector3;
  controller?: RAPIER.KinematicCharacterController;
  /** Characters: velocity of the platform they stood on last tick (added when they leave it). */
  platformVelocity?: Vector3 | null;
}

const groups = (layer: number, mask: number) => (((layer & 0xffff) << 16) | (mask & 0xffff)) >>> 0;
const q = (r: Quaternion) => ({ x: r.x, y: r.y, z: r.z, w: r.w });

function sameMatrix(a: number[], b: number[]) {
  for (let i = 0; i < 16; i++) if (Math.abs(a[i] - b[i]) > 1e-6) return false;
  return true;
}

export class PhysicsServer3DRapier implements PhysicsServer3D {
  readonly dimension = '3d' as const;
  readonly world: RAPIER.World;
  private readonly events = new RAPIER.EventQueue(true);
  private readonly records = new Map<CollisionObject3D, BodyRecord>();
  private readonly byCollider = new Map<number, BodyRecord>();

  constructor(gravity: [number, number, number]) {
    this.world = new RAPIER.World({ x: gravity[0], y: gravity[1], z: gravity[2] });
  }

  bodyEntered(node: CollisionObject3D) {
    if (this.records.has(node)) return;
    const m = node.globalTransform;
    const d = m.decompose();
    let desc: RAPIER.RigidBodyDesc;
    if (node instanceof RigidBody3D) {
      desc = node.freeze ? RAPIER.RigidBodyDesc.kinematicPositionBased() : RAPIER.RigidBodyDesc.dynamic();
      const lv = node.linearVelocity;
      const av = node.angularVelocity;
      desc.setLinvel(lv.x, lv.y, lv.z).setAngvel({ x: av.x, y: av.y, z: av.z }).setGravityScale(node.gravityScale).setLinearDamping(node.linearDamp).setAngularDamping(node.angularDamp);
      if (node.lockRotation) desc.lockRotations();
    } else if (node instanceof CharacterBody3D || node instanceof Area3D || node instanceof AnimatableBody3D) desc = RAPIER.RigidBodyDesc.kinematicPositionBased();
    else desc = RAPIER.RigidBodyDesc.fixed();
    desc.setTranslation(d.position.x, d.position.y, d.position.z).setRotation(q(d.quaternion));
    const body = this.world.createRigidBody(desc);
    const rec: BodyRecord = { node, body, colliders: [], dirty: true, lastMatrix: m.m, lastVel: node instanceof RigidBody3D ? node.linearVelocity.clone() : new Vector3(), lastAngVel: node instanceof RigidBody3D ? node.angularVelocity.clone() : new Vector3() };
    if (node instanceof CharacterBody3D) {
      const c = this.world.createCharacterController(0.01);
      c.setSlideEnabled(true);
      // Without a little nudge the character catches on the floor every few ticks (measured: ~14% speed loss).
      c.setNormalNudgeFactor(0.001);
      c.setApplyImpulsesToDynamicBodies(true);
      c.enableAutostep(0.3, 0.2, false);
      rec.controller = c;
    }
    this.records.set(node, rec);
  }

  bodyExited(node: CollisionObject3D) {
    const rec = this.records.get(node);
    if (!rec) return;
    for (const c of rec.colliders) this.byCollider.delete(c.handle);
    if (rec.controller) this.world.removeCharacterController(rec.controller);
    this.world.removeRigidBody(rec.body);
    this.records.delete(node);
    if (node instanceof Area3D) node.__overlaps.clear();
    for (const r of this.records.values()) if (r.node instanceof Area3D && r.node.__overlaps.delete(node)) r.node.bodyExited.emit(node);
  }

  shapesChanged(node: CollisionObject3D) {
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
    const shapes = node.children.filter((c): c is CollisionShape3D => c instanceof CollisionShape3D && c.isInsideTree() && !!c.shape && !c.disabled);
    const totalVolume = shapes.reduce((a, s) => a + volume(s), 0) || 1;
    for (const shapeNode of shapes) {
      const shape = shapeNode.shape!;
      const local = inv.multiply(shapeNode.globalTransform).decompose();
      const s = local.scale;
      let desc: RAPIER.ColliderDesc;
      if (shape.type === 'box') desc = RAPIER.ColliderDesc.cuboid((shape.size[0] * Math.abs(s.x)) / 2, (shape.size[1] * Math.abs(s.y)) / 2, (shape.size[2] * Math.abs(s.z)) / 2);
      else if (shape.type === 'sphere') desc = RAPIER.ColliderDesc.ball(shape.radius * Math.max(Math.abs(s.x), Math.abs(s.y), Math.abs(s.z)));
      else {
        const r = shape.radius * Math.max(Math.abs(s.x), Math.abs(s.z));
        const h = shape.height * Math.abs(s.y);
        desc = shape.type === 'capsule' ? RAPIER.ColliderDesc.capsule(Math.max(0, h / 2 - r), r) : RAPIER.ColliderDesc.cylinder(h / 2, r);
      }
      desc.setTranslation(local.position.x, local.position.y, local.position.z).setRotation(q(local.quaternion)).setCollisionGroups(groups(node.collisionLayer, node.collisionMask));
      if (node instanceof Area3D) desc.setSensor(true).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS).setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.ALL);
      else {
        const physical = node instanceof RigidBody3D || node instanceof StaticBody3D;
        desc.setFriction(physical ? node.friction : 0).setRestitution(physical ? node.bounce : 0);
        if (node instanceof RigidBody3D) {
          desc.setMass((node.mass * volume(shapeNode)) / totalVolume);
          if (node.contactMonitor) desc.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
        }
        if (node instanceof CharacterBody3D) desc.setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.ALL);
      }
      const collider = this.world.createCollider(desc, rec.body);
      rec.colliders.push(collider);
      this.byCollider.set(collider.handle, rec);
    }
    rec.dirty = false;
  }

  private syncIn(rec: BodyRecord, delta: number) {
    if (rec.dirty) this.rebuild(rec);
    const n = rec.node;
    const m = n.globalTransform;
    const moved = !sameMatrix(m.m, rec.lastMatrix);
    const d = moved ? m.decompose() : null;
    if (n instanceof AnimatableBody3D) n.__platformVelocity = d && delta > 0 ? d.position.sub(new Vector3(rec.lastMatrix[12], rec.lastMatrix[13], rec.lastMatrix[14])).scale(1 / delta) : new Vector3();
    if (n instanceof RigidBody3D && !n.freeze) {
      if (d) {
        rec.body.setTranslation(d.position, true);
        rec.body.setRotation(q(d.quaternion), true);
      }
      if (!n.linearVelocity.equals(rec.lastVel, 1e-6)) rec.body.setLinvel(n.linearVelocity, true);
      if (!n.angularVelocity.equals(rec.lastAngVel, 1e-6)) rec.body.setAngvel(n.angularVelocity, true);
      rec.body.setGravityScale(n.gravityScale, false);
      const p = rec.body.translation();
      for (const { impulse, at } of n.__impulses.splice(0)) {
        if (at) rec.body.applyImpulseAtPoint(impulse, { x: p.x + at.x, y: p.y + at.y, z: p.z + at.z }, true);
        else rec.body.applyImpulse(impulse, true);
      }
    } else if (d) {
      if (rec.body.isKinematic()) {
        rec.body.setNextKinematicTranslation(d.position);
        rec.body.setNextKinematicRotation(q(d.quaternion));
      } else {
        rec.body.setTranslation(d.position, false);
        rec.body.setRotation(q(d.quaternion), false);
      }
    }
    rec.lastMatrix = m.m;
  }

  moveAndSlide(node: CharacterBody3D, delta: number) {
    const rec = this.records.get(node);
    if (!rec?.controller) {
      node.position = node.position.add(node.velocity.scale(delta));
      return;
    }
    if (rec.dirty) this.rebuild(rec);
    const up = node.upDirection.normalized();
    const result: MotionResult<Vector3> = { onFloor: false, onWall: false, onCeiling: false, floorNormal: up.clone(), collisions: [] };
    const collider = rec.colliders[0];
    const start = node.globalPosition;
    if (!collider) {
      node.globalPosition = start.add(node.velocity.scale(delta));
      node.__setMotion(result);
      return;
    }
    const m = node.globalTransform;
    if (!sameMatrix(m.m, rec.lastMatrix)) {
      rec.body.setTranslation(start, true);
      this.world.propagateModifiedBodyPositionsToColliders();
    }
    const c = rec.controller;
    // Standing on a moving platform: first move with it (ignoring the platform itself), like Godot.
    const platform = node.isOnFloor() ? this.floorPlatform(node) : null;
    const platformVel = platform ? platform.node.__platformVelocity.clone() : null;
    if (platform && platformVel && platformVel.lengthSquared() > 0) {
      const carry = platformVel.scale(delta);
      c.computeColliderMovement(collider, { x: carry.x, y: carry.y, z: carry.z }, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, groups(node.collisionLayer, node.collisionMask), (other) => other.parent()?.handle !== rec.body.handle && other.parent()?.handle !== platform.body.handle);
      const cm = c.computedMovement();
      start.set(start.x + cm.x, start.y + cm.y, start.z + cm.z);
      rec.body.setTranslation(start, true);
      this.world.propagateModifiedBodyPositionsToColliders();
    }
    c.setUp(up);
    c.setMaxSlopeClimbAngle(node.floorMaxAngle);
    c.setMinSlopeSlideAngle(node.floorMaxAngle);
    if (node.floorSnapLength > 0) c.enableSnapToGround(node.floorSnapLength);
    else c.disableSnapToGround();
    const v0 = node.velocity;
    // Grounded: move along the floor and let snapping keep contact (see the 2D server).
    let motion = v0.scale(delta);
    if (node.isOnFloor()) {
      const fn = node.getFloorNormal();
      const into = motion.dot(fn);
      if (into < 0) motion = motion.sub(fn.scale(into));
    }
    c.computeColliderMovement(collider, { x: motion.x, y: motion.y, z: motion.z }, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, groups(node.collisionLayer, node.collisionMask), (other) => other.parent()?.handle !== rec.body.handle);
    const mv = c.computedMovement();
    const end = new Vector3(start.x + mv.x, start.y + mv.y, start.z + mv.z);
    const cosMax = Math.cos(node.floorMaxAngle);
    for (let i = 0; i < c.numComputedCollisions(); i++) {
      const col = c.computedCollision(i);
      if (!col) continue;
      const normal = new Vector3(col.normal1.x, col.normal1.y, col.normal1.z).normalized();
      const dd = normal.dot(up);
      if (dd >= cosMax - 1e-4) {
        result.onFloor = true;
        result.floorNormal = normal;
      } else if (dd <= -cosMax + 1e-4) result.onCeiling = true;
      else result.onWall = true;
      const other = col.collider ? (this.byCollider.get(col.collider.handle)?.node ?? null) : null;
      result.collisions.push({ position: new Vector3(col.witness1.x, col.witness1.y, col.witness1.z), normal, collider: other as Node | null });
    }
    if (c.computedGrounded()) result.onFloor = true;
    let v = v0.clone();
    const into = v.dot(up);
    if (result.onFloor && into < 0) v = v.sub(up.scale(into));
    if (result.onCeiling && into > 0) v = v.sub(up.scale(into));
    for (const col of result.collisions) {
      const dn = v.dot(col.normal);
      if (dn < 0 && Math.abs(col.normal.dot(up)) < cosMax) v = v.sub(col.normal.scale(dn));
    }
    if (!result.onFloor && rec.platformVelocity) v = v.add(rec.platformVelocity);
    rec.platformVelocity = result.onFloor ? platformVel : null;
    node.velocity = v;
    node.globalPosition = end;
    rec.body.setNextKinematicTranslation(end);
    rec.lastMatrix = node.globalTransform.m;
    node.__setMotion(result);
  }

  private floorPlatform(node: CharacterBody3D): (BodyRecord & { node: AnimatableBody3D }) | null {
    const up = node.upDirection.normalized();
    const cosMax = Math.cos(node.floorMaxAngle);
    for (let i = 0; i < node.getSlideCollisionCount(); i++) {
      const col = node.getSlideCollision(i);
      if (!col || !(col.collider instanceof AnimatableBody3D) || col.normal.dot(up) < cosMax - 1e-4) continue;
      const rec = this.records.get(col.collider);
      if (rec) return rec as BodyRecord & { node: AnimatableBody3D };
    }
    return null;
  }

  intersectRay(q: RayQuery<Vector3>): RayHit<Vector3> | null {
    const d = q.to.sub(q.from);
    const len = d.length();
    if (len < 1e-9) return null;
    const dir = d.scale(1 / len);
    const ray = new RAPIER.Ray({ x: q.from.x, y: q.from.y, z: q.from.z }, { x: dir.x, y: dir.y, z: dir.z });
    let flags = 0;
    if (q.collideWithBodies === false) flags |= RAPIER.QueryFilterFlags.EXCLUDE_SOLIDS;
    if (!q.collideWithAreas) flags |= RAPIER.QueryFilterFlags.EXCLUDE_SENSORS;
    const skip = new Set<number>();
    const accept = (col: RAPIER.Collider) => {
      if (skip.has(col.handle)) return false;
      const rec = this.byCollider.get(col.handle);
      return !!rec && (rec.node.collisionLayer & q.collisionMask) !== 0 && !q.exclude?.has(rec.node);
    };
    for (let attempt = 0; attempt < 8; attempt++) {
      const hit = this.world.castRayAndGetNormal(ray, len, true, flags, undefined, undefined, undefined, accept);
      if (!hit) return null;
      if (hit.timeOfImpact <= 1e-6 && !q.hitFromInside) {
        skip.add(hit.collider.handle);
        continue;
      }
      const rec = this.byCollider.get(hit.collider.handle)!;
      const normal = hit.timeOfImpact <= 1e-6 ? new Vector3() : new Vector3(hit.normal.x, hit.normal.y, hit.normal.z).normalized();
      return { collider: rec.node, position: q.from.add(dir.scale(hit.timeOfImpact)), normal };
    }
    return null;
  }

  step(delta: number) {
    for (const rec of this.records.values()) this.syncIn(rec, delta);
    this.world.timestep = delta;
    this.world.step(this.events);
    for (const rec of this.records.values()) {
      const n = rec.node;
      if (n instanceof RigidBody3D && !n.freeze) {
        const t = rec.body.translation();
        const r = rec.body.rotation();
        const scale = n.globalTransform.decompose().scale;
        n.globalTransform = Mat4.compose(new Vector3(t.x, t.y, t.z), new Quaternion(r.x, r.y, r.z, r.w), scale);
        const lv = rec.body.linvel();
        const av = rec.body.angvel();
        n.linearVelocity = new Vector3(lv.x, lv.y, lv.z);
        n.angularVelocity = new Vector3(av.x, av.y, av.z);
        rec.lastMatrix = n.globalTransform.m;
        rec.lastVel = n.linearVelocity.clone();
        rec.lastAngVel = n.angularVelocity.clone();
      }
    }
    this.events.drainCollisionEvents((h1, h2, started) => this.onContact(h1, h2, started));
  }

  private onContact(h1: number, h2: number, started: boolean) {
    const a = this.byCollider.get(h1);
    const b = this.byCollider.get(h2);
    if (!a || !b || a === b) return;
    for (const [self, other] of [
      [a, b],
      [b, a],
    ] as const) {
      const n = self.node;
      if (n instanceof Area3D) {
        if (!n.monitoring) continue;
        const has = n.__overlaps.has(other.node);
        if (started && !has) {
          n.__overlaps.add(other.node);
          if (other.node instanceof Area3D) n.areaEntered.emit(other.node);
          else n.bodyEntered.emit(other.node);
        } else if (!started && has) {
          n.__overlaps.delete(other.node);
          if (other.node instanceof Area3D) n.areaExited.emit(other.node);
          else n.bodyExited.emit(other.node);
        }
      } else if (n instanceof RigidBody3D && n.contactMonitor && !(other.node instanceof Area3D)) {
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
  }
}

function volume(s: CollisionShape3D) {
  const sh = s.shape;
  if (!sh) return 0;
  if (sh.type === 'box') return sh.size[0] * sh.size[1] * sh.size[2];
  if (sh.type === 'sphere') return (4 / 3) * Math.PI * sh.radius ** 3;
  return Math.PI * sh.radius * sh.radius * sh.height;
}

export async function createPhysics3D(gravity: [number, number, number]) {
  await initPhysics3D();
  return new PhysicsServer3DRapier(gravity);
}
