/**
 * The AI connection end to end, with a real MCP client (the SDK's Streamable HTTP client, as Claude
 * uses) against the site's MCP endpoint:
 *
 *  1. The AI builds a 3D scene while Game Studio is CLOSED (it edits the cloud copy).
 *  2. Opening Game Studio brings the work in; changes made while it's open appear live.
 *  3. With the editor open, the AI can run the game and read its errors.
 *
 *   "Create a new 3D scene, add a floor, directional light and controllable character,
 *    then run it and report any errors."
 */
import { expect, test } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { newProject } from './helpers';

async function connect(url: string) {
  const client = new Client({ name: 'e2e', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const parsed = JSON.parse((r.content as { text: string }[])[0].text);
    if (r.isError) throw Object.assign(new Error(parsed.error.message), { code: parsed.error.code });
    return parsed;
  };
  return { client, call };
}

const PLAYER = `import { CharacterBody3D, Input } from 'gamestudio';

export default class Player extends CharacterBody3D {
  static exports = ['speed'];
  speed = 4;
  override _physicsProcess(delta: number) {
    if (!this.isOnFloor()) this.velocity.y -= 12 * delta;
    const dir = Input.getVector('ui_left', 'ui_right', 'ui_up', 'ui_down');
    this.velocity.x = dir.x * this.speed;
    this.velocity.z = dir.y * this.speed;
    this.moveAndSlide();
  }
}
`;

test('an AI assistant builds a 3D scene with Game Studio closed, then runs it once it is open', async ({ page }) => {
  await newProject(page, 'empty-3d', 'MCP world');
  await page.getByTestId('toolbar-mcp').click();
  await page.getByTestId('mcp-toggle').check();
  await expect(page.getByTestId('mcp-status')).toContainText('even when Game Studio is closed');
  const url = (await page.getByTestId('mcp-url').textContent())!;
  const editorUrl = page.url();

  // --- 1. Game Studio closed ----------------------------------------------------------------------
  await page.goto('about:blank');
  const { client, call } = await connect(url);
  const status = await call('status');
  expect(status.editorOpen).toBe(false);
  expect(status.project.name).toBe('MCP world');

  await call('create_scene', { path: 'scenes/arena.scene', rootType: 'Node3D', rootName: 'Arena', setMain: true });
  const script = await call('write_script', { path: 'scripts/player.ts', source: PLAYER });
  expect(script.compiled).toBe(true);
  const built = await call('edit_project', {
    commands: [
      { op: 'add_node', scene: 'scenes/arena.scene', type: 'StaticBody3D', name: 'Floor', ref: 'floor' },
      { op: 'add_node', scene: 'scenes/arena.scene', parent: '$floor', type: 'MeshInstance3D', props: { mesh: { type: 'box', size: [16, 0.5, 16] }, position: [0, -0.25, 0] } },
      { op: 'add_node', scene: 'scenes/arena.scene', parent: '$floor', type: 'CollisionShape3D', props: { shape: { type: 'box', size: [16, 0.5, 16] }, position: [0, -0.25, 0] } },
      { op: 'add_node', scene: 'scenes/arena.scene', type: 'DirectionalLight3D', name: 'Sun', props: { rotationDegrees: [-45, 30, 0], shadowEnabled: true } },
      { op: 'add_node', scene: 'scenes/arena.scene', type: 'Camera3D', name: 'Camera', props: { position: [0, 6, 10], rotationDegrees: [-30, 0, 0], current: true } },
      { op: 'add_node', scene: 'scenes/arena.scene', type: 'CharacterBody3D', name: 'Player', ref: 'p', script: 'scripts/player.ts', props: { position: [0, 2, 0] } },
      { op: 'add_node', scene: 'scenes/arena.scene', parent: '$p', type: 'MeshInstance3D', props: { mesh: { type: 'capsule', radius: 0.4, height: 1.6 }, material: { albedo: '#4f8cff' } } },
      { op: 'add_node', scene: 'scenes/arena.scene', parent: '$p', type: 'CollisionShape3D', props: { shape: { type: 'capsule', radius: 0.4, height: 1.6 } } },
    ],
  });
  expect(built.results).toHaveLength(8);
  const diags = await call('get_diagnostics');
  expect(diags.errors).toBe(0);
  expect(diags.warnings).toBe(0);
  // Running needs a browser: a clear answer, not a hang.
  await expect(call('run_scene', { seconds: 2 })).rejects.toMatchObject({ code: 'E_NO_EDITOR' });

  // Validation and atomicity: a bad batch changes nothing.
  const before = (await call('get_scene', { scene: 'scenes/arena.scene' })).revision;
  await expect(call('edit_project', { commands: [{ op: 'add_node', scene: 'scenes/arena.scene', type: 'Node3D', name: 'Ok' }, { op: 'add_node', scene: 'scenes/arena.scene', type: 'Spaceship' }] })).rejects.toMatchObject({ code: 'E_UNKNOWN_TYPE' });
  expect((await call('get_scene', { scene: 'scenes/arena.scene' })).revision).toBe(before);
  await expect(call('update_node', { scene: 'scenes/arena.scene', node: 'Sun', props: { energy: 2 }, expected_revision: 'stale' })).rejects.toMatchObject({ code: 'E_REVISION_CONFLICT' });

  // --- 2. Open Game Studio: the work is there --------------------------------------------------------
  await page.goto(editorUrl);
  await expect(page.getByTestId('editor')).toBeVisible();
  await expect(page.locator('[data-testid="file-row"][data-path="scenes/arena.scene"]')).toBeVisible();
  await page.locator('[data-testid="file-row"][data-path="scenes/arena.scene"] button').first().click();
  await expect(page.getByTestId('scene-tree').locator('[data-node-name="Player"]')).toBeVisible();

  // Live: a change while it's open appears without reloading, as an undoable step.
  await call('add_node', { scene: 'scenes/arena.scene', type: 'MeshInstance3D', name: 'Coin', props: { position: [2, 1, 0] } });
  await expect(page.getByTestId('scene-tree').locator('[data-node-name="Coin"]')).toBeVisible();
  const undone = await call('undo');
  expect(undone.undone).toContain('Coin');
  await expect(page.getByTestId('scene-tree').locator('[data-node-name="Coin"]')).toHaveCount(0);

  // --- 3. With the editor open, the AI can run the game ----------------------------------------------
  await expect(page.getByTestId('toolbar-mcp')).toBeVisible();
  const run = await call('run_scene', { seconds: 3 });
  expect(run.started).toBe(true);
  expect(run.errors).toBe(0);
  expect(run.fps).toBeGreaterThan(0);

  // Permissions chosen in the editor are enforced by the cloud copy.
  await page.getByTestId('toolbar-mcp').click();
  await page.getByTestId('mcp-level').selectOption('read');
  await page.keyboard.press('Escape');
  await expect.poll(() => call('remove_node', { scene: 'scenes/arena.scene', node: 'Player' }).then(() => 'allowed', (e) => e.code)).toBe('E_FORBIDDEN');
  expect((await call('get_scene', { scene: 'scenes/arena.scene' })).outline).toContain('Player (CharacterBody3D)');
  await client.close();
});

test('an AI builds a visual script over MCP and it runs in the player', async ({ page }) => {
  await newProject(page, 'empty-2d', 'Visual MCP');
  await page.getByTestId('toolbar-mcp').click();
  await page.getByTestId('mcp-toggle').check();
  await expect(page.getByTestId('mcp-status')).toContainText('even when Game Studio is closed');
  await page.getByTestId('mcp-level').selectOption('full');
  const url = (await page.getByTestId('mcp-url').textContent())!;
  await page.keyboard.press('Escape');
  const { client, call } = await connect(url);

  await call('add_node', { type: 'Node2D', name: 'Mover', props: { position: [100, 100] } });
  const created = await call('create_visual_script', { path: 'scripts/mover.vgraph', nodeType: 'Node2D', events: ['_ready', '_process'], attach: { node: 'Mover' } });
  const fns = created.functions as { name: string; nodes: { id: string; type: string }[] }[];
  const readyEntry = fns.find((f) => f.name === '_ready')!.nodes[0].id;
  const tickEntry = fns.find((f) => f.name === '_process')!.nodes[0].id;
  const edited = await call('edit_visual_script', {
    path: 'scripts/mover.vgraph',
    ops: [
      { op: 'add_node', graph: '_ready', ref: 'hello', type: 'core.print', inputs: { value: 'hello from a graph' } },
      { op: 'connect', graph: '_ready', from: { node: readyEntry, port: 'then' }, to: { node: '$hello', port: 'exec' } },
      { op: 'add_node', graph: '_process', ref: 'rot', type: 'gs.node2d.rotate', inputs: { radians: 0.05 } },
      { op: 'connect', graph: '_process', from: { node: tickEntry, port: 'then' }, to: { node: '$rot', port: 'exec' } },
    ],
  });
  expect(edited.diagnostics).toEqual([]);
  expect(edited.code).toContain('this.rotate(0.05);');
  await expect(page.locator('[data-testid="file-row"][data-path="scripts/mover.vgraph"]')).toBeVisible();

  const run = await call('run_scene', { seconds: 2 });
  expect(run.errors).toBe(0);
  expect(JSON.stringify(run)).toContain('hello from a graph');
  await client.close();
});
