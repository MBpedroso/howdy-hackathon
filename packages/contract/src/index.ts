/**
 * @rematch/contract — the Boss Contract.
 *
 * The single interface between the agents and the game. Zero workspace
 * dependencies on purpose: `engine`, `harness`, `agents` and `web` all consume
 * this, so it must never consume any of them.
 *
 * No `Math.random`, no `Date.now`, no I/O anywhere in this package.
 */

export {
  ACTION_TYPES,
  BURST_COUNTS,
  CONSTANTS,
  PRIMITIVES,
  type ActionType,
  type BossAction,
  type BossView,
  type BurstCount,
  type Memory,
  type PrimitiveName,
  type StrategyMeta,
  type StrategyModule,
} from './types.ts';

export {
  validateAction,
  type ValidationErr,
  type ValidationOk,
  type ValidationResult,
} from './validate.ts';

export {
  ALLOWED_EXPORTS,
  FORBIDDEN_IDENTIFIERS,
  STATIC_RULES,
  staticCheck,
  type StaticCheckResult,
  type StaticRule,
  type Violation,
} from './staticCheck.ts';

export type { DecideResult, RunnerFailure, StrategyRunner } from './runner.ts';
