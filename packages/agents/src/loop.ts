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
  bandFor,
  gate3Plan,
  getSandbox,
  measureMimicWinRate,
  runGates,
  type BalanceRound,
  type Gate3Options,
  type GateNumber,
  type GateResult,
  type RunGatesOptions,
} from '@rematch/harness';
import { runAnalyst } from './analyst.ts';
import { runCoder, type CoderResult } from './coder.ts';
import { extractMeta } from './meta.ts';
import type { AttemptLog, CandidateLog, Emit, FailureReason, RewriteEvent, RewriteResult } from './events.ts';
import {
  adaptDials,
  blendDials,
  dialFor,
  type Analysis,
  type BotRates,
  type CandidateOutcome,
  type CoderBracket,
  type CoderDial,
  type CoderRejection,
} from './context/prompts.ts';
import { isAbortError, type LLMProvider, type LLMUsage } from './provider.ts';

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

/**
 * How many files an attempt writes at once.
 *
 * Three, because the failure the loop actually had was not a bad Coder — it was a
 * blind one. Measured over five real round-2 evals (`artifacts/agents/eval-*.json`,
 * gpt-5.4-mini both agents) the pass rate sat at 0.2-0.3 and **54 of 55**
 * rejections were Gate 3 balance; the reasons alternated "0.78 too hard" and "0.22
 * too easy" between attempts because a single measured point gives the Coder no
 * idea how big its correction should be. Three files aimed at the low edge, the
 * middle and the high edge of the band cost one extra second of wall clock (the
 * calls are concurrent and the model call, not the gate, is the long pole) and
 * come back as an *interval*, which is an interpolation rather than a guess.
 *
 * `1` restores the pre-candidate loop exactly, prompt bytes and event stream
 * included, and is what the legacy test asserts.
 */
export const DEFAULT_CANDIDATES = 3;
export const CANDIDATES_ENV = 'REMATCH_CANDIDATES';
/** More than this is not more coverage, it is a rate limit and a blown deadline. */
export const MAX_CANDIDATES = 6;

/**
 * Wall-clock an attempt keeps in hand before starting another candidate's gates.
 *
 * Gate 3 is the only expensive gate and it costs ~0.5-2.5 s at 200 matches, so a
 * candidate that starts with less than this left is a candidate whose verdict will
 * arrive after the deadline has already given up on it. Skipping it leaves the
 * attempt with fewer measured points but a real answer, which is the trade the
 * whole loop is built on.
 */
export const CANDIDATE_GATE_RESERVE_MS = 5_000;

/**
 * How long an attempt waits for its slowest candidate after the first one lands.
 *
 * Model latency is the loop's only heavy tail: measured over a ten-replay round-2
 * eval the Coder's p50 was 8.2 s and its worst call was 36.7 s — one straggler that
 * consumed a whole 40 s run on its own and returned a truncated file. K candidates
 * make that tail *cheap* to cut, because the attempt already has two other files:
 * once one has arrived, a sibling still streaming six seconds later is abandoned
 * rather than waited on.
 */
export const STRAGGLER_GRACE_MS = 6_000;

