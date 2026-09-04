/**
 * Player input — one record per tick. The replay format is `{ seed, InputLog }`:
 * nothing else is needed to reproduce a round byte-for-byte.
 */

export type Axis = -1 | 0 | 1;

export type PlayerInput = {
  /** WASD, digital. Diagonals are normalized by the engine, never faster. */
  moveX: Axis;
  moveY: Axis;
  /** Space. Ignored while a dash is already running or on cooldown. */
  dash: boolean;
  /** Mouse aim as a vector from the player (any magnitude; the engine normalizes). */
  aimX: number;
  aimY: number;
  /** Mouse button held. Respects the shot cooldown. */
  shoot: boolean;
};

/** One entry per tick. `replay` feeds `IDLE_INPUT` for ticks past the end of the log. */
export type InputLog = PlayerInput[];

/** Neutral input: no movement, no dash, no shot, aim +x. */
export const IDLE_INPUT: Readonly<PlayerInput> = Object.freeze({
  moveX: 0,
  moveY: 0,
  dash: false,
  aimX: 1,
  aimY: 0,
  shoot: false,
});

/** Build an input from partial fields, defaulting to {@link IDLE_INPUT}. */
export function makeInput(partial: Partial<PlayerInput> = {}): PlayerInput {
  return { ...IDLE_INPUT, ...partial };
}
