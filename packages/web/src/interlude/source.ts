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
  /**
   * How long the caller will actually wait, ms. The server clamps its own loop to
   * `min(configured, budgetMs - 2 s)` (`clampToClientBudget`), so this is the number
   * that decides how many Coder attempts the run gets. Built in `interlude/index.ts`
   * from the adopted deadline — see `adoptDeadlineMs` — and always equal to it.
   */
  budgetMs?: number;
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

/** Timeout for the boot-time `/api/health` probe. Chosen so a dead server never makes the player wait — the fight starts on time either way. */
export const LOCAL_PROBE_TIMEOUT_MS = 1500;

/** Badge text for a reachable server that is honestly running fallback-only (no key, or `provider: 'none'`). */
export const LIVE_FALLBACK_BADGE = 'LIVE · fallback-only';

/**
 * What the boot-time probe decided.
 *
 * `useServer: true` means `/api/health` answered `ok: true` before the timeout —
 * `fallbackOnly` is set when it also reported no working provider (`hasApiKey:
 * false`, or `provider: 'none'`), in which case the server is still the more
 * truthful choice: it streams its own honest fallback-only path instead of the
 * mock's scripted one. `useServer: false` covers every other outcome — no
 * response, a timeout, a non-2xx, or a body that isn't `{ ok: true, ... }` — and
 * `reason` is the one line worth telling a developer about it.
 *
 * `deadlineMs` is the loop deadline the server *advertises* on `/api/health`
 * (`REMATCH_DEADLINE_MS`), carried here so the client can widen its own budget to
 * match instead of clamping a 90 s server down to 45 s — see `adoptDeadlineMs` in
 * `interlude/index.ts`. Absent when the server did not advertise a usable number,
 * which is every server older than this field and every non-probed row.
 */
export type LocalProbeOutcome =
  | { useServer: true; fallbackOnly: boolean; deadlineMs?: number }
  | { useServer: false; reason: string };

/**
 * The values `VITE_DEFAULT_AGENT` accepts. Anything else — including it being unset —
 * means "no build-time default", i.e. exactly the behaviour that existed before it.
 */
export type DefaultAgent = 'recorded' | 'mock' | 'sse';

/**
 * What the build baked in as the default source, when the URL does not say.
 *
 * The deployed product is a *static* site: there is no `/api/rewrite` behind it, so
 * the host-based rule below ("not local ⇒ SSE") would spend the first interlude
 * discovering a 404 and then quietly play the mock behind it. `recorded` says the
 * honest thing instead — real model output, badged `RECORDED RUN · <model> · <date>` —
 * and says it at build time, where the deploy shape is actually known.
 *
 * `sse` is not the same as leaving it unset: it means "decide the way you always
 * did" (base, host, boot probe), it does not force the server. Only `?agent=sse`
 * does that.
 */
function buildDefaultAgent(options: Pick<ResolveOptions, 'defaultAgent'>): DefaultAgent | null {
  // `import.meta.env` is typed as an index signature, hence the cast.
  const raw = options.defaultAgent ?? (import.meta.env.VITE_DEFAULT_AGENT as string | undefined);
  return raw === 'recorded' || raw === 'mock' || raw === 'sse' ? raw : null;
}

/** The four `?agent=` values that force a source; anything else is treated as absent. */
function forcedAgent(search: string): 'mock' | 'recorded' | 'sse' | 'server' | null {
  const agent = new URLSearchParams(search).get('agent');
  return agent === 'mock' || agent === 'recorded' || agent === 'sse' || agent === 'server' ? agent : null;
}

/**
 * Whether `resolveSource`, given these same options, would land on the "local host,
 * no explicit `?agent=`, no configured API base" row — the one row the boot probe
 * exists to fix (every other row already has an unambiguous answer: a forced
 * `?agent=`, a build default of `recorded`/`mock`, a configured base, or a non-local
 * host all decide the source with no probing needed). Kept as one function so the
 * probe and `resolveSource` can never disagree about which row applies.
 *
 * A build default of `sse` is *not* one of those answers: it means "decide as before",
 * which includes consulting the probe — so it leaves this row in place.
 */
function localDefaultApplies(options: Pick<ResolveOptions, 'search' | 'hostname' | 'apiBase' | 'defaultAgent'>): boolean {
  const search = options.search ?? (typeof location === 'undefined' ? '' : location.search);
  if (forcedAgent(search) !== null) return false;
  const def = buildDefaultAgent(options);
  if (def === 'mock' || def === 'recorded') return false;
  const hostname = options.hostname ?? (typeof location === 'undefined' ? 'localhost' : location.hostname);
  const envBase = options.apiBase ?? (import.meta.env.VITE_API_BASE as string | undefined);
  return envBase === undefined && LOCAL_HOSTS.has(hostname);
}