/** `REMATCH_CANDIDATES=3`. Clamped to 1..`MAX_CANDIDATES`; anything unparseable is the default. */
export function resolveCandidates(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env[CANDIDATES_ENV]);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_CANDIDATES;
  return Math.min(MAX_CANDIDATES, Math.trunc(raw));
}

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
   * Files written per attempt. Defaults to `resolveCandidates()`
   * (`REMATCH_CANDIDATES`, else 3). `1` is the legacy single-candidate loop.
   */
  candidates?: number;
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

    /**
     * ADAPTED's relative baseline: how well the boss that just lost does against a
     * Mimic of the round it just lost. Kicked off **now** and awaited only when the
     * first Gate 3 needs it, so its ~100 matches run under the Analyst's model call
     * rather than after it — the Analyst is seconds and this is well inside that.
     *
     * Started before the Analyst rather than after because there is nothing to wait
     * for: it depends only on `prevSource` and the replay, both of which are inputs.
     *
     * Never rejected: a baseline that could not be measured is `undefined`, and
     * ADAPTED then behaves exactly as it did before the relative route existed.
     * A failure here must not cost the player their rewrite.
     */
    const gate3Opts = input.harnessOpts?.gate3 ?? {};
    const adaptedBase: Promise<number | undefined> = measureMimicWinRate(input.prevSource, {
      mimicSummary: input.summary,
      ...(gate3Opts.matches === undefined ? {} : { matches: gate3Opts.matches }),
      ...(gate3Opts.accuracy === undefined ? {} : { accuracy: gate3Opts.accuracy }),
      ...(gate3Opts.workers === undefined ? {} : { workers: gate3Opts.workers }),
    }).catch(() => undefined);

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
    const candidateCount = Math.max(
      1,
      Math.min(MAX_CANDIDATES, Math.trunc(input.candidates ?? resolveCandidates())),
    );
    const [bandLo, bandHi] = bandFor(input.round);
    const bandMid = (bandLo + bandHi) / 2;
    /**
     * Every candidate the run has measured, across all attempts.
     *
     * Accumulated rather than reset per attempt because the search is a bisection:
     * a file that measured 0.03 on attempt 1 is still the best lower bound on
     * attempt 3, and throwing it away is how the loop used to spend four attempts
     * re-discovering the same interval.
     */
    const measured: { label: string; panel: number; source: string }[] = [];
    /**
     * The best file so far that is already FAIR and was rejected for something else.
     *
     * It gets its own mode because it needs the opposite instruction from everything
     * else in the loop: a boss at 0.44 vs the panel must not move its pressure at
     * all, only re-aim it. Without this the bisection below kept "correcting" a rate
     * that was already correct — measured over a ten-replay eval, one replay spent
     * all three attempts at 0.44 / 0.00.
     *
     * Since 2026-09-08 the rejection reaching this branch is ACTIVE rather than
     * ADAPTED: an in-band boss that merely misses the Mimic goal now ships. The
     * mode survives because the instruction is the same either way — the pressure
     * is right, so change where it goes, not how much of it there is. `mimic` is
     * still the ranking key, because among several fair-but-rejected files the one
     * that already counters this player best is the one worth building on.
     */
    let fairButBlind: { label: string; source: string; mimic: number } | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      // Spec §6.3's budget is attempts; AC 5's budget is seconds. Both are checked
      // here, before spending a model call on an attempt that cannot be verified.
      if (remaining() <= 0 || controller.signal.aborted) return giveUp('deadline', analysis);

      const attemptStart = now();
      // Two measured files either side of the band turn the next attempt from
      // "how much pressure" into "where between these two", which is the one
      // question this model answers reliably.
      // Three modes, in priority order: re-aim a boss that is already fair,
      // interpolate between two files that straddle the band, or — on the first
      // attempt, with nothing measured — spread out mechanically and find the
      // interval in the first place.
      const bracket = fairButBlind === undefined ? bracketOf(measured, bandLo, bandHi) : undefined;
      const dials: (CoderDial | undefined)[] =
        candidateCount <= 1
          ? [dialFor(0, 1)]
          : fairButBlind !== undefined
            ? adaptDials(candidateCount)
            : bracket === undefined
              ? Array.from({ length: candidateCount }, (_, i) => dialFor(i, candidateCount))
              : blendDials(candidateCount, bracket, input.round);

      // The straggler cut: one controller per attempt, chained to the run's, armed
      // for `STRAGGLER_GRACE_MS` the moment the first candidate lands.
      const attemptAbort = new AbortController();
      const onRunAbort = (): void => attemptAbort.abort();
      controller.signal.addEventListener('abort', onRunAbort, { once: true });
      let straggler: NodeJS.Timeout | undefined;
      const armStraggler = (): void => {
        if (straggler !== undefined || candidateCount <= 1) return;
        straggler = setTimeout(() => attemptAbort.abort(), STRAGGLER_GRACE_MS);
        (straggler as unknown as { unref?: () => void }).unref?.();
      };

      // K model calls, all at once, differing only in the dial line. The Coder is
      // the long pole of an attempt (5-12 s against gpt-5.4-mini; every gate
      // together is under 2.5 s), so K files cost about as much wall clock as one
      // and buy K measured points instead of one.
      const pending = dials.map((dial, index) =>
        runCoder(
          {
            analysis,
            prevSource,
            round: input.round,
            ...(rejection === undefined ? {} : { rejection }),
            ...(dial === undefined ? {} : { dial }),
            ...(bracket === undefined || candidateCount <= 1 ? {} : { bracket }),
          },
          providers.coder,
          {
            signal: attemptAbort.signal,
            ...(input.coderMaxTokens === undefined ? {} : { maxTokens: input.coderMaxTokens }),
            onDelta: (delta) =>
              emit({ type: 'rewrite.delta', attempt, delta, ...tagOf(index, candidateCount) }),
          },
          // Settled, not awaited: one candidate whose model call fails must not take
          // the other two down with it, and an unawaited rejection would be an
          // unhandled promise.
        ).then<Settled, Settled>(
          (value) => {
            armStraggler();
            return { ok: true, value };
          },
          (error: unknown) => ({ ok: false, error }),
        ),
      );

      // Gates run one candidate at a time, in index order — each starting as soon
      // as its own model call lands and the previous candidate's gates are done.
      // Sequential rather than concurrent on purpose: `simulate()` already spends
      // every core on Gate 3's worker pool, so three pools at once contend for the
      // same cores and finish *later* — measured on a 12-core machine, three
      // 200-match Gate 3 runs take 2.27-2.35 s one after another and 2.55-2.59 s
      // all at once. Sequential is both faster and deterministic for the tests.
      const logs: CandidateLog[] = [];
      let coderError: Error | undefined;

      for (let index = 0; index < candidateCount; index += 1) {
        const settled = await (pending[index] as Promise<Settled>);
        if (!settled.ok) {
          coderError ??= settled.error as Error;
          continue;
        }
        const coder = settled.value;
        const dial = dials[index];
        const diff = unifiedDiff(prevSource, coder.source, attempt);
        // Parsed, not loaded: this file may be one Gate 1 is about to reject, and
        // the interlude wants the boss's name on the diff either way.
        const candidateMeta = extractMeta(coder.source);
        emit({
          type: 'rewrite.done',
          attempt,
          source: coder.source,
          diff,
          ...(candidateMeta === null ? {} : { meta: candidateMeta }),
          ...tagOf(index, candidateCount),
          ...(dial === undefined ? {} : { dial: dial.name }),
        });

        const log = candidateLog(index, dial?.name, coder, diff, candidateMeta?.name);
        logs.push(log);

        // The deadline is not allowed to eat the attempt: once there is not enough
        // time left for another Gate 3, the remaining candidates are recorded and
        // skipped so the attempt still produces a verdict.
        if (logs.length > 1 && (remaining() < CANDIDATE_GATE_RESERVE_MS || controller.signal.aborted)) {
          log.skipped = true;
          continue;
        }

        const trial = await runTrial(
          coder.source,
          attempt,
          input,
          emit,
          log.gates,
          // Awaited here, on the first candidate that reaches the gates: by now the
          // Analyst's model call has already covered its ~100 matches.
          await adaptedBase,
          tagOf(index, candidateCount),
        );
        log.approved = trial.ok;
        if (!trial.ok) log.reason = trial.reason;
        const panel = panelRate(log.gates);
        const label = `${dial?.name ?? `candidate ${index + 1}`} (attempt ${attempt})`;
        if (panel !== undefined) {
          log.panel = panel;
          measured.push({ label, panel, source: coder.source });
          const mimic = balanceRates(log.gates.find((g) => g.gate === 3))?.mimic;
          // FAIR but rejected anyway: keep the best of these, ranked by Mimic rate,
          // because the next attempt's job is to fix the other assertion without
          // touching the rate that already works.
          if (
            !trial.ok &&
            panel >= bandLo &&
            panel <= bandHi &&
            mimic !== undefined &&
            (fairButBlind === undefined || mimic > fairButBlind.mimic)
          ) {
            fairButBlind = { label, source: coder.source, mimic };
          }
        }

        // Per-candidate verdicts only exist when there are candidates to tell
        // apart; at K = 1 the attempt-level verdict below is the only one, exactly
        // as before.
        if (candidateCount > 1) {
          emit({
            type: 'verdict',
            attempt,
            approved: trial.ok,
            ...(trial.ok ? {} : { reason: trial.reason }),
            ...(panel === undefined ? {} : { panel }),
            ...tagOf(index, candidateCount),
          });
        }
      }

      if (straggler !== undefined) clearTimeout(straggler);
      controller.signal.removeEventListener('abort', onRunAbort);

      if (logs.length === 0) {
        const aborted = controller.signal.aborted || (coderError !== undefined && isAbortError(coderError));
        return giveUp(aborted ? 'deadline' : 'error', analysis, coderError?.message);
      }

      const chosen = chooseCandidate(logs, bandMid);
      const outcomes = logs.map((log) => outcomeOf(log, balanceRates(log.gates.at(-1))));
      const log: AttemptLog = {
        attempt,
        source: chosen.source,
        diff: chosen.diff,
        coder: sumCoder(logs),
        gates: chosen.gates,
        approved: chosen.approved,
        ...(chosen.reason === undefined ? {} : { reason: chosen.reason }),
        ms: now() - attemptStart,
        ...(candidateCount > 1
          ? { candidates: logs, chosen: logs.indexOf(chosen), outcomes }
          : {}),
      };
      attempts.push(log);

      if (chosen.approved) {
        // One attempt-level verdict, `candidate` absent, exactly where the
        // pre-candidate stream had its only one.
        emit({ type: 'verdict', attempt, approved: true });
        let meta: StrategyMeta;
        try {
          meta = await readMeta(chosen.source);
        } catch (err) {
          // Unreachable in practice: Gates 2-4 all loaded this module. Treated as
          // an error rather than swallowed, because shipping a strategy whose
          // `meta` the interlude cannot show is worse than a visible fallback.
          return giveUp('error', analysis, `the approved strategy's meta could not be read: ${(err as Error).message}`);
        }
        const result: RewriteResult = { approved: true, source: chosen.source, meta, attempts, analysis };
        emit({ type: 'done', result });
        return result;
      }

      const reason = chosen.reason ?? 'no candidate reached a verdict';
      emit({ type: 'verdict', attempt, approved: false, reason });

      // The rejection, verbatim, becomes the next attempt's feedback — and with it
      // the whole comparison table, which is the point of writing K files: one
      // point says "too hard", three points say where the band sits between two of
      // them (see `bracketHint`).
      const failing = chosen.gates.at(-1);
      const rates = failing === undefined ? undefined : balanceRates(failing);
      rejection = {
        gate: failing?.name ?? 'balance',
        gateNumber: failing?.gate ?? 3,
        reason,
        attempt,
        ...(rates === undefined ? {} : { rates }),
        ...(candidateCount > 1 ? { candidates: outcomes } : {}),
      };
      // The next attempt's baseline. Normally the chosen candidate — a file that
      // missed FAIR by 0.06 is a much better starting point than the boss that
      // already lost — but a file that is already fair and only blind wins over it,
      // because that is the file the ADAPT mode is about to re-aim.
      prevSource = fairButBlind?.source ?? chosen.source;

      if (remaining() <= 0 || controller.signal.aborted) return giveUp('deadline', analysis);
    }
    return giveUp('max-attempts', analysis);
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', onCallerAbort);
  }
}

