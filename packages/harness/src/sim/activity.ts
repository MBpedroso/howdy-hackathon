/**
 * "Is the boss actually playing?" — the one property none of the four original
 * gates could see, in one place.
 *
 * ## Why this file exists
 * A human playtest reported "the Round 2 boss just stood still in a corner for the
 * whole round". It had: the strategy drifted onto the centre of the player's
 * hottest heat cell and returned `idle` from then on. Every gate passed it and all
 * four were right to — `idle` is a legal action (Gate 1), it is always *valid* and
 * costs no cooldown (Gate 2), `return {type:'idle'}` is the fastest `decide` there
 * is (Gate 4), and Gate 3 only reads the win rate, which stayed in band. Worse: a
 * stationary boss is *easy to shoot*, so freezing helped it land inside the
 * fairness band. The bug was invisible by construction, and it was in almost every
 * hand-written strategy in the repo (see `docs/AI-DEV-LOG.md`, 2026-09-04).
 *
 * So activity is measured per tick, aggregated per match, and asserted by Gate 3's
 * third assertion (ACTIVE, `gates/gate3Balance.ts`). This module owns the
 * definition so the gate, `test/activity.test.ts` and any future consumer cannot
 * drift apart on what "motionless" means.
 *
 * ## The definition
 * A tick is **idle** when *all* of these hold:
 *
 *  1. the boss's position did not change (< `STILL_EPSILON` px), and
 *  2. it is not telegraphing (`boss.telegraph === null`) — a committed tell is the
 *     legitimate reason to stand still, and `decide` is not even called during one, and
 *  3. it is not mid-charge (`boss.chargeTicksLeft === 0`), and
 *  4. its last committed action was `idle` or `move`.
 *
 * Clause 4 is the subtle one. `burst`, `slam`, `charge` and `spawn` all put
 * something on the board, so a boss that stands still to throw a ring is visibly
 * playing. `move` is the opposite case: a `move` that displaced the boss by
 * nothing at all is a boss grinding into a wall, which is exactly as frozen as
 * `idle` and was the real failure mode of `fallback/round3/emberline.js` (an orbit
 * that pinned itself against the arena edge for 169 ticks without ever returning
 * `idle`). Both are counted; a `move` that actually moved is not.
 *
 * ## The second measurement, and why one was not enough (2026-09-08)
 *
 * An independent review (`docs/REVIEW-2026-09-08.md`) submitted five lines, kept as
 * `test/fixtures/jitter.js`:
 *
 * ```js
 * export function decide(view) {
 *   return { type: 'move', dx: view.tick % 2 ? 0.02 : -0.02, dy: 0 };
 * }
 * ```
 *
 * It never attacks, never approaches, never spends a cooldown. It twitches back and
 * forth over a 5 px stretch of floor and it **passed all four gates** — approved for
 * Round 2 at panel 0.44 inside the 0.35–0.50 band, with ACTIVE reporting
 * `idle run 0t/90` and `p90 0%`, the gate calling it 100% active, and ADAPTED at
 * 1.00 against two of the four recorded player replays. Against `camper` and
 * `dodger`, the two styles a first-time player at a demo actually uses, the harness
 * stamped APPROVED on a vibrating dot.
 *
 * Note what the `0.02` does *not* do: `validateMove` normalizes `move` to a unit
 * vector (`contract/src/validate.ts`), so the magnitude is discarded and the boss
 * steps a full 2.6 px every tick. The strategy is not sneaking under
 * `STILL_EPSILON` — it is genuinely moving at top speed, and clause 1 above is
 * working exactly as written. The hole is that clauses 1–4 are all about
 * *stalling*, and a boss that oscillates never stalls.
 *
 * So the definition above measures how *busy* the boss was, and nothing measured
 * where it *got to*. A match now also records `spanPx`, the diagonal of the boss's
 * bounding box, and Gate 3's ACTIVE reads the smallest span over every match. The
 * two assertions are complementary and neither subsumes the other: a boss that
 * crosses the arena once and then freezes has a large span and is caught by the
 * idle-run clause, and a boss that vibrates forever has no idle run and is caught
 * by the span clause.
 *
 * `travelPx` — path length — was already here and cannot do this job: the jittering
 * boss accumulates 9 000 px of it without leaving a 5 px box. `sim/simulate.ts` did
 * already reduce it to a `minTravelPx` aggregate, described in its own comment as
 * "a boss that never moved at all is 0", and Gate 3 never read it. That aggregate is
 * now `minSpanPx`, which is the number that comment was reaching for.
 */
