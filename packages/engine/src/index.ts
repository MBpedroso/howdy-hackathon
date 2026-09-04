/**
 * `@rematch/engine` — the deterministic game simulation.
 *
 * Pure TypeScript: no DOM, no Node APIs, no QuickJS, no `Math.random`, no `Date`.
 * Its only dependency is `@rematch/contract`. Everything else in the monorepo is a
 * consumer of this package; it consumes none of them.
 *
 * ```ts
 * const runner = nativeRunner(strategyModule);       // or the QuickJS runner
 * const state = createGame(seed, runner);
 * for (const input of inputLog) step(state, input, runner);
 * const summary = summarizeReplay(state);            // what the Analyst agent reads
 * ```
 */

// Tunables and quantization
export { COOLDOWNS, ENGINE_CONSTANTS, PRECISION, TELEGRAPHS, q } from './constants.ts';

// Seeded PRNG
export { createRng, createRngFromState, normalizeSeed, type Rng } from './prng.ts';

// Input
export { IDLE_INPUT, makeInput, type Axis, type InputLog, type PlayerInput } from './input.ts';

// State
export {
  PRIMITIVE_NAMES,
  activePrimitives,
  cloneState,
  createInitialState,
  pushEvent,
  pushViolation,
  type BossState,
  type BossTelegraph,
  type Counts,
  type EventKind,
  type GameState,
  type History,
  type Minion,
  type Outcome,
  type PlayerState,
  type Projectile,
  type ProjectileOwner,
  type TimelineEvent,
} from './state.ts';

// The read-only strategy view
export { VIEW_PRIMITIVES, buildBossView, normalizeHeat } from './view.ts';

// Simulation
export { dirBin, step } from './step.ts';

// Round lifecycle
export {
  buildTimeline,
  createGame,
  hashState,
  replay,
  summarizeReplay,
  type ReplayOptions,
  type ReplayResult,
  type ReplaySummary,
} from './game.ts';

// Hashing
export { canonicalJson, fnv1a64, hashValue } from './hash.ts';

// In-process runner (tests / benches / reference bots — not a sandbox)
export { DETERMINISTIC_TICK_MS, nativeRunner, utf8Length, type NativeRunnerOptions } from './nativeRunner.ts';