// ---------------------------------------------------------------- candidates

/** `{ candidate, candidates }` — absent entirely when the attempt writes one file. */
type CandidateTag = { candidate?: number; candidates?: number };

/** A `runCoder` promise that never rejects, so one bad candidate cannot end an attempt. */
type Settled = { ok: true; value: CoderResult } | { ok: false; error: unknown };

/**
 * The two event fields that say which candidate an event belongs to — and nothing
 * at all when there is only one, so `REMATCH_CANDIDATES=1` emits the byte-identical
 * stream the interlude was built against.
 */
export function tagOf(index: number, total: number): CandidateTag {
  return total > 1 ? { candidate: index, candidates: total } : {};
}

function candidateLog(
  index: number,
  dial: string | undefined,
  coder: CoderResult,
  diff: string,
  name: string | undefined,
): CandidateLog {
  return {
    candidate: index,
    ...(dial === undefined ? {} : { dial }),
    source: coder.source,
    diff,
    ...(name === undefined ? {} : { name }),
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
  };
}

/**
 * The attempt's cost, summed over its candidates.
 *
 * `AttemptLog.coder` is what the eval's token columns and the run log add up, so it
 * has to cover every call the attempt made rather than only the winner's — three
 * candidates cost three prompts whichever one ships. `promptChars` is the largest
 * rather than the sum: the K prompts differ by one line, so their sum would say the
 * context is three times the size it is, and the number exists to watch the context
 * budget.
 */
