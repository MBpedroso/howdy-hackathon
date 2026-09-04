import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['test/fixtures/**'],
    // The loop test runs a real Gate 3 (a worker pool of QuickJS sandboxes).
    testTimeout: 60_000,
    // Same reason as the harness: Gate 3 saturates every core, and Gates 2/4
    // measure wall clock against a 2 ms per-call deadline.
    fileParallelism: false,
  },
});
