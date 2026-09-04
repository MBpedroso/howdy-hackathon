# `@rematch/server`

The Node side of the fight: one endpoint that runs the Analyst → Coder → harness loop and
streams every beat of it to the browser, plus the pre-approved fallback pool that ships a
boss when the loop misses.

```
POST /api/rewrite            text/event-stream — the interlude (spec §2.2)
GET  /api/health             { ok, hasApiKey, provider, model, fallbackRounds, deadlineMs }
GET  /api/fallback/:round    { name, source } — one pre-approved strategy
```

```bash
pnpm dev            # web (5173) + server (8787), one Ctrl-C stops both
pnpm dev:server     # just the server
curl http://127.0.0.1:8787/api/health
```

No API key needed to run it. Without one the server answers in **fallback-only mode** (see
below), which is what makes spec AC 1 true: `pnpm install && pnpm dev` is a playable game on
a fresh clone.

Which vendor it calls is decided in exactly one place — `selectProvider()` in
`@rematch/agents` — so the boot banner, `/api/health` and `pnpm eval:agents` cannot claim
different models. `auto` prefers Anthropic when both keys are set; an *explicit*
`REMATCH_PROVIDER` whose key is missing selects fallback-only rather than quietly billing
the other vendor, and `/api/health` says which happened.

| Variable | Effect |
|---|---|
| `OPENAI_API_KEY` | present → the real loop runs on OpenAI |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` | present → the real loop runs on Anthropic |
| `REMATCH_PROVIDER` | `anthropic` \| `openai` \| `auto` (default). No usable credential → fallback-only |
| `REMATCH_MODEL`, `REMATCH_ANALYST_MODEL`, `REMATCH_CODER_MODEL` | model per agent (`@rematch/agents`) |
| `REMATCH_REASONING_EFFORT` | OpenAI only: `low` (default), `minimal`, `medium`, `high`, or `none` to omit the block |
| `REMATCH_DEADLINE_MS` | loop deadline, default 40 000 |
| `REMATCH_MATCHES` | Gate 3 matches per attempt, default 200 (spec §6.2) |
| `REMATCH_WORKERS` | Gate 3 simulation threads, default `availableParallelism() - 1` |
| `REMATCH_ORIGIN` | extra allowed origins, comma-separated |
| `REMATCH_ARTIFACT_DIR` | where event logs go, default repo-root `artifacts/server/` |
| `PORT`, `HOST` | default 8787, `127.0.0.1` |

`.env` at the repo root is read by Node itself (`--env-file-if-exists`), so there is no
`dotenv` dependency and a missing `.env` is a log line rather than a crash.

## Two layers

```ts
// The endpoint. No `req`, no `res`, no framework.
await handleRewrite(body, (event) => sse.send(event), signal);

// The Node framing around it.
createServer({ provider }).listen(8787);
```

The split is the one architectural decision in this package. Spec §5.2 deploys to Vercel,
where a handler is a `Request`/`Response` function rather than a `node:http` listener — and
it is not yet settled that the harness's worker pool runs there at all (see **Deploying**).
Keeping the loop free of Node's server types means the two hosts share the endpoint instead
of each growing their own copy of it, and it is also what lets the test suite drive the real
handler with a mocked model and nothing else faked.

## The wire contract

`POST /api/rewrite`, `content-type: application/json`:

```jsonc
{
  "round":      2,          // the round being WRITTEN (the player just won round 1)
  "seed":       3221225473, // the round seed; makes a fallback pick reproducible
  "summary":    { ... },    // engine `ReplaySummary` of the round just won
  "prevSource": "export const meta = ...",   // the strategy that just lost
  "prevMeta":   { "name": "Cornerbreaker", "rationale": "...", "version": 1 }
}
```

Response: `200`, `content-type: text/event-stream`, one frame per `RewriteEvent`, in the
order the loop emits them.

```
event: replay
data: {"type":"replay","summary":{...},"round":2}

event: analysis.delta
data: {"type":"analysis.delta","delta":"{\n  \"observations\""}

: keepalive

event: trial.gate
data: {"type":"trial.gate","attempt":1,"gate":{"gate":1,"name":"static","ok":true,"ms":3}}