function sumCoder(logs: readonly CandidateLog[]): AttemptLog['coder'] {
  const usage: LLMUsage = { inputTokens: 0, outputTokens: 0 };
  let calls = 0;
  let ms = 0;
  let promptChars = 0;
  let selfRetry: string | undefined;
  let staticInvalid: true | undefined;
  for (const log of logs) {
    calls += log.coder.calls;
    // Wall clock, not summed CPU: the calls were concurrent, so the attempt waited
    // for the slowest of them.
    ms = Math.max(ms, log.coder.ms);
    promptChars = Math.max(promptChars, log.coder.promptChars);
    usage.inputTokens += log.coder.usage.inputTokens;
    usage.outputTokens += log.coder.usage.outputTokens;
    if (log.coder.usage.cacheReadTokens !== undefined) {
      usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + log.coder.usage.cacheReadTokens;
    }
    selfRetry ??= log.coder.selfRetry;
    if (log.coder.staticInvalid === true) staticInvalid = true;
  }
  return {
    calls,
    promptChars,
    usage,
    ms,
    ...(selfRetry === undefined ? {} : { selfRetry }),
    ...(staticInvalid === undefined ? {} : { staticInvalid }),
  };
}

/** Gate 3's panel win rate, out of the gate results an attempt collected. */
export function panelRate(gates: readonly GateResult[]): number | undefined {
  const rates = balanceRates(gates.find((g) => g.gate === 3));
  if (rates === undefined || rates.perBot.length === 0) return undefined;
  return rates.perBot.reduce((sum, b) => sum + b.winRate, 0) / rates.perBot.length;
}

