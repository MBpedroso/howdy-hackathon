/**
 * StrategyRunner — the boundary between the engine and a loaded strategy.
 *
 * The engine never imports a strategy directly and never depends on QuickJS.
 * It is handed a runner and calls `decide` once per tick. Two implementations
 * exist: a native one (tests only, imports the module in-process) and the
 * QuickJS sandbox (`@rematch/sandbox`) used by the game and the harness.
 *
 * Memory (`init()`'s return) lives INSIDE the runner. The engine never sees it;
 * the runner enforces the 4 KB serialized cap and reports it via `memoryBytes`.
 *
 * Seeded randomness: the sandbox injects a global `rand(): number` in [0, 1),
 * deterministic per (round seed). `Math.random` is rejected by the static check.
 */
import type { BossView, StrategyMeta } from './types.ts';

export type RunnerFailure =
  | { kind: 'timeout'; ms: number }
  | { kind: 'memory'; bytes: number }
  | { kind: 'throw'; message: string }
  | { kind: 'load'; message: string };

export type DecideResult =
  | { ok: true; action: unknown; elapsedMs: number }
  | { ok: false; failure: RunnerFailure; elapsedMs: number };

export interface StrategyRunner {
  readonly meta: StrategyMeta;
  /** Calls the strategy's `init()`; resets memory. Must be called before `decide`. */
  init(seed: number): void;
  /** Raw action — the ENGINE validates it with `validateAction`. Never throws. */
  decide(view: BossView): DecideResult;
  /** Current serialized size of the strategy's memory object. */
  memoryBytes(): number;
  dispose(): void;
}
