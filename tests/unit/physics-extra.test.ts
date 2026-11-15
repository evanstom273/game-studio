/** Ray casts, moving platforms and tile-map collision with real Rapier (headless). */
import { describe, expect, it } from 'vitest';
import { Vector2, Vector3 } from '@gs/shared';
import { AnimatableBody2D, AnimatableBody3D, Area2D, CharacterBody2D, CharacterBody3D, CollisionShape2D, CollisionShape3D, Engine, Node2D, Node3D, RayCast2D, RayCast3D, RigidBody2D, StaticBody2D, StaticBody3D, TileMapLayer } from '@gs/core';
import { createPhysics2D } from '@gs/physics2d';
import { createPhysics3D } from '@gs/physics3d';

function shape2D(w: number, h: number) {
  const s = new CollisionShape2D();
  s.shape = { type: 'rectangle', size: [w, h] };
  return s;
}
function box3D(x: number, y: number, z: number) {
  const s = new CollisionShape3D();
  s.shape = { type: 'box', size: [x, y, z] };
  return s;
}
const run = (engine: Engine, seconds: number) => {
  for (let i = 0; i < Math.round(seconds * 60); i++) engine.step(1 / 60);
};

class Walker2D extends CharacterBody2D {
  override _physicsProcess(delta: number) {
    this.velocity.y += 1600 * delta;
    this.moveAndSlide();
  }
}

describe('RayCast2D (Rapier)', () => {
  it('hits the first body in its mask, with point, normal and collider, ignoring its parent', async () => {
    const engine = new Engine();
    engine.setPhysics2D(await createPhysics2D([0, 0]));
    const root = new Node2D();
    const floor = root.addChild(new StaticBody2D('Floor'));
    floor.position = new Vector2(0, 300);
    floor.addChild(shape2D(1000, 40));
    const wall = root.addChild(new StaticBody2D('Wall'));
    wall.position = new Vector2(0, 150);
    wall.collisionLayer = 2;
    wall.addChild(shape2D(200, 20));
    const body = root.addChild(new StaticBody2D('Self'));
    body.addChild(shape2D(40, 40));
    const ray = body.addChild(new RayCast2D());
    ray.targetPosition = new Vector2(0, 500);
    engine.tree.setCurrentScene(root);
    run(engine, 2 / 60);

    // Layer 2 (the wall) isn't in the default mask: the ray reaches the floor's top at y = 280.
    expect(ray.isColliding()).toBe(true);
    expect(ray.getCollider()).toBe(floor);
    expect(ray.getCollisionPoint().y).toBeCloseTo(280, 1);
    expect(ray.getCollisionNormal().equals(new Vector2(0, -1), 1e-4)).toBe(true);

    ray.collisionMask = 3;
    ray.forceRaycastUpdate();
    expect(ray.getCollider()).toBe(wall);
    expect(ray.getCollisionPoint().y).toBeCloseTo(140, 1);

    // Not excluding the parent: the ray starts inside it and (hitFromInside off) looks past it.
    ray.excludeParent = false;
    ray.forceRaycastUpdate();
    expect(ray.getCollider()).toBe(wall);
    ray.hitFromInside = true;
    ray.forceRaycastUpdate();
    expect(ray.getCollider()).toBe(body);

    // Too short to reach anything.
    ray.excludeParent = true;
    ray.targetPosition = new Vector2(0, 50);
    run(engine, 1 / 60);
    expect(ray.isColliding()).toBe(false);
    expect(ray.getCollider()).toBeNull();
    engine.dispose();
  });

  it('hits areas only when asked to', async () => {
    const engine = new Engine();
    engine.setPhysics2D(await createPhysics2D([0, 0]));
    const root = new Node2D();
    const area = root.addChild(new Area2D());
    area.position = new Vector2(100, 0);
    area.addChild(shape2D(20, 20));
    const ray = root.addChild(new RayCast2D());
    ray.targetPosition = new Vector2(300, 0);
    engine.tree.setCurrentScene(root);
    run(engine, 2 / 60);
    expect(ray.isColliding()).toBe(false);
    ray.collideWithAreas = true;
    run(engine, 1 / 60);
    expect(ray.getCollider()).toBe(area);
    expect(ray.getCollisionPoint().x).toBeCloseTo(90, 1);
    engine.dispose();
  });
});