/**
 * Which of an attempt's candidates the attempt is.
 *
 * A passing candidate always wins over a failing one. Between two passing
 * candidates the one nearest the middle of the round's band ships, because both are
 * fair and the middle one leaves the most room for the *next* round to get harder.
 * Between failing ones the nearest to the middle is the one the retry edits, for the
 * same reason the loop always fed the rejected file forward: a miss of 0.06 is a
 * better starting point than a miss of 0.40. Candidates the deadline skipped were
 * never measured and lose to any candidate that was.
 */
export function chooseCandidate(logs: readonly CandidateLog[], bandMid: number): CandidateLog {
  const rank = (log: CandidateLog): [number, number, number] => [
    log.approved ? 0 : 1,
    log.skipped === true || log.gates.length === 0 ? 1 : 0,
    log.panel === undefined ? Number.POSITIVE_INFINITY : Math.abs(log.panel - bandMid),
  ];
  let best = logs[0] as CandidateLog;
  let bestRank = rank(best);
  for (const log of logs.slice(1)) {
    const r = rank(log);
    if (r[0] < bestRank[0] || (r[0] === bestRank[0] && (r[1] < bestRank[1] || (r[1] === bestRank[1] && r[2] < bestRank[2])))) {
      best = log;
      bestRank = r;
    }
  }
  return best;
}

/**
 * The tightest pair of measured files straddling the band, if there is one.
 *
 * "Tightest" is what makes the search converge: each attempt adds points and the
 * interval only ever shrinks, so attempt 3 interpolates inside attempt 2's answer
 * rather than starting again from the widest pair.
 */
