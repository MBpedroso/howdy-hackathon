/**
 * The `node:http` surface. Four routes, no framework.
 *
 * ```
 * POST /api/rewrite            text/event-stream — the interlude (spec §2.2)
 * GET  /api/health             { ok, hasApiKey, provider, model, fallbackRounds }
 * GET  /api/fallback/:round    { name, source } — one pre-approved strategy
 * OPTIONS *                    CORS preflight
 * ```
 *
 * No framework because there is nothing here a framework would do: three GETs, one
 * POST, one body parse, one static allow-list. What a framework *would* add is a
 * dependency between the deployable server and the request/response types of one
 * particular host — and spec §5.2 deploys to Vercel, where the handler shape is
 * `Request`/`Response` rather than `IncomingMessage`/`ServerResponse`. So the
 * interesting half of this endpoint lives in `handleRewrite.ts`, which knows about
 * neither, and this file is the Node framing around it. A serverless wrapper is the
 * same handler with a different `emit`.
 *
 * The route order matters in one place: the rate limiter is spent **before** the
 * body is read, and refunded if the body turns out to be malformed. Charging after
 * the parse would leave an unlimited number of 512 KB parses available for free;
 * charging without the refund would let a client with a bug lock itself out of a
 * game it never got to play.
 */
import { createServer as createHttpServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from 'node:http';
import { BALANCE_ROUNDS, type BalanceRound } from '@rematch/harness';
import { allowedOrigins, corsFor } from './cors.ts';
import type { ServerRewriteEvent } from './events.ts';
import { FALLBACK_POOL, pickFallback } from './fallback.ts';
import {
  handleRewrite,
  resolveDeadlineMs,
  type RewriteHandlerOptions,
} from './handleRewrite.ts';
import {
  logLine,
  resolveArtifactDir,
  summarizeRun,
  writeRewriteArtifact,
  type RequestLogLine,
} from './log.ts';
import { activeModel, activeVendor, hasApiKey } from './providers.ts';
import { createRateLimiter, type RateLimiter, type RateLimitOptions } from './rateLimit.ts';
import { parseRewriteRequest } from './request.ts';
import { startSse } from './sse.ts';

/** 512 KB. A `ReplaySummary` is ~8 KB and `prevSource` is capped at 64 K chars. */
export const MAX_BODY_BYTES = 512 * 1024;

export type ServerOptions = RewriteHandlerOptions & {
  /** `false` disables the limiter — tests that need seven requests, and only those. */
  rateLimit?: RateLimitOptions | false;
  /** Extra allowed origins, on top of the dev ports and `VERCEL_URL`. */
  origins?: readonly string[];
  keepaliveMs?: number;
  bodyLimitBytes?: number;
  /** `false` writes no event-log artifact. Defaults to `artifacts/server/`. */
  artifactDir?: string | false;
  /** Where the JSON log line goes. Defaults to `console.log`. */
  log?: (text: string) => void;
};

// ------------------------------------------------------------------ responses

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(text);
}

/**
 * The client's address, for the rate limiter's bucket key.
 *
 * `x-forwarded-for`'s first entry is trusted, which is correct behind exactly one
 * reverse proxy (Vercel, Fly, nginx) and forgeable when the server is exposed
 * directly. That trade is deliberate and bounded: the header decides only which
 * bucket a request spends a token from, so forging it buys a fresh quota — the same
 * thing a new IP address buys — and nothing else. Nothing in this server
 * authenticates, authorizes or logs by address.
 */