import type { GameState } from '@rematch/engine';

/**
 * Below this many pixels of displacement, a tick counts as motionless.
 *
 * The engine quantizes every position with `q()` at 1e-4, and the boss's own speed
 * is 2.6 px/tick, so this separates "did not move at all" from "moved" with three
 * orders of magnitude of daylight on either side.
 *
 * Deliberately *not* raised to a fraction of boss speed. `move` is normalized to a
 * unit vector before the engine applies it, so a boss is either stepping its full
 * 2.6 px or it is being clamped by a wall to nearly zero — there is no meaningful
 * middle band for a larger threshold to catch, and raising it was measured to change
 * the idle run of none of the eleven shipped strategies.
 */
export const STILL_EPSILON = 0.01;

/** Boss activity over a whole match. Ticks, not seconds: 60 ticks = 1 s. */
export type Activity = {
  /** Ticks measured. */
  ticks: number;
  /** Ticks that were idle by the definition above. */
  idleTicks: number;
  /** Longest consecutive run of idle ticks. The number ACTIVE is really about. */
  longestIdleRun: number;
  /**
   * Total distance the boss travelled, px. How busy it was — not where it got to,
   * which is `spanPx`. A boss vibrating in place has a large `travelPx`.
   */
  travelPx: number;
  /**
   * Diagonal of the boss's bounding box over the match, px. How far it ranged.
   *
   * Bounding box rather than net start-to-end displacement, because a boss that
   * patrols and returns home would read as zero on the latter. Diagonal rather
   * than area so the number is in px and comparable to the arena's own 1131 px
   * diagonal.
   */
  spanPx: number;
};

/**
 * Is this tick idle? `movedPx` is the boss's displacement since the previous tick.
 *
 * Split out from the tracker so a test can ask the question about one state, and
 * so the four clauses are readable next to the docstring that justifies them.
 */
export function isIdleTick(state: GameState, movedPx: number): boolean {
  const boss = state.boss;
  if (movedPx >= STILL_EPSILON) return false;
  // A telegraph is the one legitimate reason to be perfectly still, and the boss
  // does not even get asked for an action while one is running.
  if (boss.telegraph !== null) return false;
  if (boss.chargeTicksLeft > 0) return false;
  // Anything else it committed to put something on the board.
  return boss.lastAction === 'idle' || boss.lastAction === 'move';
}

export type ActivityTracker = {
  /** Call once per `step`, with the state *after* the step. */
  observe: (state: GameState) => void;
  read: () => Activity;
};

/** Track activity from `state`'s current boss position onwards. */
export function createActivityTracker(state: GameState): ActivityTracker {
  let x = state.boss.x;
  let y = state.boss.y;
  let ticks = 0;
  let idleTicks = 0;
  let run = 0;
  let longestIdleRun = 0;
  let travelPx = 0;
  // The bounding box starts as the boss's opening position, not as an empty box, so
  // a zero-tick match reports a span of 0 rather than something infinite.
  let minX = x;
  let maxX = x;
  let minY = y;
  let maxY = y;

  return {
    observe(next: GameState): void {
      const movedPx = Math.hypot(next.boss.x - x, next.boss.y - y);
      x = next.boss.x;
      y = next.boss.y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      ticks += 1;
      travelPx += movedPx;
      if (isIdleTick(next, movedPx)) {
        idleTicks += 1;
        run += 1;
        if (run > longestIdleRun) longestIdleRun = run;
      } else {
        run = 0;
      }
    },
    read(): Activity {
      return {
        ticks,
        idleTicks,
        longestIdleRun,
        travelPx,
        spanPx: Math.hypot(maxX - minX, maxY - minY),
      };
    },
  };
}

/** `idleTicks / ticks`, guarded for a zero-tick match. */
export function idleFraction(activity: Activity): number {
  return activity.ticks === 0 ? 0 : activity.idleTicks / activity.ticks;
}

/** Ticks rendered as seconds, for a rejection reason: `263` -> `4.4 s`. */
export function ticksAsSeconds(ticks: number): string {
  return `${(ticks / 60).toFixed(1)} s`;
}
