/** The 2D platformer template is actually playable: both platforms can be reached by jumping. */
import { describe, expect, it } from 'vitest';
import { Vector2 } from '@gs/shared';
import { CharacterBody2D, Engine, Input, ScriptRegistry, instantiateScene, nodeTypes, type Node } from '@gs/core';
import { PLAYER_2D_SCRIPT, createProject } from '@gs/project';
import { createPhysics2D } from '@gs/physics2d';

const constant = (name: string) => Number(new RegExp(`${name} = (-?[\\d.]+);`).exec(PLAYER_2D_SCRIPT)![1]);

/** The template's player script, with the same constants (scripts aren't compiled in unit tests). */
class TemplatePlayer extends CharacterBody2D {
  speed = constant('speed');
  jumpVelocity = constant('jumpVelocity');
  gravity = constant('gravity');
  override _physicsProcess(delta: number) {
    const v = this.velocity;
    if (!this.isOnFloor()) v.y += this.gravity * delta;
    const jump = Input.isActionJustPressed('ui_accept') || Input.isActionJustPressed('ui_up');
    if (jump && this.isOnFloor()) v.y = this.jumpVelocity;
    v.x = Input.getAxis('ui_left', 'ui_right') * this.speed;
    this.moveAndSlide();
  }
}

const key = (code: string, pressed: boolean) => Input.feed({ type: 'key', code, key: code, pressed, echo: false });

describe('2D platformer template', () => {
  it('lets the player jump onto the first platform and from there onto the second', async () => {
    const { doc } = await createProject('Reach', '2d-platformer');
    const scripts = new ScriptRegistry();
    scripts.register('scripts/player.ts', TemplatePlayer);
    const engine = new Engine();
    engine.setPhysics2D(await createPhysics2D(doc.settings.physics.gravity2d as [number, number]));
    Input.reset();
    const root = instantiateScene(doc.scenes[doc.settings.mainScene!], { registry: nodeTypes, scripts, resources: null, scene: (p) => doc.scenes[p] });
    engine.tree.setCurrentScene(root);
    const player = root.getNode<TemplatePlayer>('Player');
    const platforms = root.children.filter((c: Node) => c.name.startsWith('Platform')) as CharacterBody2D[];
    const [right, left] = [...platforms].sort((a, b) => b.position.x - a.position.x);
    const tick = (n = 1) => {
      for (let i = 0; i < n; i++) engine.step(1 / 60);
    };
    const until = (cond: () => boolean, seconds: number) => {
      for (let i = 0; i < seconds * 60 && !cond(); i++) tick();
      return cond();
    };

    // Land on the floor.
    expect(until(() => player.isOnFloor(), 3)).toBe(true);
    const floorY = player.position.y;

    // Run right and jump onto the right-hand platform.
    key('ArrowRight', true);
    expect(until(() => player.position.x >= right.position.x - 170, 3)).toBe(true);
    key('Space', true);
    tick();
    key('Space', false);
    expect(until(() => player.isOnFloor() && player.position.y < floorY - 50, 3)).toBe(true);
    key('ArrowRight', false);
    expect(player.getLastSlideCollision()?.collider).toBe(right);

    // From its left edge, jump left onto the other platform.
    key('ArrowLeft', true);
    expect(until(() => player.position.x <= right.position.x - 125, 3)).toBe(true);
    key('Space', true);
    tick();
    key('Space', false);
    const platformY = player.position.y;
    expect(until(() => player.isOnFloor() && player.position.y < platformY - 50, 3)).toBe(true);
    key('ArrowLeft', false);
    expect(player.getLastSlideCollision()?.collider).toBe(left);
    expect(player.position.distanceTo(new Vector2(player.position.x, left.position.y - 41))).toBeLessThan(3);
    engine.dispose();
    Input.reset();
  });
});
