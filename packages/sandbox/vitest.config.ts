import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['test/fixtures/**'],
    // A QuickJS runtime per load; the leak suite does 200 of them.
    testTimeout: 60_000,
  },
});
