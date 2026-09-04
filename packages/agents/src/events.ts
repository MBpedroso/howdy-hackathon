/**
 * The event stream the interlude is made of.
 *
 * Spec §2.2 is four beats — Replay, Analysis, Rewrite, Trial — and this union is
 * that table with types on it. The server turns each event into one SSE frame and
 * the web client renders it; nothing else crosses that boundary, so this file is
 * the agents package's real API surface alongside `rewrite()`.
 *
 * Two properties every event holds:
 *
 *  - **JSON-serializable.** No class instances, no functions, no `undefined` in a
 *    required position. An event that cannot survive `JSON.stringify` cannot reach
 *    the player.
 *  - **Emitted as it happens.** The 45 s interlude budget (spec AC 5) is mostly
 *    waiting, and waiting is only content while something moves. That is why gates
 *    arrive one at a time, why the Coder streams deltas, and why Gate 3's 200
 *    matches report progress while they run. The one place batching is deliberate
 *    is `trial.progress`, which is coalesced to a readable rate rather than one
 *    frame per simulated match.
 */
import type { ReplaySummary } from '@rematch/engine';
import type { StrategyMeta } from '@rematch/contract';
import type { GateName, GateResult } from '@rematch/harness';
import type { Analysis, CandidateOutcome } from './context/prompts.ts';
import type { LLMUsage } from './provider.ts';

/** Why the loop gave up. `error` also covers an aborted provider stream. */
export type FailureReason = 'max-attempts' | 'deadline' | 'error';

/** One of the K files an attempt wrote, with what the gates said about it. */
export type CandidateLog = {
  /** 0-based, the same number the events carry. */
  candidate: number;
  /** `conservative` / `balanced` / `aggressive`. Absent when K is 1. */
  dial?: string;
  source: string;
  /** Unified diff, the attempt's baseline → this candidate. */
  diff: string;
  /** `meta.name`, when the file had a statically readable literal. */
  name?: string;
  coder: {
    /** Model calls this candidate took; 2 means one `staticCheck` self-retry. */
    calls: number;
    promptChars: number;
    usage: LLMUsage;
    ms: number;
    selfRetry?: string;
    staticInvalid?: true;
  };
  /** Every gate that ran for this candidate, in order. Empty if it was skipped. */
  gates: GateResult[];
  approved: boolean;
  /** The rejecting gate's `reason`, verbatim. */
  reason?: string;
  /** Gate 3's panel mean, when it measured one. */
  panel?: number;
  /** True when the deadline stopped the attempt before this candidate's gates ran. */
  skipped?: true;
};

export type AttemptLog = {
  /** 1-based. Counts harness attempts, not model calls (see `coder.calls`). */
  attempt: number;
  /**
   * The candidate the attempt settled on: the approved one, or — when none passed
   * — the one closest to the middle of the band, which is what the retry edits.
   * `source`, `diff`, `gates` and `reason` are all this candidate's.
   */
  source: string;
  /** Unified diff, previous source → this attempt's source. */
  diff: string;
  coder: {
    /**
     * Model calls this attempt took, **summed over its candidates** — so the cost
     * of an attempt is still one number, and the eval's token columns still cover
     * everything the attempt spent. Per-candidate figures are in `candidates`.
     */
    calls: number;
    promptChars: number;
    usage: LLMUsage;
    ms: number;
    /** Rendered `staticCheck` violations from a discarded first file. */
    selfRetry?: string;
    /** The file was submitted still failing `staticCheck`; Gate 1 rejected it. */
    staticInvalid?: true;
  };
  /** Every gate that ran for the chosen candidate, in order. The last is the verdict. */
  gates: GateResult[];
  approved: boolean;
  /** The rejecting gate's `reason`, verbatim. */
  reason?: string;
  /** Wall-clock for the whole attempt: model calls plus gates. */
  ms: number;
  /**
   * Every candidate this attempt ran, in index order. Present whenever the attempt
   * ran more than one; absent for `REMATCH_CANDIDATES=1`, whose log is the legacy
   * shape exactly.
   */
  candidates?: CandidateLog[];
  /** Index into `candidates` of the one the fields above describe. */
  chosen?: number;
  /** The comparison table handed to the next attempt's Coder. */
  outcomes?: CandidateOutcome[];
};

export type RewriteResult =
  | {
      approved: true;
      source: string;
      meta: StrategyMeta;
      attempts: AttemptLog[];
      analysis: Analysis;
    }
  | {
      approved: false;
      attempts: AttemptLog[];
      reason: FailureReason;
      /** Present when `reason` is `error`, or when the Analyst itself failed. */
      message?: string;
      /** Absent only if the loop died before the Analyst returned. */
      analysis?: Analysis;
    };

