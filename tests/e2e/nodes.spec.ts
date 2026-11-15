/**
 * The extended node set in the real editor and player: a scene built over MCP with tiles, lights,
 * particles, paths, an AnimationPlayer, a moving platform, ray casts, parallax and a HUD (CanvasLayer,
 * containers, label, progress bar, buttons). It must load without problems, draw in the editor,
 * support tile painting, and play: the character lands on tiles, the animation moves things, and
 * clicking a HUD button runs its handler without reaching the game as a mouse press.
 *
 * Set GS_SHOTS=<dir> to save screenshots.
 */
import { expect, test, type Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { newProject, playerFrame } from './helpers';

async function connect(url: string) {
  const client = new Client({ name: 'e2e-nodes', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const parsed = JSON.parse((r.content as { text: string }[])[0].text);
    if (r.isError) throw Object.assign(new Error(parsed.error.message), { code: parsed.error.code });
    return parsed;
  };
}

const shot = async (page: Page, name: string) => {
  if (process.env.GS_SHOTS) await page.screenshot({ path: `${process.env.GS_SHOTS}/${name}.png` });
};

const MAIN = `import { Button, Label, Node2D, ProgressBar } from 'gamestudio';

export default class Main extends Node2D {
  clicks = 0;
  override _ready() {
    this.getNode<Button>('HUD/Margin/Column/Row/ClickMe').pressed.connect(() => {
      this.clicks++;
      this.getNode<Label>('HUD/Margin/Column/Score').text = 'Clicks: ' + this.clicks;
      this.getNode<ProgressBar>('HUD/Margin/Column/Health').value -= 10;
    });
  }
}
`;

const PLAYER = `import { CharacterBody2D, Input } from 'gamestudio';

export default class Player extends CharacterBody2D {
  mousePresses = 0;
  override _physicsProcess(delta: number) {
    if (!this.isOnFloor()) this.velocity.y += 1600 * delta;
    this.velocity.x = Input.getAxis('ui_left', 'ui_right') * 250;
    this.moveAndSlide();
  }
  override _input(e: { type: string; phase?: string }) {
    if (e.type === 'pointer' && e.phase === 'down') this.mousePresses++;
  }
}
`;

const S = 'scenes/showcase.scene';
const ground: number[] = [];
for (let x = 0; x < 36; x++) ground.push(x, 17, 0, 0);
for (let x = 10; x < 14; x++) ground.push(x, 14, 1, 0);

const COMMANDS = [
  { op: 'add_node', scene: S, type: 'CanvasModulate', name: 'Night', props: { color: '#6a7090' } },
  { op: 'add_node', scene: S, type: 'Parallax2D', name: 'Far', ref: 'far', props: { scrollScale: [0.5, 1], repeatSize: [400, 0], zIndex: -10 } },
  { op: 'add_node', scene: S, parent: '$far', type: 'Polygon2D', name: 'Hill', props: { color: '#2a3350', polygon: [[0, 560], [200, 360], [400, 560]] } },
  { op: 'add_node', scene: S, type: 'TileMapLayer', name: 'Ground', props: { tileSize: [32, 32], cells: ground } },
  { op: 'add_node', scene: S, type: 'PointLight2D', name: 'Lamp', props: { position: [250, 450], range: 300, color: '#ffd28a', energy: 1.3 } },
  { op: 'add_node', scene: S, type: 'PointLight2D', name: 'Moon', props: { position: [900, 200], range: 260, color: '#8ab4ff' } },
  { op: 'add_node', scene: S, type: 'CharacterBody2D', name: 'Player', ref: 'player', script: 'scripts/player.ts', props: { position: [200, 400] } },
  { op: 'add_node', scene: S, parent: '$player', type: 'Polygon2D', name: 'Body', props: { color: '#4f8cff', polygon: [[-14, -20], [14, -20], [14, 20], [-14, 20]] } },
  { op: 'add_node', scene: S, parent: '$player', type: 'CollisionShape2D', name: 'Shape', props: { shape: { type: 'rectangle', size: [28, 40] } } },
  { op: 'add_node', scene: S, parent: '$player', type: 'RayCast2D', name: 'GroundCheck', props: { targetPosition: [0, 40] } },
  { op: 'add_node', scene: S, type: 'Line2D', name: 'Laser', props: { points: [[600, 100], [800, 200], [1000, 120]], width: 6, defaultColor: '#f87171', jointMode: 'round', capMode: 'round' } },
  { op: 'add_node', scene: S, type: 'Path2D', name: 'Track', ref: 'track', props: { position: [700, 260], points: [[0, 0], [200, 0], [200, 150], [0, 150]], closed: true } },
  { op: 'add_node', scene: S, parent: '$track', type: 'PathFollow2D', name: 'Rider', ref: 'rider' },
  { op: 'add_node', scene: S, parent: '$rider', type: 'Polygon2D', name: 'Cart', props: { color: '#4ade80', polygon: [[-10, -10], [10, -10], [10, 10], [-10, 10]] } },
  { op: 'add_node', scene: S, type: 'AnimatableBody2D', name: 'Lift', ref: 'lift', props: { position: [480, 470] } },
  { op: 'add_node', scene: S, parent: '$lift', type: 'Polygon2D', name: 'Deck', props: { color: '#f5a524', polygon: [[-50, -8], [50, -8], [50, 8], [-50, 8]] } },
  { op: 'add_node', scene: S, parent: '$lift', type: 'CollisionShape2D', name: 'Shape', props: { shape: { type: 'rectangle', size: [100, 16] } } },
  {
    op: 'add_node',
    scene: S,
    type: 'AnimationPlayer',
    name: 'Anim',
    props: {
      autoplay: 'loop',
      animations: {
        loop: {
          length: 4,
          loop: true,
          tracks: [
            { path: 'Track/Rider', property: 'progress', keys: [[0, 0], [4, 700]] },
            { path: 'Lift', property: 'position', interpolation: 'cubic', keys: [[0, [480, 470]], [2, [480, 380]], [4, [480, 470]]] },
          ],
        },
      },
    },
  },
  { op: 'add_node', scene: S, type: 'CPUParticles2D', name: 'Sparks', props: { position: [900, 150], amount: 60, lifetime: 1.2, direction: [0, -1], spread: 30, initialVelocityMin: 120, initialVelocityMax: 220, gravity: [0, 300], color: '#ffd28a', colorEnd: '#ff4d4d00', scaleAmountMin: 0.6, scaleAmountMax: 1.4 } },
  { op: 'add_node', scene: S, type: 'VisibleOnScreenNotifier2D', name: 'FarAway', props: { position: [2400, 300] } },
  { op: 'add_node', scene: S, type: 'Marker2D', name: 'Spawn', props: { position: [200, 380] } },
  { op: 'add_node', scene: S, type: 'AudioStreamPlayer2D', name: 'Hum', props: { position: [480, 470] } },
  { op: 'add_node', scene: S, type: 'CanvasLayer', name: 'HUD', ref: 'hud' },
  { op: 'add_node', scene: S, parent: '$hud', type: 'MarginContainer', name: 'Margin', ref: 'margin', props: { layoutPreset: 'fullRect', marginLeft: 16, marginTop: 16, marginRight: 16, marginBottom: 16 } },
  { op: 'add_node', scene: S, parent: '$margin', type: 'VBoxContainer', name: 'Column', ref: 'col', props: { separation: 8, sizeFlagsHorizontal: 'shrinkBegin', sizeFlagsVertical: 'shrinkBegin' } },
  { op: 'add_node', scene: S, parent: '$col', type: 'Label', name: 'Score', props: { text: 'Clicks: 0', fontSize: 22, outlineSize: 4 } },
  { op: 'add_node', scene: S, parent: '$col', type: 'ProgressBar', name: 'Health', props: { value: 80, size: [220, 22] } },
  { op: 'add_node', scene: S, parent: '$col', type: 'HBoxContainer', name: 'Row', ref: 'row', props: { separation: 8 } },
  { op: 'add_node', scene: S, parent: '$row', type: 'Button', name: 'ClickMe', props: { text: 'Click me' } },
  { op: 'add_node', scene: S, parent: '$row', type: 'Button', name: 'Toggle', props: { text: 'Toggle', toggleMode: true } },
  { op: 'add_node', scene: S, parent: '$hud', type: 'Panel', name: 'Info', ref: 'info', props: { layoutPreset: 'bottomRight', position: [-16, -16], size: [260, 70], borderWidth: 1, cornerRadius: 8 } },
  { op: 'add_node', scene: S, parent: '$info', type: 'Label', name: 'Text', props: { layoutPreset: 'fullRect', position: [10, 8], text: 'Tiles, lights, particles, paths and a HUD', autowrap: true, fontSize: 14 } },
];

test('the extended nodes load, draw in the editor, paint tiles and play with a clickable HUD', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(e.message));

  await newProject(page, 'empty-2d', 'Node showcase');
  await page.getByTestId('toolbar-mcp').click();
  await page.getByTestId('mcp-toggle').check();
  const url = (await page.getByTestId('mcp-url').textContent())!;
  await page.keyboard.press('Escape');
  const call = await connect(url);
  // The editor uploads the new project to the cloud copy the AI works on.
  await expect.poll(async () => (await call('status')).project?.name, { timeout: 20_000 }).toBe('Node showcase');

  expect((await call('write_script', { path: 'scripts/main.ts', source: MAIN })).compiled).toBe(true);
  expect((await call('write_script', { path: 'scripts/player.ts', source: PLAYER })).compiled).toBe(true);
  await call('create_scene', { path: S, rootType: 'Node2D', rootName: 'Main', setMain: true });
  await call('edit_project', { commands: [{ op: 'attach_script', scene: S, node: '.', script: 'scripts/main.ts' }, ...COMMANDS] });
  const diags = await call('get_diagnostics');
  expect(diags.errors).toBe(0);
  expect(diags.warnings).toBe(0);
  // Schemas list the new types and their signals.
  expect((await call('get_node_type', { type: 'Button' })).signals).toContain('pressed');

  // --- the editor ------------------------------------------------------------------------------------------
  await page.locator(`[data-testid="file-row"][data-path="${S}"] button`).first().click();
  const tree = page.getByTestId('scene-tree');
  await expect(tree.locator('[data-node-name="ClickMe"]')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('viewport-2d')).toBeVisible();
  await page.waitForTimeout(800);
  await shot(page, 'editor-showcase');

  // Tile painting: select the tile map, pick the paint tool, drag across empty space above the ground.
  await tree.locator('[data-node-name="Ground"]').click();
  await expect(page.getByTestId('tile-palette')).toBeVisible();
  await expect(page.getByText('40 tiles')).toBeVisible();
  await page.getByTestId('tile-2-0').click();
  await expect(page.getByTestId('tile-paint')).toHaveAttribute('aria-pressed', 'true');
  const box = (await page.getByTestId('viewport-2d').boundingBox())!;
  const y = box.y + box.height * 0.35;
  await page.mouse.move(box.x + box.width * 0.3, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.45, y, { steps: 8 });
  await page.mouse.up();
  const painted = Number(/(\d+) tiles/.exec((await page.getByText(/\d+ tiles/).textContent())!)![1]);
  expect(painted).toBeGreaterThan(40);
  await shot(page, 'editor-painted');
  // One stroke is one undo step.
  await page.getByTestId('undo').click();
  await expect(page.getByText('40 tiles')).toBeVisible();
  await page.getByTestId('tile-paint').click();

  // --- play -------------------------------------------------------------------------------------------------
  await page.getByTestId('play-main').click();
  await expect(page.getByTestId('play-view')).toHaveAttribute('data-status', 'running');
  const frame = playerFrame(page)!;
  type Probe = { onFloor: boolean; ray: boolean; particles: number; progress: number; liftY: number; farOnScreen: boolean; renderers: number; mousePresses: number; clicks: number; score: string; health: number; button: { x: number; y: number } };
  const probe = () =>
    frame.evaluate((): Probe => {
      const GS = GameStudio;
      const scene = GS.Engine.current!.tree.currentScene!;
      const player = scene.getNode('Player') as unknown as InstanceType<typeof GS.CharacterBody2D> & { mousePresses: number };
      const btn = scene.getNode('HUD/Margin/Column/Row/ClickMe') as unknown as InstanceType<typeof GS.Button>;
      // Button centre in canvas CSS pixels: viewport → canvas through the 2D renderer's stretch.
      const r2 = GS.Engine.current!.renderers.find((r) => 'stretchTransform' in r) as unknown as { stretchTransform: InstanceType<typeof GS.Transform2D> };
      const t = btn.getCanvasTransform().multiply(btn.globalTransform);
      const s = btn.getSize();
      const c = r2.stretchTransform.apply(t.apply(new GS.Vector2(s.x / 2, s.y / 2)));
      return {
        onFloor: player.isOnFloor(),
        ray: (scene.getNode('Player/GroundCheck') as unknown as InstanceType<typeof GS.RayCast2D>).isColliding(),
        particles: (scene.getNode('Sparks') as unknown as InstanceType<typeof GS.CPUParticles2D>).getParticleCount(),
        progress: (scene.getNode('Track/Rider') as unknown as InstanceType<typeof GS.PathFollow2D>).progress,
        liftY: (scene.getNode('Lift') as unknown as InstanceType<typeof GS.Node2D>).position.y,
        farOnScreen: (scene.getNode('FarAway') as unknown as InstanceType<typeof GS.VisibleOnScreenNotifier2D>).isOnScreen(),
        renderers: GS.Engine.current!.renderers.length,
        mousePresses: player.mousePresses,
        clicks: (scene as unknown as { clicks: number }).clicks,
        score: (scene.getNode('HUD/Margin/Column/Score') as unknown as InstanceType<typeof GS.Label>).text,
        health: (scene.getNode('HUD/Margin/Column/Health') as unknown as InstanceType<typeof GS.ProgressBar>).value,
        button: { x: c.x, y: c.y },
      };
    });
  await expect.poll(async () => (await probe()).onFloor, { timeout: 10_000 }).toBe(true);
  await page.waitForTimeout(1200);
  const p1 = await probe();
  expect(p1.ray).toBe(true);
  expect(p1.particles).toBeGreaterThan(10);
  expect(p1.progress).toBeGreaterThan(0);
  expect(p1.liftY).toBeLessThan(470);
  expect(p1.farOnScreen).toBe(false);
  await shot(page, 'play-showcase');

  // Click the HUD button for real: the handler runs, the game doesn't see a mouse press.
  const frameBox = (await page.getByTestId('player-frame').boundingBox())!;
  await page.mouse.click(frameBox.x + p1.button.x, frameBox.y + p1.button.y);
  await expect.poll(async () => (await probe()).clicks).toBe(1);
  const p2 = await probe();
  expect(p2.score).toBe('Clicks: 1');
  expect(p2.health).toBe(70);
  expect(p2.mousePresses).toBe(0);
  // A click on the game world does reach the game.
  await page.mouse.click(frameBox.x + frameBox.width / 2, frameBox.y + frameBox.height * 0.6);
  await expect.poll(async () => (await probe()).mousePresses).toBe(1);
  await shot(page, 'play-clicked');

  const playErrors = await page.getByTestId('play-view').evaluate(() => document.querySelectorAll('[data-level="error"]').length);
  expect(playErrors).toBe(0);
  const run = await call('get_console', { level: 'error' });
  expect(run.entries).toEqual([]);
  await page.getByTestId('stop-game').click();
  expect(consoleErrors).toEqual([]);
});

