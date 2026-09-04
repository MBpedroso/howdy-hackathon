/**
 * `@rematch/harness` — the four gates and the runner that sequences them.
 *
 * The harness decides whether a generated strategy ships. It never calls an LLM
 * (spec §6): every verdict is a deterministic function of the strategy source
 * and a seed, so any rejection replays byte-for-byte.
 *
 * Today: Gate 1 (static) and Gate 2 (contract fuzz) are real; Gates 3 (balance)
 * and 4 (perf) are stubs that reject with `not implemented` and are excluded
 * from `runGates`' default gate list.
 *
 * ```ts
 * const { approved, results, stoppedAt } = await runGates(source);
 * if (!approved) sendBackToCoder(results.at(-1)!.reason);
 * ```
 */

export { gate1Static, type Gate1Options } from './gates/gate1Static.ts';
export { gate2Fuzz, type Gate2Options } from './gates/gate2Fuzz.ts';
export { gate3Balance, type Gate3Options } from './gates/gate3Balance.ts';
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

export { DEFAULT_GATES, runGates, type RunGatesOptions, type RunGatesResult } from './runGates.ts';

export {
  CORNER_CASES,
  describeView,
  makeFuzzSequence,
  makeFuzzViews,
  xorshift32,
} from './fuzzViews.ts';
