/**
 * The rewrite endpoint's **core**, with no `req`, no `res` and no HTTP anywhere in
 * it: a validated body in, a stream of events out, an `AbortSignal` to stop.
 *
 * ```ts
 * await handleRewrite(body, (event) => sse.send(event), signal);
 * ```
 *
 * That signature is the whole design decision. Spec §5.2 deploys to Vercel, where
 * the handler is a `Request`/`Response` function rather than a `node:http`
 * listener — and it is not yet certain the harness's worker pool runs there at all
 * (see "Deploying" in this package's README). Keeping the loop free of Node's
 * server types means the Node route (`http.ts`) and a serverless wrapper are both a
 * few lines of framing around the *same* handler, and neither can quietly diverge
 * from the other.
 *
 * Three things this file owns that the loop does not:
 *
 * 1. **Fallback-only mode.** No API key is a supported mode, not an error (spec
 *    AC 1). It still produces a well-formed four-beat stream that ends in `done`,
 *    because the interlude renders events and must not need a second code path for
 *    the no-key case.
 * 2. **The picked fallback travels in `done`.** Whenever the result is not approved
 *    — max attempts, deadline, error, no key — `pickFallback(round, seed)` is
 *    attached to the result (see `events.ts` for why the field is the server's).
 *    The client can start the next round from the terminal frame alone, which is
 *    spec AC 5's visible fallback with no second request inside the budget.
 * 3. **A hard stop.** The loop's own deadline aborts model calls but deliberately
 *    does not interrupt a running gate, so its worst case overshoots by one gate.
 *    A response the client is waiting on cannot overshoot indefinitely, so there is
 *    a second timer at `deadline + grace` that aborts and ends the stream itself.
 *    It should never fire; if it does, the player still gets a boss.
 * 4. **The daily spend cap.** One global counter (`spendGuard.ts`) decides whether
 *    this request is allowed to cost money at all. Past the cap the handler takes the
 *    same fallback-only path as a missing key — which is why the cap lives here, next
 *    to that decision, rather than in the HTTP layer: a serverless wrapper gets it
 *    for free, and there is exactly one place where "will this spend?" is answered.
 */
import {
  resolveCandidates,
  rewrite,
  type Analysis,
  type LLMProvider,
  type RewriteEvent,
  type RewriteProviders,
  type RewriteResult,
} from '@rematch/agents';
import { DEFAULT_MATCHES, type RunGatesOptions } from '@rematch/harness';
import type { ServerEmit, ServerRewriteResult } from './events.ts';
import { pickFallback, type FallbackStrategy } from './fallback.ts';
import { bothFrom, resolveProviders } from './providers.ts';
import { requireRewriteRequest, type RewriteRequestBody } from './request.ts';
import { createSpendGuard, resolveDailyCap, type SpendGuard } from './spendGuard.ts';

/**
 * Server-side hard timeout for the loop. Spec AC 5 gives the interlude 45 s
 * *including* the network, so the loop gets 40 s and the remaining 5 s pay for the
 * request, the stream and the client starting the round.
 */
export const DEFAULT_DEADLINE_MS = 40_000;

/** How long past the deadline the handler waits for a gate to finish before ending. */
export const DEFAULT_GRACE_MS = 5_000;

export const DEADLINE_ENV = 'REMATCH_DEADLINE_MS';
export const MAX_ATTEMPTS_ENV = 'REMATCH_MAX_ATTEMPTS';
export const MATCHES_ENV = 'REMATCH_MATCHES';
export const WORKERS_ENV = 'REMATCH_WORKERS';

/** The honest sentence the player is shown when there is no key. Spec AC 5's copy. */
export const NO_KEY_MESSAGE = 'No API key configured — using a pre-approved strategy';

/**
 * The sentence shown once the daily cap is spent.
 *
 * Says what actually happened rather than blaming a missing key: the difference
 * between "this deployment has no model" and "this deployment has stopped paying for
 * one today" matters to anyone watching, and the second one resolves at midnight UTC.
 */
export const CAPPED_MESSAGE =
  'Daily rewrite budget reached — using a pre-approved strategy';

/**
 * The process-wide guard, shared by every request this server serves.
 *
 * A module singleton because the cap is global by definition — a per-request guard
 * would count to one and never reach the limit. Tests inject their own through
 * `opts.spendGuard`.
 */
let processGuard: SpendGuard | undefined;

