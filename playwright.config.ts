import { defineConfig, devices } from '@playwright/test';

// E2E_DIR=dist-artifact で単一HTML版も同じテストで検証できる
const DIR = process.env.E2E_DIR ?? 'out';
const PORT = DIR === 'out' ? 4173 : DIR === 'dist-artifact' ? 4174 : 4175;
// サブパス配信（GitHub Pages）の検証用：E2E_BASE=/land-design-cad/
const BASE = process.env.E2E_BASE ?? '/';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}${BASE}`, trace: 'off', screenshot: 'only-on-failure' },
  webServer: { command: `python3 -m http.server ${PORT} --directory ${DIR} --bind 127.0.0.1`, url: `http://127.0.0.1:${PORT}`, reuseExistingServer: true, timeout: 30_000 },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], channel: 'chrome', viewport: { width: 1440, height: 900 } }, testIgnore: /(mobile|shots)\.spec\.ts/ },
    { name: 'iphone', use: { ...devices['iPhone 14'], browserName: 'chromium', channel: 'chrome' }, testMatch: /mobile\.spec\.ts/ },
  ],
});
