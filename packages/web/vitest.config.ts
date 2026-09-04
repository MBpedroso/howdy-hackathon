import { defineConfig } from 'vitest/config';

/**
 * Unit tests only. `include` is narrowed to `test/` on purpose: `e2e/` holds Playwright
 * specs, and Vitest's default glob would pick up their `test()` calls and fail with a
 * confusing "did not expect test() to be called here".
 *
 * `environment: 'node'` — every unit test here is deliberately DOM-free (pure input
 * mapping, viewport maths, seed derivation, and a full sandboxed replay in Node). The
 * DOM-dependent parts of the client are covered by the Playwright suite against a real
 * browser, which is the only place they mean anything.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
