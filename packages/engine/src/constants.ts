/**
 * Engine-owned tunables — the whole game feel lives in this one object.
 *
 * What is NOT here: arena size, per-primitive cooldowns, telegraph windows and the
 * sandbox limits. Those are shared truth and are imported from `@rematch/contract`
 * (spec §4.3: "all constants owned by the engine", but the ones the *strategy* can
 * see must come from the contract so there is exactly one copy).
 *
 * Units: distance in pixels, time in ticks, 60 ticks = 1 second.
 */
import { CONSTANTS, type PrimitiveName } from '@rematch/contract';

/** Quantization step applied to every position / velocity after integration. */
export const PRECISION = 1e4;

/**
 * Round to 1e-4. Applied after every integration step so the state stays exactly
 * representable and `hashState` is stable across platforms (and absorbs the ULP-level
 * disagreement `Math.cos`/`Math.sin`/`Math.atan2` are permitted to have by spec).
 */
export function q(v: number): number {
  return Math.round(v * PRECISION) / PRECISION;
}

export const ENGINE_CONSTANTS = {
  round: {
    /** 3600 ticks = 60 s (spec §2.1). Reaching it ends the round as `timeout`. */
    maxTicks: CONSTANTS.ticksPerSecond * 60,
  },

  arena: CONSTANTS.arena,

  player: {
    /** Five hits and you are out. */
    hp: 5,
    radius: 12,
    /** px/tick — 216 px/s, crosses the 800 px arena in ~3.7 s. */
    speed: 3.6,
    /** px/tick while dashing. */
    dashSpeed: 11,
    /** Dash lasts 10 ticks -> ~110 px of travel, invulnerable throughout. */
    dashTicks: 10,
    dashCooldown: 45,
    /** 7.5 shots/s. */
    shotCooldown: 8,
    /** Invulnerability granted after taking any hit (~0.67 s of mercy). */
    hitInvulnTicks: 40,
    startX: 400,
    startY: 620,
  },

  boss: {
    /** 100 player projectiles at 1 damage: ~13 s of perfect uptime, ~30-40 s for a
     *  human landing 40% of their shots. See the bench for the measured numbers. */
    hp: 100,
    radius: 28,
    /** Deliberately slower than the player: kiting must work, charge is the answer. */
    speed: 2.6,
    startX: 400,
    startY: 180,
  },

  projectile: {
    radius: 5,
    /** Hard ceiling on live projectiles; a runaway strategy cannot exhaust memory. */
    maxAlive: 256,
    player: { speed: 11, damage: 1, ttl: 90 },
    boss: { speed: 5.5, damage: 1, ttl: 150 },
  },

  burst: {
    /** Radians between adjacent projectiles, so `count` widens the cone: 3 -> 0.44 rad,
     *  5 -> 0.88 rad, 8 -> 1.54 rad. A cone, not a full ring — see README/playtest note. */
    spreadPerShot: 0.22,
  },

  charge: {
    /** After the 20-tick telegraph: 30 ticks at 10 px/tick = 300 px of travel. */
    speed: 10,
    ticks: 30,
    damage: 2,
  },

  slam: {
    /** Resolves once, at the end of the 40-tick telegraph. */
    radius: 110,
    damage: 2,
  },

  minion: {
    /** Six player hits. */
    hp: 6,
    radius: 10,
    /** Slower than the player (3.6), so a minion is escapable on foot. */
    speed: 2,
    damage: 1,
    /** Per-minion contact re-hit delay: 1.5 s, so a glued minion is a threat, not a kill. */
    hitCooldown: 90,
    /** Materialization delay before a new minion can deal contact damage. Without it,
     *  `spawn` at the player's own position is a free, undodgeable hit — which is
     *  exactly what the `chaser` reference strategy does. */
    spawnGraceTicks: 45,
  },

  limits: {
    /** Hard cap on `state.events`; a normal match produces ~700. */
    maxEvents: 2000,
    /** A pathological strategy can violate every tick — only log the first few. */
    maxViolationEvents: 50,
    /** Entries in `ReplaySummary.timeline`. */
    timelineMax: 200,
  },
} as const;

/** Per-primitive cooldowns, re-exported for readability at the call site. */
export const COOLDOWNS: Readonly<Record<PrimitiveName, number>> = CONSTANTS.cooldowns;

/** Telegraph windows: charge 20 ticks, slam 40 ticks. */
export const TELEGRAPHS = CONSTANTS.telegraphs;