function defaultGuard(env: Record<string, string | undefined>): SpendGuard {
  processGuard ??= createSpendGuard({
    cap: resolveDailyCap(env),
    onCapped: (report) =>
      console.warn(
        JSON.stringify({
          warn: 'spend guard: daily rewrite cap reached — serving fallback-only for the rest of the UTC day',
          ...report,
        }),
      ),
  });
  return processGuard;
}

/** Visible for tests: drop the singleton so a fresh cap can be installed. */
export function resetProcessSpendGuard(): void {
  processGuard = undefined;
}

export type RewriteHandlerOptions = {
  /** One provider for both agents. How a test injects a mock. */
  provider?: LLMProvider;
  /** Per-agent providers; wins over `provider`. Defaults to `resolveProviders(env)`. */
  providers?: RewriteProviders;
  /** Loop deadline, ms. Defaults to `REMATCH_DEADLINE_MS`, else 40 000. */
  deadlineMs?: number;
  /** Extra time for one overshooting gate before the handler ends the stream itself. */
  graceMs?: number;
  maxAttempts?: number;
  /**
   * Files the Coder writes per attempt. Defaults to `REMATCH_CANDIDATES` (else 3).
   * `1` is the single-candidate loop, which is what the scripted-provider tests use.
   */
  candidates?: number;
  /** Gate options. `gate3.round` and `gate3.mimicSummary` are the loop's; see `loop.ts`. */
  harnessOpts?: RunGatesOptions;
  /** Read instead of `process.env`. */
  env?: Record<string, string | undefined>;
  /**
   * The daily spend cap. Defaults to a process-wide guard built from
   * `REMATCH_MAX_REWRITES_PER_DAY`; `false` disables the cap entirely, which is what
   * the tests that need many rewrites in one process pass.
   */
  spendGuard?: SpendGuard | false;
  /** Fallback picker. Injected only by tests; production is `pickFallback`. */
  pick?: (round: RewriteRequestBody['round'], seed: number) => FallbackStrategy;
};

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

/** `REMATCH_DEADLINE_MS` → the loop's deadline. */
export function resolveDeadlineMs(env: Record<string, string | undefined> = process.env): number {
  return positiveInt(env[DEADLINE_ENV], DEFAULT_DEADLINE_MS);
}

/**
 * `REMATCH_MAX_ATTEMPTS` → how many times the loop may be rejected and try again.
 *
 * Absent means the loop's own `MAX_ATTEMPTS` (4), which is the right number when the
 * interlude has 45 s: at ~30-40 s per attempt on a CLI provider, four is already more
 * than the clock allows. It is a knob because the *other* configuration is real — a
 * player training against the boss, who would rather wait three minutes for a boss that
 * actually adapted than get a pre-approved fallback in forty seconds. Measured
 * 2026-09-08: a Round 5 run stopped at 90 s having bracketed the band from both sides
 * (0.27 too easy, 0.91 too hard) and needed one more attempt to interpolate between
 * them. Raising the deadline without raising this would have stopped it at four
 * attempts anyway.
 *
 * Not unbounded: every attempt is K model calls, so an accidental 999 is a bill or a
 * subscription, and the ceiling makes the worst case something a person chose.
 */
export const MAX_ATTEMPTS_CEILING = 20;

export function resolveMaxAttempts(
  env: Record<string, string | undefined> = process.env,
): number | undefined {
  const raw = env[MAX_ATTEMPTS_ENV];
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return undefined;
  return Math.min(MAX_ATTEMPTS_CEILING, Math.trunc(n));
}

/**
 * Milliseconds reserved, inside the client's budget, for the loop to *report*.
 *
 * The loop's last act is a `fallback` + `done` pair on the wire, and there is no
 * point finishing the thinking if the client has already hung up before the frames
 * land. Two seconds is generous for two SSE frames over localhost and cheap against
 * a 40 s budget.
 */
export const CLIENT_BUDGET_RESERVE_MS = 2_000;

