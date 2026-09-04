/**
 * The monotonic clock a *reproducible* sandbox run is measured against.
 *
 * The `decide` deadline is enforced against `SandboxOptions.now`, which defaults to
 * `performance.now`. That is the right choice for exactly one caller — a live browser
 * tab, where the budget is a containment control and has to be real wall clock. It is
 * the wrong choice for every caller that claims reproducibility, because wall clock
 * makes the *result* depend on the machine: one GC pause inside one `decide` turns
 * into `{kind:'timeout'}`, which the engine records as a violation and an idle tick,
 * and from there the two runs have different states.
 *
 * That is not hypothetical. Before the simulator was switched to this clock, Gate 3
 * reported 2 contract violations per 60 matches for a strategy that commits none, and
 * the same source measured 0.43 and 0.45 against the panel on two consecutive runs —
 * against a documented promise of "fixed seed set → identical results on every
 * machine" (spec §6.2).
 *
 * So: anything that must reproduce (the harness simulator, a browser replay, a
 * fixture generator) passes `monotonicClock()`. The budget then bounds *work* rather
 * than time — QuickJS's interrupt handler reads the clock, so each poll advances it
 * one step and a 2 ms budget becomes ~256 interrupt polls. A runaway `while (true)`
 * is still caught, deterministically, in ~35 ms of wall clock.
 *
 * `1/128` ms: a power of two, so accumulating and subtracting it is exact in binary
 * floating point and a reported `elapsedMs` is bit-identical on every machine.
 */
export const MONOTONIC_STEP_MS = 1 / 128;

/**
 * A clock that advances a fixed step on every read. Each call returns a strictly
 * greater value, so a deadline is always eventually reached.
 */
export function monotonicClock(step: number = MONOTONIC_STEP_MS): () => number {
  let t = 0;
  return () => {
    t += step;
    return t;
  };
}
