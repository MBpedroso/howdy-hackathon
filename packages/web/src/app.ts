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
import { createRenderer, type Renderer } from './render/renderer.ts';
import { createHud, type Hud } from './ui/hud.ts';
import { introDecision, readSkipIntro, writeSkipIntro } from './ui/intro.ts';
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
  next(source?: string): Promise<void>;
};

export type RoundWonHandler = (context: RoundWonContext) => void | Promise<void>;

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
  const hud: Hud = createHud(options.hud);
  const screens: Screens = createScreens(options.screen);
  const input: InputSource = createInputSource({ canvas: options.canvas, arenaSize: ARENA });

  let round: Round | null = null;
  let loop: Loop | null = null;
  let booted = false;
  /** Published through `debug.interlude` while an interlude is on screen. */
  let interludeDebug: InterludeDebug | null = null;

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
    const stats = loop?.stats();
    hud.update(current.state, {
      round: current.index,
      maxRounds: MAX_ROUNDS,
      sessionSeed,
      roundSeed: current.seed,
      tickMs: stats?.avgTickMs ?? 0,
      renderMs: stats?.avgRenderMs ?? 0,
      runner: current.runnerStats(),
    });
  }

  function teardown(): void {
    loop?.dispose();
    loop = null;
    round?.dispose();
    round = null;
  }

  async function startRound(index: number, source?: string, deterministic = false): Promise<void> {
    teardown();
    input.clear();
    renderer.reset();
    hud.reset();
    screens.loading(index === 1 ? 'Loading the boss' : `Round ${index}`);

    const seed = roundSeed(sessionSeed, index);
    const text = source ?? bundledSource(strategyParam);

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
    loop.start();
  }

  async function handleOutcome(finished: Round): Promise<void> {
    const summary = finished.summary();
    const hash = finished.hash();

    if (finished.state.outcome !== 'playerWon') {
      screens.gameOver({
        round: finished.index,
        strategy: finished.state.strategy.name,
        rationale: finished.state.strategy.rationale,
        onRetry: () => {
          void startRound(finished.index);
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
      next: (nextSource?: string) => startRound(finished.index + 1, nextSource),
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
        onFight: () => {
          void startRound(startAt);
        },
      });
    },
    debug,
  };
}
