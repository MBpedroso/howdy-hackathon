/**
 * The app: five rounds, one canvas, one sandbox.
 *
 * Flow — Start (the intro: the cast, one round explained, the controls) -> fight
 * -> outcome:
 *   won  and round < 5  ->  `onRoundWon(context)`  ->  `context.next()`  ->  round + 1
 *   won  and round = 5  ->  the win screen
 *   lost or timed out   ->  the game-over screen, naming the strategy that beat you
 *
 * `onRoundWon` is the interlude's seam (spec §2.2), and the interlude now sits in it:
 * `createInterludeHandler` (see `src/interlude/`) receives the same `ReplaySummary`
 * the Analyst agent is shown, plays the four beats from a stream of `RewriteEvent`s,
 * and calls the same `next(source)` with whatever the harness approved. Round 2+
 * differs from Round 1 in one respect only: `nextSource` comes from the stream
 * instead of from the bundle.
 *
 * The pre-interlude "Round N cleared" screen is still here, reachable with
 * `?interlude=0`. It is not dead code kept for sentiment: it is how the round-won
 * *outcome path* is tested without a 25-second overlay in the way (see
 * `e2e/controls.spec.ts`), and it is the screen to fall back to if the interlude
 * itself ever fails to construct.
 *
 * Nothing else in the client knows a round can end.
 */
import { CONSTANTS } from '@rematch/contract';
import { ENGINE_CONSTANTS, type GameState, type InputLog, type ReplaySummary } from '@rematch/engine';

import { createInputSource, type AimContext, type InputSource } from './game/input.ts';
import { createLoop, logInputProvider, type Loop } from './game/loop.ts';
import { createRound, type Round } from './game/round.ts';
import type { RunnerStats } from './game/runnerStats.ts';
import { formatSeed, resolveSessionSeed, roundSeed } from './game/seeds.ts';
import { bundledSource, sandboxFactory, SandboxLoadError } from './game/strategy.ts';
import { createInterludeHandler, type InterludeDebug } from './interlude/index.ts';
import { habitCellsFromSummary } from './render/habitCells.ts';
import { createRenderer, type Renderer } from './render/renderer.ts';
import { createHabitCaption, type HabitCaption } from './ui/habitCaption.ts';
import { createHud, debugFooterEnabled, type Hud } from './ui/hud.ts';
import { introDecision, readFighter, readSkipIntro, writeFighter, writeSkipIntro } from './ui/intro.ts';
import { createRoundBanner, type RoundBanner } from './ui/roundBannerView.ts';
import { createScreens, type Screens } from './ui/screens.ts';

/** Spec §2.1: up to Round 5, then the win screen. */
export const MAX_ROUNDS = 5;

const ARENA = CONSTANTS.arena.w;

/** What a round-won handler is given. Everything the interlude needs, nothing more. */
export type RoundWonContext = {
  round: number;
  /** The compressed replay: the Analyst agent's entire input (spec §8). */
  summary: ReplaySummary;
  /** Equality witness for the round — same seed + inputs + strategy => same hash. */
  hash: string;
  seed: number;
  /** The strategy source that was just beaten. The Coder agent's starting point. */
  source: string;
  /** True when this was the last round; the win screen follows instead of a fight. */
  isFinal: boolean;
  /**
   * Start the next round. `source` overrides the strategy — that is how a generated,
   * harness-approved `strategy.js` gets into the fight.
   */
  /**
   * Start the next round. `provenance` says where the strategy came from and is
   * cosmetic-but-honest: a boss the harness approved and a boss taken from the
   * pre-approved pool are indistinguishable in the fight otherwise, and the whole
   * claim of the product is that the one you are fighting was written for you.
   */
  next(source?: string, provenance?: StrategyProvenance): Promise<void>;
};

export type RoundWonHandler = (context: RoundWonContext) => void | Promise<void>;

/**
 * Where the round's strategy came from.
 *
 *  - `bundled` — the file that ships with the client. Round 1, always.
 *  - `approved` — a model wrote it this session and the harness passed it.
 *  - `fallback` — nothing was approved, so the pre-approved pool supplied one.
 *
 * The distinction is the difference between "the boss learned" and "the boss was
 * replaced by one that already existed", and the fight has to be able to say which.
 */
export type StrategyProvenance = 'bundled' | 'approved' | 'fallback';