/**
 * The loop may not outlive the client that asked for it.
 *
 * Found in a playtest on 2026-09-08. The client aborts at 45 s (spec AC 5) and the
 * server was reading `REMATCH_DEADLINE_MS`, which was 90 s on the developer's
 * machine. Every Round 2 rewrite — always the first of a session, so always the one
 * paying a cold prompt cache — ran past 45 s, the browser hung up mid-stream, and the
 * request ended at exactly 45 034 ms with `attempts: 0`, `approved: null` and no
 * artifact on disk. The player saw a dead interlude instead of AC 5's honest
 * fallback, and there was nothing left to debug it with.
 *
 * A larger `REMATCH_DEADLINE_MS` is not wrong on its own — a CLI provider really is
 * slower, and a caller with no browser attached (the eval) should be able to use it.
 * What was wrong is that it could *exceed* what the caller would wait for. So the
 * client sends its budget and this takes the smaller of the two, less the reserve
 * above, which makes the two numbers impossible to disagree about.
 */
export function clampToClientBudget(deadlineMs: number, budgetMs: number | undefined): number {
  if (budgetMs === undefined) return deadlineMs;
  // Never below 1 ms: a pathologically small budget should still produce a real
  // (immediate) fallback rather than a non-positive timeout.
  return Math.max(1, Math.min(deadlineMs, budgetMs - CLIENT_BUDGET_RESERVE_MS));
}

/**
 * Gate 3's cost, from the environment.
 *
 * `REMATCH_MATCHES` and `REMATCH_WORKERS` exist for one reason: spec §6.2's 200
 * matches across a worker pool is a *server* budget, and a serverless function may
 * have neither the CPU seconds nor `worker_threads`. Turning both down is the
 * documented degradation (README, "Deploying") rather than a code change.
 */
export function resolveHarnessOpts(
  env: Record<string, string | undefined> = process.env,
  override?: RunGatesOptions,
): RunGatesOptions {
  const matches = positiveInt(env[MATCHES_ENV], DEFAULT_MATCHES);
  const workers = env[WORKERS_ENV] === undefined ? undefined : positiveInt(env[WORKERS_ENV], 0);
  return {
    ...override,
    gate3: {
      matches,
      ...(workers === undefined || workers === 0 ? {} : { workers }),
      ...override?.gate3,
    },
  };
}

/**
 * Fallback-only mode: a complete four-beat stream with no model behind it.
 *
 * It is not a stub. The interlude is the demo (spec §2.2) and AC 1 says a fresh
 * clone with no key must still play, so the no-key path emits the same event types
 * in the same order and ends in `done` — the only difference being that the
 * Analysis beat says, in as many words, that there is no key. Saying so is the
 * point: a fake analysis would be the one dishonest thing on screen.
 */
export function fallbackOnly(
  req: RewriteRequestBody,
  emit: ServerEmit,
  fallback: FallbackStrategy,
  /**
   * Why no model ran. Defaults to the no-key sentence; the spend guard passes
   * `CAPPED_MESSAGE` instead, so the two reasons are distinguishable on screen
   * without a second copy of this whole function.
   */
  why: string = NO_KEY_MESSAGE,
): ServerRewriteResult {
  emit({ type: 'replay', summary: req.summary, round: req.round });

  const analysis: Analysis = {
    observations: [why, `Round ${req.round} ships "${fallback.name}" from the pre-approved pool.`],
    // Nothing was analysed, so nothing may be claimed about the player. `mixed` is
    // the archetype that asserts the least.
    playerArchetype: 'mixed',
    counterPlan: 'Ship the pool strategy for this round; it has already passed all four gates.',
  };
  // Streamed in pieces rather than sent whole: the client renders `analysis.delta`
  // into the Analysis panel, and a single 200-character frame would flash rather
  // than type. Same code path as a real run, so the panel is exercised either way.
  const text = analysis.observations.join('\n');
  for (let i = 0; i < text.length; i += 24) emit({ type: 'analysis.delta', delta: text.slice(i, i + 24) });
  emit({
    type: 'analysis.done',
    analysis,
    calls: 0,
    promptChars: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    ms: 0,
  });

  const message = why === NO_KEY_MESSAGE ? 'no api key' : 'daily rewrite budget reached';
  const result: ServerRewriteResult = {
    approved: false,
    attempts: [],
    reason: 'error',
    message,
    analysis,
    fallback,
  };
  emit({ type: 'fallback', reason: 'error', message });
  emit({ type: 'done', result });
  return result;
}

/**
 * Run one rewrite, emitting every event as it happens. Resolves when the stream is
 * complete; never rejects for a loop failure, exactly like `rewrite()`.
 *
 * @throws BadRequestError if `body` does not validate. Thrown before anything is
 * emitted, so a caller that has not validated (a serverless wrapper) can turn it
 * into a 400 without having written a header.
 */
