/**
 * The deterministic clock the sandbox is given in replay mode.
 *
 * Its own module (and not part of `strategy.ts`) because Node needs it too: the
 * fixture generator and the fixture's regression test both replay a log with the exact
 * same clock the browser uses, and they cannot import `strategy.ts` — that module
 * imports strategy sources with Vite's `?raw` suffix, which only exists in a bundler.
 *
 * Why a fake clock at all: the sandbox enforces the 2 ms `decide` budget against
 * `now()`, so a real clock makes a replay *slightly* non-reproducible — a GC pause or
 * a screenshot can push one `decide` over budget, which the engine turns into `idle`
 * plus a violation and the state diverges. Replays therefore use a monotonic counter,
 * exactly as the engine's own `nativeRunner` does by default. Live play keeps
 * `performance.now`, where the deadline is a containment control and must be real.
 *
 * 1/128 ms: a power of two, so accumulating and subtracting it is exact in binary
 * floating point and `elapsedMs` is bit-identical on every machine.
 */
export const DETERMINISTIC_TICK_MS = 1 / 128;

export function deterministicClock(step: number = DETERMINISTIC_TICK_MS): () => number {
  let t = 0;
  return () => {
    t += step;
    return t;
  };
}
