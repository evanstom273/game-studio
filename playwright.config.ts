import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests run against the Vite dev server (editor + runtime bundles + MCP dev relay).
 * Set GS_E2E_URL to run them against another deployment instead, e.g. `wrangler dev`
 * (production build, Durable Object relay, production security headers):
 *   npm run build && npx wrangler dev --port 8787 &  GS_E2E_URL=http://127.0.0.1:8787 npm run test:e2e
 */
const external = process.env.GS_E2E_URL;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: external ?? 'http://localhost:5174',
    launchOptions: { args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] },
  },
  webServer: external
    ? undefined
    : {
    command: 'npx vite --config apps/editor/vite.config.ts --port 5174 --strictPort',
    url: 'http://localhost:5174',
    reuseExistingServer: true,
    timeout: 120_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
});
