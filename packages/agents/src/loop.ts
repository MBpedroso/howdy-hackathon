/**
 * THE AUTONOMOUS LOOP — spec §6.3, exactly.
 *
 * ```
 * Coder emits strategy.js
 *   → Gate 1 static      fail → reason → Coder
 *   → Gate 2 fuzz        fail → reason → Coder
 *   → Gate 3 balance     fail → reason → Coder
 *   → Gate 4 perf        fail → reason → Coder
 *   → APPROVED → ship
 * Max 4 attempts. Then fallback pool.
 * ```
 *
 * There is no human message anywhere in this file, and that is the point: it is
 * the Autonomous Loop Evidence for `SYSTEM.md` (spec §6.3, AC 6). Four properties
 * are load-bearing:
 *
 * 1. **The rejection reason travels verbatim.** `GateResult.reason` goes into the
 *    next Coder prompt unmodified (`coderPrompt`'s ATTEMPT-REJECTED block). Nothing
 *    in the loop rewords, summarizes or classifies it. The harness's sentence is
 *    the whole feedback channel, which is why the gates spend so much effort on it.
 *
 * 2. **Gates are emitted one at a time.** `runGates` returns all results at once
 *    and has no per-gate hook, so the loop drives it one gate per call, in
 *    `ALL_GATES` order, and stops at the first failure itself — identical semantics,
 *    but the interlude gets `✓ Gate 1` on screen while Gate 3 is still simulating.
 *    Reimplementing the *dispatch* would have been the wrong call; reusing it a
 *    gate at a time costs three extra function calls and keeps one source of truth.
 *
 * 3. **Gate 3 always gets `mimicSummary`.** Without it Gate 3 silently skips
 *    ADAPTED and the loop would approve a strategy that never learned anything —
 *    the exact failure the product exists to rule out (spec §6.2, AC 7).
 *
 * 4. **The deadline is real but not violent.** It is checked before every attempt
 *    and after every gate, and it aborts an in-flight provider stream through
 *    `signal`. It does *not* interrupt a running gate: a half-simulated Gate 3 has
 *    no verdict, and a verdict is the only thing worth having. Worst case the loop
 *    overshoots by one gate, which is why `deadlineMs` defaults to 40 s inside the
 *    45 s interlude budget (spec AC 5).
 */
import { createTwoFilesPatch } from 'diff';
import type { ReplaySummary } from '@rematch/engine';
import type { StrategyMeta } from '@rematch/contract';
import {
  ALL_GATES,
  GATE_NAMES,
  gate3Plan,
  getSandbox,
  runGates,
  type BalanceRound,
  type Gate3Options,
  type GateNumber,
  type GateResult,
  type RunGatesOptions,
} from '@rematch/harness';
import { runAnalyst } from './analyst.ts';
import { runCoder } from './coder.ts';
import { extractMeta } from './meta.ts';
import type { AttemptLog, Emit, FailureReason, RewriteEvent, RewriteResult } from './events.ts';
import type { Analysis, BotRates, CoderRejection } from './context/prompts.ts';
import { isAbortError, type LLMProvider } from './provider.ts';

/** Spec §6.3: "Max 4 attempts. Then fallback pool." */
export const MAX_ATTEMPTS = 4;
/**
 * Floor on the gap between two `trial.progress` events.
 *
 * The simulator already batches its callbacks (~20 per gate), but `matches` is the
 * caller's and a 2000-match probe would batch at 20 and still arrive in a burst.
 * One frame per 100 ms is the rate a meter can actually be read at, and it bounds
 * what the SSE connection carries for the slowest gate in the loop.
 */
export const PROGRESS_MIN_GAP_MS = 100;
/** Inside the 45 s interlude budget (spec AC 5), with room for one overshooting gate. */
export const DEADLINE_MS = 40_000;

export type RewriteProviders = {
  analyst: LLMProvider;
  coder: LLMProvider;
};

export type RewriteInput = {
  /** The round the player just won, compressed. */
  summary: ReplaySummary;
  /** The round being written — 2 after the player wins round 1. */
  round: BalanceRound;
  /** The strategy that just lost. */
  prevSource: string;
  /** Its `meta`, shown to the Analyst. Defaults to `summary.strategy`. */
  prevMeta?: StrategyMeta;
  providers: RewriteProviders | LLMProvider;
  /**
   * Gate options. `gate3.round` and `gate3.mimicSummary` are set by the loop and
   * cannot be overridden — the round is the input's round and the Mimic is this
   * player. Everything else (`matches`, `workers`) is the caller's.
   */
  harnessOpts?: RunGatesOptions;
  maxAttempts?: number;
  deadlineMs?: number;
  /** Caller-side cancellation (the SSE connection dropped, the player left). */
  signal?: AbortSignal;
  analystMaxTokens?: number;
  coderMaxTokens?: number;
  now?: () => number;
};