function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (first !== undefined) {
    const ip = first.split(',')[0]?.trim();
    if (ip !== undefined && ip !== '') return ip;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/**
 * Read the body with a hard cap, destroying the socket the moment it is exceeded.
 *
 * The cap is enforced on the bytes *seen*, not on `content-length`: a chunked
 * request has no declared length, and trusting the declared one is how a cap gets
 * bypassed. `req.destroy()` rather than a polite drain, because continuing to read
 * a body already known to be too large is the denial of service.
 */
async function readBody(req: IncomingMessage, limit: number): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const declared = Number(req.headers['content-length'] ?? Number.NaN);
  if (Number.isFinite(declared) && declared > limit) {
    return { ok: false, error: `body must be at most ${limit} bytes` };
  }
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      size += buf.length;
      if (size > limit) {
        req.destroy();
        return { ok: false, error: `body must be at most ${limit} bytes` };
      }
      chunks.push(buf);
    }
  } catch (err) {
    return { ok: false, error: `could not read the request body: ${(err as Error).message}` };
  }
  return { ok: true, text: Buffer.concat(chunks).toString('utf8') };
}

// --------------------------------------------------------------------- routes

export function createRequestListener(opts: ServerOptions = {}): RequestListener {
  const env = opts.env ?? process.env;
  const origins = allowedOrigins(env, opts.origins ?? []);
  const limiter: RateLimiter | undefined =
    opts.rateLimit === false ? undefined : createRateLimiter(opts.rateLimit ?? {});
  const bodyLimit = opts.bodyLimitBytes ?? MAX_BODY_BYTES;
  const write = opts.log ?? ((text: string): void => console.log(text));
  const artifactDir = opts.artifactDir === undefined ? resolveArtifactDir(env) : opts.artifactDir;

  return (req, res) => {
    const started = performance.now();
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const route = `${req.method ?? 'GET'} ${url.pathname}`;

    const cors = corsFor(req.headers.origin, origins);
    if (!cors.allowed) {
      json(res, 403, { error: `origin ${cors.origin} is not allowed` });
      return;
    }
    const headers = cors.headers;

    // ------------------------------------------------------------- preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...headers, 'content-length': '0' });
      res.end();
      return;
    }

    // ---------------------------------------------------------------- health
    if (req.method === 'GET' && url.pathname === '/api/health') {
      json(
        res,
        200,
        {
          ok: true,
          hasApiKey: hasApiKey(env),
          provider: activeVendor(env),
          model: activeModel(env),
          fallbackRounds: BALANCE_ROUNDS,
          deadlineMs: opts.deadlineMs ?? resolveDeadlineMs(env),
        },
        headers,
      );
      return;
    }

    // -------------------------------------------------------------- fallback
    if (req.method === 'GET' && url.pathname.startsWith('/api/fallback/')) {
      const raw = url.pathname.slice('/api/fallback/'.length);
      const round = Number(raw);
      if (!Number.isInteger(round) || !(BALANCE_ROUNDS as readonly number[]).includes(round)) {
        json(res, 400, { error: `round must be one of ${BALANCE_ROUNDS.join(', ')}` }, headers);
        return;
      }
      const seedParam = url.searchParams.get('seed');
      const seed = seedParam === null ? 0 : Number(seedParam);
      if (!Number.isFinite(seed)) {
        json(res, 400, { error: 'seed must be a number' }, headers);
        return;
      }
      const pick = (opts.pick ?? pickFallback)(round as BalanceRound, seed);
      // Cacheable, unlike everything else here: it is a pure function of the path
      // and the query, and the pool only changes when the server is redeployed.
      json(res, 200, { name: pick.name, source: pick.source }, { ...headers, 'cache-control': 'public, max-age=60' });
      return;
    }

    // --------------------------------------------------------------- rewrite
    if (req.method === 'POST' && url.pathname === '/api/rewrite') {
      void serveRewrite(req, res, {
        opts,
        headers,
        route,
        started,
        limiter,
        bodyLimit,
        write,
        artifactDir,
      });
      return;
    }

    json(res, 404, { error: `no route for ${route}` }, headers);
  };
}

type RewriteContext = {
  opts: ServerOptions;
  headers: Record<string, string>;
  route: string;
  started: number;
  limiter: RateLimiter | undefined;
  bodyLimit: number;
  write: (text: string) => void;
  artifactDir: string | false;
};

