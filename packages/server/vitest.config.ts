import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // The fallback strategies are data — `strategy.js` source read as text and run
    // inside QuickJS. Vitest must never try to transform or collect them.
    exclude: ['fallback/**'],
    // The pool's balance regression runs 8 strategies x 32 panel matches in QuickJS.
    testTimeout: 120_000,
    /**
     * One test file at a time, for the same reason `@rematch/harness` does it: Gates 2
     * and 4 measure wall clock against a 2 ms per-call deadline while Gate 3 saturates
     * every core with simulation workers. Run them concurrently and a known-good
     * strategy gets descheduled past its budget and fails for no reason.
     */
    fileParallelism: false,
  },
});
