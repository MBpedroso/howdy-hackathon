/**
 * Strategy loading — the client's half of the sandbox boundary (spec §4.4).
 *
 * The browser runs generated code the same way the harness does: through
 * `@rematch/sandbox`, i.e. real QuickJS with no host bindings and a 64 MB heap. The
 * renderer and the loop only ever see a `StrategyRunner`; nothing here knows what a
 * strategy *does*.
 *
 * ## The one place live play differs from the harness: the `decide` deadline
 *
 * `CONSTANTS.limits.decideBudgetMs` is 2 ms, and 2 ms is a **harness** number. It is
 * the frame-budget promise a strategy has to keep, and Gate 4 is where that promise
 * is judged — statistically, against the p99, on the machine that runs the gates
 * (spec §6.3: `"decide() p99 = 6.2ms > 2ms"`). Enforcing the same 2 ms *per call*
 * against `performance.now` in a live tab measures something else entirely: whether
 * the browser happened to schedule a GC, a compositor pass or another tab inside
 * this one call. Warden's measured p99 in Chromium is 0.3 ms — 6x of headroom — and
 * a single scheduling hiccup still blows it, and the engine answers a blown deadline
 * with an idle tick. A boss that stutters because the tab was busy is a worse bug
 * than a boss that spends 4 ms on one frame.
 *
 * So live play multiplies the budget by {@link LIVE_BUDGET_FACTOR}. The sandbox is
 * still the same sandbox and a runaway `while (true)` is still stopped in 20 ms
 * rather than hanging the page — that is the containment guarantee, and it is the
 * only thing the live deadline is for. The *deterministic* guarantee belongs to the
 * harness simulation and to replays, both of which run on the monotonic clock (see
 * `clock.ts`), where the budget bounds work rather than time.
 *
 * `loadRoundStrategy(source)` takes **source text**, never a module, never a path.
 * That is the seam the server plugs into: today the source is a `?raw` import of
 * `src/strategies/round1.js`, from Round 2 on it is whatever the Coder agent wrote
 * and the harness approved, arriving over the wire as a string.
 */
import { CONSTANTS, type StrategyRunner } from '@rematch/contract';
import { createSandbox, SandboxLoadError, type SandboxFactory } from '@rematch/sandbox';

import { deterministicClock, DETERMINISTIC_TICK_MS } from './clock.ts';

import round1Source from '../strategies/round1.js?raw';
import houndSource from '../strategies/hound.js?raw';

/**
 * Multiplier on `CONSTANTS.limits.decideBudgetMs` for live, real-clock play. 10x of
 * the harness's 2 ms: far more than any healthy strategy needs (p99 measured at
 * 0.3 ms in Chromium, 0.06 ms in Node), far less than the 16.6 ms frame, and still
 * a hard stop on a strategy that never returns.
 */
export const LIVE_BUDGET_FACTOR = 10;

/** The `decide` deadline used in live play. See the header. */
export const LIVE_DECIDE_BUDGET_MS = CONSTANTS.limits.decideBudgetMs * LIVE_BUDGET_FACTOR;

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
  // Replay: the monotonic clock and the contract's own budget, so the hash matches
  // Node's byte for byte. Live: the real clock and the relaxed budget (see header).
  return sandbox.load(
    source,
    options.deterministic === true
      ? { now: deterministicClock() }
      : { decideBudgetMs: LIVE_DECIDE_BUDGET_MS },
  );
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