event: done
data: {"type":"done","result":{"approved":true,"source":"...","meta":{...}}}
```

- The `event:` name always equals the payload's `type`. The client reads `type` from the
  JSON; the name is there so `curl -N` is readable and a proxy's logs mean something.
- `data:` is one JSON object on one line.
- The stream **always** ends with `done`, and `done` is always last. Everything the client
  needs to start the next round is in `result`.
- `: keepalive` comments arrive every 10 s. They are SSE comments — the client's parser
  drops them — and they exist because Gate 3 can simulate for tens of seconds in silence.
- A bad body is a `400` with `{ "error": "…" }` and **no** stream. Validation happens before
  a header is written, because once the response is an event stream there is no status code
  left to say no with.
- `429` past the rate limit, `413` past the 512 KB body cap, `403` for an origin that is not
  on the allow-list.

The event union is `RewriteEvent` from `@rematch/agents`, with **one** server-side addition:

```ts
// done, when result.approved === false
result.fallback = { name: "hollow", source: "export const meta = …" }
```

`RewriteResult` has no `fallback` field and should not get one — the loop has no fallback
pool, does not read the filesystem, and does not know which round has which pre-approved
bosses. So the widened type is the server's (`src/events.ts`: `ServerDoneEvent`,
`ServerRewriteResult`). It is an extra field on a structural type, so a client that ignores
it keeps working; the reason it is there is that a client which needs a boss at exactly the
moment something has gone wrong should not have to make a second request to get one
(spec AC 5).

## Fallback-only mode

No credential is a *mode*, not an error. `GET /api/health` reports it as
`hasApiKey: false` with `provider: null`, and a rewrite request still produces a
well-formed four-beat stream:

```
replay → analysis.delta… → analysis.done → fallback → done
```

with the Analysis beat saying, in as many words, `No API key configured — using a
pre-approved strategy`, and `done.result.fallback` carrying the round's pool entry. The
interlude therefore needs no second code path for the no-key case, and nothing on screen is
fabricated — a fake analysis would be the one dishonest thing in the product.

## What protects the endpoint

One request is one Analyst call, up to four Coder calls and up to 800 simulated matches. So:

| Control | Value | Why |
|---|---|---|
| Deadline | 40 s, then a 5 s grace | Spec AC 5's 45 s budget includes the network. The loop's own deadline aborts model calls but deliberately does not interrupt a running gate, so a second timer ends the response if a gate overruns |
| Rate limit | 6 rewrites / 10 min per IP, token bucket | Four rewrites is a whole game (rounds 2-5), so it never bites on honest play. Charged before the body is read, refunded on a `400` |
| Body cap | 512 KB | A `ReplaySummary` is ~8 KB and `prevSource` is capped at 64 K chars |
| CORS | allow-list: the Vite dev/preview ports, `VERCEL_URL`, `REMATCH_ORIGIN` | `POST /api/rewrite` spends money; any page on the internet must not be able to fire it from a visitor's browser |
| Abort | client disconnect → `AbortSignal` → the provider stream | A closed tab must stop burning tokens |

## Logging (spec AC 6)

Two things per rewrite:

- **One JSON line to stdout** — round, attempts, approved, ms, tokens, which gate rejected
  each attempt, which fallback shipped.
- **The full event log** to `artifacts/server/rewrite-<timestamp>.json` — every frame the
  client was sent, including every rejection sentence and every generated `strategy.js`.

`artifacts/` is gitignored, so those files are raw material: a run worth keeping gets copied
into `docs/` by hand. That is the right way round — the AC 6 evidence should be chosen
deliberately, not accumulated. A failed write (a read-only filesystem, every serverless
platform included) is logged as a warning and never turns a good interlude into a 500.

## Tests

```
pnpm --filter @rematch/server test      # ~7 s, no network, no API key
```

| File | Covers |
|---|---|
| `rewrite.test.ts` | the endpoint over a socket: the four beats in order, `done` last, all four gates as separate events, a Gate 1 rejection reaching the client verbatim then approving, the max-attempts fallback, fallback-only mode, seeded pick stability, and a client disconnect aborting the provider's signal |
| `providers.test.ts` | which vendor and model the server resolves from the environment, including fallback-only on a fresh clone |
| `http.test.ts` | health (`provider` and `model` for both vendors), the fallback route, eight `400` shapes, `413`, `429` with `Retry-After`, CORS preflight and refusal, keep-alive comments, `404` |
| `units.test.ts` | the token bucket against an injected clock (including the drip-back a socket test cannot show), the validator, the frame format, the log line |
| `fallback.test.ts` | balance regression: every pooled strategy still lands in its round's band (spec §7) |

Every test goes over a real socket with a real `fetch` and a hand-written SSE parser — not
the client's parser, deliberately, so that a shared misreading of the format cannot hide.
The only thing mocked anywhere is the model.

## Deploying

**What Vercel needs, concretely, for `POST /api/rewrite` to work as a serverless function:**

1. **`maxDuration >= 60`** in `vercel.json` (Hobby's ceiling; the default is 10 s, which
   ends the stream mid-Analysis). The 40 s deadline plus a 5 s grace plus a cold start needs
   every one of those 60 seconds. Pro allows 300 s and would be comfortable.
2. **Streaming.** Node functions on Vercel do stream, but only if the handler returns a
   `ReadableStream`/`Response` and nothing buffers it. `handleRewrite` is written for that —
   `emit` becomes a stream writer — but the `node:http` route in `src/http.ts` is *not* the
   thing to deploy; a `Request`/`Response` wrapper is (kept out of scope on purpose, so the
   decision below can be made first).
3. **`worker_threads` for Gate 3.** Available in Vercel's Node runtime, but the CPU is not:
   a function gets 1-2 vCPU, while `resolveWorkers()` sizes the pool from
   `availableParallelism()`, which reports the *host's* cores. Left alone it will start ~8
   workers on 1 vCPU and 200 matches will take far longer than the budget — this is the
   single most likely way AC 5 fails on the deployed URL.
4. **`includeFiles` for the pool.** `src/fallback.ts` reads `fallback/round*/**.js` with
   `readdirSync` at module load. Vercel's bundler follows `import`s, not `readdirSync`, so
   without `functions: { "api/rewrite.ts": { includeFiles: "packages/server/fallback/**" } }`
   the function fails at boot — and the thing it fails to load is the safety net.
5. **A writable path for artifacts.** Only `/tmp` is writable, and it does not survive the
   invocation. `REMATCH_ARTIFACT_DIR=/tmp` keeps the writes harmless, but the AC 6 evidence
   then has to be collected from a local run or from the stdout log lines.
6. **The rate limiter is per-instance.** In-memory, so a caller spread across cold starts
   gets one bucket each. On Vercel the real protection is the platform's concurrency cap.

**Recommendation — split the deployment.** Put `packages/web`'s static bundle on Vercel
(which is what Vercel is good at, and satisfies "deployed URL" for AC 9) and run
`@rematch/server` as a **single always-on Node process** on Fly.io or Railway, with the
browser pointed at it by `VITE_API_BASE`. Reasons, in order of weight: Gate 3 is a CPU-bound
worker pool and a long-lived process with a real core count is the only place spec §6.2's 200
matches finish inside AC 5; the 45 s budget stops competing with a cold start; the rate
limiter and the artifact log both start working as designed; and the deployed path becomes
the same code the tests exercise. The CORS allow-list and `REMATCH_ORIGIN` exist for exactly
this shape.

**If it has to be all-Vercel**, it is survivable but degraded, and the degradation is
configuration rather than code: `maxDuration: 60`, `REMATCH_WORKERS=2`, `REMATCH_MATCHES=60`,
`REMATCH_ARTIFACT_DIR=/tmp`, `includeFiles` for the pool. 60 matches is a coarser Gate 3 —
the panel rate then moves in steps of ~0.03, so a strategy near a band edge becomes a coin
flip, and the honest framing for a jury is "fewer matches, same assertions". Note that this
weakens the *verifier*, which is the thing the project is arguing for, so it is a trade worth
making consciously rather than by default.
