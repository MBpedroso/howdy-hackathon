/**
 * Geometry and aiming shared by the reference bots.
 *
 * Everything here is a pure function of the state (plus the seeded `Rng` for aim
 * noise). No clock, no `Math.random`: a bot's whole input sequence has to be a
 * function of `(seed, strategy)` or Gate 3's verdict would not reproduce.
 */
import { ENGINE_CONSTANTS as E, type GameState, type PlayerInput, type Rng } from '@rematch/engine';
import { BASE_AIM_ERROR } from './types.ts';

export const TAU = Math.PI * 2;

/** Contact radius for a boss projectile against the player. */
export const BOSS_SHOT_HIT_RADIUS = E.player.radius + E.projectile.radius;

/** Digitize a direction component into a WASD axis, the way a keyboard does. */
export function axis(v: number): -1 | 0 | 1 {
  if (v > 0.4) return 1;
  if (v < -0.4) return -1;
  return 0;
}

/** Normalize, with a zero vector mapping to `(0, 0)` rather than NaN. */
export function unit(dx: number, dy: number): { x: number; y: number } {
  const d = Math.hypot(dx, dy);
  return d < 1e-9 ? { x: 0, y: 0 } : { x: dx / d, y: dy / d };
}

/** Bias a move vector away from the walls — a cornered player cannot dodge. */
export function pushOffWalls(state: Readonly<GameState>, mx: number, my: number, margin = 80): { x: number; y: number } {
  const p = state.player;
  let x = mx;
  let y = my;
  if (p.x < margin) x = Math.abs(x) + 0.5;
  else if (p.x > state.arena.w - margin) x = -Math.abs(x) - 0.5;
  if (p.y < margin) y = Math.abs(y) + 0.5;
  else if (p.y > state.arena.h - margin) y = -Math.abs(y) - 0.5;
  return { x, y };
}

/** The dash is available this tick (not already dashing, not on cooldown). */
export function dashReady(state: Readonly<GameState>): boolean {
  return state.player.dashCooldown === 0 && state.player.dashTicksLeft === 0;
}

export type SlamThreat = { x: number; y: number; ticksLeft: number };
export type ChargeThreat = { angle: number; ticksLeft: number };

/** The slam circle currently being telegraphed, if any. */
export function slamTelegraph(state: Readonly<GameState>): SlamThreat | null {
  const t = state.boss.telegraph;
  return t !== null && t.type === 'slam' ? { x: t.x, y: t.y, ticksLeft: t.ticksLeft } : null;
}

/** The charge currently being telegraphed, if any. */
export function chargeTelegraph(state: Readonly<GameState>): ChargeThreat | null {
  const t = state.boss.telegraph;
  return t !== null && t.type === 'charge' ? { angle: t.angle, ticksLeft: t.ticksLeft } : null;
}

/** True while any tell is on screen or the charge itself is in flight. */
export function bossIsCommitted(state: Readonly<GameState>): boolean {
  return state.boss.telegraph !== null || state.boss.chargeTicksLeft > 0;
}

export type Incoming = {
  /** Unit vector from the projectile towards the player. */
  dirX: number;
  dirY: number;
  /** Ticks until closest approach. */
  ticks: number;
  /** Distance at closest approach, if the player stands still. */
  miss: number;
  /** Current distance. */
  dist: number;
};

/**
 * The most urgent boss projectile actually on a collision course, or null.
 *
 * "On a course" is closest-approach against a *stationary* player: a projectile
 * that will pass 200 px away is not a threat and a bot that dodges it is wasting
 * its dash. `margin` widens the hit radius so a bot leaves itself room.
 */
export function nearestIncoming(
  state: Readonly<GameState>,
  withinTicks: number,
  margin = 14,
): Incoming | null {
  const p = state.player;
  let best: Incoming | null = null;
  for (const pr of state.projectiles) {
    if (pr.owner !== 'boss') continue;
    const rx = p.x - pr.x;
    const ry = p.y - pr.y;
    const speedSq = pr.vx * pr.vx + pr.vy * pr.vy;
    if (speedSq < 1e-9) continue;
    const t = (rx * pr.vx + ry * pr.vy) / speedSq;
    if (t < 0 || t > withinTicks) continue;
    const missX = rx - pr.vx * t;
    const missY = ry - pr.vy * t;
    const miss = Math.hypot(missX, missY);
    if (miss > BOSS_SHOT_HIT_RADIUS + margin) continue;
    if (best !== null && t >= best.ticks) continue;
    const dist = Math.hypot(rx, ry);
    const dir = unit(rx, ry);
    best = { dirX: dir.x, dirY: dir.y, ticks: t, miss, dist };
  }
  return best;
}

