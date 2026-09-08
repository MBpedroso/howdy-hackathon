// The strategy that passed all four gates while going nowhere.
//
// Submitted by an independent review on 2026-09-08 (`docs/REVIEW-2026-09-08.md`).
// Approved for Round 2 at panel 0.44 inside the 0.35–0.50 band, with ACTIVE
// reporting `idle run 0t/90` and `p90 0%` — the gate calling it 100% active — and
// ADAPTED at 1.00 against the `camper` and `dodger` replay summaries.
//
// Nothing here is a trick. `validateMove` normalizes `move` to a unit vector, so
// the 0.02 magnitude is discarded and the boss steps its full 2.6 px every single
// tick: it is genuinely moving at top speed, no tick is idle, and both of ACTIVE's
// original clauses are satisfied honestly. It just alternates direction, so it
// never leaves a 5 px stretch of floor.
//
// Kept as a fixture rather than deleted: it is the counter-example that justifies
// Gate 3's span clause, and `test/activity.test.ts` asserts that the idle clauses
// still see nothing wrong with it while the span clause rejects it. If a future
// change makes this file pass Gate 3 again, that is the regression.
export const meta = { name: 'Jitter', rationale: 'I am very busy standing here.', version: 1 };

export function init() {
  return {};
}

export function decide(view) {
  return { type: 'move', dx: view.tick % 2 ? 0.02 : -0.02, dy: 0 };
}
