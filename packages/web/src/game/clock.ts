/**
 * The deterministic clock the sandbox is given in replay mode.
 *
 * Its own module (and not part of `strategy.ts`) because Node needs it too: the
 * fixture generator and the fixture's regression test both replay a log with the exact
 * same clock the browser uses, and they cannot import `strategy.ts` — that module
 * imports strategy sources with Vite's `?raw` suffix, which only exists in a bundler.
 *
 * Why a fake clock at all: the sandbox enforces the `decide` budget against `now()`,
 * so a real clock makes a replay *slightly* non-reproducible — a GC pause or a
 * screenshot can push one `decide` over budget, which the engine turns into `idle`
 * plus a violation and the state diverges. Replays therefore use a monotonic counter,
 * exactly as the engine's own `nativeRunner` does by default. Live play keeps
 * `performance.now` (see `strategy.ts` for the budget it gets).
 *
 * The implementation now lives in `@rematch/sandbox` (`clock.ts`), because the
 * harness simulator needs the identical clock for the identical reason and cannot
 * depend on this package. The names are kept as-is: `DETERMINISTIC_TICK_MS` is
 * `MONOTONIC_STEP_MS` (1/128 ms) and the step is unchanged, so every recorded replay
 * hash still verifies.
 */
import { monotonicClock, MONOTONIC_STEP_MS } from '@rematch/sandbox';

export const DETERMINISTIC_TICK_MS = MONOTONIC_STEP_MS;

export function deterministicClock(step: number = DETERMINISTIC_TICK_MS): () => number {
  return monotonicClock(step);
}
