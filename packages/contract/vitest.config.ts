import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Fixture strategies are data, not tests. Never let vitest transform them.
    exclude: ['test/fixtures/**'],
  },
});
