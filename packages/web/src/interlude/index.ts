/**
 * `interlude/` — the round-won handler, assembled.
 *
 * ```
 * app.ts                 createApp({ onRoundWon: createInterludeHandler(...) })
 *   └─ index.ts          request  ──▶  source  ──▶  events  ──▶  ui  ──▶  next(source)
 *        ├─ source.ts    mockSource | sseSource        (the one-line swap)
 *        ├─ events.ts    the event union, copied from `@rematch/agents`
 *        ├─ ui.ts        the four beats, as DOM
 *        └─ replayViz.ts beat 1's canvases
 * ```
 *
 * This file owns the three things that are neither transport nor presentation:
 *
 * 1. **The request.** Everything the Analyst and Coder are allowed to see, and
 *    nothing else (spec §8): the compressed replay, the round being written, the
 *    strategy that just lost and its `meta`, plus the round seed so a fallback pick
 *    is reproducible. No engine internals, no input log, no renderer state.
 * 2. **The deadline** — 45 s by default (spec AC 5), raised to what a locally probed
 *    server advertises when that is larger (`adoptDeadlineMs`, spec §13 delta 25). A
 *    client-side `AbortController`, not a promise race: aborting actually cancels the
 *    `fetch`, and the same number rides the request as `budgetMs` so the server's loop
 *    is bounded by it rather than disagreeing with it. When it fires, the fallback
 *    banner goes up and the round still starts — against a bundled strategy.
 * 3. **What the next round fights.** An approved `result.source` if there is one, a
 *    bundled strategy otherwise. `context.next()` is called exactly once, from
 *    whichever of FIGHT / auto-continue / skip happens first.
 */
import type { RoundWonContext, RoundWonHandler } from '../app.ts';
import { bundledSource } from '../game/strategy.ts';

import { serverFallbackPick, type RewriteEvent } from './events.ts';
import { knownIssueLabel, provenanceLabel } from './recorded.ts';
import { bootProbeLocalServer, resolveSource, type InterludeSource, type LocalProbeOutcome, type ResolveOptions, type RewriteRequest, type SourceKind } from './source.ts';
import { createInterludeUi, INTERLUDE_DEADLINE_MS, type InterludeState, type InterludeUi } from './ui.ts';

export { fallbackText, SKIP_AFTER_MS, INTERLUDE_DEADLINE_MS, clockView, createInterludeUi, meterView, type InterludeState, type InterludeUi, type MeterView } from './ui.ts';
export {
  INITIAL_CAST,
  castStatus,
  fallbackHeadline,
  plainVerdict,
  reduceCast,
  type AgentSlot,
  type CastState,
  type CastVerdict,
} from './castStatus.ts';
export { createSseParser, readEventStream, type SseFrame, type SseParser } from './sse.ts';
export { mockSource, buildMockScript, scriptDuration, APPROVED_META, type MockOptions, type MockScript, type MockStep } from './mock.ts';
export {
  RECORDED_PATH,
  delaysOf,
  loadRecordedIndex,
  knownIssueLabel,
  provenanceLabel,
  recordedSource,
  type RecordedFile,
  type RecordedHeader,
  type RecordedIndex,
  type RecordedIndexEntry,
  type RecordedOptions,
} from './recorded.ts';
export {
  resolveSource,
  sseSource,
  withFallbackSource,
  bootProbeLocalServer,
  probeHealth,
  SourceUnavailableError,
  LOCAL_PROBE_TIMEOUT_MS,
  LIVE_FALLBACK_BADGE,
  type InterludeSource,
  type RewriteRequest,
  type SourceKind,
  type LocalProbeOutcome,
} from './source.ts';
export { unifiedDiff } from './diff.ts';
export * from './events.ts';

/**
 * The ceiling on a deadline adopted from a server's `/api/health`.
 *
 * The advertised number is configuration on the developer's own machine, not input
 * from a stranger, so the cap is not a security boundary — it is a guard against a
 * typo (`REMATCH_DEADLINE_MS=900000`) turning a round transition into a fifteen-minute
 * stare at a progress meter with no way back except the skip button.
 */
export const MAX_ADOPTED_DEADLINE_MS = 180_000;

