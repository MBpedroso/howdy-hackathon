/**
 * The body of `POST /api/rewrite`, and the validation that stands between an
 * untrusted request and a 40-second LLM + simulation run.
 *
 * Validation is not defensive politeness here, it is the reason the endpoint can be
 * public. Three things go wrong without it:
 *
 *  1. **A bad `round` reaches the harness.** Gate 3's fairness band is per-round
 *     (spec §6.2) and only rounds 2-5 have one. A `round: 1` would be a crash inside
 *     Gate 3 *after* the Analyst has already been paid for.
 *  2. **A malformed `summary` becomes a mid-stream error.** The Analyst renderer and
 *     the Mimic bot both read into `summary.history` and `summary.durations` without
 *     re-checking; a missing `playerPosHeat` is a `TypeError` thrown after the SSE
 *     headers have been flushed, which the client can only render as a broken beat.
 *     Everything the renderer and the Mimic touch is checked here instead, before a
 *     single byte of response is written.
 *  3. **Cost.** One request = one Analyst call plus up to four Coder calls plus 200
 *     simulated matches. A request that cannot possibly succeed must cost nothing.
 *
 * So the rule is: reject with a 400 and a sentence naming the field, or run the loop.
 * Never start streaming and then discover the input was wrong.
 */
import type { StrategyMeta } from '@rematch/contract';
import type { ReplaySummary } from '@rematch/engine';
import { BALANCE_ROUNDS, type BalanceRound } from '@rematch/harness';

/** The validated body. Mirrors `RewriteRequest` in `packages/web/src/interlude/source.ts`. */
export type RewriteRequestBody = {
  /** The round being **written** — 2 after the player wins round 1. */
  round: BalanceRound;
  /** The compressed replay of the round just won; the Analyst's entire input. */
  summary: ReplaySummary;
  /** The strategy that just lost. The Coder's starting point. */
  prevSource: string;
  /** Its `meta`, shown to the Analyst. */
  prevMeta: StrategyMeta;
  /** The round seed. Makes a fallback pick reproducible (spec AC 3). */
  seed: number;
  /**
   * How long the *client* will wait, ms. Optional; absent means "use the server's
   * own configured deadline".
   *
   * The server clamps its loop to this, and the reason is a bug this caught in a
   * real playtest (2026-09-08). The client aborts at `INTERLUDE_DEADLINE_MS` (45 s,
   * spec AC 5) while the server's deadline is whatever `REMATCH_DEADLINE_MS` says —
   * 90 s on the developer's machine. Three Round 2 rewrites in a row died at exactly
   * 45 034 ms with `attempts: 0`, `approved: null` and **no artifact written**: the
   * client hung up mid-stream, so the loop's `fallback` + `done` pair never reached
   * anyone and the one case most worth debugging was the one with no evidence.
   *
   * Sending the budget makes the two numbers impossible to disagree about. The
   * player still gets AC 5's visible fallback, on time, and the server still writes
   * its artifact.
   */
  budgetMs?: number;
};

/**
 * Bounds on `budgetMs`. Below the minimum the loop cannot even finish one Coder call
 * (p50 7.7 s), so the request is a mistake; above the maximum a caller is asking the
 * server to hold a worker pool far longer than any interlude the spec describes.
 */
export const MIN_BUDGET_MS = 5_000;
export const MAX_BUDGET_MS = 300_000;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Thrown by `handleRewrite` when it is handed a body that `parseRewriteRequest`
 * rejects, so the core handler is safe to call directly from a framework wrapper
 * that has not validated anything. The HTTP layer validates first anyway — it has to
 * choose between a 400 and an event stream before it writes a header — so in the
 * Node server this is unreachable, and that is the point: it is there for the next
 * caller, not this one.
 */
export class BadRequestError extends Error {
  override readonly name = 'BadRequestError';
  readonly status = 400;
  constructor(message: string) {
    super(message);
  }
}

/** Spec §3: source is capped so a paste of the engine cannot become a prompt. */
export const MAX_PREV_SOURCE_CHARS = 64_000;

const ROUNDS: readonly number[] = BALANCE_ROUNDS;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A finite number — `NaN` and `Infinity` survive `JSON.parse` as `null`, but not via a string body. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function numberArray(value: unknown, length: number): boolean {
  return Array.isArray(value) && value.length === length && value.every(isFiniteNumber);
}

/** Every value in a `Record<PrimitiveName, number>`-shaped object is a number. */
function numberRecord(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every(isFiniteNumber);
}

function meta(value: unknown, path: string): string | undefined {
  if (!isRecord(value)) return `${path} must be an object`;
  if (typeof value['name'] !== 'string') return `${path}.name must be a string`;
  if (typeof value['rationale'] !== 'string') return `${path}.rationale must be a string`;
  if (!isFiniteNumber(value['version'])) return `${path}.version must be a number`;
  return undefined;
}

