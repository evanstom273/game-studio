/**
 * GitHub in the editor, end to end in a real browser: connect a token, open a repository as a
 * project, edit, see the diff, commit to a new branch, open a pull request, pull a remote change,
 * publish a new project, add a workflow and follow a failing run to the file, and deploy the web
 * build to GitHub Pages and Cloudflare — on desktop and on a phone. The site's /github/<key>/…
 * endpoints are served by the in-memory fake GitHub (the Durable Object side is unit-tested).
 */
import { expect, test, type Page } from '@playwright/test';
import { createProject, projectTextFiles } from '@gs/project';
import { FakeGitHub } from '../fixtures/fake-github';
import { newProject } from './helpers';

async function serveGitHub(page: Page, fake: FakeGitHub) {
  let connected = false;
  let cloudflare = false;
  await page.route(/\/github\/[^/]+\/token$/, async (route) => {
    const m = route.request().method();
    if (m === 'PUT') {
      const { token } = JSON.parse(route.request().postData() ?? '{}') as { token?: string };
      if (token !== fake.token) return route.fulfill({ status: 400, json: { error: { code: 'E_GITHUB_AUTH', message: 'GitHub did not accept that token.' } } });
      connected = true;
      return route.fulfill({ json: { connected: true, login: fake.login } });
    }
    if (m === 'DELETE') connected = false;
    return route.fulfill({ json: connected ? { connected: true, login: fake.login, since: 1 } : { connected: false } });
  });
  await page.route(/\/github\/[^/]+\/api\//, async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const path = u.pathname.replace(/^\/github\/[^/]+\/api/, '') + u.search;
    if (!connected) return route.fulfill({ status: 401, json: { message: 'GitHub is not connected', code: 'E_GITHUB_NOT_CONNECTED' } });
    const body = req.postData();
    const r = await fake.fetch(path, { method: req.method(), ...(body ? { body: JSON.parse(body) } : {}) });
    if (r.status === 204) return route.fulfill({ status: 204 });
    if (/\/logs$/.test(u.pathname) && r.status === 200) return route.fulfill({ status: 200, contentType: 'text/plain', body: (r.body as { text: string }).text });
    return route.fulfill({ status: r.status, json: r.body });
  });
  await page.route(/\/github\/[^/]+\/cloudflare(\/secrets)?$/, async (route) => {
    const req = route.request();
    if (req.url().endsWith('/secrets')) {
      const { owner, repo } = JSON.parse(req.postData() ?? '{}') as { owner: string; repo: string };
      fake.repo(`${owner}/${repo}`).secrets.set('CLOUDFLARE_API_TOKEN', { encrypted_value: 'sealed', key_id: 'key-1' });
      return route.fulfill({ json: { repository: `${owner}/${repo}`, secrets: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'], workers_subdomain: 'lyra' } });
    }
    if (req.method() === 'PUT') cloudflare = true;
    if (req.method() === 'DELETE') cloudflare = false;
    return route.fulfill({ json: cloudflare ? { configured: true, accountId: '0123456789abcdef0123456789abcdef' } : { configured: false } });
  });
}

async function connect(page: Page, fake: FakeGitHub) {
  await page.getByTestId('github-token').fill('github_pat_wrong_000000000000000000');
  await page.getByTestId('github-token-save').click();
  await expect(page.getByRole('status').filter({ hasText: 'did not accept' })).toBeVisible();
  await page.getByTestId('github-token').fill(fake.token);
  await page.getByTestId('github-token-save').click();
}

/** A Game Studio project as repository files, pushed to the fake's lyra/game. */
async function seedRepo(fake: FakeGitHub, name: string) {
  const { doc, blobs } = await createProject(name, '2d-platformer');
  const files: Record<string, string | Uint8Array> = Object.fromEntries(projectTextFiles(doc));
  for (const a of Object.values(doc.assets)) files[a.path] = blobs.get(a.hash)!;
  files['README.md'] = `# ${name}\n`;
  fake.push('main', files, 'Initial project');
}

test('open a repository, edit, commit to a branch, open a pull request, pull a remote change', async ({ page }) => {
  const fake = new FakeGitHub();
  await seedRepo(fake, 'Repo game');
  await serveGitHub(page, fake);
  await page.goto('/');
  await page.getByTestId('open-github').click();
  await connect(page, fake);
  await page.locator('[data-testid="repo-row"][data-repo="lyra/game"]').click();
  await page.getByTestId('clone-repo').click();
  await expect(page.getByTestId('project-title')).toHaveText('Repo game');

  // Rename the player in the inspector.
  await page.getByTestId('scene-tree').locator('[data-node-name="Player"]').click();
  await page.getByTestId('inspector-name').fill('Hero');
  await page.getByTestId('inspector-name').press('Enter');

  await page.getByTestId('toolbar-git').click();
  await expect(page.getByTestId('git-branch')).toHaveText('lyra/game · main');
  const change = page.locator('[data-testid="git-change"][data-path="scenes/main.scene"]');
  await expect(change).toHaveAttribute('data-status', 'modified');
  await expect(page.getByTestId('git-change')).toHaveCount(1);
  await change.getByRole('button').first().click();
  await expect(page.getByTestId('diff-view')).toContainText('+       "name": "Hero",');

  await page.getByTestId('commit-message').fill('Rename the player');
  await page.getByTestId('commit-new-branch').check();
  await page.getByTestId('commit-branch-name').fill('rename-player');
  await page.getByTestId('commit-push').click();
  await expect(page.getByTestId('git-branch')).toHaveText('lyra/game · rename-player');
  await expect(page.getByTestId('git-change')).toHaveCount(0);
  expect(fake.files('rename-player')['scenes/main.scene']).toContain('"name": "Hero"');
  expect(fake.files('main')['scenes/main.scene']).not.toContain('"name": "Hero"');
  // Only the scene was uploaded.
  expect(fake.calls.filter((c) => c === 'POST /repos/lyra/game/git/blobs')).toHaveLength(1);

  await page.getByTestId('create-pr').click();
  await expect(page.getByTestId('pr-link')).toBeVisible();
  expect(fake.repo().pulls[0]).toMatchObject({ head: 'rename-player', base: 'main', state: 'open' });
  await page.getByTestId('git-view-pulls').click();
  await expect(page.getByTestId('pr-row')).toHaveCount(1);

  // A change pushed from elsewhere comes in with Pull, as one undoable step.
  fake.push('rename-player', { 'scripts/remote.ts': 'export const fromElsewhere = 1;\n' });
  await page.getByTestId('git-pull').click();
  await expect(page.getByRole('status').filter({ hasText: 'Pulled 1 file' })).toBeVisible();
  await expect(page.getByTestId('git-view-changes')).toHaveText('Changes (0)');
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid="file-row"][data-path="scripts/remote.ts"]')).toBeVisible();
  await page.getByTestId('undo').click();
  await expect(page.locator('[data-testid="file-row"][data-path="scripts/remote.ts"]')).toHaveCount(0);
});

test('on a phone: publish a new project, add the check workflow, follow a failing run to the file, deploy to Pages and Cloudflare', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fake = new FakeGitHub();
  await serveGitHub(page, fake);
  await newProject(page, '2d-platformer', 'Phone Game');
  await expect(page.getByTestId('editor')).toHaveAttribute('data-layout', 'compact');

  await page.getByTestId('menu').click();
  await page.getByTestId('menu-git').click();
  await connect(page, fake);
  await expect(page.getByTestId('publish-name')).toHaveValue('phone-game');
  await page.getByTestId('publish-private').uncheck();
  await page.getByTestId('publish-create').click();
  await expect(page.getByTestId('git-branch')).toHaveText('lyra/phone-game · main');
  expect(Object.keys(fake.files('main', 'lyra/phone-game')).sort()).toEqual(['README.md', 'gamestudio.json', 'icon.png', 'scenes/main.scene', 'scripts/player.ts']);

  // CI: the ready-made check workflow, a failing run, and its problem linked to the script.
  await page.getByTestId('git-view-actions').click();
  await page.getByTestId('add-workflow-check').click();
  await expect(page.getByTestId('workflow-row')).toHaveCount(1);
  fake.addRun('main', { name: 'Check project', conclusion: 'failure', log: '2026-01-01T00:00:00.0000000Z ✘ [ERROR] Expected ";" but found "x"\n\n2026-01-01T00:00:00.0000000Z     scripts/player.ts:3:8:\n##[error]Process completed with exit code 1.' }, 'lyra/phone-game');
  await page.getByTestId('git-view-changes').click();
  await page.getByTestId('git-view-actions').click();
  await page.getByTestId('run-row').first().click();
  await page.getByTestId('open-log').click();
  const problem = page.locator('[data-testid="log-problem"][data-file="scripts/player.ts"]');
  await expect(problem).toContainText('Expected ";" but found "x"');
  await problem.click();
  await expect(page.getByTestId('script-editor')).toBeVisible();

  // Deploy the web build to GitHub Pages.
  await page.getByTestId('menu').click();
  await page.getByTestId('menu-git').click();
  await page.getByTestId('git-view-deploy').click();
  await page.getByTestId('deploy-pages').click();
  await expect(page.getByTestId('deploy-url')).toHaveText('https://lyra.github.io/phone-game/', { timeout: 60_000 });
  const build = fake.files('gh-pages', 'lyra/phone-game');
  expect(build['docs/index.html']).toContain('<title>Phone Game</title>');
  expect(Object.keys(build)).toEqual(expect.arrayContaining(['docs/game.js', 'docs/game.json', 'docs/runtime/gs-runtime.js', 'docs/assets/icon.png', 'README.md']));
  expect(fake.repo('lyra/phone-game').pages?.source).toEqual({ branch: 'gh-pages', path: '/docs' });
  // The project's own branch is untouched by the deploy.
  expect(Object.keys(fake.files('main', 'lyra/phone-game'))).not.toContain('docs/index.html');

  // And to Cloudflare: save the credentials once, then deploy (secrets set, workflow added next to the build).
  await page.getByTestId('cloudflare-token').fill('cf_token_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345');
  await page.getByTestId('cloudflare-account').fill('0123456789abcdef0123456789abcdef');
  await page.getByTestId('cloudflare-save').click();
  await expect(page.getByTestId('cloudflare-connected')).toBeVisible();
  await page.getByTestId('deploy-cloudflare').click();
  await expect(page.getByTestId('deploy-url')).toHaveText('https://phone-game.lyra.workers.dev', { timeout: 60_000 });
  const cf = fake.files('gh-pages', 'lyra/phone-game');
  expect(cf['wrangler.jsonc']).toContain('"directory": "./docs"');
  expect(cf['.github/workflows/deploy-cloudflare.yml']).toContain('wrangler@');
  expect(fake.repo('lyra/phone-game').secrets.has('CLOUDFLARE_API_TOKEN')).toBe(true);
});

test('repository settings: rename keeps the project linked, delete needs the exact name and unlinks it', async ({ page }) => {
  const fake = new FakeGitHub();
  await seedRepo(fake, 'Settings game');
  await serveGitHub(page, fake);
  await page.goto('/');
  await page.getByTestId('open-github').click();
  await connect(page, fake);
  await page.locator('[data-testid="repo-row"][data-repo="lyra/game"]').click();
  await page.getByTestId('clone-repo').click();
  await expect(page.getByTestId('project-title')).toHaveText('Settings game');

  await page.getByTestId('toolbar-git').click();
  await page.getByTestId('git-view-repo').click();
  await page.getByTestId('repo-name').fill('settings-game');
  await page.getByTestId('repo-save').click();
  await expect(page.getByTestId('git-branch')).toHaveText('lyra/settings-game · main');
  expect(fake.repos.has('lyra/settings-game')).toBe(true);

  await page.getByTestId('git-view-repo').click();
  await expect(page.getByTestId('repo-delete')).toBeDisabled();
  await page.getByTestId('repo-delete-confirm').fill('lyra/settings-game');
  await page.getByTestId('repo-delete').click();
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('git-not-linked')).toBeVisible();
  expect(fake.repos.has('lyra/settings-game')).toBe(false);
});
