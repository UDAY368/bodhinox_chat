import os from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// End-to-end tests run the real app (next dev) against the isolated test
// database; see scripts/e2e-server.cjs. Never point them at production.
const port = process.env.E2E_PORT || '3100';
const baseURL = `http://localhost:${port}`;
// Run artifacts live outside the project: the dev server watches the
// project folder, and every trace/screenshot write would reload the page.
const E2E_RUN_DIR = path.join(os.tmpdir(), 'bodhinox-e2e');

export default defineConfig({
  testDir: 'e2e',
  outputDir: path.join(E2E_RUN_DIR, 'test-results'),
  // One worker: the dev server compiles routes on first hit, and the
  // seeded fixtures are shared across specs.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never', outputFolder: path.join(E2E_RUN_DIR, 'report') }]]
    : [['list']],
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node scripts/e2e-server.cjs',
    url: `${baseURL}/api/health`,
    // Never reuse a running server: a local dev server may point at production.
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
