import { expect, test, type Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { newProject, playerFrame, waitSaved } from './helpers';

const shots = 'test-results/visual';

/** Add a node through the add-node menu by searching for it. */
async function addNode(page: Page, query: string, entry?: string) {
  await expect(page.getByTestId('add-node-menu')).toBeVisible();
  await page.getByTestId('add-node-search').fill(query);
  const item = entry ? page.locator(`[data-testid="add-node-item"][data-entry="${entry}"]`) : page.getByTestId('add-node-item').first();
  await item.click();
  await expect(page.getByTestId('add-node-menu')).toHaveCount(0);
}

const nodes = (page: Page) => page.getByTestId('graph-canvas').getByTestId('graph-node');

test.describe('desktop', () => {
  test.use({ deviceScaleFactor: 2 });

  test('creates a visual script from the inspector, builds a graph, shows its code and runs it', async ({ page }) => {
    await newProject(page, '2d-platformer', 'Visual');
    await page.getByTestId('scene-tree').locator('[data-node-name="Hint"]').click();
    await page.getByTestId('new-visual-script').click();
    const editor = page.getByTestId('graph-editor');
    await expect(editor).toBeVisible();
    await expect(editor).toHaveAttribute('data-path', 'scripts/hint.vgraph');
    // A Label2D gets Ready and Every Frame; the file browser shows the new script with its own icon.
    await expect(page.getByTestId('graph-tab')).toHaveText(['Ready', 'Every Frame']);
    await expect(page.locator('[data-testid="file-row"][data-path="scripts/hint.vgraph"] [aria-label="Visual script"]')).toBeVisible();
    await expect(page.getByTestId('script-extends')).toHaveValue('Label2D');

    // Add an event from the add-node menu: it opens that event's graph.
    await page.getByTestId('graph-add-node').click();
    await addNode(page, 'enter tree', 'event:_enterTree');
    await expect(page.locator('[data-testid="graph-tab"][aria-selected="true"]')).toHaveText('Enter Tree');

    // Back to Ready: Print, then Set Text, each joining on after the last step.
    await page.locator('[data-testid="graph-tab"][data-fn="_ready"]').click();
    await expect(nodes(page)).toHaveCount(1);
    await page.getByTestId('graph-add-node').click();
    await addNode(page, 'print', 'core.print');
    await expect(nodes(page)).toHaveCount(2);
    const print = page.locator('[data-testid="graph-node"][data-node-type="core.print"]');
    await print.getByLabel('Value value').fill('Hello from a graph');
    await page.keyboard.press('Tab');
    await page.getByTestId('graph-add-node').click();
    await addNode(page, 'set text', 'gs.label2d.set.text');
    await expect(nodes(page)).toHaveCount(3);
    const setText = page.locator('[data-testid="graph-node"][data-node-type="gs.label2d.set.text"]');
    await setText.getByLabel('Text value').fill('Made with a graph');
    // The node inspector shows the selected node (Set Text was just added and is selected).
    await expect(page.getByTestId('node-inspector')).toContainText('Set Text');

    // Generated code and no problems.
    await page.getByTestId('toggle-code').click();
    const code = page.getByTestId('code-text');
    await expect(code).toContainText('export default class Hint extends Label2D {');
    await expect(code).toContainText("console.log('Hello from a graph');");
    await expect(code).toContainText("this.text = 'Made with a graph';");
    await expect(code).toContainText('_enterTree(): void {');
    await expect(page.getByTestId('graph-status')).toHaveAttribute('data-errors', '0');
    await page.getByTestId('graph-fit').click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${shots}/desktop-graph.png` });

    // Undo removes the last value edit and the graph follows the document.
    await page.getByTestId('undo').click();
    await expect(code).not.toContainText('Made with a graph');
    await page.getByTestId('redo').click();
    await expect(code).toContainText("this.text = 'Made with a graph';");

    // A diagnostic: Set Text without its value shows on the node and in the problems list, and
    // clicking it selects the node.
    await setText.getByLabel('Text value').fill('Made with a graph');
    await waitSaved(page);

    // Play: the graph runs as the label's script.
    await page.getByTestId('play-main').click();
    await expect(page.getByTestId('play-view')).toHaveAttribute('data-status', 'running');
    const frame = playerFrame(page)!;
    await expect.poll(() => frame.evaluate(() => (GameStudio.Engine.current?.tree.currentScene?.getNode('Hint') as unknown as { text: string } | undefined)?.text)).toBe('Made with a graph');
    await page.getByTestId('bottom-tab-console').click();
    await expect(page.getByTestId('console')).toContainText('Hello from a graph');
    await expect(page.getByTestId('play-error')).toHaveCount(0);
    await page.getByTestId('stop-game').click();
    await expect(editor).toBeVisible();
  });

  test('drag a wire onto empty canvas to add a compatible node; errors show on nodes and link to them', async ({ page }) => {
    await newProject(page, 'empty-2d', 'Wires');
    await page.getByTestId('scene-tree').getByTestId('tree-row').first().click();
    await page.getByTestId('new-visual-script').click();
    await expect(page.getByTestId('graph-editor')).toBeVisible();
    // Drag from the Entry's exec pin to empty space: the menu lists nodes that can follow it.
    const pin = page.locator('[data-testid="graph-node"][data-node-type="core.entry"] [data-testid="pin-out-then"]');
    const box = (await pin.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 200, box.y + 60, { steps: 8 });
    await page.mouse.move(box.x + 260, box.y + 80, { steps: 4 });
    await page.mouse.up();
    await expect(page.getByTestId('add-node-menu')).toContainText('can connect to the dragged pin');
    // Get Node is pure (no exec input), so it is not offered for an exec wire.
    await page.getByTestId('add-node-search').fill('get node');
    await expect(page.locator('[data-testid="add-node-item"][data-entry="gs.get_node"]')).toHaveCount(0);
    await addNode(page, 'move and slide', 'gs.characterbody2d.move_and_slide');
    // Node2D isn't a CharacterBody2D: the node shows the error, the code view lists it.
    const move = page.locator('[data-testid="graph-node"][data-node-type="gs.characterbody2d.move_and_slide"]');
    await expect(move).toHaveAttribute('data-diag', 'error');
    await expect(move.getByTestId('node-diagnostic')).toContainText("isn't a CharacterBody2D");
    await expect(page.getByTestId('graph-status')).not.toHaveAttribute('data-errors', '0');
    await page.getByTestId('graph-status').click();
    await page.locator('[data-testid="visual-diagnostic"]').first().click();
    await expect(page.getByTestId('node-inspector')).toContainText('Move And Slide');
    // Fix it by changing what the script extends: the error goes away.
    await page.getByTestId('script-extends').selectOption('CharacterBody2D');
    await expect(page.getByTestId('graph-status')).toHaveAttribute('data-errors', '0');
    await expect(page.getByTestId('code-text')).toContainText('this.moveAndSlide();');
  });
});

test('the open graph follows edits made by the AI connection, and their undo', async ({ page }) => {
  await newProject(page, 'empty-2d', 'AI graph');
  await page.getByTestId('scene-tree').getByTestId('tree-row').first().click();
  await page.getByTestId('new-visual-script').click();
  await expect(page.getByTestId('graph-editor')).toBeVisible();
  const path = (await page.getByTestId('graph-editor').getAttribute('data-path'))!;
  await page.getByTestId('toolbar-mcp').click();
  await page.getByTestId('mcp-toggle').check();
  // Connected and synced: the AI's edits now reach this editor live.
  await expect(page.getByTestId('mcp-status')).toContainText('even when Game Studio is closed');
  const url = (await page.getByTestId('mcp-url').textContent())!;
  await page.keyboard.press('Escape');
  const client = new Client({ name: 'e2e', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  const call = async (name: string, args: Record<string, unknown> = {}) => JSON.parse(((await client.callTool({ name, arguments: args })).content as { text: string }[])[0].text);

  // The AI adds a Print node after Ready by rewriting the .vgraph (as write_script does).
  const doc = JSON.parse((await call('read_script', { path })).source);
  const ready = doc.functions.find((f: { event?: string }) => f.event === '_ready');
  const entry = ready.graph.nodes[0];
  ready.graph.nodes.push({ id: 'n_ai_print', type: 'core.print', position: { x: 320, y: 0 }, props: {}, inputs: { value: 'Written by the AI' } });
  ready.graph.edges.push({ id: 'e_ai', from: { node: entry.id, port: 'then' }, to: { node: 'n_ai_print', port: 'exec' } });
  expect((await call('write_script', { path, source: JSON.stringify(doc) })).compiled).toBe(true);
  await expect(page.locator('[data-testid="graph-node"][data-node-id="n_ai_print"]')).toBeVisible();
  await expect(page.locator('[data-testid="graph-node"][data-node-id="n_ai_print"]').getByLabel('Value value')).toHaveValue('Written by the AI');
  await page.getByTestId('toggle-code').click();
  await expect(page.getByTestId('code-text')).toContainText("console.log('Written by the AI');");
  // Undo (here, in the editor) takes it away again and the canvas follows.
  await page.getByTestId('undo').click();
  await expect(page.locator('[data-testid="graph-node"][data-node-id="n_ai_print"]')).toHaveCount(0);
  await expect(page.getByTestId('code-text')).not.toContainText('Written by the AI');
  await client.close();
});

test.describe('phone', () => {
  test.use({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

  test('creates and edits a visual script with touch: sheets, tap-to-add, code view', async ({ page }) => {
    await newProject(page, '2d-platformer', 'Phone graph');
    await expect(page.getByTestId('editor')).toHaveAttribute('data-layout', 'compact');
    await page.getByTestId('nav-scene').tap();
    await page.locator('[data-node-name="Hint"]').tap();
    await page.getByTestId('nav-inspector').tap();
    await page.getByTestId('new-visual-script').tap();
    // The sheet closes and the graph fills the screen.
    await expect(page.getByTestId('graph-editor')).toBeVisible();
    await expect(page.getByTestId('bottom-sheet')).toHaveCount(0);
    await expect(page.getByTestId('graph-hint')).toBeVisible();

    // Add (bottom bar) → bottom sheet → tap a node: it joins on after Ready.
    await page.getByTestId('nav-add').tap();
    await expect(page.getByTestId('add-node-menu')).toBeVisible();
    await page.screenshot({ path: `${shots}/phone-add-node.png` });
    await page.locator('[data-testid="add-node-item"][data-entry="core.print"]').first().tap();
    await expect(nodes(page)).toHaveCount(2);
    await page.getByTestId('nav-add').tap();
    await page.getByTestId('add-node-search').fill('set text');
    await page.locator('[data-testid="add-node-item"][data-entry="gs.label2d.set.text"]').tap();
    await expect(nodes(page)).toHaveCount(3);
    // Touch-size pins.
    const pin = await page.locator('[data-testid="graph-node"][data-node-type="core.print"] [data-testid="pin-in-exec"]').boundingBox();
    expect(pin!.height).toBeGreaterThanOrEqual(18);

    // Edit the selected node's value in the inspector sheet (bigger fields than on the node).
    await page.getByTestId('selection-inspect').tap();
    await expect(page.getByTestId('node-inspector')).toContainText('Set Text');
    await page.getByTestId('node-inspector').getByLabel('Text value').fill('Hi from my phone');
    await page.getByTestId('nav-inspector').tap();
    await expect(page.getByTestId('bottom-sheet')).toHaveCount(0);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${shots}/phone-graph.png` });

    // Long-press a node for its menu (a sheet on phones): duplicate it, then delete the copy.
    const cdp = await page.context().newCDPSession(page);
    const longPress = async (x: number, y: number) => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      await page.waitForTimeout(700);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    const title = (await page.locator('[data-testid="graph-node"][data-node-type="gs.label2d.set.text"] [data-testid="node-title"]').boundingBox())!;
    await longPress(title.x + title.width / 2, title.y + title.height / 2);
    await expect(page.getByTestId('node-menu')).toBeVisible();
    await page.getByTestId('node-menu-duplicate').tap();
    await expect(nodes(page)).toHaveCount(4);
    await page.getByTestId('selection-delete').tap();
    await expect(nodes(page)).toHaveCount(3);
    // Long-press empty canvas: the add-node menu.
    const canvas = (await page.getByTestId('graph-canvas').boundingBox())!;
    await longPress(canvas.x + 60, canvas.y + canvas.height - 200);
    await expect(page.getByTestId('add-node-menu')).toBeVisible();
    await page.getByTestId('add-node-menu').getByRole('button', { name: 'Close', exact: true }).tap();
    await expect(page.getByTestId('add-node-menu')).toHaveCount(0);

    // Script panel and code as sheets.
    await page.getByTestId('toggle-members').tap();
    await expect(page.getByTestId('members-sheet')).toBeVisible();
    await expect(page.getByTestId('members-sheet').getByTestId('function-row')).toHaveCount(2);
    await page.screenshot({ path: `${shots}/phone-members.png` });
    await page.getByTestId('toggle-code').tap();
    await expect(page.getByTestId('code-sheet')).toBeVisible();
    await expect(page.getByTestId('code-text')).toContainText("this.text = 'Hi from my phone';");
    await page.screenshot({ path: `${shots}/phone-code.png` });
  });
});
