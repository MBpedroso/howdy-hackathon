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
 */
import type { GameState } from '@rematch/engine';

/**
 * Below this many pixels of displacement, a tick counts as motionless.
 *
 * The engine quantizes every position with `q()` at 1e-4, and the boss's own speed
 * is 2.6 px/tick, so this separates "did not move at all" from "moved" with three
 * orders of magnitude of daylight on either side.
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
  /** Total distance the boss travelled, px. A crude "did it play at all" check. */
  travelPx: number;
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

  return {
    observe(next: GameState): void {
      const movedPx = Math.hypot(next.boss.x - x, next.boss.y - y);
      x = next.boss.x;
      y = next.boss.y;
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
      return { ticks, idleTicks, longestIdleRun, travelPx };
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
