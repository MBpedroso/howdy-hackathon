/**
 * Playwright — chromium only (spec §5.2: the browser test exists to prove the game
 * boots and that the browser agrees with Node, not to chase engine differences).
 *
 * The suite runs against the **built** bundle by default (`vite build` + `vite
 * preview`), because the thing most likely to break is the QuickJS variant surviving
 * Rollup, not the dev server. `E2E_SERVER=dev` points it at `vite dev` instead, which
 * is how the dev path gets the same coverage.
 *
 * Artifacts (screenshots, traces) land in the repo-root `artifacts/`, which is
 * gitignored and is where spec §7 says the browser evidence goes.
 *
 * `--host 127.0.0.1` is not decoration: Vite binds `localhost` by default, which on a
 * machine with IPv6 resolves to `::1`, and Playwright's readiness probe against
 * `127.0.0.1` then times out while the server is perfectly healthy.
 */
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 4173);
const useDevServer = process.env.E2E_SERVER === 'dev';
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  outputDir: '../../artifacts/playwright',
  fullyParallel: false,
  // One worker: every spec drives the same singleton QuickJS instance in its own page,
  // but the fixture replay is CPU-bound and parallel runs make its timing noisy.
  workers: 1,
  forbidOnly: process.env.CI === 'true',
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI === 'true' ? [['github'], ['list']] : [['list']],
  use: {
    baseURL,
    viewport: { width: 1200, height: 1000 },
    deviceScaleFactor: 1,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: useDevServer
      ? `pnpm exec vite --host 127.0.0.1 --port ${PORT} --strictPort`
      : `pnpm exec vite build && pnpm exec vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: baseURL,
    reuseExistingServer: process.env.CI !== 'true',
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
