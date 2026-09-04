/**
 * Where interlude events come from — one function type, two implementations, and
 * the rule that picks between them.
 *
 * ```ts
 * type InterludeSource = (req, onEvent, signal) => Promise<void>;
 * ```
 *
 * That is the whole seam. The UI in `ui.ts` never learns which implementation it is
 * watching: it renders `RewriteEvent`s. Swapping the mock for the live server is one
 * line in `resolveSource`, which is the point — the interlude was built and demoed
 * against `mockSource` before the server existed, and the server did not change a
 * single line of the renderer.
 *
 * ## The wire contract (`POST /api/rewrite`)
 *
 * The server implements exactly this; it is duplicated in `README.md` for the
 * server's author.
 *
 * **Request** — `POST {base}/api/rewrite`, `content-type: application/json`:
 *
 * ```jsonc
 * {
 *   "round":      2,          // the round being WRITTEN (player just won round 1)
 *   "seed":       3221225473, // the round seed; makes a fallback pick reproducible
 *   "summary":    { ... },    // engine `ReplaySummary` of the round just won
 *   "prevSource": "export const meta = ...",  // the strategy that just lost
 *   "prevMeta":   { "name": "Cornerbreaker", "rationale": "...", "version": 1 }
 * }
 * ```
 *
 * **Response** — `200`, `content-type: text/event-stream`, one frame per
 * `RewriteEvent` (`events.ts`), in the order the loop emits them:
 *
 * ```
 * event: replay
 * data: {"type":"replay","summary":{...},"round":2}
 *
 * event: analysis.delta
 * data: {"type":"analysis.delta","delta":"Player camped the bottom-left corner."}
 *
 * ...
 * event: done
 * data: {"type":"done","result":{"approved":true,"source":"...","meta":{...}}}
 * ```
 *
 * - The `event:` name MUST equal the payload's `type`. The client reads `type` from
 *   the JSON and ignores the name; the name is there so `curl -N` is readable and so
 *   a proxy's logs mean something.
 * - `analysis.delta` is the Analyst's **prose**; the JSON block it ends with is
 *   withheld from the stream and arrives whole on `analysis.done.raw`.
 * - `rewrite.done` carries the attempt's own `meta`, parsed from its source, so the
 *   diff can be labelled with the boss's name before any gate has run.
 * - `trial.progress` is measured: `matchesDone: 0`, then one event per batch of
 *   finished matches, then the total. The meter renders those numbers directly.
 * - `data:` is one JSON object. Multi-line `data:` is parsed (the parser joins with
 *   `\n`) but is not required.
 * - The stream MUST end with a `done` frame, and `done` MUST be last. Everything the
 *   client needs to start the next round is in `result`.
 * - `fallback` MAY precede a `done` whose `result.approved` is `false`; that pair is
 *   spec AC 5's visible fallback.
 * - Comment frames (`: keep-alive\n\n`) are ignored and are the right way to keep a
 *   proxy from idling the connection out.
 * - A non-2xx response, a dropped connection or a body that is not an event stream
 *   is a client-side failure, handled here — never a hang.
 */
import type { StrategyMeta } from '@rematch/contract';
import type { ReplaySummary } from '@rematch/engine';

import { isRewriteEvent, type RewriteEvent } from './events.ts';
import { mockSource, type MockOptions } from './mock.ts';
import { recordedSource, type RecordedOptions } from './recorded.ts';
import { readEventStream } from './sse.ts';

/** The body of `POST /api/rewrite`. */
export type RewriteRequest = {
  /** The round being written — 2 after the player wins round 1. */
  round: number;
  /** The compressed replay: the Analyst's entire input (spec §8). */
  summary: ReplaySummary;
  /** The strategy that just lost. The Coder's starting point. */
  prevSource: string;
  /** Its `meta`, shown to the Analyst. */
  prevMeta: StrategyMeta;
  /** The round seed. Keeps a seeded fallback pick reproducible (spec AC 3). */
  seed: number;
};

export type InterludeSource = (
  req: RewriteRequest,
  onEvent: (event: RewriteEvent) => void,
  signal: AbortSignal,
) => Promise<void>;

