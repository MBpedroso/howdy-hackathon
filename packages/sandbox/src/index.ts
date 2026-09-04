/**
 * `@rematch/sandbox` — QuickJS containment for generated boss strategies.
 *
 * The engine never imports a strategy and never imports QuickJS: it is handed a
 * `StrategyRunner` (the interface in `@rematch/contract`) and calls `decide`
 * once per tick. This package is the only implementation that runs untrusted
 * code, and it is the runtime half of spec §4.4:
 *
 *   - no host bindings at all — nothing to call out to;
 *   - no `Date`, no `RegExp`, no `Proxy` (removed as *intrinsics*, so no
 *     prototype chain leads back to them), no `Math.random`, no `eval`,
 *     no `Function`, no `globalThis`;
 *   - `rand()`: a seeded xorshift32 written in JS inside the VM, so randomness is
 *     deterministic per round seed and costs no boundary crossing;
 *   - 2 ms per `decide` (QuickJS interrupt handler on a deadline), 64 MB heap,
 *     4 KB serialized strategy memory;
 *   - `decide` **never throws**: a timeout, a throw, an over-budget memory object
 *     and a garbage return value all come back as `{ ok: false, failure }`.
 *
 * ```ts
 * import { createSandbox } from '@rematch/sandbox';
 *
 * const sandbox = await createSandbox();     // instantiates the WASM once
 * const runner = sandbox.load(source);       // synchronous from here on
 * runner.init(seed);
 * const result = runner.decide(view);        // never throws
 * runner.dispose();
 * ```
 */

export {
  createSandbox,
  loadStrategy,
  loadStrategyUnchecked,
  SandboxInitError,
  SandboxLoadError,
  type SandboxFactory,
  type SandboxOptions,
} from './loadStrategy.ts';

export {
  getQuickJSModule,
  SANDBOX_DELETED_GLOBALS,
  SANDBOX_INTRINSICS,
} from './quickjs.ts';

export { NON_FINITE_TAG, PRELUDE_GLOBALS } from './prelude.ts';

// Re-exported for consumers that only depend on this package's surface.
export type { DecideResult, RunnerFailure, StrategyRunner } from '@rematch/contract';
