/**
 * `@rematch/harness` — the four gates and the runner that sequences them.
 *
 * The harness decides whether a generated strategy ships. It never calls an LLM
 * (spec §6): every verdict is a deterministic function of the strategy source
 * and a seed, so any rejection replays byte-for-byte.
 *
 * All four gates are real. `runGates` runs the two cheap ones by default and all
 * four when it is given a round (the balance band is per-round, so a round is how
 * a caller asks for the expensive gates):
 *
 * ```ts
 * const quick = await runGates(source);                                  // [1, 2]
 * const full = await runGates(source, { gate3: { round: 2, mimicSummary } }); // [1..4]
 * if (!full.approved) sendBackToCoder(full.results.at(-1)!.reason);
 * ```
 *
 * This package also owns the reference bot panel (spec §6.1 puts the bots in
 * `contract`; see the root README for why they live here) and the balance
 * simulator the panel is played through.
 */

export { gate1Static, type Gate1Options } from './gates/gate1Static.ts';
export { gate2Fuzz, type Gate2Options } from './gates/gate2Fuzz.ts';
export {
  adapted,
  gate3Balance,
  gate3Plan,
  measureMimicWinRate,
  type Gate3Options,
  type Gate3Plan,
} from './gates/gate3Balance.ts';
export { gate4Perf, type Gate4Options } from './gates/gate4Perf.ts';

export {
  formatGateResult,
  gateFail,
  gateOk,
  GATE_NAMES,
  GATE_NUMBERS,
  type GateFail,
  type GateName,
  type GateNumber,
  type GateOk,
  type GateResult,
} from './gates/types.ts';

export { ALL_GATES, DEFAULT_GATES, gatesFor, runGates, type RunGatesOptions, type RunGatesResult } from './runGates.ts';

export {
  ACTIVITY,
  ADAPTED_MARGIN,
  ADAPTED_MIN,
  BALANCE_ROUNDS,
  BAND,
  DEFAULT_MATCHES,
  DEFAULT_ROUND,
  SEED_OFFSET,
  bandFor,
  formatBand,
  seedsFor,
  type BalanceRound,
} from './gates/balanceConfig.ts';

export { MEASURE_SLACK } from './gates/gate4Perf.ts';

// The reference bot panel (spec §6.1).
export {
  BASE_AIM_ERROR,
  BOT_KINDS,
  PANEL,
  camper,
  dodger,
  kiter,
  makeBot,
  makeFullPanel,
  makeMimic,
  makePanel,
  rusher,
  type BotKind,
  type BotOptions,
  type PlayerBot,
} from './bots/index.ts';

// The balance simulator.
export {
  getSandbox,
  playMatch,
  playMatchState,
  playerSeed,
  runMatch,
  runMatchWith,
  summarizeMatch,
  type MatchResult,
  type RunMatchOptions,
} from './sim/runMatch.ts';
export {
  resolveWorkers,
  simulate,
  type BotRate,
  type SimulateActivity,
  type SimulateOptions,
  type SimulateResult,
} from './sim/simulate.ts';

// "Does the boss actually play?" — the measurement behind Gate 3's ACTIVE assertion.
export {
  STILL_EPSILON,
  createActivityTracker,
  idleFraction,
  isIdleTick,
  ticksAsSeconds,
  type Activity,
  type ActivityTracker,
} from './sim/activity.ts';
export { botFromSpec, botSpecName, type BotSpec } from './sim/protocol.ts';

export {
  CORNER_CASES,
  describeView,
  makeFuzzSequence,
  makeFuzzViews,
  xorshift32,
} from './fuzzViews.ts';
