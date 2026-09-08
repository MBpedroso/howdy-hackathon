/**
 * A boss that stands still is a bug — and, since 2026-09-04, a gate.
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
 * ## What changed
 *
 * This file used to argue that "does the boss actually play?" should stay a test and
 * not become a gate, because the threshold between "holding position" and "crashed"
 * is a judgement about how the game *reads* rather than a contract. A human
 * playtest settled it the other way: the property was invisible to the harness, so
 * it shipped broken, and it was broken in *every* hand-written strategy in the repo.
 * Measured worst motionless run against the four reference bots, in ticks (60 = 1 s),
 * before the fix:
 *
 * ```
 *   web/src/strategies/round1           169   web/src/strategies/hound     98
 *   server/fallback/round2/hollow       391   round4/bellringer           630
 *   server/fallback/round2/metronome    143   round4/curfew                89
 *   server/fallback/round3/emberline    169   round5/crossfire            485
 *   server/fallback/round3/nettle        89   round5/tollkeeper           343
 * ```
 *
 * So the measurement moved into `src/sim/activity.ts`, Gate 3 grew a third
 * assertion (ACTIVE) that rejects on it, and every strategy above was fixed and
 * re-balanced. This file is now the *property* test over the shipped set: it walks
 * real matches tick by tick and asserts the same definition the gate uses, which is
 * why it imports it rather than restating it. Two things it checks that the gate
 * does not:
 *
 *  1. every shipped strategy, including the two in `web/` that have no fairness
 *     band and are therefore never put through Gate 3 by any suite;
 *  2. the recorded **human** replay, which is the input the four scripted bots
 *     cannot produce — see the note on that test.
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
import {
  ACTIVITY,
  camper,
  createActivityTracker,
  dodger,
  idleFraction,
  kiter,
  rusher,
  type Activity,
  type PlayerBot,
} from '../src/index.ts';
import { playerSeed } from '../src/sim/runMatch.ts';
import { readCandidate, readGood } from './helpers.ts';

/**
 * Longest run of ticks a shipped boss may stay in exactly the same place.
 *
 * Not a second copy of the number: it *is* Gate 3's threshold, imported, because a
 * test that could disagree with the gate would be worse than no test. See
 * `gates/balanceConfig.ts` for why it is 90 (1.5 s) and `sim/activity.ts` for what
 * counts as motionless — telegraphs are excluded, and a `move` that walks into a
 * wall is not.
 */
const MAX_STILL_TICKS = ACTIVITY.maxIdleRunTicks;

/**
 * Smallest bounding-box diagonal a shipped boss may confine itself to, px.
 *
 * Imported rather than restated, for the same reason as `MAX_STILL_TICKS`: a test
 * that could disagree with the gate would be worse than no test. See
 * `gates/balanceConfig.ts` for why it is the boss's own diameter.
 */
const MIN_SPAN_PX = ACTIVITY.minSpanPx;

/** The recorded human Round 1, reused as a Round 2 player. */
function humanLog(): InputLog {
  const url = new URL('../../web/e2e/fixtures/inputlog-round1.json', import.meta.url);
  return (JSON.parse(readFileSync(url, 'utf8')) as { log: InputLog }).log;
}

/** Every strategy the game can put in front of a player, by where it lives. */
const SHIPPED: ReadonlyArray<{ name: string; path: string }> = [
  { name: 'web/round1', path: '../../web/src/strategies/round1.js' },
  { name: 'web/hound', path: '../../web/src/strategies/hound.js' },
  { name: 'harness/round2-candidate', path: './fixtures/round2-candidate.js' },
  { name: 'fallback/round2/hollow', path: '../../server/fallback/round2/hollow.js' },
  { name: 'fallback/round2/metronome', path: '../../server/fallback/round2/metronome.js' },
  { name: 'fallback/round3/emberline', path: '../../server/fallback/round3/emberline.js' },
  { name: 'fallback/round3/nettle', path: '../../server/fallback/round3/nettle.js' },
  { name: 'fallback/round4/bellringer', path: '../../server/fallback/round4/bellringer.js' },
  { name: 'fallback/round4/curfew', path: '../../server/fallback/round4/curfew.js' },
  { name: 'fallback/round5/crossfire', path: '../../server/fallback/round5/crossfire.js' },
  { name: 'fallback/round5/tollkeeper', path: '../../server/fallback/round5/tollkeeper.js' },
];