async function serveRewrite(req: IncomingMessage, res: ServerResponse, ctx: RewriteContext): Promise<void> {
  const { opts, headers, route, started, limiter, bodyLimit, write, artifactDir } = ctx;
  const ip = clientIp(req);

  // Charged before the body is read; refunded below if the body is unusable.
  const verdict = limiter?.take(ip);
  if (verdict !== undefined && !verdict.ok) {
    json(
      res,
      429,
      {
        error: `too many rewrites — ${limiter?.capacity ?? 0} per ${Math.round((limiter?.windowMs ?? 0) / 60_000)} minutes`,
        retryAfterSeconds: verdict.retryAfterSeconds,
      },
      { ...headers, 'retry-after': String(verdict.retryAfterSeconds) },
    );
    return;
  }

  const body = await readBody(req, bodyLimit);
  if (!body.ok) {
    limiter?.refund(ip);
    json(res, 413, { error: body.error }, headers);
    return;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(body.text);
  } catch (err) {
    limiter?.refund(ip);
    json(res, 400, { error: `body is not valid JSON: ${(err as Error).message}` }, headers);
    return;
  }

  // Validated *before* a header is written: once the response is an event stream
  // there is no status code left to say "your request was wrong" with.
  const parsed = parseRewriteRequest(parsedJson);
  if (!parsed.ok) {
    limiter?.refund(ip);
    json(res, 400, { error: parsed.error }, headers);
    return;
  }

  const stream = startSse(req, res, {
    headers,
    ...(opts.keepaliveMs === undefined ? {} : { keepaliveMs: opts.keepaliveMs }),
  });

  /** Kept for the log line and the artifact; the stream itself is write-only. */
  const events: ServerRewriteEvent[] = [];
  let error: Error | undefined;
  try {
    await handleRewrite(
      parsed.value,
      (event) => {
        events.push(event);
        stream.send(event);
      },
      stream.signal,
      opts,
    );
  } catch (err) {
    // `handleRewrite` only throws `BadRequestError`, and the body has already been
    // validated — so this is a bug. The stream is open, so it cannot become a
    // status code; it is logged and the connection is closed.
    error = err instanceof Error ? err : new Error(String(err));
  } finally {
    stream.close();
  }

  const line: RequestLogLine = summarizeRun(events, {
    route,
    status: 200,
    ms: performance.now() - started,
    round: parsed.value.round,
  });

  if (artifactDir !== false && !stream.signal.aborted) {
    const artifact = writeRewriteArtifact(
      {
        generatedAt: new Date().toISOString(),
        request: { round: parsed.value.round, seed: parsed.value.seed, prevMeta: parsed.value.prevMeta },
        summary: line,
        events,
      },
      artifactDir,
      (err) => write(JSON.stringify({ route, warn: `artifact not written: ${err.message}` })),
    );
    if (artifact !== undefined) line.artifact = artifact;
  }
  if (error !== undefined) {
    logLine({ ...line, status: 500 }, write);
    write(JSON.stringify({ route, error: error.message, stack: error.stack }));
    return;
  }
  logLine(line, write);
}

// -------------------------------------------------------------------- server

/**
 * A ready-to-listen server.
 *
 * ```ts
 * createServer({ provider: mockProvider([...]) }).listen(0);
 * ```
 *
 * `provider` is how the test suite runs the whole HTTP + SSE path with no network
 * and no API key — the same injection point `handleRewrite` takes, surfaced here so
 * a test never has to reach past the server it started.
 */
export function createServer(opts: ServerOptions = {}): Server {
  const server = createHttpServer(createRequestListener(opts));
  // An interlude is up to 45 s of mostly-silence (spec AC 5) and Node's default
  // `requestTimeout` (300 s) is fine, but `headersTimeout` and the keep-alive
  // timeout are what kill a long streamed response on an idle connection.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  return server;
}

/** The rounds the pool covers, for the boot log. */
export function poolSummary(): string {
  return BALANCE_ROUNDS.map((round) => `round ${round}: ${FALLBACK_POOL[round].map((s) => s.name).join(', ')}`).join(
    ' | ',
  );
}
