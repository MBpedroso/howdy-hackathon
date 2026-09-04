/**
 * One simulated match: a generated strategy against one reference bot, on one seed.
 *
 * The runner is the **QuickJS sandbox**, never the engine's `nativeRunner`. That is
 * the point of the whole exercise: Gate 3's verdict has to describe the strategy as
 * the player will actually meet it, including the marshalling cost and every
 * failure mode the sandbox turns into a value. A native run would be ~40x faster and
 * would measure a program that never ships.
 *
 * ```ts
 * const result = await runMatch(source, kiter(), 7);   // loads and disposes a sandbox
 * // or, hot path: load once, then one `init(seed)` per match
 * const result2 = runMatchWith(runner, kiter(), 7);
 * ```
 */
import {
  createGame,
  createRng,
  ENGINE_CONSTANTS as E,
  step,
  summarizeReplay,
  type GameState,
  type Outcome,
  type ReplaySummary,
} from '@rematch/engine';
import type { StrategyRunner } from '@rematch/contract';
import { createSandbox, monotonicClock, type SandboxFactory, type SandboxOptions } from '@rematch/sandbox';
import type { PlayerBot } from '../bots/index.ts';
import { createActivityTracker, idleFraction, type Activity } from './activity.ts';

export type MatchResult = {
  outcome: Outcome;
  ticks: number;
  bossHpLeft: number;
  playerHpLeft: number;
  /**
   * True unless the player killed the boss. Running out the 60-second clock is a
   * boss win for balance purposes (spec §6.2 measures `win_rate(boss vs ...)`): a
   * boss that survived was not beaten.
   */
  bossWon: boolean;
  /** Contract violations the strategy committed during the match. */
  violations: number;
  /** The sandbox killed the strategy (timeout or memory) mid-match. */
  strategyKilled: boolean;
  /**
   * Longest run of consecutive ticks in which the boss did nothing visible — it
   * did not move, was not telegraphing, was not mid-charge, and its last action
   * was `idle` or a `move` that displaced nothing. See `sim/activity.ts` for why
   * this is measured at all and what each clause is for; Gate 3's ACTIVE
   * assertion is the consumer.
   */
  longestIdleRun: number;
  /** `idleTicks / ticks` by the same definition. */
  idleFraction: number;
  /** Total distance the boss travelled, px. */
  travelPx: number;
};

/**
 * Player RNG seed for a match. Derived from the match seed by a multiplicative
 * mix so consecutive seeds do not produce near-identical bot behaviour (xorshift32
 * warms up slowly from small, adjacent states).
 */
export function playerSeed(seed: number): number {
  return (Math.imul(seed >>> 0, 0x9e3779b1) ^ 0x5bf03635) >>> 0;
}

/** Play a full match on an already-loaded runner. Synchronous and allocation-light. */
export function runMatchWith(runner: StrategyRunner, bot: PlayerBot, seed: number): MatchResult {
  const { state, activity } = playMatch(runner, bot, seed);
  return {
    outcome: state.outcome,
    ticks: state.tick,
    bossHpLeft: state.boss.hp,
    playerHpLeft: state.player.hp,
    bossWon: state.outcome !== 'playerWon',
    violations: state.violations,
    strategyKilled: state.strategyKilled,
    longestIdleRun: activity.longestIdleRun,
    idleFraction: idleFraction(activity),
    travelPx: activity.travelPx,
  };
}

/**
 * Play a match and return the whole final state — for callers that need more than
 * the verdict (the balance table's damage numbers, or a `ReplaySummary` to build a
 * Mimic from).
 */
export function playMatchState(runner: StrategyRunner, bot: PlayerBot, seed: number): GameState {
  return playMatch(runner, bot, seed).state;
}

/**
 * `playMatchState` plus the per-tick activity measurement.
 *
 * The activity numbers cannot be recovered from the final state — a longest run
 * of motionless ticks is a property of the *trajectory* — so they are accumulated
 * as the match runs. The tracker is two adds and a `hypot` per tick and the
 * measurement is unconditional: a number that is only collected when someone asks
 * for it is a number nobody checks. See `sim/activity.ts`.
 */
export function playMatch(
  runner: StrategyRunner,
  bot: PlayerBot,
  seed: number,
): { state: GameState; activity: Activity } {
  bot.reset(seed);
  const state = createGame(seed, runner);
  const rng = createRng(playerSeed(seed));
  const tracker = createActivityTracker(state);

  for (let i = 0; i < E.round.maxTicks; i += 1) {
    step(state, bot.act(state, rng), runner);
    tracker.observe(state);
    if (state.outcome !== 'playing') break;
  }
  return { state, activity: tracker.read() };
}

/** `playMatchState`, compressed into the object the Analyst agent (and the Mimic) reads. */
export function summarizeMatch(runner: StrategyRunner, bot: PlayerBot, seed: number): ReplaySummary {
  return summarizeReplay(playMatchState(runner, bot, seed));
}

/** One `createSandbox()` per process; instantiating the WASM is the expensive part. */
let sharedSandbox: Promise<SandboxFactory> | undefined;
export function getSandbox(): Promise<SandboxFactory> {
  sharedSandbox ??= createSandbox().catch((err: unknown) => {
    sharedSandbox = undefined;
    throw err;
  });
  return sharedSandbox;
}

export type RunMatchOptions = {
  sandbox?: SandboxFactory;
  sandboxOptions?: SandboxOptions;
};

/**
 * Play one match against `target`, which is either strategy **source** (loaded into
 * a fresh sandbox and disposed afterwards) or an already-loaded `StrategyRunner`
 * (reused, and left alive for the caller).
 */
export async function runMatch(
  target: string | StrategyRunner,
  bot: PlayerBot,
  seed: number,
  opts: RunMatchOptions = {},
): Promise<MatchResult> {
  if (typeof target !== 'string') return runMatchWith(target, bot, seed);

  const sandbox = opts.sandbox ?? (await getSandbox());
  // Monotonic by default, overridable: a match is a measurement, so it must not
  // depend on what else the machine was doing. See `sim/worker.ts` for the numbers.
  const runner = sandbox.load(target, { now: monotonicClock(), ...opts.sandboxOptions });
  try {
    return runMatchWith(runner, bot, seed);
  } finally {
    // Disposal is not optional: a leaked QuickJS handle aborts the wasm module,
    // which is memoized per process and would take every later match with it.
    runner.dispose();
  }
}
