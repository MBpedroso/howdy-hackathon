/**
 * Strategy loading — the client's half of the sandbox boundary (spec §4.4).
 *
 * The browser runs generated code the same way the harness does: through
 * `@rematch/sandbox`, i.e. real QuickJS with no host bindings, a 2 ms `decide`
 * deadline and a 64 MB heap. The renderer and the loop only ever see a
 * `StrategyRunner`; nothing here knows what a strategy *does*.
 *
 * `loadRoundStrategy(source)` takes **source text**, never a module, never a path.
 * That is the seam the server plugs into: today the source is a `?raw` import of
 * `src/strategies/round1.js`, from Round 2 on it is whatever the Coder agent wrote
 * and the harness approved, arriving over the wire as a string.
 */
import type { StrategyRunner } from '@rematch/contract';
import { createSandbox, SandboxLoadError, type SandboxFactory } from '@rematch/sandbox';

import { deterministicClock, DETERMINISTIC_TICK_MS } from './clock.ts';

import round1Source from '../strategies/round1.js?raw';
import houndSource from '../strategies/hound.js?raw';

let factory: Promise<SandboxFactory> | null = null;

/**
 * The one QuickJS WASM instantiation in the process, memoized. Called at boot so the
 * ~1.4 MB variant is already warm by the time the player clicks Fight.
 */
export function sandboxFactory(): Promise<SandboxFactory> {
  factory ??= createSandbox();
  return factory;
}

export type LoadOptions = {
  /** Use the deterministic clock instead of `performance.now`. See above. */
  deterministic?: boolean;
};

/**
 * Load one strategy for one round.
 *
 * Runs Gate 1 (the static check) before any code executes — the sandbox does that
 * itself inside `load`, and a rejection arrives as a thrown `SandboxLoadError`
 * carrying the machine-readable `failure`, which is what the caller shows the player.
 */
export async function loadRoundStrategy(source: string, options: LoadOptions = {}): Promise<StrategyRunner> {
  const sandbox = await sandboxFactory();
  return sandbox.load(source, options.deterministic === true ? { now: deterministicClock() } : {});
}

/** Re-exported so callers can `instanceof` a load failure without importing the sandbox. */
export { SandboxLoadError };

/** Re-exported for callers that need the replay clock (see `clock.ts`). */
export { deterministicClock, DETERMINISTIC_TICK_MS };

/**
 * The strategies that ship in the bundle.
 *
 * `round1` is the boss every session starts against. `hound` is a dev/e2e seam
 * (`?strategy=hound`) and the only shipped strategy that spends `charge`, so the
 * charge telegraph has something to render.
 */
export const BUNDLED_STRATEGIES: Readonly<Record<string, string>> = Object.freeze({
  round1: round1Source,
  hound: houndSource,
});

export type BundledStrategyName = keyof typeof BUNDLED_STRATEGIES;

/** Pick a bundled strategy by `?strategy=`, falling back to Round 1's. */
export function bundledSource(name: string | null): string {
  if (name !== null) {
    const found = BUNDLED_STRATEGIES[name];
    if (found !== undefined) return found;
  }
  return round1Source;
}