/**
 * Run the loop. Never throws for a *loop* failure — an exhausted attempt budget, a
 * blown deadline and an unexpected error all resolve as
 * `{ approved: false, reason }` after a `fallback` event, because the caller's job
 * in every one of those cases is the same: ship a pre-approved strategy and say so
 * on screen (spec §3, AC 5).
 */
export async function rewrite(input: RewriteInput, emit: Emit = (): void => {}): Promise<RewriteResult> {
  const now = input.now ?? ((): number => Date.now());
  const started = now();
  const deadlineMs = input.deadlineMs ?? DEADLINE_MS;
  const maxAttempts = Math.max(1, input.maxAttempts ?? MAX_ATTEMPTS);
  const providers: RewriteProviders =
    'analyst' in input.providers
      ? input.providers
      : { analyst: input.providers, coder: input.providers };

  const remaining = (): number => deadlineMs - (now() - started);
  const attempts: AttemptLog[] = [];

  // One controller for the whole run: the deadline timer and the caller's signal
  // both land on it, so a provider stream is cancelled by either.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, deadlineMs));
  // Never hold the process open on the loop's own timer.
  (timer as unknown as { unref?: () => void }).unref?.();
  const onCallerAbort = (): void => controller.abort();
  input.signal?.addEventListener('abort', onCallerAbort, { once: true });

  const giveUp = (reason: FailureReason, analysis?: Analysis, message?: string): RewriteResult => {
    const result: RewriteResult = {
      approved: false,
      attempts,
      reason,
      ...(message === undefined ? {} : { message }),
      ...(analysis === undefined ? {} : { analysis }),
    };
    emit({ type: 'fallback', reason, ...(message === undefined ? {} : { message }) });
    emit({ type: 'done', result });
    return result;
  };

  try {
    emit({ type: 'replay', summary: input.summary, round: input.round });

    // ---------------------------------------------------------------- Analysis
    let analysis: Analysis;
    try {
      const analyst = await runAnalyst(
        {
          summary: input.summary,
          // The Analyst studies the round that was just played, not the one being
          // written: the round it is handed is `round - 1`.
          round: input.round - 1,
          ...(input.prevMeta === undefined ? {} : { prevMeta: input.prevMeta }),
        },
        providers.analyst,
        {
          signal: controller.signal,
          ...(input.analystMaxTokens === undefined ? {} : { maxTokens: input.analystMaxTokens }),
          onDelta: (delta) => emit({ type: 'analysis.delta', delta }),
        },
      );
      analysis = {
        observations: analyst.observations,
        playerArchetype: analyst.playerArchetype,
        counterPlan: analyst.counterPlan,
      };
      emit({
        type: 'analysis.done',
        analysis,
        // The prose was streamed; the JSON half was withheld from the stream. Both
        // are here so the run log is the model's actual reply (spec §6.3).
        raw: analyst.raw,
        calls: analyst.calls,
        promptChars: analyst.promptChars,
        usage: analyst.usage,
        ms: analyst.ms,
      });
    } catch (err) {
      const aborted = isAbortError(err) || controller.signal.aborted;
      return giveUp(aborted ? 'deadline' : 'error', undefined, (err as Error).message);
    }

    // ------------------------------------------------------------ the attempts
    let prevSource = input.prevSource;
    let rejection: CoderRejection | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      // Spec §6.3's budget is attempts; AC 5's budget is seconds. Both are checked
      // here, before spending a model call on an attempt that cannot be verified.
      if (remaining() <= 0 || controller.signal.aborted) return giveUp('deadline', analysis);

      const attemptStart = now();
      let coder;
      try {
        coder = await runCoder(
          {
            analysis,
            prevSource,
            round: input.round,
            ...(rejection === undefined ? {} : { rejection }),
          },
          providers.coder,
          {
            signal: controller.signal,
            ...(input.coderMaxTokens === undefined ? {} : { maxTokens: input.coderMaxTokens }),
            onDelta: (delta) => emit({ type: 'rewrite.delta', attempt, delta }),
          },
        );
      } catch (err) {
        const aborted = isAbortError(err) || controller.signal.aborted;
        return giveUp(aborted ? 'deadline' : 'error', analysis, (err as Error).message);
      }

      const diff = unifiedDiff(prevSource, coder.source, attempt);
      // Parsed, not loaded: this attempt may be one Gate 1 is about to reject, and
      // the interlude wants the boss's name on the diff either way.
      const attemptMeta = extractMeta(coder.source);
      emit({
        type: 'rewrite.done',
        attempt,
        source: coder.source,
        diff,
        ...(attemptMeta === null ? {} : { meta: attemptMeta }),
      });

      const log: AttemptLog = {
        attempt,
        source: coder.source,
        diff,
        coder: {
          calls: coder.calls,
          promptChars: coder.promptChars,
          usage: coder.usage,
          ms: coder.ms,
          ...(coder.selfRetry === undefined ? {} : { selfRetry: coder.selfRetry }),
          ...(coder.staticInvalid === undefined ? {} : { staticInvalid: coder.staticInvalid }),
        },
        gates: [],
        approved: false,
        ms: 0,
      };
      attempts.push(log);

      // ------------------------------------------------------------- the gates
      const trial = await runTrial(coder.source, attempt, input, emit, log.gates);
      log.ms = now() - attemptStart;

      if (trial.ok) {
        log.approved = true;
        emit({ type: 'verdict', attempt, approved: true });
        let meta: StrategyMeta;
        try {
          meta = await readMeta(coder.source);
        } catch (err) {
          // Unreachable in practice: Gates 2-4 all loaded this module. Treated as
          // an error rather than swallowed, because shipping a strategy whose
          // `meta` the interlude cannot show is worse than a visible fallback.
          return giveUp('error', analysis, `the approved strategy's meta could not be read: ${(err as Error).message}`);
        }
        const result: RewriteResult = { approved: true, source: coder.source, meta, attempts, analysis };
        emit({ type: 'done', result });
        return result;
      }

      log.reason = trial.reason;
      emit({ type: 'verdict', attempt, approved: false, reason: trial.reason });

      // The rejection, verbatim, becomes the next attempt's only feedback. For a
      // Gate 3 rejection the per-bot rates go with it: the sentence says the boss
      // is too hard, the table says which opponent made it so.
      const rates = balanceRates(trial.gate);
      rejection = {
        gate: trial.gate.name,
        gateNumber: trial.gate.gate,
        reason: trial.reason,
        attempt,
        ...(rates === undefined ? {} : { rates }),
      };
      // The rejected file is the next attempt's baseline, not the round's opening
      // strategy: an attempt that failed FAIR by 0.06 is a much better starting
      // point than the boss that already lost, and the diff the player sees stays
      // a diff of what actually changed.
      prevSource = coder.source;

      if (remaining() <= 0 || controller.signal.aborted) return giveUp('deadline', analysis);
    }

    return giveUp('max-attempts', analysis);
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', onCallerAbort);
  }
}

