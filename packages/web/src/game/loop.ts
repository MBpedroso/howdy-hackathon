/**
 * The game loop: a fixed 60 Hz simulation decoupled from the display.
 *
 * `requestAnimationFrame` fires at whatever the monitor does — 60, 75, 120 Hz, or not
 * at all in a background tab. The simulation must not care: it advances in fixed
 * 1/60 s steps out of an accumulator, so a 120 Hz screen renders twice per tick and a
 * 30 Hz one steps twice per frame, and the resulting state (and therefore the replay
 * hash) is identical on both.
 *
 * Catch-up is capped at `MAX_CATCHUP_STEPS` per frame. Without the cap, a tab that was
 * hidden for ten seconds would try to run 600 ticks in one frame, which either freezes
 * the page or — worse, with a real clock in the sandbox — trips the 2 ms `decide`
 * deadline and corrupts the round. Time past the cap is dropped: the fight runs slow
 * for a frame instead of exploding.
 */
import { IDLE_INPUT, type InputLog, type PlayerInput } from '@rematch/engine';

import type { AimContext } from './input.ts';
import type { Round } from './round.ts';

/** Simulation step, in milliseconds. 60 ticks per second, exactly as the engine says. */
export const TICK_MS = 1000 / 60;

/** Maximum simulation steps per animation frame. */
export const MAX_CATCHUP_STEPS = 5;

/** Anything that can produce a tick's input: the live keyboard/mouse, or a log. */
export type InputProvider = {
  sample(ctx: AimContext): PlayerInput;
};

/** Replay a recorded log. Past the end it feeds `IDLE_INPUT`, like `engine.replay`. */
export function logInputProvider(log: InputLog): InputProvider & { index(): number; remaining(): number } {
  let i = 0;
  return {
    sample(): PlayerInput {
      const input = log[i] ?? IDLE_INPUT;
      i += 1;
      return input;
    },
    index(): number {
      return i;
    },
    remaining(): number {
      return Math.max(0, log.length - i);
    },
  };
}

export type FrameStats = {
  /** Frames rendered since the loop started. */
  frames: number;
  ticks: number;
  /** Milliseconds for the last simulated tick (input + step + QuickJS decide). */
  lastTickMs: number;
  /** Milliseconds for the last full render. */
  lastRenderMs: number;
  /** Exponential moving averages of the two above. */
  avgTickMs: number;
  avgRenderMs: number;
  /** Ticks dropped by the catch-up cap. Non-zero means the machine is too slow. */
  droppedTicks: number;
};

export type LoopOptions = {
  round: Round;
  input: InputProvider;
  /** Draw one frame. Never mutates state. */
  render: (round: Round) => void;
  /** Where the aim vector points before the mouse has moved (the boss). */
  aimContext: (round: Round) => AimContext;
  /** Called once, on the tick the round is decided. The loop has already stopped. */
  onOutcome?: (round: Round) => void;
  /** Injectable for tests. Defaults to `performance.now`. */
  now?: () => number;
};

export type Loop = {
  start(): void;
  stop(): void;
  running(): boolean;
  /** Swap the input source — used by the replay hook. */
  setInput(provider: InputProvider): void;
  /**
   * Run up to `maxTicks` simulation steps synchronously, with no rAF and no clock,
   * then render once. Returns how many ticks actually ran. This is how the e2e suite
   * replays a 20-second round in a few hundred milliseconds.
   */
  fastForward(maxTicks: number): number;
  /** Draw one frame without simulating. */
  renderFrame(): void;
  stats(): FrameStats;
  dispose(): void;
};

const EMA = 0.1;

export function createLoop(options: LoopOptions): Loop {
  const { round, render, aimContext } = options;
  const now = options.now ?? ((): number => performance.now());

  let input = options.input;
  let handle: number | null = null;
  let last = 0;
  let accumulator = 0;
  let ended = false;

  const stats: FrameStats = {
    frames: 0,
    ticks: 0,
    lastTickMs: 0,
    lastRenderMs: 0,
    avgTickMs: 0,
    avgRenderMs: 0,
    droppedTicks: 0,
  };

  function drawOnce(): void {
    const t0 = now();
    render(round);
    stats.lastRenderMs = now() - t0;
    stats.avgRenderMs = stats.avgRenderMs === 0 ? stats.lastRenderMs : stats.avgRenderMs * (1 - EMA) + stats.lastRenderMs * EMA;
    stats.frames += 1;
  }

  /** One simulation step. Returns false once the round is decided. */
  function simulate(measure: boolean): boolean {
    if (round.state.outcome !== 'playing') return false;
    const t0 = measure ? now() : 0;
    round.tick(input.sample(aimContext(round)));
    stats.ticks += 1;
    if (measure) {
      stats.lastTickMs = now() - t0;
      stats.avgTickMs = stats.avgTickMs === 0 ? stats.lastTickMs : stats.avgTickMs * (1 - EMA) + stats.lastTickMs * EMA;
    }
    return round.state.outcome === 'playing';
  }

  function finish(): void {
    if (ended) return;
    ended = true;
    stop();
    drawOnce();
    options.onOutcome?.(round);
  }

  function frame(): void {
    handle = null;
    const t = now();
    // A negative or absurd delta (clock jump, first frame) is treated as one tick.
    const delta = Math.min(Math.max(t - last, 0), TICK_MS * MAX_CATCHUP_STEPS * 4);
    last = t;
    accumulator += delta;

    let steps = 0;
    let alive = true;
    while (accumulator >= TICK_MS && steps < MAX_CATCHUP_STEPS) {
      accumulator -= TICK_MS;
      steps += 1;
      alive = simulate(true);
      if (!alive) break;
    }
    if (accumulator >= TICK_MS) {
      // Over the cap: throw the backlog away rather than run it all at once.
      stats.droppedTicks += Math.floor(accumulator / TICK_MS);
      accumulator = 0;
    }

    drawOnce();

    if (!alive) {
      finish();
      return;
    }
    schedule();
  }

  function schedule(): void {
    if (handle !== null) return;
    handle = requestAnimationFrame(frame);
  }

  function stop(): void {
    if (handle !== null) {
      cancelAnimationFrame(handle);
      handle = null;
    }
  }

  return {
    start(): void {
      if (ended || handle !== null) return;
      last = now();
      accumulator = 0;
      schedule();
    },
    stop,
    running(): boolean {
      return handle !== null;
    },
    setInput(provider: InputProvider): void {
      input = provider;
      accumulator = 0;
      last = now();
    },
    fastForward(maxTicks: number): number {
      stop();
      let ran = 0;
      while (ran < maxTicks && round.state.outcome === 'playing') {
        simulate(false);
        ran += 1;
      }
      drawOnce();
      if (round.state.outcome !== 'playing') finish();
      return ran;
    },
    renderFrame(): void {
      drawOnce();
    },
    stats(): FrameStats {
      return { ...stats };
    },
    dispose(): void {
      stop();
      ended = true;
    },
  };
}