export type AppOptions = {
  canvas: HTMLCanvasElement;
  hud: HTMLElement;
  screen: HTMLElement;
  /** Defaults to `location.search`. */
  search?: string;
  /**
   * Defaults to the interlude (spec §2.2), or to the "Round N cleared" screen when
   * the URL says `?interlude=0`. Supplying one overrides both.
   */
  onRoundWon?: RoundWonHandler;
};

export type App = {
  /** Warm the sandbox and show the start screen (or start immediately). */
  boot(): Promise<void>;
  /** Everything `window.__rematch` exposes. See `main.ts`. */
  readonly debug: DebugApi;
};

/** The debug/e2e surface. Deliberately small and stable — Playwright depends on it. */
export type DebugApi = {
  readonly state: GameState | null;
  readonly inputLog: InputLog | null;
  readonly seed: number | null;
  readonly sessionSeed: number;
  readonly round: number;
  readonly screen: string | null;
  readonly ready: boolean;
  /**
   * The live interlude, or `null` when none is on screen. Spec §2.2 is the one part
   * of the product that cannot be asserted from the game state, so the e2e suite
   * reads the events it received and the state it derived from them.
   */
  readonly interlude: InterludeDebug | null;
  hash(): string | null;
  summary(): ReplaySummary | null;
  stats(): ReturnType<Loop['stats']> | null;
  /**
   * This round's `decide` counters — calls, failures by kind, the worst consecutive
   * failure streak, and the elapsed-time quantiles. The same numbers the HUD's
   * diagnostics line shows; the regression test for "the boss stood still" reads them.
   */
  runnerStats(): RunnerStats | null;
  /** Start a round directly, bypassing the screens. */
  startRound(index: number, source?: string): Promise<void>;
  /**
   * Replay a recorded input log: restarts the current round from tick 0 with the same
   * seed and strategy, swaps the live input for the log, and switches the sandbox to
   * the deterministic clock (see `strategy.ts`). This is the AC 3 hook.
   */
  driveWith(log: InputLog): Promise<void>;
  /** Run queued ticks synchronously, no rAF. Returns the number of ticks run. */
  fastForward(maxTicks?: number): number;
  renderFrame(): void;
};