// --------------------------------------------------------------------- gates

type TrialOutcome = { ok: true } | { ok: false; gate: GateResult; reason: string };

/**
 * Run the four gates in order, emitting each as it lands, stopping at the first
 * failure — `runGates`' contract, driven one gate at a time so the interlude can
 * show progress instead of a single verdict at the end.
 */
async function runTrial(
  source: string,
  attempt: number,
  input: RewriteInput,
  emit: Emit,
  into: GateResult[],
): Promise<TrialOutcome> {
  const opts = input.harnessOpts ?? {};
  // `round` and `mimicSummary` are the loop's, not the caller's: ADAPTED is only
  // measured if the Mimic is built from *this* player's replay (spec §6.2).
  const gate3: Gate3Options = { ...(opts.gate3 ?? {}), round: input.round, mimicSummary: input.summary };
  // The denominator the meter is labelled with, known before the first match.
  const total = gate3Plan(gate3).total;
  const now = input.now ?? ((): number => Date.now());

  for (const gate of ALL_GATES) {
    let progressAt = 0;
    let reported = 0;

    if (gate === 3) {
      progressAt = now();
      emit({ type: 'trial.progress', attempt, matchesDone: 0, matchesTotal: total, gate: GATE_NAMES[3] });
    }

    // Throttled, but the last callback of a simulation always lands on
    // `done === total`, so the meter is never left short of the finish.
    const onProgress = (done: number, matchesTotal: number): void => {
      const final = done >= matchesTotal;
      if (!final && now() - progressAt < PROGRESS_MIN_GAP_MS) return;
      if (done <= reported) return;
      progressAt = now();
      reported = done;
      emit({ type: 'trial.progress', attempt, matchesDone: done, matchesTotal, gate: GATE_NAMES[3] });
    };

    const result = await runOneGate(source, gate, opts, gate3, gate === 3 ? onProgress : undefined);
    into.push(result);

    // A gate that never simulated (the sandbox broke, the strategy would not
    // load) reports no progress at all; close the meter rather than leave it.
    if (gate === 3 && reported < total) {
      emit({ type: 'trial.progress', attempt, matchesDone: total, matchesTotal: total, gate: GATE_NAMES[3] });
    }
    emit({ type: 'trial.gate', attempt, gate: result });

    if (!result.ok) return { ok: false, gate: result, reason: result.reason };
  }
  return { ok: true };
}

