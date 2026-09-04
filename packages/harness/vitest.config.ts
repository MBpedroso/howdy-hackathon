import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Fixture strategies are data, not tests. Never let vitest transform them.
    exclude: ['test/fixtures/**'],
    // Gate 2 boots a QuickJS runtime per fixture and fuzzes 500+ states.
    testTimeout: 60_000,
    /**
     * One test file at a time. Gates 2 and 4 measure *wall clock* against a 2 ms
     * per-call deadline, and Gate 3 saturates every core with simulation workers:
     * run those two concurrently and a `decide` that costs 20 µs gets descheduled
     * past its deadline, which shows up as a flaky "exceeded its 2 ms budget" on a
     * known-good fixture. Sequential files cost a few seconds and buy a suite whose
     * verdicts mean what they say.
     */
    fileParallelism: false,
  },
});