/**
 * How long this round's interlude may take, in ms.
 *
 * | Input | Wins because |
 * |---|---|
 * | `explicitMs` — `options.deadlineMs` or `?deadline=<ms>` | a human asked for exactly this number; the e2e suite proves AC 5's fallback path with it |
 * | `advertisedMs` — `/api/health`'s `deadlineMs`, when **larger** than the default | the server in front of us really does have that long, and clamping it to 45 s buys one Coder attempt and a guaranteed fallback |
 * | `INTERLUDE_DEADLINE_MS` (45 s) | spec AC 5, and the deployed site: no probe, nothing advertised, nothing changes |
 *
 * An advertised value at or below the default is **ignored**, deliberately: AC 5's
 * 45 s is the promise the product makes, and a server configured lower has its own
 * clamp (`clampToClientBudget`) to keep it from outliving the client. So this only
 * ever moves the number up, and only when a probe supplied one.
 */
export function adoptDeadlineMs(explicitMs: number | undefined, advertisedMs: number | undefined): number {
  if (explicitMs !== undefined && Number.isFinite(explicitMs) && explicitMs > 0) return Math.trunc(explicitMs);
  if (advertisedMs !== undefined && Number.isFinite(advertisedMs) && advertisedMs > INTERLUDE_DEADLINE_MS) {
    return Math.min(Math.trunc(advertisedMs), MAX_ADOPTED_DEADLINE_MS);
  }
  return INTERLUDE_DEADLINE_MS;
}

/**
 * The request, built from the round that was just won and the budget it gets.
 *
 * Separate from the handler, and pure, because `budgetMs` **must** equal the adopted
 * deadline: the server clamps its loop to it (`clampToClientBudget`), so any drift
 * between the two numbers is the exact bug spec §13 delta 21 exists for. One
 * construction site, one assertion in `test/interlude-deadline.test.ts`.
 */
export function interludeRequest(
  context: Pick<RoundWonContext, 'round' | 'summary' | 'source' | 'seed'>,
  deadlineMs: number,
): RewriteRequest {
  return {
    round: context.round + 1,
    summary: context.summary,
    prevSource: context.source,
    prevMeta: context.summary.strategy,
    seed: context.seed,
    // Tell the server how long we will actually wait, so it cannot outlive us.
    // Before this, a server configured with a larger `REMATCH_DEADLINE_MS` kept
    // working after `controller.abort()` fired: the run ended with no `fallback`
    // event, no `done`, and no artifact — see `clampToClientBudget` in
    // `packages/server/src/handleRewrite.ts` for the playtest that found it.
    budgetMs: Math.trunc(deadlineMs),
  };
}

/**
 * The strategy the next round fights when nothing was approved **and** the server did
 * not send a pool pick.
 *
 * The real fallback pool is the server's (`packages/server/fallback/`, ≥ 2 per round,
 * all four gates passed at their round's band), and it arrives attached to a
 * non-approved `done` as `result.fallback` — preferred whenever it is there, because
 * a pool entry is balance-tested for *that* round and `hound` is not.
 *
 * The browser cannot reach the pool when the *reason* for falling back is that the
 * server is unreachable, or when the client's own 45 s deadline fired before any
 * verdict. For those two cases the client keeps its own last resort: `hound`, the
 * bundled strategy that is not Round 1's, so a fallback still visibly changes the
 * fight. Named here rather than inline because it is the one strategy choice the
 * client makes entirely on its own.
 */
export const CLIENT_FALLBACK_STRATEGY = 'hound';

/** What `window.__rematch.interlude` exposes. */
export type InterludeDebug = {
  /** Every event received, in order. */
  events: RewriteEvent[];
  state: InterludeState;
  /**
   * Which source this round is actually playing — `'sse'`, `'mock'`, or
   * `'recorded'`. On the local, no-`?agent=`, no-`VITE_API_BASE` default this is
   * the boot probe's decision (see `bootProbeLocalServer`), not a hardcoded guess,
   * which is what this field exists to let a test assert directly rather than by
   * reading the badge's rendered text.
   */
  sourceKind: SourceKind;
};

export type InterludeHandlerOptions = {
  /** Where the overlay mounts. Defaults to `document.body`. */
  host?: HTMLElement;
  /** Override source selection entirely (tests). */
  source?: InterludeSource;
  /** Passed to `resolveSource`. Defaults to reading `location`. */
  resolve?: ResolveOptions;
  /**
   * Force this round's deadline, ms. Wins over `?deadline=` and over anything a
   * probed server advertises. Absent, the number is `adoptDeadlineMs`'s: 45 000
   * (spec AC 5) unless a locally probed server advertised more.
   */
  deadlineMs?: number;
  /**
   * `0` disables the post-`done` auto-continue — the default for real play, so a
   * human always gets the FIGHT button rather than the screen moving on by itself.
   * Defaults to `?autofight=<seconds>` if the URL says so (every automated flow —
   * this suite's own specs, the mock/recorded e2e paths — opts back in that way).
   */
  autoFightMs?: number;
  /** Called whenever the debug snapshot changes, so `app.ts` can publish it. */
  onDebug?: (debug: InterludeDebug | null) => void;
};

