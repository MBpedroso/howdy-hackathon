/**
 * The reference bot panel's one interface (spec §6.1).
 *
 * A bot stands in for a *human at the keyboard*, so it is handed the whole
 * `GameState` — a human sees the screen, including the boss's telegraph and every
 * projectile on it. What a bot may **not** do is mutate that state: it is typed
 * `Readonly<GameState>` and every bot reads through it, exactly as the renderer
 * does. (`Readonly` is shallow in TypeScript, so this is a stated rule the tests
 * enforce by hashing the state around a call, not a type-system guarantee.)
 *
 * Two determinism requirements, both tested:
 *  1. `reset(seed)` must clear every bit of per-match state, so one bot instance
 *     can play any number of matches with no carry-over.
 *  2. `act` may only use `state` and the `rng` it is handed. No `Math.random`,
 *     no clock, no module-level mutable state. Same seed → same input sequence.
 */
import type { GameState, PlayerInput, Rng } from '@rematch/engine';

export interface PlayerBot {
  /** Shown in the Gate 3 reason and the balance table. Stable; used as a key. */
  readonly name: string;
  /** Start a new match. Must reset all internal state. */
  reset(seed: number): void;
  /** One tick of input. Must not mutate `state`. */
  act(state: Readonly<GameState>, rng: Rng): PlayerInput;
}

/**
 * Aim error at `accuracy = 0`, in radians. The bot's aim is rotated by a seeded
 * value in `±BASE_AIM_ERROR * (1 - accuracy)`.
 *
 * Scale: the boss (radius 28) subtends about ±0.09 rad at 300 px, so at accuracy
 * 0.85 the whole aim cone lands on the boss and the bot is effectively perfect,
 * while 0.7 puts roughly half its shots wide at that range. This is the knob that
 * decides how long the panel takes to grind 100 boss hp down, and therefore where
 * a "reasonable" strategy sits inside the fairness band — it is deliberately
 * coarse enough to matter. Accuracy 1 is laser-perfect, which no human is: the
 * panel must not measure the boss against a machine.
 */
export const BASE_AIM_ERROR = 0.55;

export type BotOptions = {
  /** 0 = wild, 1 = perfect. Per-bot, so the panel can span skill levels. */
  accuracy?: number;
};

/** Every scripted bot, by name. `mimic` is built from a replay, not from a name. */
export const BOT_KINDS = ['camper', 'kiter', 'rusher', 'dodger'] as const;
export type BotKind = (typeof BOT_KINDS)[number];
