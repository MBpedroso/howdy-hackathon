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
import type { Analysis } from './context/prompts.ts';
import type { LLMUsage } from './provider.ts';

/** Why the loop gave up. `error` also covers an aborted provider stream. */
export type FailureReason = 'max-attempts' | 'deadline' | 'error';

export type AttemptLog = {
  /** 1-based. Counts harness attempts, not model calls (see `coder.calls`). */
  attempt: number;
  source: string;
  /** Unified diff, previous source → this attempt's source. */
  diff: string;
  coder: {
    /** Model calls this attempt took; 2 means one `staticCheck` self-retry. */
    calls: number;
    promptChars: number;
    usage: LLMUsage;
    ms: number;
    /** Rendered `staticCheck` violations from a discarded first file. */
    selfRetry?: string;
    /** The file was submitted still failing `staticCheck`; Gate 1 rejected it. */
    staticInvalid?: true;
  };
  /** Every gate that ran, in order. The last one is the verdict. */
  gates: GateResult[];
  approved: boolean;
  /** The rejecting gate's `reason`, verbatim. */
  reason?: string;
  /** Wall-clock for the whole attempt: model call plus gates. */
  ms: number;
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
  /** Beat 3, streaming. `attempt` is 1-based. */
  | { type: 'rewrite.delta'; attempt: number; delta: string }
  /**
   * `meta` is read out of the source with `extractMeta` — the same literal Gate 1
   * validated — so the Rewrite beat can label the diff with the boss's *name*
   * ("Warden") instead of an attempt number. Absent only if the file's `meta` is
   * not a statically readable literal, which Gate 1 is about to reject anyway.
   */
  | { type: 'rewrite.done'; attempt: number; source: string; diff: string; meta?: StrategyMeta }
  /**
   * Beat 4. One event per gate, as it finishes — the harness stops at the first
   * failure, so a rejected attempt emits fewer of these than an approved one.
   */
  | { type: 'trial.gate'; attempt: number; gate: GateResult }
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
  | { type: 'trial.progress'; attempt: number; matchesDone: number; matchesTotal: number; gate: GateName }
  | { type: 'verdict'; attempt: number; approved: boolean; reason?: string }
  /** Attempts or the deadline are exhausted; the server should ship a fallback. */
  | { type: 'fallback'; reason: FailureReason; message?: string }
  | { type: 'done'; result: RewriteResult };

export type Emit = (event: RewriteEvent) => void;