export function createApp(options: AppOptions): App {
  const search = options.search ?? window.location.search;
  const params = new URLSearchParams(search);
  const sessionSeed = resolveSessionSeed(search);
  const strategyParam = params.get('strategy');
  // `?autostart=1` still means "no screens, just fight" — the e2e suite depends on
  // it. The rest of the decision (the remembered "skip intro" box, `?intro=`) is in
  // `ui/intro.ts`, as a pure function with its own tests.
  const intro = introDecision({ search, remembered: readSkipIntro() });
  const startAt = Math.min(MAX_ROUNDS, Math.max(1, Number(params.get('round') ?? 1) || 1));
  // `?interlude=0` keeps the pre-interlude round-won screen. See the header.
  const interludeEnabled = params.get('interlude') !== '0';

  const renderer: Renderer = createRenderer(options.canvas);
  /**
   * The costumes, handed straight to the renderer. They go nowhere else:
   * `startRound` and the engine never learn them, which is what keeps the replay
   * hash and every recorded run valid across this feature (`ui/fighters.ts`).
   *
   * Held here rather than re-read from storage after each pick, because a write can
   * fail — a tab with site data blocked throws on every access — and a pick that
   * silently snapped back to the default would look like a broken button.
   */
  const fighters = { player: readFighter('player'), boss: readFighter('boss') };
  renderer.setFighters(fighters);
  const hud: Hud = createHud(options.hud, { debugFooter: debugFooterEnabled(search) });
  // Both mount into the HUD root, appended after `createHud`'s own `replaceChildren`
  // so neither is wiped by it. Both are cosmetic-only entrances over an existing
  // readout — the banner over `hud-strategy`, the caption over the boss's own
  // telegraph — and neither ever reaches `GameState` or a strategy's view.
  const banner: RoundBanner = createRoundBanner(options.hud);
  const habitCaption: HabitCaption = createHabitCaption(options.hud);
  const screens: Screens = createScreens(options.screen);
  const input: InputSource = createInputSource({ canvas: options.canvas, arenaSize: ARENA });

  let round: Round | null = null;
  let loop: Loop | null = null;
  /** Where the round on screen got its strategy. See `StrategyProvenance`. */
  let roundProvenance: StrategyProvenance = 'bundled';
  let booted = false;
  /** Published through `debug.interlude` while an interlude is on screen. */
  let interludeDebug: InterludeDebug | null = null;
  /**
   * The banner's own `requestAnimationFrame` ticker, live only while the pre-fight
   * interstitial is holding (`banner.isHolding()`) — the sim is not stepping yet,
   * so nothing else is driving a frame loop that could advance it. Tracked so
   * `teardown()` can cancel a stale one: without this, tearing a round down mid-hold
   * (a retry, `driveWith`, a fast window-close-reopen) would leave a callback
   * pointing at a `banner`/`loop` that a *later* round now owns, and it would call
   * that later round's `loop.start()` on a delay nobody asked for.
   */
  let holdTicker: number | null = null;

  function cancelHoldTicker(): void {
    if (holdTicker !== null) {
      cancelAnimationFrame(holdTicker);
      holdTicker = null;
    }
  }

  /**
   * Drives the banner's `update()` while the round it belongs to has not started
   * stepping — see `roundBanner.ts`'s module doc for why this is wall-clock rather
   * than tick-based. Ends by calling `loop.start()` itself: that is the one and
   * only place a held round's first tick gets scheduled.
   */
  function runHoldTicker(): void {
    const step = (): void => {
      holdTicker = null;
      banner.update(performance.now());
      if (banner.isHolding()) {
        holdTicker = requestAnimationFrame(step);
        return;
      }
      loop?.start();
    };
    holdTicker = requestAnimationFrame(step);
  }

  function fitStage(): void {
    const viewport = renderer.resize();
    const stage = options.canvas.parentElement;
    if (stage !== null) {
      stage.style.width = `${viewport.cssSize}px`;
      stage.style.height = `${viewport.cssSize}px`;
    }
    if (round !== null) renderer.draw(round.state);
  }
  window.addEventListener('resize', fitStage);
  fitStage();

  function aimContext(current: Round): AimContext {
    // Before the mouse has moved, aim at the boss: the first shot must go somewhere
    // deliberate, and the engine must never receive a zero-length aim vector.
    return {
      player: { x: current.state.player.x, y: current.state.player.y },
      fallback: { x: current.state.boss.x, y: current.state.boss.y },
    };
  }

  function render(current: Round): void {
    renderer.draw(current.state);

    // The "YOUR HABIT" caption stays one drawn frame behind the highlight it
    // labels by construction — both read off the same `draw()` call.
    const habit = renderer.activeHabitHighlight();
    if (habit === null) habitCaption.hide();
    else habitCaption.show(habit.x, habit.y, renderer.viewport().cssSize, ARENA);
    // A no-op once the pre-fight interstitial has closed (`banner`'s own state is
    // `hidden` for the rest of the round) — see `runHoldTicker` for who drives this
    // call while the round has not started stepping yet.
    banner.update(performance.now());

    const stats = loop?.stats();
    hud.update(current.state, {
      round: current.index,
      maxRounds: MAX_ROUNDS,
      sessionSeed,
      roundSeed: current.seed,
      tickMs: stats?.avgTickMs ?? 0,
      renderMs: stats?.avgRenderMs ?? 0,
      runner: current.runnerStats(),
      provenance: roundProvenance,
    });
  }

  function teardown(): void {
    cancelHoldTicker();
    loop?.dispose();
    loop = null;
    round?.dispose();
    round = null;
  }

  async function startRound(
    index: number,
    source?: string,
    deterministic = false,
    provenance: StrategyProvenance = 'bundled',
    /**
     * The just-finished round's `ReplaySummary` — the same object `context.summary`
     * hands the interlude for the rewrite request — so this round's habit-cell
     * highlight (`render/habitCells.ts`) knows where the player used to live.
     * `null` for round 1 and for every retry (`onRetry` below omits it on purpose):
     * a retry replays the fight the player just lost, not a new one the loop wrote
     * off a fresh replay, so "it knows your ground" has nothing new to show.
     */
    prevSummary: ReplaySummary | null = null,
    /**
     * Whether *this* round transition is the moment to open the pre-fight "it
     * learned" interstitial (`ui/roundBanner.ts`). `false` for round 1, a retry,
     * `driveWith` and the debug hook — a retry in particular replays the fight the
     * player just lost against the boss they already met, so re-opening the
     * interstitial every time they die would be the annoying-friction version of
     * the same bug `prevSummary` already avoids for the habit-cell highlight, not
     * a repeat of the reveal. Only the interlude's own `next()` (below) passes
     * `true`, and only when the strategy it is handing off really is one the loop
     * wrote (`banner.start` still re-checks `provenance === 'approved'` itself).
     */
    showLearnedBanner = false,
  ): Promise<void> {
    teardown();
    input.clear();
    renderer.reset();
    hud.reset();
    banner.reset();
    habitCaption.hide();
    screens.loading(index === 1 ? 'Loading the boss' : `Round ${index}`);

    const seed = roundSeed(sessionSeed, index);
    const text = source ?? bundledSource(strategyParam);
    // A round with no supplied source is the bundled file whatever the caller said.
    roundProvenance = source === undefined ? 'bundled' : provenance;

    try {
      round = await createRound({ index, seed, source: text, deterministic });
    } catch (err) {
      const detail =
        err instanceof SandboxLoadError
          ? `The sandbox rejected the strategy (${err.failure.kind}): ${err.message}`
          : String(err);
      screens.failure({ title: 'The boss failed to load', detail });
      return;
    }

    renderer.setHabitCells(habitCellsFromSummary(prevSummary, ARENA, ARENA));
    // `banner.reset()` above already leaves it `hidden`; only a genuine win->next
    // transition (`showLearnedBanner`) is allowed to arm it, so a retry keeps the
    // HUD's "written for you" chip (from `roundProvenance` alone, below) without
    // reopening the reveal.
    if (showLearnedBanner) {
      banner.start(performance.now(), roundProvenance, round.state.strategy.name, round.state.strategy.rationale);
    }

    const current = round;
    loop = createLoop({
      round: current,
      input,
      render,
      aimContext,
      onOutcome: (finished) => {
        void handleOutcome(finished);
      },
    });

    screens.hide();
    render(current);
    // A round with a strategy the loop wrote holds here on a pre-fight interstitial
    // (spec: Matt's playtest, `docs/AI-DEV-LOG.md` 2026-09-09) — `banner.start` just
    // above only *arms* it for `provenance === 'approved'`, so `isHolding()` is the
    // single source of truth for whether `loop.start()` happens now or after the
    // hold. `round.state.tick` stays 0 throughout: nothing here steps the sim, so
    // the input log the eventual `loop.start()` begins recording still starts at
    // tick 0, same as any other round — the delay is entirely host-side UI time.
    if (banner.isHolding()) runHoldTicker();
    else loop.start();
  }

  async function handleOutcome(finished: Round): Promise<void> {
    const summary = finished.summary();
    const hash = finished.hash();

    if (finished.state.outcome !== 'playerWon') {
      // Retry the round you lost, against the boss you lost to.
      //
      // This passed the index alone until 2026-09-09, and `startRound` reads "no
      // source" as "the bundled file" — so dying on Round 3 and pressing RETRY
      // restarted Round 3 against the *round-1* boss. Which is the easiest strategy
      // in the game, silently, at the exact moment the player is being told they
      // are retrying the hard one. A playtest caught it ("depois que eu perdi uma
      // vez e iniciei de novo, parece que ele voltou pro nível mais fácil
      // possível"), and it had been eating the whole point of a round the agents
      // wrote: the adapted boss existed for one attempt and then evaporated.
      //
      // `finished.source` is the text the round actually ran, so the retry is the
      // same fight — same seed (`roundSeed` is a function of the round index), same
      // strategy, same provenance chip. It is the same thing `driveWith` does.
      const source = finished.source;
      const provenance = roundProvenance;
      screens.gameOver({
        round: finished.index,
        strategy: finished.state.strategy.name,
        rationale: finished.state.strategy.rationale,
        onRetry: () => {
          void startRound(finished.index, source, false, provenance);
        },
      });
      return;
    }

    const isFinal = finished.index >= MAX_ROUNDS;
    if (isFinal) {
      screens.won({
        rounds: MAX_ROUNDS,
        onRetry: () => {
          void startRound(1);
        },
      });
      return;
    }

    const context: RoundWonContext = {
      round: finished.index,
      summary,
      hash,
      seed: finished.seed,
      source: finished.source,
      isFinal,
      next: (nextSource?: string, nextProvenance?: StrategyProvenance) =>
        // `summary` is this round's — exactly what was just handed to the interlude
        // as `context.summary` (the rewrite request's `summary` field) — so the
        // *next* round's habit-cell highlight reads the replay the loop actually
        // wrote the new boss against. `true`: this is the one call site that is
        // always a genuine win->next transition, never a retry, so it is the only
        // place the pre-fight interstitial is allowed to open.
        startRound(finished.index + 1, nextSource, false, nextProvenance ?? 'bundled', summary, true),
    };

    await roundWon(context);
  }

  /** `?interlude=0`: show the hash and fight the same strategy on a new seed. */
  function defaultRoundWon(context: RoundWonContext): void {
    screens.roundWon({
      round: context.round,
      hash: context.hash,
      seconds: context.summary.durations.seconds,
      hpLeft: context.summary.player.hpEnd,
      onNext: () => {
        void context.next();
      },
    });
  }

  /**
   * The round-won handler, chosen once.
   *
   * `createInterludeHandler` only builds a closure: nothing is mounted, no source is
   * resolved and `location` is not read until a round is actually won, so choosing
   * the handler up front costs nothing and keeps the decision in one place.
   * `onDebug` is the only wire back out — `app.ts` does not otherwise know what an
   * interlude contains.
   */
  const roundWon: RoundWonHandler =
    options.onRoundWon ??
    (interludeEnabled
      ? createInterludeHandler({
          onDebug: (debug) => {
            interludeDebug = debug;
          },
        })
      : defaultRoundWon);

  const debug: DebugApi = {
    get state(): GameState | null {
      return round?.state ?? null;
    },
    get inputLog(): InputLog | null {
      return round?.inputLog ?? null;
    },
    get seed(): number | null {
      return round?.seed ?? null;
    },
    get sessionSeed(): number {
      return sessionSeed;
    },
    get round(): number {
      return round?.index ?? 0;
    },
    get screen(): string | null {
      return screens.current();
    },
    get ready(): boolean {
      return booted;
    },
    get interlude(): InterludeDebug | null {
      return interludeDebug;
    },
    hash(): string | null {
      return round?.hash() ?? null;
    },
    summary(): ReplaySummary | null {
      return round?.summary() ?? null;
    },
    stats(): ReturnType<Loop['stats']> | null {
      return loop?.stats() ?? null;
    },
    runnerStats(): RunnerStats | null {
      return round?.runnerStats() ?? null;
    },
    startRound(index: number, source?: string): Promise<void> {
      return startRound(index, source);
    },
    async driveWith(log: InputLog): Promise<void> {
      const index = round?.index ?? startAt;
      const source = round?.source;
      await startRound(index, source, true);
      loop?.stop();
      loop?.setInput(logInputProvider(log));
    },
    fastForward(maxTicks = ENGINE_CONSTANTS.round.maxTicks): number {
      // `loop.fastForward` simulates synchronously regardless of whether
      // `loop.start()` was ever called, so a round still holding on the pre-fight
      // interstitial would otherwise run to completion *behind* a banner that is
      // still on screen, with its `requestAnimationFrame` ticker left dangling
      // (harmless once the round ends — `loop.start()`'s own `ended` guard makes
      // its eventual call a no-op — but a stray frame or two of a banner floating
      // over the outcome screen for no reason). Skipping straight past it here
      // matches what `fastForward` means everywhere else it is used: skip to the
      // end, now.
      if (banner.isHolding()) {
        cancelHoldTicker();
        banner.reset();
      }
      return loop?.fastForward(maxTicks) ?? 0;
    },
    renderFrame(): void {
      loop?.renderFrame();
    },
  };

  return {
    async boot(): Promise<void> {
      screens.loading('Starting the sandbox');
      // Instantiate QuickJS up front: ~1.4 MB of WASM should not be paid for on the
      // click that starts the fight.
      await sandboxFactory();
      booted = true;
      if (!intro.show) {
        await startRound(startAt);
        return;
      }
      screens.start({
        seed: Number(formatSeed(sessionSeed)),
        skipIntro: readSkipIntro(),
        onSkipIntro: (value) => {
          writeSkipIntro(value);
        },
        // Cosmetic, and it stops here: the picks are remembered and handed to the
        // renderer, and never reach `startRound`, the engine or a strategy's view.
        // See `ui/fighters.ts` for why that boundary is the whole design.
        playerFighter: fighters.player,
        bossFighter: fighters.boss,
        onPickFighter: (which, id) => {
          fighters[which] = id;
          renderer.setFighters(fighters);
          writeFighter(which, id);
        },
        onFight: () => {
          void startRound(startAt);
        },
      });
    },
    debug,
  };
}