async function runOneGate(
  source: string,
  gate: GateNumber,
  opts: RunGatesOptions,
  gate3: Gate3Options,
  onProgress?: (done: number, total: number) => void,
): Promise<GateResult> {
  const single: RunGatesOptions = {
    gates: [gate],
    ...(opts.gate1 === undefined ? {} : { gate1: opts.gate1 }),
    ...(opts.gate2 === undefined ? {} : { gate2: opts.gate2 }),
    ...(opts.gate4 === undefined ? {} : { gate4: opts.gate4 }),
    gate3: { ...gate3, ...(onProgress === undefined ? {} : { onProgress }) },
  };
  const run = await runGates(source, single);
  const result = run.results[0];
  if (result === undefined) throw new Error(`runGates returned no result for gate ${gate}`);
  return result;
}

/**
 * Gate 3's per-bot rates, out of its `detail`.
 *
 * Read structurally rather than typed: `detail` is `unknown` on `GateResult` by
 * design (each gate reports what it has), and a shape that drifts should cost the
 * Coder a table, not the loop an exception. Returns `undefined` for every other
 * gate, so the retry prompt only grows a table when there is one to show.
 */
export function balanceRates(result: GateResult): BotRates | undefined {
  if (result.gate !== 3) return undefined;
  const detail = result.detail;
  if (typeof detail !== 'object' || detail === null) return undefined;

  const node = (key: string): Record<string, unknown> | undefined => {
    const value = (detail as Record<string, unknown>)[key];
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
  };

  const raw = node('panel')?.['perBot'];
  const perBot = (Array.isArray(raw) ? raw : [])
    .map((entry) => {
      if (typeof entry !== 'object' || entry === null) return undefined;
      const { name, winRate } = entry as { name?: unknown; winRate?: unknown };
      return typeof name === 'string' && typeof winRate === 'number' ? { name, winRate } : undefined;
    })
    .filter((entry): entry is { name: string; winRate: number } => entry !== undefined);
  if (perBot.length === 0) return undefined;

  const mimic = node('mimic')?.['winRate'];
  return { perBot, ...(typeof mimic === 'number' ? { mimic } : {}) };
}

// ------------------------------------------------------------------ meta, diff

/**
 * Read the approved strategy's `meta` — by loading it in the QuickJS sandbox, not
 * by parsing it.
 *
 * `meta` is what the player is shown ("The boss is now: Cornerbreaker — you always
 * run to the same corner…"), so it has to be the value the game will actually see.
 * A regex over the source would agree with the sandbox until the first strategy
 * that computes its name, and then disagree silently.
 */
export async function readMeta(source: string): Promise<StrategyMeta> {
  const sandbox = await getSandbox();
  const runner = sandbox.load(source);
  try {
    return { ...runner.meta };
  } finally {
    runner.dispose();
  }
}

/**
 * Unified diff, previous source → this attempt's source. This is beat 3 of the
 * interlude: "a code diff appears: old strategy → new strategy" (spec §2.2).
 */
export function unifiedDiff(before: string, after: string, attempt: number): string {
  return createTwoFilesPatch(
    'strategy.js (previous)',
    `strategy.js (attempt ${attempt})`,
    `${before.trimEnd()}\n`,
    `${after.trimEnd()}\n`,
    '',
    '',
    { context: 3 },
  );
}

/** Collect every event into an array. Handy for tests and for the eval script. */
export function recorder(): { emit: Emit; events: RewriteEvent[] } {
  const events: RewriteEvent[] = [];
  return { emit: (event) => void events.push(event), events };
}