/**
 * Which implementation is talking. Rendered as a badge, asserted in the e2e suite.
 *
 * | Kind | Badge | What the player is watching |
 * |---|---|---|
 * | `sse` | `LIVE` | the server, running the loop right now |
 * | `recorded` | `RECORDED RUN · <model> · <date>` | a real eval run, replayed from disk |
 * | `mock` | `MOCK` | the hand-scripted offline run |
 *
 * Three kinds rather than two because the demo has three honest answers and the badge
 * must give the right one. `recorded` is real model output that is not happening now;
 * conflating it with either neighbour would be a lie in one direction or the other.
 */
export type SourceKind = 'mock' | 'sse' | 'recorded';

/**
 * Thrown by `sseSource` when the request failed **before the first event**.
 *
 * The distinction matters. A stream that died mid-run has already told the player
 * things, so the honest ending is the fallback banner. A request that never started
 * means there is no server there at all — a plain `pnpm dev` — and the right answer
 * is to demo against the mock instead of showing an error to a jury. `resolveSource`
 * is the only thing that catches this.
 */
export class SourceUnavailableError extends Error {
  override readonly name = 'SourceUnavailableError';
  constructor(message: string) {
    super(message);
  }
}

// --------------------------------------------------------------------- SSE

/**
 * The live source: POST the request, parse the `text/event-stream` response.
 *
 * `EventSource` is not usable here — it is GET-only and cannot carry the summary —
 * so this is `fetch` + a hand-rolled frame parser (`sse.ts`). What that costs is
 * automatic reconnection, which is not wanted anyway: the loop is not idempotent, a
 * reconnect would restart four LLM calls, and the deadline in `app.ts` is the thing
 * that must decide when to stop.
 */
export function sseSource(baseUrl: string): InterludeSource {
  const base = baseUrl.replace(/\/$/, '');

  return async (req, onEvent, signal) => {
    let seen = 0;
    /** Once the player has been told something, the ending has to be visible. */
    const bail = (message: string): void => {
      if (seen === 0) throw new SourceUnavailableError(message);
      onEvent({ type: 'fallback', reason: 'error', message });
      onEvent({ type: 'done', result: { approved: false, attempts: [], reason: 'error', message } });
    };

    let response: Response;
    try {
      response = await fetch(`${base}/api/rewrite`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(req),
        signal,
      });
    } catch (err) {
      // An abort is the caller's decision; it is not a failure to report.
      if (signal.aborted) return;
      bail(`could not reach the rewrite service: ${(err as Error).message}`);
      return;
    }

    if (!response.ok) {
      // The body of an error is usually the only useful thing about it.
      const detail = await response.text().catch(() => '');
      const trimmed = detail.trim().slice(0, 200);
      bail(`the rewrite service answered ${response.status}${trimmed === '' ? '' : `: ${trimmed}`}`);
      return;
    }
    if (response.body === null) {
      bail('the rewrite service sent no body');
      return;
    }

    try {
      await readEventStream(
        response.body,
        (frame) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(frame.data);
          } catch {
            // One malformed frame must not end the run: the next one may be the
            // gate verdict the player is waiting for.
            return;
          }
          // An unknown `type` is a newer server; drop it rather than render a hole.
          if (!isRewriteEvent(parsed)) return;
          seen += 1;
          onEvent(parsed);
        },
        signal,
      );
    } catch (err) {
      if (signal.aborted) return;
      bail(`the rewrite stream broke: ${(err as Error).message}`);
      return;
    }

    if (signal.aborted) return;
    // A stream that ended without `done` would leave the UI waiting forever.
    if (seen === 0) throw new SourceUnavailableError('the rewrite service closed the stream immediately');
  };
}

// ---------------------------------------------------------------- selection

