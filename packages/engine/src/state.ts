/**
 * `GameState` — the entire world, as plain JSON-serializable data.
 *
 * Invariants the rest of the package depends on:
 *  - No functions, no `undefined` values, no class instances, no `NaN`. `JSON.parse(
 *    JSON.stringify(state))` is an equal state and hashes identically.
 *  - Array order is load-bearing (minions, projectiles, events resolve in array order),
 *    so nothing may reorder or sort these in place.
 *  - Every position and velocity has been quantized with `q()` (1e-4).
 */
import { PRIMITIVES, type ActionType, type PrimitiveName, type StrategyMeta } from '@rematch/contract';
import { ENGINE_CONSTANTS as E, q } from './constants.ts';
import { normalizeSeed } from './prng.ts';

export type ProjectileOwner = 'boss' | 'player';

export type Projectile = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  owner: ProjectileOwner;
  /** Ticks until it despawns. */
  ttl: number;
};

export type Minion = {
  /** Stable per-round id, so a renderer can animate one without index churn. */
  id: number;
  x: number;
  y: number;
  hp: number;
  /** Ticks until this minion can deal contact damage again. */
  hitCooldown: number;
};

/**
 * The boss's committed-but-not-yet-resolved action. While this is non-null the boss
 * does NOT call `decide` — it is locked into the tell the player is reading.
 */
export type BossTelegraph =
  | { type: 'charge'; ticksLeft: number; angle: number }
  | { type: 'slam'; ticksLeft: number; x: number; y: number };

export type PlayerState = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  hp: number;
  /** Radians; aim direction, or movement direction when not aiming. */
  facing: number;
  /** > 0 while the dash burst is active. Invulnerable throughout. */
  dashTicksLeft: number;
  dashCooldown: number;
  /** Direction the current dash was launched in; held for its whole duration. */
  dashDirX: number;
  dashDirY: number;
  shotCooldown: number;
  /** Tick of the most recent shot, or -1. Exposed to the strategy via `BossView`. */
  lastShotTick: number;
  /** Post-hit mercy invulnerability. */
  invulnTicks: number;
};

export type BossState = {
  x: number;
  y: number;
  hp: number;
  facing: number;
  /** Ticks remaining per primitive; 0 = ready. Set on action START. */
  cooldowns: Record<PrimitiveName, number>;
  /** Non-null while a charge or slam is telegraphing. */
  telegraph: BossTelegraph | null;
  /** > 0 while the boss is mid-charge (after the telegraph resolved). */
  chargeTicksLeft: number;
  chargeAngle: number;
  /** One charge deals damage at most once. */
  chargeHit: boolean;
  /** What the boss last committed to; drives "which primitive is active". */
  lastAction: ActionType;
};

export type History = {
  /** 8x8 row-major ACCUMULATED tick counts. Normalized only in `buildBossView`. */
  playerPosHeat: number[];
  /** 8 bins of dash counts, bin 0 centred on +x, counter-clockwise. */
  playerDashDirs: number[];
  /** Shots the player fired while each primitive was active. */
  playerShotsDuring: Record<PrimitiveName, number>;
};

export type Outcome = 'playing' | 'playerWon' | 'bossWon' | 'timeout';

export type EventKind =
  | 'playerDash'
  | 'playerShot'
  | 'playerHit'
  | 'bossHit'
  | 'bossBurst'
  | 'bossChargeStart'
  | 'bossChargeHit'
  | 'bossSlamStart'
  | 'bossSlamHit'
  | 'bossSlamMiss'
  | 'bossSpawn'
  | 'minionDown'
  | 'violation'
  | 'outcome';

/** A notable moment. `detail` is a short number or string, never an object. */
export type TimelineEvent = {
  tick: number;
  kind: EventKind;
  detail?: number | string;
};

export type Counts = {
  dashes: number;
  shots: number;
  /** Boss actions actually APPLIED (rejected/coerced ones are not counted). */
  primitives: Record<PrimitiveName, number>;
};

export type GameState = {
  tick: number;
  seed: number;
  /** Serialized xorshift32 state. See `prng.ts`. */
  rngState: number;
  arena: { w: number; h: number };
  /** `meta` of the strategy driving the boss; carried so a replay is self-describing. */
  strategy: StrategyMeta;
  player: PlayerState;
  boss: BossState;
  /** At most `CONSTANTS.limits.maxMinionsAlive`. */
  minions: Minion[];
  projectiles: Projectile[];
  history: History;
  /** Contract violations by the strategy (invalid action, on-cooldown action, runner failure). */
  violations: number;
  /**
   * Set when the strategy is *done*: a `memory` failure (which the sandbox makes
   * sticky, so the strategy really cannot answer again) or `TIMEOUT_KILL_STREAK`
   * consecutive `timeout`s. The harness reads this, and so does the Analyst's prompt.
   *
   * Deliberately NOT set by a single timeout. The `decide` deadline is wall clock;
   * one blown deadline means the host was busy for a moment, and the round recovers
   * on the next tick. See `step.ts`.
   */
  strategyKilled: boolean;
  /**
   * Consecutive `timeout` failures, reset by any other outcome. Bookkeeping for
   * `strategyKilled`; see `TIMEOUT_KILL_STREAK` in `step.ts`.
   */
  timeoutStreak: number;
  /** Player damage dealt to the boss. */
  damageDealt: number;
  /** Player damage dealt to minions (kept separate: it is not progress on the boss). */
  damageToMinions: number;
  /** Damage the player has taken. */
  damageTaken: number;
  minionsSpawned: number;
  /** Tallies for the replay summary. */
  counts: Counts;
  events: TimelineEvent[];
  /** Number of violation events suppressed by `limits.maxViolationEvents`. */
  droppedEvents: number;
  nextId: number;
  outcome: Outcome;
};