function read(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

type Measured = Activity & { violations: number; strategyKilled: boolean };

/**
 * Play a match to its end and report the activity.
 *
 * The per-tick bookkeeping is `createActivityTracker` — the same code Gate 3's
 * verdict is computed from — so this test cannot drift away from the assertion it
 * is the property version of.
 */
function measure(
  state: GameState,
  next: (s: GameState) => PlayerInput,
  runner: Parameters<typeof step>[2],
): Measured {
  const tracker = createActivityTracker(state);
  while (state.outcome === 'playing') {
    step(state, next(state), runner);
    tracker.observe(state);
  }
  return { ...tracker.read(), violations: state.violations, strategyKilled: state.strategyKilled };
}

const sandbox = await createSandbox();

/** Load on the monotonic clock, like the simulator: a measurement must reproduce. */
function load(source: string): ReturnType<typeof sandbox.load> {
  return sandbox.load(source, { now: monotonicClock() });
}

describe('a shipped boss keeps playing', () => {
  for (const { name, path } of SHIPPED) {
    it(`${name} never freezes against the reference panel`, () => {
      const runner = load(read(path));
      try {
        for (const [i, bot] of ([kiter(), rusher(), camper(), dodger()] as PlayerBot[]).entries()) {
          const seed = 0x5eedface + i;
          bot.reset(seed);
          const state = createGame(seed, runner);
          const rng = createRng(playerSeed(seed));
          const activity = measure(state, (s) => bot.act(s, rng), runner);
          const where = `${name} vs bot#${i}: ${JSON.stringify(activity)}`;
          expect(activity.longestIdleRun, where).toBeLessThanOrEqual(MAX_STILL_TICKS);
          expect(idleFraction(activity), where).toBeLessThanOrEqual(ACTIVITY.maxIdleFractionP90);
          // The demo's floor: a boss that travelled 100 px in a whole round did not
          // play, whatever its idle runs say.
          expect(activity.travelPx, where).toBeGreaterThan(100);
          // ...and travel alone is not enough, because a boss can spend 9 000 px of
          // it vibrating on one tile. `spanPx` is where it *got to*, and Gate 3's
          // span clause is the assertion; this holds the shipped set to it directly,
          // including the two in `web/` that no Gate 3 suite ever runs.
          expect(activity.spanPx, where).toBeGreaterThanOrEqual(MIN_SPAN_PX);
        }
      } finally {
        runner.dispose();
      }
    }, 60_000);
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
      expect(activity.longestIdleRun, where).toBeLessThanOrEqual(MAX_STILL_TICKS);
      expect(activity.idleTicks, `idle ticks — ${where}`).toBe(0);
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
      expect(activity.longestIdleRun).toBeGreaterThan(MAX_STILL_TICKS);
      expect(idleFraction(activity)).toBe(1);
      expect(activity.travelPx).toBe(0);
    } finally {
      runner.dispose();
    }
  }, 30_000);

  /**
   * The counter-example the run clause cannot produce, and the reason the span
   * clause exists at all.
   *
   * An independent review submitted this strategy on 2026-09-08 and it passed all
   * four gates — approved for Round 2, panel 0.44 inside the band, ACTIVE reporting
   * `idle run 0t/90` and `p90 0%`, ADAPTED 1.00 against two of the four recorded
   * player replays. It is kept verbatim at `test/fixtures/jitter.js` and read from
   * there rather than inlined, so the file that broke the gate and the file that
   * guards it cannot drift apart.
   *
   * Every clause of the idle definition is satisfied honestly: `validateMove`
   * normalizes `move` to a unit vector, so `dx: 0.02` steps the boss a full 2.6 px
   * and *no tick is idle*. That is the whole point — the boss is busy and going
   * nowhere, so `longestIdleRun` and `idleFraction` are both at their best possible
   * values while the span is two and a half pixels.
   */
  it('jitter.js is the counter-example the idle clauses cannot see', () => {
    const runner = load(read('./fixtures/jitter.js'));
    try {
      const seed = 13;
      const bot = camper();
      bot.reset(seed);
      const state = createGame(seed, runner);
      const rng = createRng(playerSeed(seed));
      const activity = measure(state, (s) => bot.act(s, rng), runner);
      const where = JSON.stringify(activity);
      // The two clauses that were already there see nothing wrong.
      expect(activity.longestIdleRun, where).toBeLessThanOrEqual(MAX_STILL_TICKS);
      expect(idleFraction(activity), where).toBeLessThanOrEqual(ACTIVITY.maxIdleFractionP90);
      // It is not sneaking under `STILL_EPSILON` either: it really does move, a lot.
      expect(activity.travelPx, where).toBeGreaterThan(1_000);
      // And it went nowhere. This is the only number that says so.
      expect(activity.spanPx, where).toBeLessThan(MIN_SPAN_PX);
      expect(activity.violations, where).toBe(0);
    } finally {
      runner.dispose();
    }
  }, 30_000);

  /**
   * The clause that is easy to get wrong, asserted on its own.
   *
   * `emberline` did not have an `idle` branch and still froze for 169 ticks: its
   * orbit ran the boss into the top-left corner, where `move` clamps at the boss's
   * own radius and displaces it by nothing. That is why the definition is about
   * *displacement* and not about the action type, and this is a boss that does
   * nothing but walk into a wall — no `idle` anywhere in the file.
   */
  it('counts a `move` that walks into a wall, not just `idle`', () => {
    const source = `export const meta = { name: 'Wallflower', rationale: 'I push.', version: 1 };
export function init() { return {}; }
export function decide() { return { type: 'move', dx: -1, dy: -1 }; }`;
    const runner = load(source);
    try {
      const seed = 11;
      const bot = camper();
      bot.reset(seed);
      const state = createGame(seed, runner);
      const rng = createRng(playerSeed(seed));
      const activity = measure(state, (s) => bot.act(s, rng), runner);
      const where = JSON.stringify(activity);
      // It walked to the corner and then stayed there for the rest of the round.
      expect(activity.travelPx, where).toBeGreaterThan(100);
      expect(activity.longestIdleRun, where).toBeGreaterThan(MAX_STILL_TICKS);
      expect(activity.violations, where).toBe(0);
    } finally {
      runner.dispose();
    }
  }, 30_000);
});