export type RewriteEvent =
  /** Beat 1. The round the player just won, as the Analyst will read it. */
  | { type: 'replay'; summary: ReplaySummary; round: number }
  /** Beat 2, streaming. */
  | { type: 'analysis.delta'; delta: string }
  | {
      type: 'analysis.done';
      analysis: Analysis;
      /**
       * The Analyst's reply in full — the prose the player saw *and* the JSON block
       * that was withheld from the stream. Kept because a judge reading the run log
       * should see the model's actual bytes, not only the parsed conclusion.
       *
       * Absent only where no model produced the analysis: the server's no-key path
       * writes the `Analysis` itself, so there is no reply to keep.
       */
      raw?: string;
      calls: number;
      promptChars: number;
      usage: LLMUsage;
      ms: number;
    }
  /**
   * Beat 3, streaming. `attempt` is 1-based.
   *
   * ## Candidates
   *
   * An attempt writes K files at once (`REMATCH_CANDIDATES`, default 3), aimed at
   * the low edge, the middle and the high edge of the round's band, and keeps
   * whichever the harness likes best. Every event that belongs to one of those
   * files therefore carries `candidate` (0-based) and `candidates` (K), and the
   * five that do are `rewrite.delta`, `rewrite.done`, `trial.gate`,
   * `trial.progress` and `verdict`.
   *
   * Both fields are **absent when K is 1**, so a single-candidate run emits the
   * byte-identical stream it always did. They are also absent on the one
   * *attempt-level* `verdict` that follows the per-candidate ones: a consumer that
   * ignores `candidate` entirely still sees exactly one verdict per attempt, which
   * is what the pre-candidate clients were written against.
   */
  | { type: 'rewrite.delta'; attempt: number; delta: string; candidate?: number; candidates?: number }
  /**
   * `meta` is read out of the source with `extractMeta` — the same literal Gate 1
   * validated — so the Rewrite beat can label the diff with the boss's *name*
   * ("Warden") instead of an attempt number. Absent only if the file's `meta` is
   * not a statically readable literal, which Gate 1 is about to reject anyway.
   */
  | {
      type: 'rewrite.done';
      attempt: number;
      source: string;
      diff: string;
      meta?: StrategyMeta;
      candidate?: number;
      candidates?: number;
      /** The aim point this file was written to: `conservative` / `balanced` / `aggressive`. */
      dial?: string;
    }
  /**
   * Beat 4. One event per gate, as it finishes — the harness stops at the first
   * failure, so a rejected attempt emits fewer of these than an approved one.
   */
  | { type: 'trial.gate'; attempt: number; gate: GateResult; candidate?: number; candidates?: number }
  /**
   * Gate 3's simulation, as it happens.
   *
   * The first event of an attempt is always `matchesDone: 0` — it is what tells the
   * UI the total and puts the meter on screen — and the last is always
   * `matchesDone === matchesTotal`. In between, one event per batch of results from
   * the worker pool (`progressBatch`, ~20 per gate), throttled here to at most one
   * per `PROGRESS_MIN_GAP_MS`. So the meter shows *measured* progress and needs no
   * duration estimate; the cadence depends on the worker count and the machine, the
   * verdict does not.
   *
   * `matchesTotal` is `gate3Plan(...).total` and is the same in every event of an
   * attempt, including the first — the gate's rounding (`matches / 2 / 4`) means it
   * is not always the `matches` the caller asked for.
   */
  | {
      type: 'trial.progress';
      attempt: number;
      matchesDone: number;
      matchesTotal: number;
      gate: GateName;
      candidate?: number;
      candidates?: number;
    }
  /**
   * One per candidate as its gates finish, then one for the attempt as a whole
   * with `candidate` absent — the attempt-level one is the event the interlude was
   * built against and the only one a K-unaware consumer sees.
   */
  | {
      type: 'verdict';
      attempt: number;
      approved: boolean;
      reason?: string;
      candidate?: number;
      candidates?: number;
      /** Gate 3's panel mean for this candidate, when it measured one. */
      panel?: number;
    }
  /** Attempts or the deadline are exhausted; the server should ship a fallback. */
  | { type: 'fallback'; reason: FailureReason; message?: string }
  | { type: 'done'; result: RewriteResult };

export type Emit = (event: RewriteEvent) => void;