test('a 3D game with a HUD loads the 2D renderer on top', async ({ page }) => {
  await newProject(page, 'empty-3d', 'HUD over 3D');
  await page.getByTestId('toolbar-mcp').click();
  await page.getByTestId('mcp-toggle').check();
  const url = (await page.getByTestId('mcp-url').textContent())!;
  await page.keyboard.press('Escape');
  const call = await connect(url);
  await expect.poll(async () => (await call('status')).project?.name, { timeout: 20_000 }).toBe('HUD over 3D');
  const scene = (await call('get_project')).settings.mainScene as string;
  await call('edit_project', {
    commands: [
      { op: 'add_node', scene, type: 'MeshInstance3D', name: 'Box' },
      { op: 'add_node', scene, type: 'CanvasLayer', name: 'HUD', ref: 'hud' },
      { op: 'add_node', scene, parent: '$hud', type: 'Label', name: 'Title', props: { layoutPreset: 'centerTop', position: [0, 24], text: 'HUD over 3D', fontSize: 32 } },
      { op: 'add_node', scene, parent: '$hud', type: 'Button', name: 'Go', props: { layoutPreset: 'bottomRight', position: [-20, -20], text: 'Go' } },
    ],
  });
  expect((await call('get_diagnostics')).warnings).toBe(0);
  await expect(page.getByTestId('scene-tree').locator('[data-node-name="Go"]')).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('play-main').click();
  await expect(page.getByTestId('play-view')).toHaveAttribute('data-status', 'running');
  const frame = playerFrame(page)!;
  await expect.poll(() => frame.evaluate(() => GameStudio.Engine.current?.renderers.length ?? 0)).toBe(2);
  await page.waitForTimeout(500);
  await shot(page, 'play-3d-hud');
  expect((await call('get_console', { level: 'error' })).entries).toEqual([]);
  await page.getByTestId('stop-game').click();
});