/**
 * Check the parts of `ReplaySummary` that are actually read downstream.
 *
 * Not a full schema, deliberately. The summary is produced by `summarizeReplay` in
 * the client's own engine, so a *shape* mismatch means a version skew rather than an
 * attack, and the fields worth naming in an error are the ones whose absence would
 * otherwise throw inside the Analyst renderer (`renderSummary`) or the Mimic bot
 * (`makeMimic`). Those two are enumerated; the rest travels as data.
 */
function summary(value: unknown): string | undefined {
  if (!isRecord(value)) return 'summary must be an object';

  if (!isFiniteNumber(value['seed'])) return 'summary.seed must be a number';
  const metaError = meta(value['strategy'], 'summary.strategy');
  if (metaError !== undefined) return metaError;
  if (typeof value['outcome'] !== 'string') return 'summary.outcome must be a string';

  const durations = value['durations'];
  if (!isRecord(durations)) return 'summary.durations must be an object';
  if (!isFiniteNumber(durations['ticks'])) return 'summary.durations.ticks must be a number';

  const player = value['player'];
  if (!isRecord(player)) return 'summary.player must be an object';
  for (const field of ['hpStart', 'hpEnd', 'dashes', 'shots'] as const) {
    if (!isFiniteNumber(player[field])) return `summary.player.${field} must be a number`;
  }

  const boss = value['boss'];
  if (!isRecord(boss)) return 'summary.boss must be an object';
  if (!numberRecord(boss['primitives'])) return 'summary.boss.primitives must be a record of numbers';

  const history = value['history'];
  if (!isRecord(history)) return 'summary.history must be an object';
  // 8x8, spec §4.2. The renderer prints it as a grid and the Mimic samples from it;
  // a short array would silently become a different arena.
  if (!numberArray(history['playerPosHeat'], 64)) {
    return 'summary.history.playerPosHeat must be 64 numbers (the 8x8 heat grid)';
  }
  if (!numberArray(history['playerDashDirs'], 8)) {
    return 'summary.history.playerDashDirs must be 8 numbers (the dash bins)';
  }
  if (!numberRecord(history['playerShotsDuring'])) {
    return 'summary.history.playerShotsDuring must be a record of numbers';
  }

  if (!isRecord(value['contract'])) return 'summary.contract must be an object';
  if (!Array.isArray(value['timeline'])) return 'summary.timeline must be an array';
  if (!isFiniteNumber(value['timelineTotal'])) return 'summary.timelineTotal must be a number';

  return undefined;
}

/**
 * Validate a parsed JSON body. Returns the reason as a sentence, not a field path
 * list — it goes straight into a 400 body and, in the client, into the fallback
 * banner the player reads.
 */
export function parseRewriteRequest(body: unknown): ParseResult<RewriteRequestBody> {
  const fail = (error: string): ParseResult<RewriteRequestBody> => ({ ok: false, error });

  if (!isRecord(body)) return fail('body must be a JSON object');

  const round = body['round'];
  if (!isFiniteNumber(round) || !ROUNDS.includes(round)) {
    return fail(`round must be one of ${ROUNDS.join(', ')} (the rounds with a fairness band)`);
  }

  const seed = body['seed'];
  if (!isFiniteNumber(seed) || !Number.isInteger(seed)) return fail('seed must be an integer');

  const prevSource = body['prevSource'];
  if (typeof prevSource !== 'string' || prevSource.trim() === '') {
    return fail('prevSource must be a non-empty string (the strategy.js that just lost)');
  }
  if (prevSource.length > MAX_PREV_SOURCE_CHARS) {
    return fail(`prevSource must be at most ${MAX_PREV_SOURCE_CHARS} characters`);
  }

  const metaError = meta(body['prevMeta'], 'prevMeta');
  if (metaError !== undefined) return fail(metaError);

  const summaryError = summary(body['summary']);
  if (summaryError !== undefined) return fail(summaryError);

  // Optional, and bounded on both sides. A client asking for 5 ms would get an
  // instant fallback every round, and one asking for an hour would hold a worker
  // pool hostage — neither is a thing an honest client asks for, so both are a
  // rejection rather than a silent clamp.
  const rawBudget = body['budgetMs'];
  let budgetMs: number | undefined;
  if (rawBudget !== undefined) {
    if (!isFiniteNumber(rawBudget) || !Number.isInteger(rawBudget)) {
      return fail('budgetMs must be an integer number of milliseconds');
    }
    if (rawBudget < MIN_BUDGET_MS || rawBudget > MAX_BUDGET_MS) {
      return fail(`budgetMs must be between ${MIN_BUDGET_MS} and ${MAX_BUDGET_MS}`);
    }
    budgetMs = rawBudget;
  }

  return {
    ok: true,
    value: {
      round: round as BalanceRound,
      seed,
      prevSource,
      prevMeta: body['prevMeta'] as StrategyMeta,
      summary: body['summary'] as ReplaySummary,
      ...(budgetMs === undefined ? {} : { budgetMs }),
    },
  };
}

/** Validate or throw. The shape `handleRewrite` uses so it can stand alone. */
export function requireRewriteRequest(body: unknown): RewriteRequestBody {
  const parsed = parseRewriteRequest(body);
  if (!parsed.ok) throw new BadRequestError(parsed.error);
  return parsed.value;
}
