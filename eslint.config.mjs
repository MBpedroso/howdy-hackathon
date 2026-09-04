/**
 * ESLint — flat config. One job only.
 *
 * This is a *deterministic control* (spec §7): "A lint rule forbids `Math.random` and
 * `Date.now` in `engine/`." It is not a style tool. There are no formatting rules, no
 * recommended presets, no type-aware linting — adding any of those would make `pnpm
 * lint` slow, noisy, and something an agent would be tempted to `--fix` its way around.
 *
 * What it forbids, and why each one:
 *
 * | Forbidden           | Why it breaks determinism                                  |
 * |---------------------|------------------------------------------------------------|
 * | `Math.random()`     | Unseeded entropy. The engine has `prng.ts`; use it.        |
 * | `Date.now()`        | Wall-clock. Replays would diverge between runs.            |
 * | `new Date()`        | Same, plus timezone dependence.                            |
 * | `performance.now()` | Monotonic clock, still wall-clock-shaped. Also non-        |
 * |                     | portable: it does not exist inside QuickJS.                |
 *
 * Scope is deliberately narrow — `packages/engine/src` and `packages/contract/src`, the
 * two packages that must produce bit-identical results in the browser and in Node
 * (AC 3). Everything else in the workspace legitimately needs clocks:
 *
 *   - `packages/sandbox/src/loadStrategy.ts` uses `performance.now()` as the default
 *     deadline clock for the 2 ms `decide()` budget (§4.4). That is a *host-side*
 *     measurement of untrusted guest code, never an input to the simulation, so it does
 *     not affect determinism. It lives in `sandbox`, outside this rule's globs, which is
 *     the exemption — no inline disable needed.
 *   - `harness` times the perf gate, `server` stamps SSE events, `agents` measures
 *     latency, `web` drives requestAnimationFrame.
 *
 * If a future engine file genuinely needs a clock, that is a design conversation, not an
 * `eslint-disable` — the fix is to pass the value in from the caller so the simulation
 * stays a pure function of (seed, inputs).
 */

import tsParser from '@typescript-eslint/parser';

/** The packages that must be bit-deterministic. Everything else is unlinted. */
const DETERMINISTIC_SRC = [
  'packages/engine/src/**/*.{ts,tsx,mts,cts,js,mjs,cjs}',
  'packages/contract/src/**/*.{ts,tsx,mts,cts,js,mjs,cjs}',
];

const WHY = 'forbidden in engine/ and contract/: the simulation must be a pure function of (seed, inputs) so replays match byte-for-byte in the browser and in Node (spec §7, AC 3).';

/**
 * `no-restricted-properties` catches the plain member reads. `no-restricted-syntax`
 * below covers what it cannot see: `new Date()`, bare `Date()`, computed access like
 * `Math['random']`, and destructuring like `const { now } = Date`.
 */
const restrictedProperties = [
  { object: 'Math', property: 'random', message: `Math.random is ${WHY} Use the seeded PRNG in packages/engine/src/prng.ts.` },
  { object: 'Date', property: 'now', message: `Date.now is ${WHY} Take the tick from the game state, or pass the time in from the caller.` },
  { object: 'performance', property: 'now', message: `performance.now is ${WHY} It also does not exist inside QuickJS. Measure from the host (packages/sandbox, packages/harness) instead.` },
];

const restrictedSyntax = [
  {
    selector: "NewExpression[callee.name='Date']",
    message: `new Date is ${WHY} Take the tick from the game state, or pass the time in from the caller.`,
  },
  {
    selector: "CallExpression[callee.name='Date']",
    message: `Date() is ${WHY} Take the tick from the game state, or pass the time in from the caller.`,
  },
  // Computed access defeats no-restricted-properties: Math['random'], Date['now'].
  {
    selector: "MemberExpression[computed=true][object.name=/^(Math|Date|performance)$/]",
    message: `Computed access to Math/Date/performance is ${WHY} Name the property so the lint rule can see it.`,
  },
  // Destructuring defeats it too: const { random } = Math; const { now } = Date.
  {
    selector: "VariableDeclarator[init.name=/^(Math|Date|performance)$/] ObjectPattern > Property[key.name=/^(random|now)$/]",
    message: `Destructuring random/now off Math, Date or performance is ${WHY}`,
  },
  // `import { performance } from 'node:perf_hooks'` — Node APIs have no business here.
  {
    selector: "ImportDeclaration[source.value=/^(node:)?(perf_hooks|crypto)$/]",
    message: `Node clock and entropy modules are ${WHY}`,
  },
];

export default [
  {
    // Global ignores. Nothing here is ours to lint.
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.vite/**',
      'artifacts/**',
      'coverage/**',
      // Deliberately-bad strategy fixtures: their whole purpose is to contain the
      // forbidden identifiers so Gate 1's static check can reject them.
      '**/test/fixtures/**',
    ],
  },
  {
    files: DETERMINISTIC_SRC,
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2024,
      sourceType: 'module',
      // No `project` / `projectService`: these are purely syntactic selectors, and
      // type-aware linting would cost seconds for nothing. `pnpm typecheck` already
      // owns types.
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    linterOptions: {
      // The whole point of a deterministic control is that it cannot be waved away, and
      // an `// eslint-disable-next-line no-restricted-properties` is exactly the wave.
      // `noInlineConfig` makes ESLint ignore inline directives in these files entirely,
      // so the comment does not suppress anything...
      noInlineConfig: true,
      // ...and this then reports the dead directive as an error, so the attempt itself
      // fails the commit instead of passing silently.
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      'no-restricted-properties': ['error', ...restrictedProperties],
      'no-restricted-syntax': ['error', ...restrictedSyntax],
    },
  },
];