/**
 * Build the `onRoundWon` handler.
 *
 * The returned promise resolves when the interlude is over and the next round has
 * been started, which is what `app.ts`'s `await handler(context)` wants: nothing
 * else in the client may run while the interlude owns the screen.
 */
export function createInterludeHandler(options: InterludeHandlerOptions = {}): RoundWonHandler {
  // Started once, here, when the handler is built — at app boot, well before the
  // player has finished (or even started) Round 1. `bootProbeLocalServer` caps
  // itself at `LOCAL_PROBE_TIMEOUT_MS`, but paying that cap happens now, off the
  // critical path, rather than as part of the first round transition. Every round
  // this handler ever plays awaits the same cached promise — one probe per page
  // load, not one per round.
  const localProbePromise: Promise<LocalProbeOutcome | null> =
    options.source === undefined ? bootProbeLocalServer(options.resolve ?? {}) : Promise.resolve(null);

  return async function onRoundWon(context: RoundWonContext): Promise<void> {
    const host = options.host ?? document.body;
    const events: RewriteEvent[] = [];

    let ui: InterludeUi | null = null;
    let resolvedKind: SourceKind = 'mock';
    const publish = (): void => {
      const snapshot = ui;
      options.onDebug?.(snapshot === null ? null : { events, state: snapshot.state(), sourceKind: resolvedKind });
    };

    // Already settled in every real case: the probe was kicked off at app boot and
    // is capped at 1.5 s, and a round takes far longer than that to play out.
    const localProbe = await localProbePromise;

    // The source is resolved before the UI so the badge is right from the first
    // frame; `onSwitch` fires later only for the "no server, fall back to mock" path.
    const resolved =
      options.source === undefined
        ? resolveSource(
            {
              ...options.resolve,
              localProbe,
              // A recorded run only learns its model and date when the file lands, so
              // the badge is completed out of band rather than from an event. See
              // `recorded.ts`: the claim on screen has to name the run it is playing.
              recorded: {
                ...options.resolve?.recorded,
                onHeader: (header) => {
                  // The badge names the run; the note discloses what is wrong with
                  // it. The three committed recordings predate Gate 3's ACTIVE
                  // assertion, so their bosses freeze — see `recorded.ts`.
                  ui?.setProvenance(provenanceLabel(header), knownIssueLabel(header));
                  publish();
                },
              },
            },
            (kind, why) => {
              ui?.setKind(kind, why);
              resolvedKind = kind;
              publish();
            },
          )
        : { source: options.source, kind: 'mock' as SourceKind, speed: options.resolve?.mock?.speed ?? 1 };
    resolvedKind = resolved.kind;

    // Manual by default: a human player gets FIGHT and nothing else, always — a
    // playtest ("ele já foi pro próximo round sozinho") found the 3 s auto-continue
    // moving on before the player had read the verdict, let alone the boss's new
    // name. `?autofight=<seconds>` opts back into the old auto-continue (`0`
    // explicitly disables it, same as the default) for the flows that want it: the
    // mock/recorded e2e paths and this suite's own specs, which all already pass
    // it. `?autostart=1` alone does *not* imply auto-continue any more — the two
    // params are independent, and nothing in this codebase's automated flows was
    // relying on the old implicit default (every one of them already sets
    // `autofight` explicitly).
    const search = options.resolve?.search ?? (typeof location === 'undefined' ? '' : location.search);
    const params = new URLSearchParams(search);
    const autofightParam = params.get('autofight');
    const autoFightMs =
      options.autoFightMs ??
      (autofightParam === null ? 0 : Math.max(0, Number(autofightParam) === 0 ? 0 : Number(autofightParam) * 1000));
    // `?deadline=<ms>` sets the AC 5 deadline outright. The e2e suite uses it to
    // shorten the run and prove the fallback path for real rather than by stubbing
    // the UI, and it is the only way to see that path on a machine where everything
    // works. It beats the server's advertised number in both directions.
    const deadlineParam = Number(params.get('deadline'));
    // What the boot probe read off `/api/health`, if it probed at all. Only the
    // local, no-`?agent=`, no-`VITE_API_BASE` row ever has one — the deployed site,
    // the recorded/mock paths and a configured `VITE_API_BASE` all leave this
    // `undefined` and keep AC 5's 45 s exactly as it was.
    const advertisedDeadlineMs = localProbe !== null && localProbe.useServer ? localProbe.deadlineMs : undefined;
    const deadlineMs = adoptDeadlineMs(
      options.deadlineMs ?? (Number.isFinite(deadlineParam) && deadlineParam > 0 ? deadlineParam : undefined),
      advertisedDeadlineMs,
    );

    const controller = new AbortController();
    /** Resolves when the player (or the auto-continue) has asked to move on. */
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let continued = false;

    /** The source of the next round's strategy, decided by the stream's ending. */
    let nextSource: string | null = null;
    /**
     * Where that source came from, for the HUD's chip during the next fight
     * (`app.ts`, `StrategyProvenance`). Starts as `fallback` because every ending
     * except an approval is one: a stream that dies, a deadline, an exhausted
     * attempt budget and a client last resort all ship a strategy nobody approved
     * this session, and the fight must not imply otherwise.
     */
    let nextProvenance: 'approved' | 'fallback' = 'fallback';

    function goToNextRound(source: string | null): void {
      if (continued) return;
      continued = true;
      controller.abort();
      ui?.dispose();
      ui = null;
      options.onDebug?.(null);
      release();
      // `next` re-enters `app.ts`, which tears the round down and builds the next
      // one; it must not run while this overlay is still in the document.
      void context.next(
        source ?? bundledSource(CLIENT_FALLBACK_STRATEGY),
        source === null ? 'fallback' : nextProvenance,
      );
    }

    ui = createInterludeUi({
      host,
      round: context.round,
      kind: resolved.kind,
      // Set only for the boot probe's "reachable, but no working provider" outcome
      // (spec: still SSE, badge says so) — every other path keeps `KIND_LABEL`'s default.
      ...(resolved.note === undefined ? {} : { provenance: resolved.note }),
      // The clock's `over` state keys off the round's real budget, not the constant:
      // at a 90 s adopted deadline the number must not turn red at 45 s.
      deadlineMs,
      // `autoFightMs` is always a number by construction above; the guard is only
      // for a malformed `?autofight=` value (`Number('x') * 1000` is `NaN`), which
      // falls back to `createInterludeUi`'s own default rather than passing `NaN`
      // through as a real timeout.
      ...(Number.isNaN(autoFightMs) ? {} : { autoFightMs }),
      onFight: () => goToNextRound(nextSource),
      onSkip: () => {
        // The 50 s safety valve: whatever the stream is doing, stop and fight.
        ui?.showFallback('deadline', 'skipped by the player');
        goToNextRound(null);
      },
    });
    publish();

    const deadline = window.setTimeout(() => {
      if (continued || nextSource !== null) return;
      controller.abort();
      // Spec AC 5's other half: a visible fallback, not a stalled screen.
      ui?.showFallback('deadline');
      ui?.finish();
      publish();
    }, deadlineMs);

    const request: RewriteRequest = interludeRequest(context, deadlineMs);

    try {
      await resolved.source(
        request,
        (event) => {
          events.push(event);
          if (event.type === 'done') {
            if (event.result.approved) {
              nextSource = event.result.source;
              nextProvenance = 'approved';
            } else {
              // Prefer the server's pool pick over the client's bundled last resort.
              const pick = serverFallbackPick(event.result);
              if (pick !== null) nextSource = pick.source;
              ui?.handle(event);
              // Re-render the banner so it names the strategy that is actually
              // shipping: "a pre-approved strategy" is the promise, and the player
              // should be able to see which one kept it.
              if (pick !== null) ui?.showFallback(event.result.reason, `shipping ${pick.name}`);
              publish();
              return;
            }
          }
          ui?.handle(event);
          publish();
        },
        controller.signal,
      );
      // A source that returned without ever emitting `done` (an abort, or a server
      // that hung up cleanly) must still end the screen.
      if (!continued && !controller.signal.aborted && events.at(-1)?.type !== 'done') {
        ui?.showFallback('error', 'the rewrite stream ended without a verdict');
        ui?.finish();
        publish();
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        ui?.showFallback('error', (err as Error).message);
        ui?.finish();
        publish();
      }
    } finally {
      window.clearTimeout(deadline);
    }

    await released;
  };
}