function zeroPrimitives(): Record<PrimitiveName, number> {
  return { move: 0, burst: 0, charge: 0, slam: 0, spawn: 0 };
}

/** A fresh round. `createGame` in `game.ts` is the public entry point. */
export function createInitialState(seed: number, strategy: StrategyMeta): GameState {
  return {
    tick: 0,
    seed,
    rngState: normalizeSeed(seed),
    arena: { w: E.arena.w, h: E.arena.h },
    strategy: { name: strategy.name, rationale: strategy.rationale, version: strategy.version },
    player: {
      x: q(E.player.startX),
      y: q(E.player.startY),
      vx: 0,
      vy: 0,
      hp: E.player.hp,
      facing: 0,
      dashTicksLeft: 0,
      dashCooldown: 0,
      dashDirX: 1,
      dashDirY: 0,
      shotCooldown: 0,
      lastShotTick: -1,
      invulnTicks: 0,
    },
    boss: {
      x: q(E.boss.startX),
      y: q(E.boss.startY),
      hp: E.boss.hp,
      facing: q(Math.PI / 2),
      cooldowns: zeroPrimitives(),
      telegraph: null,
      chargeTicksLeft: 0,
      chargeAngle: 0,
      chargeHit: false,
      lastAction: 'idle',
    },
    minions: [],
    projectiles: [],
    history: {
      playerPosHeat: new Array<number>(64).fill(0),
      playerDashDirs: new Array<number>(8).fill(0),
      playerShotsDuring: zeroPrimitives(),
    },
    violations: 0,
    strategyKilled: false,
    timeoutStreak: 0,
    damageDealt: 0,
    damageToMinions: 0,
    damageTaken: 0,
    minionsSpawned: 0,
    counts: { dashes: 0, shots: 0, primitives: zeroPrimitives() },
    events: [],
    droppedEvents: 0,
    nextId: 1,
    outcome: 'playing',
  };
}

/** Deep copy via JSON. Deterministic, and it proves the state is serializable. */
export function cloneState(state: GameState): GameState {
  return JSON.parse(JSON.stringify(state)) as GameState;
}

/** Append a timeline event, respecting the caps in `ENGINE_CONSTANTS.limits`. */
export function pushEvent(state: GameState, kind: EventKind, detail?: number | string): void {
  if (state.events.length >= E.limits.maxEvents) {
    state.droppedEvents += 1;
    return;
  }
  state.events.push(detail === undefined ? { tick: state.tick, kind } : { tick: state.tick, kind, detail });
}

/** Count a contract violation and log at most `maxViolationEvents` of them. */
export function pushViolation(state: GameState, reason: string): void {
  state.violations += 1;
  let logged = 0;
  for (const ev of state.events) {
    if (ev.kind === 'violation') logged += 1;
  }
  if (logged >= E.limits.maxViolationEvents) {
    state.droppedEvents += 1;
    return;
  }
  pushEvent(state, 'violation', reason.length > 120 ? `${reason.slice(0, 120)}…` : reason);
}

/**
 * Which primitives are "active" right now, for `history.playerShotsDuring`.
 * Evaluated at the START of the tick, i.e. against the boss state the player could
 * actually see when they pulled the trigger.
 *
 *  - `move`   the boss's last committed action was a move
 *  - `burst`  a boss projectile is alive (or a burst was just fired)
 *  - `charge` charge is telegraphing or the charge itself is running
 *  - `slam`   slam is telegraphing
 *  - `spawn`  at least one minion is alive
 */
export function activePrimitives(state: GameState): PrimitiveName[] {
  const out: PrimitiveName[] = [];
  const b = state.boss;
  if (b.lastAction === 'move') out.push('move');
  let bossShotAlive = b.lastAction === 'burst';
  if (!bossShotAlive) {
    for (const p of state.projectiles) {
      if (p.owner === 'boss') {
        bossShotAlive = true;
        break;
      }
    }
  }
  if (bossShotAlive) out.push('burst');
  if (b.chargeTicksLeft > 0 || (b.telegraph !== null && b.telegraph.type === 'charge')) out.push('charge');
  if (b.telegraph !== null && b.telegraph.type === 'slam') out.push('slam');
  if (state.minions.length > 0) out.push('spawn');
  return out;
}

/** Runtime companion so callers can iterate primitives without importing the contract. */
export const PRIMITIVE_NAMES = PRIMITIVES;
