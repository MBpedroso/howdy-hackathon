/**
 * Gate 4 — performance. The statistical version of Gate 2's hard deadline.
 *
 * Gate 2's 2 ms budget is enforced *per call*: a strategy that blows it comes back
 * as `{kind:'timeout'}` and is rejected immediately. Gate 4 asks the softer and more
 * dangerous question — what does the **p99** look like? A strategy whose calls sit
 * at 1.9 ms passes Gate 2 on every single state and still drops frames at 60 Hz,
 * because the engine has 16.6 ms per frame for everything, not for `decide` alone.
 *
 * Two design choices worth keeping:
 *
 *  1. **Realistic views.** Cost scales with the size of the `BossView` (marshalling
 *     dominates: 16 µs empty, 43 µs with 30 projectiles). So the measurement mixes
 *     Gate 2's fuzz corpus with the views from *real matches* against the reference
 *     bots — the mid-fight states, with projectiles on the board, are the expensive
 *     ones and they are exactly the ones a fuzz corpus under-samples.
 *  2. **A relaxed measuring deadline.** The sandbox interrupts a call at its budget,
 *     so measuring with the shipping 2 ms deadline would report every slow strategy
 *     as "p99 = 2.0 ms" and lose the number the Coder agent needs. Gate 4 measures
 *     with a deadline `MEASURE_SLACK` times the budget and compares the result
 *     against the real one, which is what makes the spec §6.3 reason honest:
 *     `"decide() p99 = 6.2ms > 2ms"`.
 */
import { CONSTANTS, type BossView, type DecideResult, type RunnerFailure, type StrategyRunner } from '@rematch/contract';
import type { SandboxFactory, SandboxOptions } from '@rematch/sandbox';
import { camper, dodger, kiter, rusher, type PlayerBot } from '../bots/index.ts';
import { makeFuzzViews } from '../fuzzViews.ts';
import { getSandbox, playMatchState } from '../sim/runMatch.ts';
import { gateFail, gateOk, type GateResult } from './types.ts';

export type Gate4Options = {
  /** Minimum `decide` calls to measure. Default 2000 (a third of a match at 60 Hz). */
  ticks?: number;
  /** Budget the p99 is compared against. Default `CONSTANTS.limits.decideBudgetMs`. */
  budgetMs?: number;
  /** Seed for the fuzz corpus and the match seeds. */
  seed?: number;
  sandbox?: SandboxFactory;
  sandboxOptions?: SandboxOptions;
  now?: () => number;
};

const DEFAULTS = { ticks: 2000, seed: 0x5eedface };

/** How much slack the measuring deadline gets over the shipping budget. */
export const MEASURE_SLACK = 8;

/** Fraction of the sample budget drawn from the fuzz corpus; the rest is real matches. */
const FUZZ_SHARE = 0.4;

/**
 * The p99 tolerates 1% of calls over budget, so once *more* than 1% of the target
 * sample count is already over, no remaining call can bring the p99 back under it.
 * The measurement stops there — not as an optimisation but as a necessity: at the
 * relaxed measuring deadline one pathological match is 3600 x 16 ms = 57 s of wall
 * clock, and Gate 4 has to fit inside `pnpm verify`.
 */
const P99_ALLOWANCE = 0.01;

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
}

type Samples = {
  elapsed: number[];
  failures: Map<RunnerFailure['kind'], { count: number; text: string }>;
  /** Calls over the *shipping* budget — the ones the p99 is about. */
  overBudget: number;
  /** How many over-budget calls the p99 can still absorb. */
  allowance: number;
  /** Set once `overBudget` passes `allowance`: the verdict can no longer change. */
  stopped: boolean;
};

function noteFailure(samples: Samples, failure: RunnerFailure): void {
  const existing = samples.failures.get(failure.kind);
  if (existing) {
    existing.count += 1;
    return;
  }
  const text =
    failure.kind === 'timeout'
      ? `${failure.ms.toFixed(2)} ms`
      : failure.kind === 'memory'
        ? `${failure.bytes} bytes`
        : failure.message;
  samples.failures.set(failure.kind, { count: 1, text });
}

/**
 * A `StrategyRunner` that records every call's `elapsedMs` and passes everything
 * else straight through. `elapsedMs` is what the *engine* pays — host stringify,
 * VM call, parse — which is the number that matters at 60 Hz.
 */
function recordingRunner(inner: StrategyRunner, samples: Samples, budgetMs: number): StrategyRunner {
  return {
    meta: inner.meta,
    init: (seed: number) => inner.init(seed),
    decide(view: BossView): DecideResult {
      // Past the stop point the strategy is not called and nothing is recorded, so
      // the match that is mid-flight finishes at engine speed and the sample set is
      // exactly what was measured before the verdict was decided.
      if (samples.stopped) return { ok: true, action: { type: 'idle' }, elapsedMs: 0 };
      const result = inner.decide(view);
      samples.elapsed.push(result.elapsedMs);
      if (!result.ok) noteFailure(samples, result.failure);
      if (result.elapsedMs > budgetMs) {
        samples.overBudget += 1;
        if (samples.overBudget > samples.allowance) samples.stopped = true;
      }
      return result;
    },
    memoryBytes: () => inner.memoryBytes(),
    dispose: () => inner.dispose(),
  };
}

