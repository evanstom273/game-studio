import { expect, type Page } from '@playwright/test';

export async function newProject(page: Page, template: '2d-platformer' | '3d-starter' | 'empty-2d' | 'empty-3d' = '2d-platformer', name = 'E2E game') {
  await page.goto('/');
  await page.getByTestId('new-project').click();
  await page.getByTestId('project-name').fill(name);
  await page.getByTestId(`template-${template}`).click();
  await page.getByTestId('create-project').click();
  await expect(page.getByTestId('editor')).toBeVisible();
  await expect(page.getByTestId('project-title')).toHaveText(name);
}

/** The play frame (sandboxed iframe). */
export function playerFrame(page: Page) {
  return page.frames().find((f) => f.url().includes('/player.html'));
}

export async function waitSaved(page: Page) {
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved');
}