describe('AnimatableBody2D (Rapier)', () => {
  it('carries a character standing on it, sideways and upwards, and pushes rigid bodies', async () => {
    const engine = new Engine();
    engine.setPhysics2D(await createPhysics2D([0, 980]));
    const root = new Node2D();
    const platform = root.addChild(new AnimatableBody2D());
    platform.position = new Vector2(0, 300);
    platform.addChild(shape2D(300, 20));
    const player = root.addChild(new Walker2D());
    player.position = new Vector2(0, 250);
    player.addChild(shape2D(20, 40));
    engine.tree.setCurrentScene(root);
    run(engine, 1);
    expect(player.isOnFloor()).toBe(true);
    const y0 = player.position.y;
    expect(y0).toBeGreaterThan(265);
    expect(y0).toBeLessThan(271);

    // Move right at 120 px/s for one second.
    for (let i = 0; i < 60; i++) {
      platform.position = platform.position.add(new Vector2(2, 0));
      engine.step(1 / 60);
    }
    expect(platform.getPlatformVelocity().x).toBeCloseTo(120, 0);
    expect(player.position.x).toBeGreaterThan(110);
    expect(player.position.x).toBeLessThan(122);
    expect(player.isOnFloor()).toBe(true);

    // Rise 60 px over a second: the character rides up without falling through.
    for (let i = 0; i < 60; i++) {
      platform.position = platform.position.add(new Vector2(0, -1));
      engine.step(1 / 60);
    }
    expect(player.position.y).toBeLessThan(y0 - 55);
    expect(player.position.y).toBeGreaterThan(y0 - 65);
    expect(player.isOnFloor()).toBe(true);

    // A crate in its way gets pushed.
    const crate = root.addChild(new RigidBody2D());
    crate.position = new Vector2(platform.position.x + 200, platform.position.y);
    crate.gravityScale = 0;
    crate.addChild(shape2D(30, 30));
    run(engine, 2 / 60);
    for (let i = 0; i < 60; i++) {
      platform.position = platform.position.add(new Vector2(3, 0));
      engine.step(1 / 60);
    }
    expect(crate.position.x).toBeGreaterThan(platform.position.x + 150);
    engine.dispose();
  });
});

describe('TileMapLayer collision (Rapier)', () => {
  it('lands characters on tiles, rebuilds when cells change and is hit by rays', async () => {
    const engine = new Engine();
    engine.setPhysics2D(await createPhysics2D([0, 980]));
    const root = new Node2D();
    const tiles = root.addChild(new TileMapLayer());
    tiles.tileSize = new Vector2(32, 32);
    for (let x = -10; x <= 10; x++) tiles.setCell(new Vector2(x, 10));
    const player = root.addChild(new Walker2D());
    player.position = new Vector2(16, 200);
    player.addChild(shape2D(20, 40));
    engine.tree.setCurrentScene(root);
    run(engine, 1.5);
    // Row 10 starts at y = 320; the 40 px tall character rests with its centre ~20 px above.
    expect(player.isOnFloor()).toBe(true);
    expect(player.position.y).toBeGreaterThan(297);
    expect(player.position.y).toBeLessThan(301);
    expect(player.getLastSlideCollision()?.collider).toBe(tiles);

    // Dig the tile out from under it: it falls to a lower row added at runtime.
    tiles.eraseCell(new Vector2(0, 10));
    for (let x = -10; x <= 10; x++) tiles.setCell(new Vector2(x, 15));
    run(engine, 1.5);
    expect(player.position.y).toBeGreaterThan(457);
    expect(player.position.y).toBeLessThan(461);

    // Non-solid atlas tiles don't collide.
    tiles.solidTiles = [new Vector2(5, 5)];
    run(engine, 1);
    expect(player.position.y).toBeGreaterThan(600);

    const ray = root.addChild(new RayCast2D());
    tiles.solidTiles = [];
    ray.position = new Vector2(-100, 0);
    ray.targetPosition = new Vector2(0, 1000);
    run(engine, 2 / 60);
    expect(ray.getCollider()).toBe(tiles);
    expect(ray.getCollisionPoint().y).toBeCloseTo(320, 1);
    engine.dispose();
  });
});

describe('3D ray casts and platforms (Rapier)', () => {
  it('hits the floor and carries characters on an AnimatableBody3D', async () => {
    const engine = new Engine();
    engine.setPhysics3D(await createPhysics3D([0, -9.8, 0]));
    const root = new Node3D();
    const floor = root.addChild(new StaticBody3D());
    floor.position = new Vector3(0, -0.5, 0);
    floor.addChild(box3D(20, 1, 20));
    const ray = root.addChild(new RayCast3D());
    ray.position = new Vector3(5, 3, 0);
    ray.targetPosition = new Vector3(0, -10, 0);
    const lift = root.addChild(new AnimatableBody3D());
    lift.position = new Vector3(0, 1, 0);
    lift.addChild(box3D(3, 0.2, 3));
    class Walker extends CharacterBody3D {
      override _physicsProcess(delta: number) {
        this.velocity.y -= 16 * delta;
        this.moveAndSlide();
      }
    }
    const player = root.addChild(new Walker());
    player.position = new Vector3(0, 2.5, 0);
    player.addChild(box3D(0.5, 1, 0.5));
    engine.tree.setCurrentScene(root);
    run(engine, 1);
    expect(ray.getCollider()).toBe(floor);
    expect(ray.getCollisionPoint().y).toBeCloseTo(0, 3);
    expect(ray.getCollisionNormal().equals(new Vector3(0, 1, 0), 1e-4)).toBe(true);
    expect(player.isOnFloor()).toBe(true);
    const y0 = player.position.y;
    expect(y0).toBeGreaterThan(1.55);
    expect(y0).toBeLessThan(1.65);
    for (let i = 0; i < 60; i++) {
      lift.position = lift.position.add(new Vector3(0.02, 0.01, 0));
      engine.step(1 / 60);
    }
    expect(player.position.x).toBeGreaterThan(1.1);
    expect(player.position.x).toBeLessThan(1.25);
    expect(player.position.y).toBeGreaterThan(y0 + 0.5);
    expect(player.isOnFloor()).toBe(true);
    engine.dispose();
  });
});