export async function gate4Perf(source: string, opts: Gate4Options = {}): Promise<GateResult> {
  const now = opts.now ?? ((): number => performance.now());
  const started = now();
  const elapsed = (): number => now() - started;

  const target = Math.max(1, Math.trunc(opts.ticks ?? DEFAULTS.ticks));
  const budgetMs = opts.budgetMs ?? CONSTANTS.limits.decideBudgetMs;
  const seed = opts.seed ?? DEFAULTS.seed;
  const sandbox = opts.sandbox ?? (await getSandbox());

  let runner: StrategyRunner;
  try {
    runner = sandbox.load(source, {
      ...opts.sandboxOptions,
      // See MEASURE_SLACK: measure how slow it really is, judge against the real budget.
      decideBudgetMs: budgetMs * MEASURE_SLACK,
    });
  } catch (err) {
    return gateFail(4, elapsed(), `the strategy could not be loaded: ${(err as Error).message}`, { samples: 0 });
  }

  const samples: Samples = {
    elapsed: [],
    failures: new Map(),
    overBudget: 0,
    allowance: Math.ceil(target * P99_ALLOWANCE),
    stopped: false,
  };
  const recorded = recordingRunner(runner, samples, budgetMs);

  try {
    // 1. Real match trajectories: the views that actually cost something.
    const bots: PlayerBot[] = [kiter(), rusher(), camper(), dodger()];
    const matchTarget = Math.ceil(target * (1 - FUZZ_SHARE));
    let matches = 0;
    while (!samples.stopped && samples.elapsed.length < matchTarget && matches < bots.length * 3) {
      const bot = bots[matches % bots.length]!;
      playMatchState(recorded, bot, seed + matches);
      matches += 1;
    }
    const matchCalls = samples.elapsed.length;

    // 2. Top up from Gate 2's corpus, so the degenerate states are covered too.
    const remaining = samples.stopped ? 0 : Math.max(0, target - samples.elapsed.length);
    if (remaining > 0) {
      recorded.init(seed);
      for (const view of makeFuzzViews(remaining, seed)) {
        if (samples.stopped) break;
        recorded.decide(view);
      }
    }

    const sorted = [...samples.elapsed].sort((a, b) => a - b);
    const p99 = quantile(sorted, 0.99);
    const detail = {
      samples: sorted.length,
      matches,
      matchCalls,
      fuzzCalls: sorted.length - matchCalls,
      budgetMs,
      measuredWithBudgetMs: budgetMs * MEASURE_SLACK,
      p50: quantile(sorted, 0.5),
      p90: quantile(sorted, 0.9),
      p99,
      max: sorted[sorted.length - 1] ?? 0,
      overBudget: samples.overBudget,
      allowance: samples.allowance,
      stoppedEarly: samples.stopped,
      failures: Object.fromEntries([...samples.failures].map(([kind, b]) => [kind, b.count])),
    };

    // A memory failure is fatal regardless of timing: the strategy is dead for the
    // rest of the round, so the boss would simply stop playing.
    const memory = samples.failures.get('memory');
    if (memory !== undefined) {
      return gateFail(
        4,
        elapsed(),
        `strategy memory grew past the ${CONSTANTS.limits.memoryBytes}-byte limit (${memory.text}) on ${memory.count}/${sorted.length} decide() calls`,
        detail,
      );
    }

    if (p99 > budgetMs || samples.stopped) {
      const timeouts = samples.failures.get('timeout');
      const alsoTimedOut =
        timeouts === undefined
          ? ''
          : `, and ${timeouts.count} blew the ${(budgetMs * MEASURE_SLACK).toFixed(0)} ms measuring deadline`;
      return gateFail(
        4,
        elapsed(),
        `decide() p99 = ${p99.toFixed(1)}ms > ${budgetMs}ms over ${sorted.length} calls (p50 = ${detail.p50.toFixed(2)}ms, max = ${detail.max.toFixed(1)}ms; ${samples.overBudget} over budget${alsoTimedOut})`,
        detail,
      );
    }

    const timeouts = samples.failures.get('timeout');
    if (timeouts !== undefined) {
      return gateFail(
        4,
        elapsed(),
        `decide() hit the ${(budgetMs * MEASURE_SLACK).toFixed(0)} ms measuring deadline on ${timeouts.count}/${sorted.length} calls (p99 = ${p99.toFixed(2)}ms, budget ${budgetMs}ms)`,
        detail,
      );
    }

    return gateOk(4, elapsed(), detail);
  } finally {
    recorded.dispose();
  }
}
