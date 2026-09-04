/**
 * A round: everything needed to play it, and everything needed to replay it.
 *
 * `{ seed, inputLog, source }` is the whole replay format. The state is the engine's;
 * the runner is a QuickJS sandbox holding this round's strategy. Nothing in here knows
 * about the DOM, rAF or the renderer — `loop.ts` drives it and `app.ts` owns it.
 */
import type { StrategyRunner } from '@rematch/contract';
import {
  createGame,
  hashState,
  step,
  summarizeReplay,
  type GameState,
  type InputLog,
  type PlayerInput,
  type ReplaySummary,
} from '@rematch/engine';

import { recordingRunner, type RunnerStats } from './runnerStats.ts';
import { loadRoundStrategy } from './strategy.ts';

export type Round = {
  /** 1-based round number, shown in the HUD. */
  readonly index: number;
  readonly seed: number;
  /** The exact strategy text the sandbox loaded. Part of the replay. */
  readonly source: string;
  readonly runner: StrategyRunner;
  /** True when the sandbox was given the deterministic clock (replay mode). */
  readonly deterministic: boolean;
  readonly state: GameState;
  /** One entry per elapsed tick, in order. */
  readonly inputLog: InputLog;
  /** Advance one tick and record the input. Returns the (possibly new) outcome. */
  tick(input: PlayerInput): GameState['outcome'];
  hash(): string;
  summary(): ReplaySummary;
  /** `decide` counters for this round. See `runnerStats.ts`. */
  runnerStats(): RunnerStats;
  dispose(): void;
};

export type CreateRoundOptions = {
  index: number;
  seed: number;
  source: string;
  /** Inject the deterministic sandbox clock. See `strategy.ts` for why. */
  deterministic?: boolean;
};

/**
 * Load the strategy, then start the round. The only async step in the whole fight —
 * after this, every tick is synchronous, including the QuickJS `decide` call.
 */
export async function createRound(options: CreateRoundOptions): Promise<Round> {
  const deterministic = options.deterministic === true;
  // Wrapped before `createGame`, so `init(seed)` and every `decide` of the round go
  // through the counters — including the ones the HUD reports as "stalled".
  const runner = recordingRunner(await loadRoundStrategy(options.source, { deterministic }));
  const state = createGame(options.seed, runner);
  const inputLog: InputLog = [];

  return {
    index: options.index,
    seed: options.seed,
    source: options.source,
    runner,
    deterministic,
    state,
    inputLog,
    tick(input: PlayerInput): GameState['outcome'] {
      inputLog.push(input);
      step(state, input, runner);
      return state.outcome;
    },
    hash(): string {
      return hashState(state);
    },
    summary(): ReplaySummary {
      return summarizeReplay(state);
    },
    runnerStats(): RunnerStats {
      return runner.stats();
    },
    dispose(): void {
      runner.dispose();
    },
  };
}
