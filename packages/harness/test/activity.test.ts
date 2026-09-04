/**
 * A boss that stands still is a bug, and no gate can see it.
 *
 * The playtest report was "the Round 2 boss just stood still in a corner of the
 * screen for the whole round". It had: `round2-candidate.js` drifted onto the centre
 * of the player's hottest heat cell and returned `idle` from then on. Against the
 * recorded human log that was 219 idle ticks out of 510 and one motionless run of
 * 263 ticks.
 *
 * Every gate passed it, and all four were right to:
 *
 *  - Gate 1 is static; `idle` is a legal action.
 *  - Gate 2 asks whether the action is *valid*; `idle` always is, and it costs no
 *    cooldown, so it is not even a contract violation.
 *  - Gate 3 asks whether the win rate is in band. The frozen version measured 0.38
 *    and the fixed one measures 0.45 — both inside 0.35–0.50. Worse, the frozen
 *    version was partly in band *because* a stationary boss is easy to shoot.
 *  - Gate 4 asks how long `decide` takes. `return {type:'idle'}` is the fastest
 *    strategy there is.
 *
 * So "does the boss actually play?" is a separate property, and this is where it is
 * asserted. It is deliberately not a gate: a gate rejects a candidate, and the
 * threshold that separates "holding position" from "crashed" is a judgement about
 * how the game *reads*, not a contract.
 *
 * ## Scope, and what is knowingly left out
 *
 * The same `if (nothing to do) return {type:'idle'}` fallback is in almost every
 * hand-written strategy in the repo. Measured worst motionless run against the four
 * reference bots, in ticks (60 = 1 s):
 *
 * ```
 *   harness/round2-candidate    43   (fixed — this file)
 *   web/src/strategies/round1   888  vs Kiter, 690 idle actions
 *   web/src/strategies/hound    187  vs Camper
 *   server/fallback/round2/hollow      589    round4/bellringer  430
 *   server/fallback/round2/metronome   272    round4/curfew       43
 *   server/fallback/round3/emberline   169    round5/crossfire   708
 *   server/fallback/round3/nettle      184    round5/tollkeeper  242
 * ```
 *
 * Only the Round 2 candidate is asserted here. Every other entry is a *balance*
 * change as well as a bug fix — `round1.js` sets what "winnable on a first try"
 * (spec AC 4) means and owns the recorded AC 3 replay fixture, and each fallback
 * entry is documented as having passed all four gates at its round's band, so each
 * needs re-measuring against Gate 3 before it moves. That is a decision to take
 * deliberately, not a side effect of fixing the reported bug. See
 * `docs/SYSTEM.md` §9.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  createGame,
  createRng,
  step,
  IDLE_INPUT,
  type GameState,
  type InputLog,
  type PlayerInput,
} from '@rematch/engine';
import { createSandbox, monotonicClock } from '@rematch/sandbox';
import { camper, dodger, kiter, rusher, type PlayerBot } from '../src/index.ts';
import { playerSeed } from '../src/sim/runMatch.ts';
import { readCandidate, readGood } from './helpers.ts';

/**
 * Longest run of ticks a shipped boss may stay in exactly the same place.
 *
 * A telegraph is the legitimate reason to be still and the longest one is the slam's
 * 40 ticks, during which `decide` is not called at all. 90 ticks (1.5 s) leaves room
 * for a slam with a burst on either side of it, and still rejects the 263-tick stall
 * this file exists for. `idle.js` is exempt: standing still is its entire definition
 * and it is the panel's zero point.
 */
export const MAX_STILL_TICKS = 90;

/** The recorded human Round 1, reused as a Round 2 player. */
function humanLog(): InputLog {
  const url = new URL('../../web/e2e/fixtures/inputlog-round1.json', import.meta.url);
  return (JSON.parse(readFileSync(url, 'utf8')) as { log: InputLog }).log;
}

