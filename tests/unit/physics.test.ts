import { describe, expect, it } from 'vitest';
import { Vector2, Vector3 } from '@gs/shared';
import { Area2D, CharacterBody2D, CharacterBody3D, CollisionShape2D, CollisionShape3D, Engine, Input, Node, Node2D, Node3D, RigidBody2D, RigidBody3D, StaticBody2D, StaticBody3D } from '@gs/core';
import { createPhysics2D } from '@gs/physics2d';
import { createPhysics3D } from '@gs/physics3d';

function shape2D(w: number, h: number) {
  const s = new CollisionShape2D();
  s.shape = { type: 'rectangle', size: [w, h] };
  return s;
}

class Faller2D extends CharacterBody2D {
  landedAt = -1;
  override _physicsProcess(delta: number) {
    this.velocity.y += 1600 * delta;
    this.velocity.x = Input.getAxis('ui_left', 'ui_right') * 300;
    this.moveAndSlide();
    if (this.isOnFloor() && this.landedAt < 0) this.landedAt = this.position.y;
  }
}

describe('2D physics (Rapier)', () => {
  it('lands characters on floors, settles rigid bodies and reports area overlaps', async () => {
    const engine = new Engine();
    engine.setPhysics2D(await createPhysics2D([0, 980]));
    const root = new Node2D('Root');
    const floor = root.addChild(new StaticBody2D('Floor'));
    floor.position = new Vector2(0, 500);
    floor.addChild(shape2D(2000, 40));
    const player = root.addChild(new Faller2D('Player'));
    player.position = new Vector2(0, 100);
    player.addChild(shape2D(40, 60));
    const crate = root.addChild(new RigidBody2D('Crate'));
    crate.position = new Vector2(-600, 0);
    crate.addChild(shape2D(50, 50));
    const zone = root.addChild(new Area2D('Zone'));
    zone.position = new Vector2(0, 440);
    zone.addChild(shape2D(100, 60));
    const entered: Node[] = [];
    zone.bodyEntered.connect((b) => entered.push(b));
    engine.tree.setCurrentScene(root);

    for (let i = 0; i < 180; i++) engine.step(1 / 60);

    // Floor top is at y = 480; the player's 60 px box rests with its centre ~30 px above it.
    expect(player.isOnFloor()).toBe(true);
    expect(player.position.y).toBeGreaterThan(445);
    expect(player.position.y).toBeLessThan(452);
    expect(player.velocity.y).toBe(0);
    expect(crate.position.y).toBeGreaterThan(450);
    expect(crate.position.y).toBeLessThan(457);
    expect(entered).toContain(player);

    // Walking right moves the character along the floor and out of the area.
    Input.feed({ type: 'key', code: 'ArrowRight', key: 'ArrowRight', pressed: true, echo: false });
    const exited: Node[] = [];
    zone.bodyExited.connect((b) => exited.push(b));
    for (let i = 0; i < 60; i++) engine.step(1 / 60);
    // 300 px/s for one second, with no speed lost to the floor.
    expect(player.position.x).toBeCloseTo(300, 0);
    expect(player.isOnFloor()).toBe(true);
    expect(exited).toContain(player);
    engine.dispose();
  });

  it('stops characters at walls', async () => {
    const engine = new Engine();
    engine.setPhysics2D(await createPhysics2D([0, 0]));
    const root = new Node2D();
    const wall = root.addChild(new StaticBody2D('Wall'));
    wall.position = new Vector2(200, 0);
    wall.addChild(shape2D(20, 400));
    class Runner extends CharacterBody2D {
      override _physicsProcess() {
        this.velocity = new Vector2(400, 0);
        this.moveAndSlide();
      }
    }
    const r = root.addChild(new Runner());
    r.addChild(shape2D(20, 20));
    engine.tree.setCurrentScene(root);
    for (let i = 0; i < 60; i++) engine.step(1 / 60);
    expect(r.position.x).toBeGreaterThan(178);
    expect(r.position.x).toBeLessThan(181);
    expect(r.isOnWall()).toBe(true);
    engine.dispose();
  });
});

describe('3D physics (Rapier)', () => {
  it('lands characters and drops rigid bodies onto a floor', async () => {
    const engine = new Engine();
    engine.setPhysics3D(await createPhysics3D([0, -9.8, 0]));
    const root = new Node3D('Root');
    const floor = root.addChild(new StaticBody3D('Floor'));
    floor.position = new Vector3(0, -0.25, 0);
    const fs = floor.addChild(new CollisionShape3D());
    fs.shape = { type: 'box', size: [20, 0.5, 20] };
    class Walker extends CharacterBody3D {
      override _physicsProcess(delta: number) {
        this.velocity.y -= 16 * delta;
        this.velocity.x = 2;
        this.moveAndSlide();
      }
    }
    const player = root.addChild(new Walker());
    player.position = new Vector3(0, 3, 0);
    const ps = player.addChild(new CollisionShape3D());
    ps.shape = { type: 'capsule', radius: 0.4, height: 1.6 };
    const crate = root.addChild(new RigidBody3D());
    crate.position = new Vector3(0, 4, -5);
    crate.addChild(new CollisionShape3D());
    engine.tree.setCurrentScene(root);
    for (let i = 0; i < 120; i++) engine.step(1 / 60);
    expect(player.isOnFloor()).toBe(true);
    expect(player.position.y).toBeGreaterThan(0.75);
    expect(player.position.y).toBeLessThan(0.85);
    expect(player.position.x).toBeGreaterThan(3);
    expect(crate.position.y).toBeGreaterThan(0.45);
    expect(crate.position.y).toBeLessThan(0.55);
    engine.dispose();
  });
});
