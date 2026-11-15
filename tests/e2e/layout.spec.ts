import { expect, test } from '@playwright/test';
import { newProject } from './helpers';

const shots = 'test-results/layouts';

test.describe('phone', () => {
  test.use({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.6, isMobile: true, hasTouch: true });
  test('uses the compact layout: full-screen viewport, bottom navigation and sheets', async ({ page }) => {
    await newProject(page, '2d-platformer', 'Phone');
    await expect(page.getByTestId('editor')).toHaveAttribute('data-layout', 'compact');
    await expect(page.getByTestId('bottom-nav')).toBeVisible();
    await expect(page.getByTestId('context-toolbar')).toBeVisible();
    await page.screenshot({ path: `${shots}/phone-viewport.png` });
    // Scene sheet → tap a node → inspector sheet shows it.
    await page.getByTestId('nav-scene').tap();
    await expect(page.getByTestId('bottom-sheet')).toHaveAttribute('data-sheet', 'scene');
    await page.locator('[data-node-name="Player"]').tap();
    await page.screenshot({ path: `${shots}/phone-scene-sheet.png` });
    await page.getByTestId('nav-inspector').tap();
    await expect(page.getByTestId('inspector-name')).toHaveValue('Player');
    await page.screenshot({ path: `${shots}/phone-inspector-sheet.png` });
    // Touch targets are at least 40 px.
    const box = await page.getByTestId('nav-files').boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(40);
  });

  test('landscape phone is still compact', async ({ page }) => {
    await page.setViewportSize({ width: 915, height: 412 });
    await newProject(page, '3d-starter', 'Landscape');
    await expect(page.getByTestId('editor')).toHaveAttribute('data-layout', 'compact');
    await page.screenshot({ path: `${shots}/phone-landscape.png` });
  });
});

test.describe('tablet and unfolded foldable', () => {
  test.use({ viewport: { width: 884, height: 1104 }, hasTouch: true, isMobile: true });
  test('uses the medium layout with a tabbed dock, and re-flows when folded', async ({ page }) => {
    await newProject(page, '2d-platformer', 'Foldable');
    await expect(page.getByTestId('editor')).toHaveAttribute('data-layout', 'medium');
    await expect(page.getByTestId('dock')).toBeVisible();
    await page.screenshot({ path: `${shots}/foldable-unfolded.png` });
    // Fold to the cover screen: the same session switches to the compact layout.
    await page.setViewportSize({ width: 374, height: 812 });
    await expect(page.getByTestId('editor')).toHaveAttribute('data-layout', 'compact');
    await page.screenshot({ path: `${shots}/foldable-folded.png` });
    // And back.
    await page.setViewportSize({ width: 884, height: 1104 });
    await expect(page.getByTestId('editor')).toHaveAttribute('data-layout', 'medium');
  });
});

test.describe('dual-screen spanning', () => {
  test.use({ viewport: { width: 1200, height: 800 }, hasTouch: true });
  test('puts the viewport on one segment and panels on the other', async ({ page }) => {
    await page.addInitScript(() => {
      const segs = [new DOMRect(0, 0, 590, 800), new DOMRect(610, 0, 590, 800)];
      Object.defineProperty(window, 'viewport', { value: { segments: segs } });
    });
    await newProject(page, '3d-starter', 'Dual');
    await expect(page.getByTestId('editor')).toHaveAttribute('data-layout', 'split');
    const vp = await page.getByTestId('viewport').boundingBox();
    const dock = await page.getByTestId('dock').boundingBox();
    expect(vp!.x + vp!.width).toBeLessThanOrEqual(591);
    expect(dock!.x).toBeGreaterThanOrEqual(609);
    await page.screenshot({ path: `${shots}/dual-screen.png` });
  });
});

test('desktop uses the wide multi-panel layout', async ({ page }) => {
  await newProject(page, '3d-starter', 'Desktop');
  await expect(page.getByTestId('editor')).toHaveAttribute('data-layout', 'wide');
  await expect(page.getByTestId('scene-tree')).toBeVisible();
  await expect(page.getByTestId('inspector')).toBeVisible();
  await expect(page.getByTestId('file-browser')).toBeVisible();
  await page.screenshot({ path: `${shots}/desktop-3d.png` });
});