export function bracketOf(
  measured: readonly { label: string; panel: number; source: string }[],
  lo: number,
  hi: number,
): CoderBracket | undefined {
  let low: { label: string; panel: number; source: string } | undefined;
  let high: { label: string; panel: number; source: string } | undefined;
  for (const point of measured) {
    if (point.panel < lo && (low === undefined || point.panel > low.panel)) low = point;
    if (point.panel > hi && (high === undefined || point.panel < high.panel)) high = point;
  }
  return low === undefined || high === undefined ? undefined : { low, high };
}

/** One row of the table the next attempt's Coder reads. */
function outcomeOf(log: CandidateLog, rates: BotRates | undefined): CandidateOutcome {
  const failing = log.gates.find((g) => !g.ok);
  return {
    candidate: log.candidate,
    dial: log.dial ?? `candidate ${log.candidate + 1}`,
    ...(log.name === undefined ? {} : { name: log.name }),
    approved: log.approved,
    ...(failing === undefined ? {} : { gate: failing.name, gateNumber: failing.gate, reason: failing.reason }),
    ...(rates === undefined ? {} : { rates }),
    ...(log.panel === undefined ? {} : { panel: log.panel }),
  };
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
  /**
   * The incumbent's rate against this Mimic, or `undefined` when it could not be
   * measured. Enables ADAPTED's relative route (`harness/gates/balanceConfig.ts`,
   * `ADAPTED_MARGIN`).
   */
  adaptedBase: number | undefined,
  /** `{ candidate, candidates }`, or `{}` for a single-candidate attempt. */
  tag: CandidateTag = {},
): Promise<TrialOutcome> {
  const opts = input.harnessOpts ?? {};
  // `round`, `mimicSummary` and `adaptedBase` are the loop's, not the caller's:
  // ADAPTED is only measured if the Mimic is built from *this* player's replay
  // (spec §6.2), and its baseline only if the incumbent ran on the same seeds.
  const gate3: Gate3Options = {
    ...(opts.gate3 ?? {}),
    round: input.round,
    mimicSummary: input.summary,
    ...(adaptedBase === undefined ? {} : { adaptedBase }),
  };
  // The denominator the meter is labelled with, known before the first match.
  const total = gate3Plan(gate3).total;
  const now = input.now ?? ((): number => Date.now());

  for (const gate of ALL_GATES) {
    let progressAt = 0;
    let reported = 0;

    if (gate === 3) {
      progressAt = now();
      emit({ type: 'trial.progress', attempt, matchesDone: 0, matchesTotal: total, gate: GATE_NAMES[3], ...tag });
    }

    // Throttled, but the last callback of a simulation always lands on
    // `done === total`, so the meter is never left short of the finish.
    const onProgress = (done: number, matchesTotal: number): void => {
      const final = done >= matchesTotal;
      if (!final && now() - progressAt < PROGRESS_MIN_GAP_MS) return;
      if (done <= reported) return;
      progressAt = now();
      reported = done;
      emit({ type: 'trial.progress', attempt, matchesDone: done, matchesTotal, gate: GATE_NAMES[3], ...tag });
    };

    const result = await runOneGate(source, gate, opts, gate3, gate === 3 ? onProgress : undefined);
    into.push(result);

    // A gate that never simulated (the sandbox broke, the strategy would not
    // load) reports no progress at all; close the meter rather than leave it.
    if (gate === 3 && reported < total) {
      emit({ type: 'trial.progress', attempt, matchesDone: total, matchesTotal: total, gate: GATE_NAMES[3], ...tag });
    }
    emit({ type: 'trial.gate', attempt, gate: result, ...tag });

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
export function balanceRates(result: GateResult | undefined): BotRates | undefined {
  if (result === undefined || result.gate !== 3) return undefined;
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
      const { name, winRate, maxIdleRun } = entry as {
        name?: unknown;
        winRate?: unknown;
        maxIdleRun?: unknown;
      };
      if (typeof name !== 'string' || typeof winRate !== 'number') return undefined;
      // ACTIVE's per-bot breakdown, when the gate reported one. Optional on purpose:
      // the same structural read has to survive a `detail` from before it existed.
      return typeof maxIdleRun === 'number' ? { name, winRate, maxIdleRun } : { name, winRate };
    })
    .filter((entry): entry is { name: string; winRate: number; maxIdleRun?: number } => entry !== undefined);
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