export async function handleRewrite(
  body: unknown,
  emit: ServerEmit,
  signal?: AbortSignal,
  opts: RewriteHandlerOptions = {},
): Promise<void> {
  const req = requireRewriteRequest(body);
  const env = opts.env ?? process.env;
  const pick = opts.pick ?? pickFallback;
  const fallback = (): FallbackStrategy => pick(req.round, req.seed);

  const providers =
    opts.providers ?? (opts.provider === undefined ? resolveProviders(env) : bothFrom(opts.provider));
  if (providers === undefined) {
    fallbackOnly(req, emit, fallback());
    return;
  }

  // Claimed here and nowhere else: after validation (a `400` must not cost a slot)
  // and after the no-key check (a request that was never going to spend must not
  // count against the budget), but before a single token is bought.
  const guard = opts.spendGuard === undefined ? defaultGuard(env) : opts.spendGuard;
  if (guard !== false && !guard.claim()) {
    fallbackOnly(req, emit, fallback(), CAPPED_MESSAGE);
    return;
  }

  const deadlineMs = clampToClientBudget(opts.deadlineMs ?? resolveDeadlineMs(env), req.budgetMs);
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;

  // One controller for the run. The caller's signal (the SSE connection dropped)
  // and the hard stop both land on it, and it is what stops an in-flight model call
  // so a closed tab does not keep burning tokens.
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  if (signal?.aborted === true) return;
  signal?.addEventListener('abort', onAbort, { once: true });

  /** The loop emits its own `done`; the server sends a widened one instead. */
  let done = false;
  const relay = (event: RewriteEvent): void => {
    if (event.type === 'done') return;
    emit(event);
  };

  const finish = (result: RewriteResult): void => {
    if (done || controller.signal.aborted) return;
    done = true;
    emit({
      type: 'done',
      result: result.approved ? result : { ...result, fallback: fallback() },
    });
  };

  let hardStop: NodeJS.Timeout | undefined;
  try {
    const loop = rewrite(
      {
        summary: req.summary,
        round: req.round,
        prevSource: req.prevSource,
        prevMeta: req.prevMeta,
        providers,
        harnessOpts: resolveHarnessOpts(env, opts.harnessOpts),
        deadlineMs,
        signal: controller.signal,
        // Explicit option wins; otherwise `REMATCH_MAX_ATTEMPTS`, else the loop's own
        // default. See `resolveMaxAttempts` for why this is configurable at all.
        ...(() => {
          const attempts = opts.maxAttempts ?? resolveMaxAttempts(env);
          return attempts === undefined ? {} : { maxAttempts: attempts };
        })(),
        // Read from this handler's `env` rather than left to the loop's own
        // `process.env` lookup, so a test (or a serverless config) that passes an
        // env gets the candidate count it asked for.
        candidates: opts.candidates ?? resolveCandidates(env),
      },
      relay,
    );

    // `undefined` means the hard stop won. See the header: this should never fire.
    const raced = await new Promise<RewriteResult | undefined>((resolve, reject) => {
      hardStop = setTimeout(() => {
        controller.abort();
        resolve(undefined);
      }, deadlineMs + graceMs);
      hardStop.unref?.();
      loop.then(resolve, reject);
    });

    if (raced === undefined) {
      const message = `the rewrite loop did not finish within ${deadlineMs + graceMs} ms`;
      if (!done && !controller.signal.aborted) {
        done = true;
        emit({ type: 'fallback', reason: 'deadline', message });
        emit({
          type: 'done',
          result: { approved: false, attempts: [], reason: 'deadline', message, fallback: fallback() },
        });
      }
      // Do not await the abandoned loop: it may still be inside a gate, and the
      // client is not waiting for it. It holds no resource that outlives the
      // process (`getSandbox` is a shared instance, workers are pooled).
      return;
    }

    finish(raced);
  } catch (err) {
    // `rewrite()` documents that it does not throw for a loop failure, so this is
    // a bug or an OOM — and the player still gets a boss out of it.
    const message = err instanceof Error ? err.message : String(err);
    if (!done && !controller.signal.aborted) {
      done = true;
      emit({ type: 'fallback', reason: 'error', message });
      emit({
        type: 'done',
        result: { approved: false, attempts: [], reason: 'error', message, fallback: fallback() },
      });
    }
  } finally {
    if (hardStop !== undefined) clearTimeout(hardStop);
    signal?.removeEventListener('abort', onAbort);
  }
}