type Activity = {
  ticks: number;
  travelPx: number;
  longestStill: number;
  idleActions: number;
  violations: number;
  strategyKilled: boolean;
};

function measure(state: GameState, next: (s: GameState) => PlayerInput, runner: Parameters<typeof step>[2]): Activity {
  let travelPx = 0;
  let still = 0;
  let longestStill = 0;
  let idleActions = 0;
  let x = state.boss.x;
  let y = state.boss.y;

  while (state.outcome === 'playing') {
    step(state, next(state), runner);
    const moved = Math.hypot(state.boss.x - x, state.boss.y - y);
    travelPx += moved;
    if (moved < 0.01) {
      still += 1;
      if (still > longestStill) longestStill = still;
    } else {
      still = 0;
    }
    x = state.boss.x;
    y = state.boss.y;
    if (state.boss.lastAction === 'idle') idleActions += 1;
  }

  return {
    ticks: state.tick,
    travelPx,
    longestStill,
    idleActions,
    violations: state.violations,
    strategyKilled: state.strategyKilled,
  };
}

const sandbox = await createSandbox();

/** Load on the monotonic clock, like the simulator: a measurement must reproduce. */
function load(source: string): ReturnType<typeof sandbox.load> {
  return sandbox.load(source, { now: monotonicClock() });
}

describe('a shipped boss keeps playing', () => {
  const cases: Array<{ name: string; source: string }> = [{ name: 'round2-candidate', source: readCandidate() }];

  for (const { name, source } of cases) {
    it(`${name} never freezes against the reference panel`, () => {
      const runner = load(source);
      try {
        for (const [i, bot] of ([kiter(), rusher(), camper(), dodger()] as PlayerBot[]).entries()) {
          const seed = 0x5eedface + i;
          bot.reset(seed);
          const state = createGame(seed, runner);
          const rng = createRng(playerSeed(seed));
          const activity = measure(state, (s) => bot.act(s, rng), runner);
          const where = `${name} vs bot#${i}: ${JSON.stringify(activity)}`;
          expect(activity.longestStill, where).toBeLessThanOrEqual(MAX_STILL_TICKS);
          expect(activity.travelPx, where).toBeGreaterThan(100);
        }
      } finally {
        runner.dispose();
      }
    }, 30_000);
  }

  /**
   * The case the panel misses. Every reference bot keeps moving on a scripted path;
   * a human settles into a cell, leaves it, and settles somewhere else — which is
   * what turns a cumulative heat map into a *stale* one and is the exact input the
   * frozen `round2-candidate` needed. Before the fix: 263 motionless ticks and 219
   * idle actions out of 510.
   */
  it('round2-candidate never freezes against the recorded human replay', () => {
    const log = humanLog();
    const runner = load(readCandidate());
    try {
      const state = createGame(1661053139, runner);
      let i = 0;
      const activity = measure(
        state,
        () => {
          const input = log[i] ?? IDLE_INPUT;
          i += 1;
          return input;
        },
        runner,
      );
      const where = JSON.stringify(activity);
      expect(activity.longestStill, where).toBeLessThanOrEqual(MAX_STILL_TICKS);
      expect(activity.idleActions, `idle actions — ${where}`).toBe(0);
      expect(activity.violations, where).toBe(0);
      expect(activity.strategyKilled, where).toBe(false);
    } finally {
      runner.dispose();
    }
  }, 30_000);

  /** The control: the panel's zero point really does stand still. */
  it('idle.js is the counter-example, so the assertion is not vacuous', () => {
    const runner = load(readGood('idle'));
    try {
      const seed = 7;
      const bot = kiter();
      bot.reset(seed);
      const state = createGame(seed, runner);
      const rng = createRng(playerSeed(seed));
      const activity = measure(state, (s) => bot.act(s, rng), runner);
      expect(activity.longestStill).toBeGreaterThan(MAX_STILL_TICKS);
      expect(activity.travelPx).toBe(0);
    } finally {
      runner.dispose();
    }
  }, 30_000);
});
