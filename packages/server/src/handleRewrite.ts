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

/**
 * Server-side hard timeout for the loop. Spec AC 5 gives the interlude 45 s
 * *including* the network, so the loop gets 40 s and the remaining 5 s pay for the
 * request, the stream and the client starting the round.
 */
export const DEFAULT_DEADLINE_MS = 40_000;

/** How long past the deadline the handler waits for a gate to finish before ending. */
export const DEFAULT_GRACE_MS = 5_000;

export const DEADLINE_ENV = 'REMATCH_DEADLINE_MS';
export const MATCHES_ENV = 'REMATCH_MATCHES';
export const WORKERS_ENV = 'REMATCH_WORKERS';

/** The honest sentence the player is shown when there is no key. Spec AC 5's copy. */
export const NO_KEY_MESSAGE = 'No API key configured — using a pre-approved strategy';

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
): ServerRewriteResult {
  emit({ type: 'replay', summary: req.summary, round: req.round });

  const analysis: Analysis = {
    observations: [NO_KEY_MESSAGE, `Round ${req.round} ships "${fallback.name}" from the pre-approved pool.`],
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

  const result: ServerRewriteResult = {
    approved: false,
    attempts: [],
    reason: 'error',
    message: 'no api key',
    analysis,
    fallback,
  };
  emit({ type: 'fallback', reason: 'error', message: 'no api key' });
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

  const deadlineMs = opts.deadlineMs ?? resolveDeadlineMs(env);
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
        ...(opts.maxAttempts === undefined ? {} : { maxAttempts: opts.maxAttempts }),
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
