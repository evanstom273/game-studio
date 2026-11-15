import { expect, test } from '@playwright/test';
import { newProject, playerFrame, waitSaved } from './helpers';

test('creates a project, edits nodes with undo/redo, and keeps changes across a reload', async ({ page }) => {
  await newProject(page, '2d-platformer', 'Persistence');
  const tree = page.getByTestId('scene-tree');
  await expect(tree.getByTestId('tree-row')).toHaveCount(14);

  // Add a node through the Add Node dialog.
  await page.getByTestId('add-node').click();
  await page.getByTestId('node-search').fill('Label2D');
  await page.getByTestId('node-type-Label2D').click();
  await page.getByTestId('add-node-confirm').click();
  await expect(tree.locator('[data-node-name="Label2D"]')).toBeVisible();

  // Edit a property in the inspector.
  await page.getByTestId('prop-text').fill('Hello inspector');
  await page.getByTestId('prop-text').blur();
  await page.getByTestId('prop-fontSize').fill('40');
  await page.getByTestId('prop-fontSize').press('Enter');

  // Undo removes the font size change, redo brings it back.
  await page.getByTestId('undo').click();
  await expect(page.getByTestId('prop-fontSize')).toHaveValue('24');
  await page.getByTestId('redo').click();
  await expect(page.getByTestId('prop-fontSize')).toHaveValue('40');

  // Rename via the inspector.
  await page.getByTestId('inspector-name').fill('Greeting');
  await page.getByTestId('inspector-name').press('Enter');
  await expect(tree.locator('[data-node-name="Greeting"]')).toBeVisible();

  await waitSaved(page);
  await page.reload();
  await expect(page.getByTestId('editor')).toBeVisible();
  await page.getByTestId('scene-tree').locator('[data-node-name="Greeting"]').click();
  await expect(page.getByTestId('prop-fontSize')).toHaveValue('40');
  await expect(page.getByTestId('prop-text')).toHaveValue('Hello inspector');
});

test('plays the 2D platformer in the sandboxed player and the player responds to input', async ({ page }) => {
  await newProject(page, '2d-platformer', 'Play 2D');
  await page.getByTestId('play-main').click();
  await expect(page.getByTestId('play-view')).toHaveAttribute('data-status', 'running');
  const frame = playerFrame(page)!;
  // Sandboxed: an opaque origin with no access to the editor's storage.
  expect(await frame.evaluate(() => origin)).toBe('null');
  await expect.poll(() => frame.evaluate(() => (GameStudio.Engine.current?.tree.currentScene?.getNode('Player') as unknown as { isOnFloor(): boolean } | undefined)?.isOnFloor())).toBe(true);
  const x0 = await frame.evaluate(() => GameStudio.Engine.current!.tree.currentScene!.getNode<InstanceType<typeof GameStudio.Node2D>>('Player').position.x);
  await page.getByTestId('player-frame').click();
  await page.keyboard.down('ArrowRight');
  await page.waitForTimeout(700);
  await page.keyboard.up('ArrowRight');
  const x1 = await frame.evaluate(() => GameStudio.Engine.current!.tree.currentScene!.getNode<InstanceType<typeof GameStudio.Node2D>>('Player').position.x);
  expect(x1 - x0).toBeGreaterThan(100);
  await page.getByTestId('stop-game').click();
  await expect(page.getByTestId('viewport')).toBeVisible();
});

test('plays the 3D starter: physics bodies fall and land', async ({ page }) => {
  await newProject(page, '3d-starter', 'Play 3D');
  await expect(page.getByTestId('viewport')).toHaveAttribute('data-mode', '3d');
  await page.getByTestId('play-main').click();
  await expect(page.getByTestId('play-view')).toHaveAttribute('data-status', 'running');
  const frame = playerFrame(page)!;
  await expect.poll(() => frame.evaluate(() => (GameStudio.Engine.current!.tree.currentScene!.getNode('Crate') as unknown as { position: { y: number } }).position.y), { timeout: 20_000 }).toBeLessThan(0.6);
  expect(await frame.evaluate(() => (GameStudio.Engine.current!.tree.currentScene!.getNode('Player') as unknown as { isOnFloor(): boolean }).isOnFloor())).toBe(true);
});

test('reports script errors from play mode in the console', async ({ page }) => {
  await newProject(page, 'empty-2d', 'Errors');
  // Attach a broken script to the root through the inspector.
  await page.getByTestId('scene-tree').getByTestId('tree-row').first().click();
  await page.getByTestId('new-script').click();
  await expect(page.getByTestId('script-editor')).toBeVisible();
  const editor = page.locator('.cm-content');
  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\nconst broken = ;\n');
  await expect(page.getByTestId('script-status')).toContainText('1', { timeout: 15_000 });
  await page.getByTestId('play-main').click();
  await expect(page.getByTestId('play-error')).toContainText('Scripts have errors');
  await expect(page.getByTestId('console')).toContainText('Unexpected');
});

test('exports a web build and a project archive', async ({ page }) => {
  await newProject(page, '2d-platformer', 'Export me');
  await page.getByTestId('menu').click();
  await page.getByTestId('menu-export').click();
  const [web] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-web').click()]);
  expect(web.suggestedFilename()).toBe('export-me-web.zip');
  await expect(page.getByTestId('export-result')).toContainText('render2d, physics2d');
  const [archive] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-archive').click()]);
  expect(archive.suggestedFilename()).toBe('export-me.gsproj');
});
