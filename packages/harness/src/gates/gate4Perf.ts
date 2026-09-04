/**
 * Gate 4 — performance. **NOT IMPLEMENTED YET.** Milestone: with Gate 3 (spec §10).
 *
 * TODO(gate4): assert `decide()`'s p99 against `CONSTANTS.limits.decideBudgetMs`
 * over a full match's worth of ticks, and reject with the spec §6.3 reason shape:
 *
 *   "decide() p99 = 6.2ms > 2ms"
 *
 * The measurement already exists and does **not** need re-instrumenting: every
 * `DecideResult` from `@rematch/sandbox` carries `elapsedMs` (host stringify → VM
 * → parse, i.e. what the engine actually pays), and Gate 2 already accumulates
 * the distribution — see `detail.elapsedMs` in `gate2Fuzz.ts` (`samples`, `p50`,
 * `p99`, `max`). Gate 4's job is to run the *right* states (a real match
 * trajectory from Gate 3's simulation rather than fuzz states, since cost scales
 * with how much is in the `BossView`) and to apply the threshold.
 *
 * Why it is a separate gate from Gate 2 at all: Gate 2's per-call budget is a
 * *hard deadline* — over-budget calls come back as `{kind:'timeout'}` and fail
 * immediately. Gate 4 is the statistical version: a strategy whose p99 sits just
 * under the deadline passes Gate 2 but would still drop frames at 60 Hz.
 */
import { gateFail, type GateResult } from './types.ts';

export type Gate4Options = {
  /** Ticks to measure. A full round is 3600. */
  ticks?: number;
  /** Budget to compare the p99 against. Defaults to `CONSTANTS.limits.decideBudgetMs`. */
  budgetMs?: number;
  seed?: number;
  now?: () => number;
};

export function gate4Perf(_source: string, opts: Gate4Options = {}): GateResult {
  const now = opts.now ?? (() => performance.now());
  const started = now();
  return gateFail(4, now() - started, 'not implemented', { todo: 'gate4', ticks: opts.ticks ?? 3600 });
}
