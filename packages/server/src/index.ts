/**
 * `@rematch/server` — the Node side of the fight (spec §5).
 *
 * ```ts
 * import { createServer } from '@rematch/server';
 * createServer().listen(8787);
 * ```
 *
 * Two layers, on purpose:
 *
 *  - **`handleRewrite(body, emit, signal)`** — the whole endpoint, with no HTTP in
 *    it. It validates, runs the Analyst/Coder/harness loop from `@rematch/agents`,
 *    re-emits every event, and attaches a pre-approved fallback strategy to the
 *    terminal `done` whenever the loop did not approve one.
 *  - **`createServer(opts)`** — `node:http` framing: four routes, SSE, a per-IP
 *    token bucket, a CORS allow-list, and one JSON log line per request.
 *
 * The split is not decoration. Spec §5.2 deploys to Vercel, where a handler is a
 * `Request`/`Response` function rather than a `node:http` listener, and the harness's
 * worker pool may not run there at all (see "Deploying" in `README.md`). Keeping the
 * loop free of Node's server types means the two hosts share the endpoint instead of
 * each having their own copy of it.
 */

// The endpoint core — no `req`, no `res`.
export {
  CAPPED_MESSAGE,
  DEADLINE_ENV,
  DEFAULT_DEADLINE_MS,
  DEFAULT_GRACE_MS,
  MATCHES_ENV,
  NO_KEY_MESSAGE,
  WORKERS_ENV,
  fallbackOnly,
  handleRewrite,
  resetProcessSpendGuard,
  resolveDeadlineMs,
  resolveHarnessOpts,
  type RewriteHandlerOptions,
} from './handleRewrite.ts';

// The daily spend cap (`REMATCH_MAX_REWRITES_PER_DAY`). Global, unlike the per-IP
// rate limiter — see `spendGuard.ts` for why both exist.
export {
  DAILY_CAP_ENV,
  DEFAULT_DAILY_CAP,
  createSpendGuard,
  resolveDailyCap,
  utcDay,
  type SpendGuard,
  type SpendGuardOptions,
  type SpendGuardReport,
  type SpendState,
} from './spendGuard.ts';

export {
  BadRequestError,
  MAX_PREV_SOURCE_CHARS,
  parseRewriteRequest,
  requireRewriteRequest,
  type ParseResult,
  type RewriteRequestBody,
} from './request.ts';

export {
  frameOf,
  type ServerDoneEvent,
  type ServerEmit,
  type ServerRewriteEvent,
  type ServerRewriteResult,
} from './events.ts';

// The HTTP surface.
export {
  MAX_BODY_BYTES,
  createRequestListener,
  createServer,
  poolSummary,
  type ServerOptions,
} from './http.ts';

export { KEEPALIVE_MS, startSse, type SseOptions, type SseStream } from './sse.ts';

export {
  DEFAULT_CAPACITY,
  DEFAULT_WINDOW_MS,
  createRateLimiter,
  type RateLimitOptions,
  type RateLimitVerdict,
  type RateLimiter,
} from './rateLimit.ts';

export { LOCAL_ORIGINS, ORIGIN_ENV, allowedOrigins, corsFor, type CorsDecision } from './cors.ts';

export {
  KEY_ENV,
  PROVIDER_NONE,
  activeModel,
  activeVendor,
  bothFrom,
  hasApiKey,
  providerDisabled,
  resolveProviders,
  selection,
} from './providers.ts';

export {
  ARTIFACT_DIR,
  ARTIFACT_DIR_ENV,
  logLine,
  resolveArtifactDir,
  summarizeRun,
  writeRewriteArtifact,
  type RequestLogLine,
  type RewriteArtifact,
} from './log.ts';

// The fallback pool (spec §3).
export {
  FALLBACK_DIR,
  FALLBACK_POOL,
  FALLBACK_ROUNDS,
  MIN_PER_ROUND,
  POOL_BYTES,
  pickFallback,
  type FallbackStrategy,
} from './fallback.ts';
