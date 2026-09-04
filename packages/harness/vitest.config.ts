import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Fixture strategies are data, not tests. Never let vitest transform them.
    exclude: ['test/fixtures/**'],
    // Gate 2 boots a QuickJS runtime per fixture and fuzzes 500+ states.
    testTimeout: 60_000,
  },
});