/**
 * Distance from the player to the closest approach of any boss projectile if the
 * player walks in `(mx, my)` for `ticks`. Both sides are integrated at their real
 * speeds, so this is the same prediction a good human makes by eye.
 * `Infinity` when nothing is inbound.
 */
export function clearanceIfMoving(
  state: Readonly<GameState>,
  mx: number,
  my: number,
  ticks: number,
  speed = E.player.speed,
): number {
  const dir = unit(mx, my);
  let worst = Number.POSITIVE_INFINITY;
  for (const pr of state.projectiles) {
    if (pr.owner !== 'boss') continue;
    for (let t = 1; t <= ticks; t += 1) {
      const px = state.player.x + dir.x * speed * t;
      const py = state.player.y + dir.y * speed * t;
      const d = Math.hypot(pr.x + pr.vx * t - px, pr.y + pr.vy * t - py);
      if (d < worst) worst = d;
    }
  }
  return worst;
}

/** Perpendicular distance from the player to the line a charge will sweep. */
export function distanceToChargeLine(state: Readonly<GameState>, angle: number): number {
  const rx = state.player.x - state.boss.x;
  const ry = state.player.y - state.boss.y;
  const along = rx * Math.cos(angle) + ry * Math.sin(angle);
  if (along < 0) return Math.hypot(rx, ry);
  return Math.abs(-rx * Math.sin(angle) + ry * Math.cos(angle));
}

/** Nearest live minion, with its unit direction from the player. */
export function nearestMinion(state: Readonly<GameState>): { dirX: number; dirY: number; dist: number } | null {
  let best: { dirX: number; dirY: number; dist: number } | null = null;
  for (const m of state.minions) {
    const d = Math.hypot(m.x - state.player.x, m.y - state.player.y);
    if (best !== null && d >= best.dist) continue;
    const dir = unit(m.x - state.player.x, m.y - state.player.y);
    best = { dirX: dir.x, dirY: dir.y, dist: d };
  }
  return best;
}

export type Aimer = {
  reset(): void;
  /**
   * Aim vector for this tick: lead the boss by its own velocity, then rotate by
   * seeded noise scaled by `1 - accuracy`. Call at most once per tick — it
   * tracks the boss's position between calls to estimate velocity.
   */
  aim(state: Readonly<GameState>, rng: Rng): { x: number; y: number };
};

/**
 * A bot that aimed straight at the boss would miss almost everything: a shot
 * takes ~27 ticks to cross 300 px and the boss moves 2.6 px/tick, so it has left
 * by the time the shot arrives. Every bot therefore leads its target — that is
 * what a competent player does — and the *only* thing `accuracy` degrades is the
 * final angle, which is the human-like error.
 */
export function makeAimer(accuracy: number): Aimer {
  const spread = BASE_AIM_ERROR * (1 - Math.min(1, Math.max(0, accuracy)));
  let lastX = 0;
  let lastY = 0;
  let lastTick = -1;

  return {
    reset(): void {
      lastTick = -1;
    },
    aim(state, rng) {
      const b = state.boss;
      const p = state.player;
      let bvx = 0;
      let bvy = 0;
      if (lastTick >= 0 && state.tick > lastTick) {
        const dt = state.tick - lastTick;
        bvx = (b.x - lastX) / dt;
        bvy = (b.y - lastY) / dt;
      }
      lastX = b.x;
      lastY = b.y;
      lastTick = state.tick;

      // One refinement pass is enough at these speeds.
      const shot = E.projectile.player.speed;
      let t = Math.hypot(b.x - p.x, b.y - p.y) / shot;
      t = Math.hypot(b.x + bvx * t - p.x, b.y + bvy * t - p.y) / shot;
      const angle = Math.atan2(b.y + bvy * t - p.y, b.x + bvx * t - p.x) + (rng.next() * 2 - 1) * spread;
      return { x: Math.cos(angle), y: Math.sin(angle) };
    },
  };
}

/** Assemble a `PlayerInput` from a move vector, an aim vector and two flags. */
export function input(
  move: { x: number; y: number },
  aim: { x: number; y: number },
  dash: boolean,
  shoot: boolean,
): PlayerInput {
  return {
    moveX: axis(move.x),
    moveY: axis(move.y),
    dash,
    aimX: aim.x,
    aimY: aim.y,
    shoot,
  };
}