/** Hosts where "no server running" is the normal case, so the mock is the default. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '']);

export type ResolveOptions = {
  /** Defaults to `location.search`. */
  search?: string;
  /** Defaults to `location.hostname`. */
  hostname?: string;
  /** Defaults to `import.meta.env.VITE_API_BASE`. */
  apiBase?: string | undefined;
  /** Extra mock options; `speed` is overridden by `?speed=`. */
  mock?: MockOptions;
  /** Extra recorded options; `speed` is overridden by `?speed=`, `run` by `?run=`. */
  recorded?: RecordedOptions;
};

export type ResolvedSource = {
  source: InterludeSource;
  /** What the badge shows initially. `run` may report a switch to `mock`. */
  kind: SourceKind;
  /** Mock speed multiplier in effect (1 unless `?speed=` said otherwise). */
  speed: number;
};

/**
 * Pick a source from the URL and the build config.
 *
 * | Condition | Source |
 * |---|---|
 * | `?agent=mock` | mock, always |
 * | `?agent=recorded` | a recorded real run, `?run=<name>` or `index.json`'s first |
 * | `?agent=sse` / `?agent=server` | SSE, no mock safety net |
 * | `VITE_API_BASE` is set | SSE at that base |
 * | hostname is not local | SSE at the same origin (the Vercel deploy) |
 * | otherwise | mock |
 *
 * Except when the URL asked for SSE explicitly, the SSE source is wrapped so that a
 * failure *before the first event* silently continues on the mock. That is what
 * makes `pnpm dev` with no server a working demo, and it is the one case where the
 * badge changes from `sse` to `mock` mid-run.
 *
 * `recorded` gets **no** such safety net, deliberately: its asset is committed to this
 * repo, so a failure to load it is a broken build rather than a missing service, and
 * quietly playing the mock behind a badge that says `RECORDED RUN` would be the one
 * dishonest thing on screen.
 */
export function resolveSource(options: ResolveOptions = {}, onSwitch?: (kind: SourceKind, why: string) => void): ResolvedSource {
  const search = options.search ?? (typeof location === 'undefined' ? '' : location.search);
  const params = new URLSearchParams(search);
  const agent = params.get('agent');
  const speedParam = Number(params.get('speed'));
  const speed = Number.isFinite(speedParam) && speedParam > 0 ? speedParam : (options.mock?.speed ?? 1);
  const mock = mockSource({ ...options.mock, speed });

  if (agent === 'mock') return { source: mock, kind: 'mock', speed };

  if (agent === 'recorded') {
    // `?run=` names a file in `public/recorded/`; absent, the source reads
    // `index.json` and takes the first entry, so the demo URL stays short.
    const run = params.get('run');
    return {
      source: recordedSource(run, { ...options.recorded, speed }),
      kind: 'recorded',
      speed,
    };
  }

  const hostname = options.hostname ?? (typeof location === 'undefined' ? 'localhost' : location.hostname);
  // `import.meta.env` is typed as an index signature, hence the cast.
  const envBase = options.apiBase ?? (import.meta.env.VITE_API_BASE as string | undefined);
  const explicit = agent === 'sse' || agent === 'server';
  const wantsServer = explicit || envBase !== undefined || !LOCAL_HOSTS.has(hostname);

  if (!wantsServer) return { source: mock, kind: 'mock', speed };

  const sse = sseSource(envBase ?? '');
  if (explicit) return { source: sse, kind: 'sse', speed };
  return { source: withFallbackSource(sse, mock, onSwitch), kind: 'sse', speed };
}

/**
 * Run `primary`; if it reports it never started, run `secondary` instead.
 *
 * Only `SourceUnavailableError` triggers the switch — a mid-stream failure has
 * already been turned into `fallback` + `done` by the primary, and replaying a mock
 * on top of that would show the player a second, contradictory ending.
 */
export function withFallbackSource(
  primary: InterludeSource,
  secondary: InterludeSource,
  onSwitch?: (kind: SourceKind, why: string) => void,
): InterludeSource {
  return async (req, onEvent, signal) => {
    try {
      await primary(req, onEvent, signal);
      return;
    } catch (err) {
      if (signal.aborted) return;
      if (!(err instanceof SourceUnavailableError)) throw err;
      onSwitch?.('mock', err.message);
    }
    await secondary(req, onEvent, signal);
  };
}
