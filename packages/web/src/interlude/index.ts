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
 * 2. **The 45-second deadline** (spec AC 5). A client-side `AbortController`, not a
 *    promise race: aborting actually cancels the `fetch`, and the server's own 40 s
 *    loop deadline is the inner bound. When it fires, the fallback banner goes up
 *    and the round still starts — against a bundled strategy.
 * 3. **What the next round fights.** An approved `result.source` if there is one, a
 *    bundled strategy otherwise. `context.next()` is called exactly once, from
 *    whichever of FIGHT / auto-continue / skip happens first.
 */
import type { RoundWonContext, RoundWonHandler } from '../app.ts';
import { bundledSource } from '../game/strategy.ts';

import { serverFallbackPick, type RewriteEvent } from './events.ts';
import { resolveSource, type InterludeSource, type ResolveOptions, type SourceKind } from './source.ts';
import { createInterludeUi, type InterludeState, type InterludeUi } from './ui.ts';

export { fallbackText, SKIP_AFTER_MS, createInterludeUi, meterView, type InterludeState, type InterludeUi, type MeterView } from './ui.ts';
export { createSseParser, readEventStream, type SseFrame, type SseParser } from './sse.ts';
export { mockSource, buildMockScript, scriptDuration, APPROVED_META, type MockOptions, type MockScript, type MockStep } from './mock.ts';
export { resolveSource, sseSource, withFallbackSource, SourceUnavailableError, type InterludeSource, type RewriteRequest, type SourceKind } from './source.ts';
export { unifiedDiff } from './diff.ts';
export * from './events.ts';

/** Spec AC 5: all four beats in ≤ 45 s, or a visible fallback in ≤ 50 s. */
export const INTERLUDE_DEADLINE_MS = 45_000;

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
};

export type InterludeHandlerOptions = {
  /** Where the overlay mounts. Defaults to `document.body`. */
  host?: HTMLElement;
  /** Override source selection entirely (tests). */
  source?: InterludeSource;
  /** Passed to `resolveSource`. Defaults to reading `location`. */
  resolve?: ResolveOptions;
  /** Defaults to 45 000 (spec AC 5). */
  deadlineMs?: number;
  /**
   * 0 disables the post-`done` auto-continue. Defaults to `?autofight=` if the URL
   * says (the e2e suite passes `?autofight=0` so it can assert before the screen
   * goes away), else the UI's 3 s.
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
  return async function onRoundWon(context: RoundWonContext): Promise<void> {
    const host = options.host ?? document.body;
    const events: RewriteEvent[] = [];

    let ui: InterludeUi | null = null;
    const publish = (): void => {
      const snapshot = ui;
      options.onDebug?.(snapshot === null ? null : { events, state: snapshot.state() });
    };

    // The source is resolved before the UI so the badge is right from the first
    // frame; `onSwitch` fires later only for the "no server, fall back to mock" path.
    const resolved =
      options.source === undefined
        ? resolveSource(options.resolve, (kind, why) => {
            ui?.setKind(kind, why);
            publish();
          })
        : { source: options.source, kind: 'mock' as SourceKind, speed: options.resolve?.mock?.speed ?? 1 };

    // `?autofight=0` holds the finished interlude open. It is a test and demo
    // affordance, not a game setting: on stage the 3 s auto-continue is what keeps
    // the demo moving without anyone touching the keyboard.
    const search = options.resolve?.search ?? (typeof location === 'undefined' ? '' : location.search);
    const params = new URLSearchParams(search);
    const autofightParam = params.get('autofight');
    const autoFightMs =
      options.autoFightMs ??
      (autofightParam === null ? undefined : Math.max(0, Number(autofightParam) === 0 ? 0 : Number(autofightParam) * 1000));
    // `?deadline=<ms>` shortens the AC 5 deadline. The e2e suite uses it to prove
    // the fallback path for real rather than by stubbing the UI, and it is the only
    // way to see that path on a machine where everything works.
    const deadlineParam = Number(params.get('deadline'));

    const controller = new AbortController();
    /** Resolves when the player (or the auto-continue) has asked to move on. */
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let continued = false;

    /** The source of the next round's strategy, decided by the stream's ending. */
    let nextSource: string | null = null;

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
      void context.next(source ?? bundledSource(CLIENT_FALLBACK_STRATEGY));
    }

    ui = createInterludeUi({
      host,
      round: context.round,
      kind: resolved.kind,
      ...(autoFightMs === undefined || Number.isNaN(autoFightMs) ? {} : { autoFightMs }),
      onFight: () => goToNextRound(nextSource),
      onSkip: () => {
        // The 50 s safety valve: whatever the stream is doing, stop and fight.
        ui?.showFallback('deadline', 'skipped by the player');
        goToNextRound(null);
      },
    });
    publish();

    const deadlineMs =
      options.deadlineMs ??
      (Number.isFinite(deadlineParam) && deadlineParam > 0 ? deadlineParam : INTERLUDE_DEADLINE_MS);
    const deadline = window.setTimeout(() => {
      if (continued || nextSource !== null) return;
      controller.abort();
      // Spec AC 5's other half: a visible fallback, not a stalled screen.
      ui?.showFallback('deadline');
      ui?.finish();
      publish();
    }, deadlineMs);

    const request = {
      round: context.round + 1,
      summary: context.summary,
      prevSource: context.source,
      prevMeta: context.summary.strategy,
      seed: context.seed,
    };

    try {
      await resolved.source(
        request,
        (event) => {
          events.push(event);
          if (event.type === 'done') {
            if (event.result.approved) {
              nextSource = event.result.source;
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
