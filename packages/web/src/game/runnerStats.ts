/**
 * `decide` telemetry for live play.
 *
 * The engine turns every runner failure into a violation and an idle tick, which is
 * the right behaviour but is *invisible*: a boss that stands still because its
 * strategy is failing 60 times a second looks exactly like a boss whose strategy
 * decided to stand still. That ambiguity cost an afternoon of debugging once (see
 * `packages/web/README.md`, "when the boss stands still"), so the counters are now
 * part of the product: they are on the HUD's diagnostics line and on
 * `window.__rematch.runnerStats()`.
 *
 * Cost: one array push and a couple of increments per tick. `elapsedMs` samples are
 * kept in full — a round is capped at 3600 ticks, so that is one 3600-element array
 * per round, and quantiles come out exact rather than from a sketch.
 *
 * `stats()` is called from the render path, i.e. up to 60 times a second, so the
 * quantiles are memoized and refreshed at most every `QUANTILE_EVERY` calls. Sorting
 * 3600 numbers per frame would cost more than the sandbox call it is measuring; the
 * counters, which are what "stalled" is read from, are always current.
 */
import type { BossView, DecideResult, RunnerFailure, StrategyRunner } from '@rematch/contract';

/** What one round's `decide` calls looked like. */
export type RunnerStats = {
  /** `decide` calls made. Fewer than `state.tick`: a telegraph skips the call. */
  calls: number;
  ok: number;
  /**
   * Calls on which the strategy *chose* to do nothing (`{type:'idle'}`, or a
   * zero-length `move`, which the contract canonicalizes to idle).
   *
   * This is the counter the "boss stood still" bug needed and nothing had: `idle`
   * is a legal action, it costs no cooldown and it is not a violation, so a strategy
   * that has frozen is indistinguishable from one that is holding position unless
   * somebody is counting. See `packages/web/README.md`.
   */
  idle: number;
  /** Failures by `RunnerFailure['kind']`. Only non-zero kinds appear. */
  failures: Partial<Record<RunnerFailure['kind'], number>>;
  /** Longest run of consecutive failures — the number that says "stalled". */
  worstStreak: number;
  /** Consecutive failures right now. */
  streak: number;
  /** The most recent failure, for a one-line explanation. */
  lastFailure: RunnerFailure | null;
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
};

export type RecordingRunner = StrategyRunner & {
  stats(): RunnerStats;
};

/** Refresh the elapsed-time quantiles at most once per this many `decide` calls. */
const QUANTILE_EVERY = 30;

/**
 * Did the strategy ask for nothing? `action` is whatever crossed the sandbox
 * boundary, so it is `unknown` and every read has to be defensive — an invalid
 * action is the engine's business (it becomes a violation), not this counter's.
 */
function isIdleAction(action: unknown): boolean {
  if (action === null || typeof action !== 'object') return false;
  const record = action as Record<string, unknown>;
  if (record['type'] === 'idle') return true;
  // A zero-length move is "stand still" spelled differently; `validateAction`
  // canonicalizes it to idle without a violation, so it counts the same here.
  return record['type'] === 'move' && record['dx'] === 0 && record['dy'] === 0;
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
}

type Quantiles = { p50Ms: number; p99Ms: number; maxMs: number };

const ZERO_QUANTILES: Quantiles = { p50Ms: 0, p99Ms: 0, maxMs: 0 };

/**
 * Wrap a runner so every `decide` is counted and timed. Pass-through in every other
 * respect: the engine cannot tell the difference, and `elapsedMs` is reported exactly
 * as the sandbox measured it (host stringify + VM call + parse — what the frame pays).
 */
export function recordingRunner(inner: StrategyRunner): RecordingRunner {
  const elapsed: number[] = [];
  const failures = new Map<RunnerFailure['kind'], number>();
  let calls = 0;
  let ok = 0;
  let idle = 0;
  let streak = 0;
  let worstStreak = 0;
  let lastFailure: RunnerFailure | null = null;
  let quantiles: Quantiles = ZERO_QUANTILES;
  let quantilesAt = -1;

  return {
    meta: inner.meta,
    init(seed: number): void {
      inner.init(seed);
    },
    decide(view: BossView): DecideResult {
      const result = inner.decide(view);
      calls += 1;
      elapsed.push(result.elapsedMs);
      if (result.ok) {
        ok += 1;
        if (isIdleAction(result.action)) idle += 1;
        streak = 0;
      } else {
        failures.set(result.failure.kind, (failures.get(result.failure.kind) ?? 0) + 1);
        lastFailure = result.failure;
        streak += 1;
        if (streak > worstStreak) worstStreak = streak;
      }
      return result;
    },
    memoryBytes(): number {
      return inner.memoryBytes();
    },
    dispose(): void {
      inner.dispose();
    },
    stats(): RunnerStats {
      if (quantilesAt < 0 || calls - quantilesAt >= QUANTILE_EVERY) {
        const sorted = [...elapsed].sort((a, b) => a - b);
        quantiles = {
          p50Ms: quantile(sorted, 0.5),
          p99Ms: quantile(sorted, 0.99),
          maxMs: sorted[sorted.length - 1] ?? 0,
        };
        quantilesAt = calls;
      }
      return {
        calls,
        ok,
        idle,
        failures: Object.fromEntries(failures) as Partial<Record<RunnerFailure['kind'], number>>,
        worstStreak,
        streak,
        lastFailure,
        ...quantiles,
      };
    },
  };
}
