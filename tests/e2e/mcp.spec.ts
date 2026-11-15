/**
 * The scenario from the brief, through real MCP: an MCP client (the SDK's Streamable HTTP client,
 * as Claude uses) → the dev server's relay → this editor tab → the shared command layer.
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
    const text = (r.content as { text: string }[])[0].text;
    const parsed = JSON.parse(text);
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

test('an AI assistant builds and runs a 3D scene through MCP', async ({ page }) => {
  await newProject(page, 'empty-3d', 'MCP world');
  await page.getByTestId('toolbar-mcp').click();
  await page.getByTestId('mcp-toggle').check();
  await expect(page.getByTestId('mcp-status')).toContainText('Connected');
  const url = (await page.getByTestId('mcp-url').textContent())!;
  await page.keyboard.press('Escape');
  const { client, call } = await connect(url);

  const status = await call('status');
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

  // The editor shows it: the new scene is open with the nodes in its tree.
  await expect(page.getByTestId('scene-tree').locator('[data-node-name="Player"]')).toBeVisible();

  const diags = await call('get_diagnostics');
  expect(diags.errors).toBe(0);
  expect(diags.warnings).toBe(0);

  const run = await call('run_scene', { seconds: 3 });
  expect(run.started).toBe(true);
  expect(run.errors).toBe(0);
  expect(run.fps).toBeGreaterThan(0);

  // Validation and atomicity: a bad batch changes nothing.
  const before = (await call('get_scene', { scene: 'scenes/arena.scene' })).revision;
  await expect(call('edit_project', { commands: [{ op: 'add_node', scene: 'scenes/arena.scene', type: 'Node3D', name: 'Ok' }, { op: 'add_node', scene: 'scenes/arena.scene', type: 'Spaceship' }] })).rejects.toMatchObject({ code: 'E_UNKNOWN_TYPE' });
  expect((await call('get_scene', { scene: 'scenes/arena.scene' })).revision).toBe(before);

  // Revision checks protect the user's edits.
  await expect(call('update_node', { scene: 'scenes/arena.scene', node: 'Sun', props: { energy: 2 }, expected_revision: 'stale' })).rejects.toMatchObject({ code: 'E_REVISION_CONFLICT' });

  // AI edits are ordinary undo steps for the user.
  await call('update_node', { scene: 'scenes/arena.scene', node: 'Sun', props: { energy: 2 } });
  const undone = await call('undo');
  expect(undone.undone).toContain('AI:');

  // Permissions: switching the connection to read-only blocks edits.
  await page.getByTestId('toolbar-mcp').click();
  await page.getByTestId('mcp-level').selectOption('read');
  await page.keyboard.press('Escape');
  await expect(call('remove_node', { scene: 'scenes/arena.scene', node: 'Player' })).rejects.toMatchObject({ code: 'E_FORBIDDEN' });
  expect((await call('get_scene', { scene: 'scenes/arena.scene' })).outline).toContain('Player (CharacterBody3D)');
  await client.close();
});