/**
 * `GET {base}/api/health`, capped at `timeoutMs`. Never throws: a network error, a
 * non-2xx, a body that is not `{ ok: true, ... }`, and the timeout all become
 * `{ useServer: false, reason }` rather than an exception — the caller's job is
 * always "pick a source", never "handle a probe failure".
 */
export async function probeHealth(
  base: string,
  fetchImpl: typeof fetch,
  timeoutMs: number = LOCAL_PROBE_TIMEOUT_MS,
): Promise<LocalProbeOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${base}/api/health`, { signal: controller.signal });
    if (!res.ok) return { useServer: false, reason: `/api/health answered ${res.status}` };
    const body = (await res.json().catch(() => null)) as
      | { ok?: unknown; hasApiKey?: unknown; provider?: unknown; deadlineMs?: unknown }
      | null;
    if (body === null || body.ok !== true) {
      return { useServer: false, reason: '/api/health did not report ok: true' };
    }
    const fallbackOnly = body.hasApiKey !== true || body.provider === 'none';
    // Anything that is not a positive finite number is treated as "not advertised":
    // the client's own default is the safe answer, and a server that answers
    // `deadlineMs: null` must not turn into a `NaN` budget on the wire.
    const advertised = body.deadlineMs;
    const deadlineMs =
      typeof advertised === 'number' && Number.isFinite(advertised) && advertised > 0
        ? Math.trunc(advertised)
        : undefined;
    return { useServer: true, fallbackOnly, ...(deadlineMs === undefined ? {} : { deadlineMs }) };
  } catch (err) {
    const why = controller.signal.aborted ? `no response within ${timeoutMs}ms` : (err as Error).message;
    return { useServer: false, reason: `could not reach /api/health: ${why}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run the boot-time probe exactly once, at app boot, and hand back its outcome for
 * `resolveSource` to consult later — the whole point being that a developer's `pnpm
 * dev` (which starts the API server too) reaches the *real* agents by default,
 * instead of the mock a bare `resolveSource` would otherwise pick.
 *
 * The caller (`interlude/index.ts`) starts this once when the handler is built —
 * before any round has been played — and awaits the same cached promise on every
 * later round, so the 1500 ms cap is paid at most once per page load and never as
 * part of a round transition.
 *
 * Returns `null` without probing when `localDefaultApplies` says `resolveSource`
 * would not consult it anyway (a forced `?agent=`, a configured base, or a
 * non-local host). Logs exactly one line when the decision comes out against the
 * server — that is the one moment a developer needs telling *why* they are looking
 * at the mock instead of the real agents.
 */
export async function bootProbeLocalServer(
  options: ResolveOptions = {},
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = LOCAL_PROBE_TIMEOUT_MS,
): Promise<LocalProbeOutcome | null> {
  if (!localDefaultApplies(options)) return null;
  const outcome = await probeHealth('', fetchImpl, timeoutMs);
  if (!outcome.useServer) {
    console.info(`[interlude] ${outcome.reason} — playing the mock (pass ?agent=sse to force the server)`);
  }
  return outcome;
}

export type ResolveOptions = {
  /** Defaults to `location.search`. */
  search?: string;
  /** Defaults to `location.hostname`. */
  hostname?: string;
  /** Defaults to `import.meta.env.VITE_API_BASE`. */
  apiBase?: string | undefined;
  /**
   * The build-time default source, used only when the URL carries no `?agent=`.
   * Defaults to `import.meta.env.VITE_DEFAULT_AGENT`; `'recorded' | 'mock' | 'sse'`
   * are read, anything else is ignored. See `buildDefaultAgent`.
   */
  defaultAgent?: string | undefined;
  /** Extra mock options; `speed` is overridden by `?speed=`. */
  mock?: MockOptions;
  /** Extra recorded options; `speed` is overridden by `?speed=`, `run` by `?run=`. */
  recorded?: RecordedOptions;
  /**
   * The boot probe's outcome (see `bootProbeLocalServer`), already settled. Only
   * consulted on the local, no-`?agent=`, no-`VITE_API_BASE` row; every other row
   * decides the source without it. `undefined`/`null` — the probe never ran, or
   * hasn't settled yet — is treated exactly like `{ useServer: false }`: the mock,
   * same as before this existed.
   */
  localProbe?: LocalProbeOutcome | null;
};

export type ResolvedSource = {
  source: InterludeSource;
  /** What the badge shows initially. `run` may report a switch to `mock`. */
  kind: SourceKind;
  /** Mock speed multiplier in effect (1 unless `?speed=` said otherwise). */
  speed: number;
  /** Badge override — set only for the reachable-but-fallback-only probe outcome. */
  note?: string;
};

/**
 * Pick a source from the URL and the build config.
 *
 * | Condition | Source |
 * |---|---|
 * | `?agent=mock` | mock, always |
 * | `?agent=recorded` | a recorded real run, `?run=<name>` or `index.json`'s first |
 * | `?agent=sse` / `?agent=server` | SSE, no mock safety net |
 * | no `?agent=`, `VITE_DEFAULT_AGENT=recorded` | that same recorded run — `?run=` still picks which |
 * | no `?agent=`, `VITE_DEFAULT_AGENT=mock` | mock |
 * | no `?agent=`, `VITE_DEFAULT_AGENT` unset / `sse` / anything else | the rows below decide |
 * | `VITE_API_BASE` is set | SSE at that base |
 * | hostname is not local | SSE at the same origin (the Vercel deploy) |
 * | local, no `?agent=`, no `VITE_API_BASE`, boot probe found `/api/health` ok | SSE at `''`, badge `LIVE` (or `LIVE · fallback-only` — see below) |
 * | local, no `?agent=`, no `VITE_API_BASE`, probe failed/timed out/never ran | mock |
 *
 * The URL always wins: `?agent=` is the demo's switch and a build default never
 * overrides it. Below it sits `VITE_DEFAULT_AGENT`, which exists because the deployed
 * product is a static site with no `/api/rewrite` behind it — the "not local ⇒ SSE"
 * row would otherwise spend the first interlude on a 404 and land on the mock, which
 * is real-looking output that no model produced. Building with `recorded` puts the
 * honest answer on the published site instead. A default of `sse` (or an unrecognised
 * value, or none) changes nothing: the host/base/probe rows below decide, exactly as
 * they did before this option existed.
 *
 * The last two rows are `localDefaultApplies`'s row — the one `pnpm dev` sits on,
 * since `pnpm dev` starts both Vite and the API server on 8787. Before this existed,
 * that row was unconditionally the mock, which meant a developer playing `pnpm dev`
 * watched a scripted interlude and never reached the real agents. Now
 * `bootProbeLocalServer` (called once, at app boot, well before any round ends)
 * decides it: reachable and `ok: true` means the real server, even when it reports
 * no working provider — `hasApiKey: false` or `provider: 'none'` — because the
 * server's own honest fallback-only stream is still more truthful than the mock's
 * scripted one; only a badge suffix (`LIVE · fallback-only`, via `ResolvedSource.note`)
 * tells the player which is happening. Anything else — unreachable, slow, a bad
 * body — is the mock, exactly as before, plus one console line saying why.
 *
 * Except when the URL asked for SSE explicitly, the SSE source is wrapped so that a
 * failure *before the first event* silently continues on the mock. That is what
 * makes `pnpm dev` with no server a working demo, and it is the one case where the
 * badge changes from `sse` to `mock` mid-run. The probed row gets the same
 * wrapping — the boot probe answers "was there a server a moment ago", not "is
 * there one right now", so the safety net still matters if it went away in between.
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
  // The build default is consulted only when the URL forced nothing — so `?agent=sse`
  // still beats `VITE_DEFAULT_AGENT=recorded`, same as every other `?agent=`.
  const fallbackAgent = forcedAgent(search) === null ? buildDefaultAgent(options) : null;

  if (agent === 'mock' || fallbackAgent === 'mock') return { source: mock, kind: 'mock', speed };

  if (agent === 'recorded' || fallbackAgent === 'recorded') {
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

  if (!wantsServer) {
    // `!wantsServer` is exactly `localDefaultApplies`'s row (agent unforced, no
    // envBase, local host) — see that function for why the two must never disagree.
    const probe = options.localProbe ?? null;
    if (probe !== null && probe.useServer) {
      const sse = sseSource('');
      return {
        source: withFallbackSource(sse, mock, onSwitch),
        kind: 'sse',
        speed,
        ...(probe.fallbackOnly ? { note: LIVE_FALLBACK_BADGE } : {}),
      };
    }
    return { source: mock, kind: 'mock', speed };
  }

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
