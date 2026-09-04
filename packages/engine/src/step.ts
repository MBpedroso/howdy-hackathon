/**
 * `step` — the single fixed-timestep update. 60 of these per second, forever.
 *
 * ## Phase order (determinism depends on it; do not reorder)
 *
 *  a. `tick += 1`, then decrement every cooldown / timer (clamped at 0).
 *  b. **Player**: start a dash if requested, integrate velocity (diagonals normalized,
 *     dash overrides), clamp to the arena, accumulate the position heat cell, then shoot.
 *  c. **Boss**: if a telegraph is running, count it down and resolve it — the boss does
 *     NOT call `decide` while telegraphing, so a tell can never be cancelled. Else if a
 *     charge is in flight, advance it. Otherwise build a fresh `BossView`, call
 *     `runner.decide`, validate, and apply.
 *  d. **Minions**: chase the player, contact damage on a per-minion cooldown.
 *  e. **Projectiles**: integrate, expire on ttl, cull outside the arena, then collide.
 *  f. **Outcome**: boss dead -> `playerWon`; player dead -> `bossWon`; tick cap ->
 *     `timeout`.
 *
 * The player acts before the boss on purpose: the boss's `BossView` therefore contains
 * the player's *current* tick position, which is the fairest read for a strategy and
 * makes `history.playerShotsDuring` reflect the boss state the player could see.
 *
 * ## Mutation
 * `step` mutates `state` in place and returns the same object — cloning per tick would
 * dominate the runtime. Callers that need frames use `cloneState` explicitly.
 *
 * ## Math
 * Only `+ - * /`, `Math.sqrt/hypot/atan2/cos/sin/floor/round/min/max/abs`. Every
 * position and velocity is quantized with `q()` after integration.
 */
import { validateAction, type BossAction, type BossView, type StrategyRunner } from '@rematch/contract';
import { CONSTANTS } from '@rematch/contract';
import { COOLDOWNS, ENGINE_CONSTANTS as E, TELEGRAPHS, q } from './constants.ts';
import type { PlayerInput } from './input.ts';
import {
  activePrimitives,
  pushEvent,
  pushViolation,
  type GameState,
  type Minion,
  type Projectile,
} from './state.ts';
import { buildBossView } from './view.ts';

const TAU = Math.PI * 2;
const HEAT_COLS = 8;

function dec(v: number): number {
  return v > 0 ? v - 1 : 0;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Dash-direction bin: bin 0 centred on +x, 8 bins counter-clockwise. */
export function dirBin(dx: number, dy: number): number {
  let a = Math.atan2(dy, dx);
  if (a < 0) a += TAU;
  const bin = Math.round(a / (TAU / HEAT_COLS)) % HEAT_COLS;
  return bin < 0 ? bin + HEAT_COLS : bin;
}

function isPlayerInvulnerable(state: GameState): boolean {
  return state.player.dashTicksLeft > 0 || state.player.invulnTicks > 0;
}

/** Apply damage to the player. Returns false if it was absorbed by invulnerability. */
function damagePlayer(state: GameState, amount: number): boolean {
  if (isPlayerInvulnerable(state)) return false;
  const p = state.player;
  p.hp = Math.max(0, q(p.hp - amount));
  p.invulnTicks = E.player.hitInvulnTicks;
  state.damageTaken += amount;
  pushEvent(state, 'playerHit', p.hp);
  return true;
}

// ---------------------------------------------------------------- a. timers

function tickTimers(state: GameState): void {
  const p = state.player;
  p.shotCooldown = dec(p.shotCooldown);
  p.dashCooldown = dec(p.dashCooldown);
  p.dashTicksLeft = dec(p.dashTicksLeft);
  p.invulnTicks = dec(p.invulnTicks);

  const cd = state.boss.cooldowns;
  cd.move = dec(cd.move);
  cd.burst = dec(cd.burst);
  cd.charge = dec(cd.charge);
  cd.slam = dec(cd.slam);
  cd.spawn = dec(cd.spawn);

  for (const m of state.minions) m.hitCooldown = dec(m.hitCooldown);
}

// ---------------------------------------------------------------- b. player

function updatePlayer(state: GameState, input: PlayerInput): void {
  const p = state.player;
  const r = E.player.radius;

  const aimLen = Math.hypot(input.aimX, input.aimY);
  const moveLen = Math.hypot(input.moveX, input.moveY);

  // Dash start. Cooldowns are checked before movement so the dash applies this tick.
  if (input.dash && p.dashCooldown === 0 && p.dashTicksLeft === 0) {
    let dx: number;
    let dy: number;
    if (moveLen > 0) {
      dx = input.moveX / moveLen;
      dy = input.moveY / moveLen;
    } else if (aimLen > 0) {
      dx = input.aimX / aimLen;
      dy = input.aimY / aimLen;
    } else {
      dx = Math.cos(p.facing);
      dy = Math.sin(p.facing);
    }
    p.dashDirX = q(dx);
    p.dashDirY = q(dy);
    p.dashTicksLeft = E.player.dashTicks;
    p.dashCooldown = E.player.dashCooldown;
    const bin = dirBin(dx, dy);
    state.history.playerDashDirs[bin] = (state.history.playerDashDirs[bin] ?? 0) + 1;
    state.counts.dashes += 1;
    pushEvent(state, 'playerDash', bin);
  }

  // Velocity: dash overrides walk; diagonals are normalized, never faster.
  if (p.dashTicksLeft > 0) {
    p.vx = q(p.dashDirX * E.player.dashSpeed);
    p.vy = q(p.dashDirY * E.player.dashSpeed);
  } else if (moveLen > 0) {
    p.vx = q((input.moveX / moveLen) * E.player.speed);
    p.vy = q((input.moveY / moveLen) * E.player.speed);
  } else {
    p.vx = 0;
    p.vy = 0;
  }

  p.x = clamp(q(p.x + p.vx), r, state.arena.w - r);
  p.y = clamp(q(p.y + p.vy), r, state.arena.h - r);

  if (aimLen > 0) {
    p.facing = q(Math.atan2(input.aimY, input.aimX));
  } else if (p.vx !== 0 || p.vy !== 0) {
    p.facing = q(Math.atan2(p.vy, p.vx));
  }

  // Position heat: accumulated counts, normalized only in `buildBossView`.
  const cellW = state.arena.w / HEAT_COLS;
  const cellH = state.arena.h / HEAT_COLS;
  const col = clamp(Math.floor(p.x / cellW), 0, HEAT_COLS - 1);
  const row = clamp(Math.floor(p.y / cellH), 0, HEAT_COLS - 1);
  const cell = row * HEAT_COLS + col;
  state.history.playerPosHeat[cell] = (state.history.playerPosHeat[cell] ?? 0) + 1;

  // Shooting.
  if (input.shoot && p.shotCooldown === 0 && aimLen > 0 && state.projectiles.length < E.projectile.maxAlive) {
    const ux = input.aimX / aimLen;
    const uy = input.aimY / aimLen;
    const off = E.player.radius + E.projectile.radius;
    state.projectiles.push({
      x: q(p.x + ux * off),
      y: q(p.y + uy * off),
      vx: q(ux * E.projectile.player.speed),
      vy: q(uy * E.projectile.player.speed),
      owner: 'player',
      ttl: E.projectile.player.ttl,
    });
    p.shotCooldown = E.player.shotCooldown;
    p.lastShotTick = state.tick;
    state.counts.shots += 1;
    for (const prim of activePrimitives(state)) {
      state.history.playerShotsDuring[prim] += 1;
    }
    pushEvent(state, 'playerShot');
  }
}

// ------------------------------------------------------------------ c. boss

function resolveSlam(state: GameState, x: number, y: number): void {
  const d = Math.hypot(state.player.x - x, state.player.y - y);
  if (d <= E.slam.radius && damagePlayer(state, E.slam.damage)) {
    pushEvent(state, 'bossSlamHit', q(d));
  } else {
    pushEvent(state, 'bossSlamMiss', q(d));
  }
}

function advanceCharge(state: GameState): void {
  const b = state.boss;
  const r = E.boss.radius;
  b.x = clamp(q(b.x + Math.cos(b.chargeAngle) * E.charge.speed), r, state.arena.w - r);
  b.y = clamp(q(b.y + Math.sin(b.chargeAngle) * E.charge.speed), r, state.arena.h - r);
  b.chargeTicksLeft = dec(b.chargeTicksLeft);

  if (!b.chargeHit) {
    const d = Math.hypot(state.player.x - b.x, state.player.y - b.y);
    if (d < E.boss.radius + E.player.radius && damagePlayer(state, E.charge.damage)) {
      b.chargeHit = true;
      pushEvent(state, 'bossChargeHit');
    }
  }
}

/**
 * Spawn a burst. Two shapes, chosen by `count` (see `ENGINE_CONSTANTS.burst`):
 *
 *  - `count === ringCount` (8): a full 2*PI ring — `count` evenly spaced projectiles,
 *    the first exactly on `angle`, step `2*PI / count`. Area denial: the player dashes
 *    through it or outruns it, sidestepping does not work.
 *  - otherwise (3, 5): an aimed cone centred on `angle`, `spreadPerShot` between shots.
 */
function spawnBurst(state: GameState, angle: number, count: number): void {
  const b = state.boss;
  const off = E.boss.radius + E.projectile.radius;
  const ring = count === E.burst.ringCount;
  for (let i = 0; i < count; i += 1) {
    if (state.projectiles.length >= E.projectile.maxAlive) break;
    const a = ring ? angle + (TAU / count) * i : angle + E.burst.spreadPerShot * (i - (count - 1) / 2);
    const ux = Math.cos(a);
    const uy = Math.sin(a);
    state.projectiles.push({
      x: q(b.x + ux * off),
      y: q(b.y + uy * off),
      vx: q(ux * E.projectile.boss.speed),
      vy: q(uy * E.projectile.boss.speed),
      owner: 'boss',
      ttl: E.projectile.boss.ttl,
    });
  }
}

/**
 * Apply a validated action. Cooldowns are set on action **START**, which is what makes
 * telegraphed actions impossible to double-queue: `charge` is on cooldown for its whole
 * 20-tick tell, so `validateAction` rejects a second charge before it reaches here.
 */
function applyAction(state: GameState, action: BossAction): void {
  const b = state.boss;
  b.lastAction = action.type;

  switch (action.type) {
    case 'idle':
      return;

    case 'move': {
      const r = E.boss.radius;
      b.x = clamp(q(b.x + action.dx * E.boss.speed), r, state.arena.w - r);
      b.y = clamp(q(b.y + action.dy * E.boss.speed), r, state.arena.h - r);
      b.facing = q(Math.atan2(action.dy, action.dx));
      b.cooldowns.move = COOLDOWNS.move;
      state.counts.primitives.move += 1;
      return;
    }

    case 'burst': {
      b.facing = q(action.angle);
      spawnBurst(state, action.angle, action.count);
      b.cooldowns.burst = COOLDOWNS.burst;
      state.counts.primitives.burst += 1;
      pushEvent(state, 'bossBurst', action.count);
      return;
    }

    case 'charge': {
      b.facing = q(action.angle);
      b.telegraph = { type: 'charge', ticksLeft: TELEGRAPHS.charge, angle: action.angle };
      b.cooldowns.charge = COOLDOWNS.charge;
      state.counts.primitives.charge += 1;
      pushEvent(state, 'bossChargeStart', q(action.angle));
      return;
    }

    case 'slam': {
      b.telegraph = { type: 'slam', ticksLeft: TELEGRAPHS.slam, x: q(action.x), y: q(action.y) };
      b.cooldowns.slam = COOLDOWNS.slam;
      state.counts.primitives.slam += 1;
      pushEvent(state, 'bossSlamStart');
      return;
    }

    case 'spawn': {
      // At the cap the call is wasted, not queued: no minion, no cooldown, and a
      // violation so the Coder agent learns it burned a tick.
      if (state.minions.length >= CONSTANTS.limits.maxMinionsAlive) {
        b.lastAction = 'idle';
        pushViolation(state, `spawn at minion cap (${CONSTANTS.limits.maxMinionsAlive} alive)`);
        return;
      }
      const r = E.minion.radius;
      const minion: Minion = {
        id: state.nextId,
        x: clamp(q(action.x), r, state.arena.w - r),
        y: clamp(q(action.y), r, state.arena.h - r),
        hp: E.minion.hp,
        // Spawn grace: a minion dropped on the player's head cannot hit instantly.
        hitCooldown: E.minion.spawnGraceTicks,
      };
      state.nextId += 1;
      state.minions.push(minion);
      state.minionsSpawned += 1;
      b.cooldowns.spawn = COOLDOWNS.spawn;
      state.counts.primitives.spawn += 1;
      pushEvent(state, 'bossSpawn', minion.id);
      return;
    }
  }
}

function updateBoss(state: GameState, runner: StrategyRunner): void {
  const b = state.boss;

  // A committed tell runs to completion; `decide` is not called.
  if (b.telegraph !== null) {
    b.telegraph.ticksLeft = dec(b.telegraph.ticksLeft);
    if (b.telegraph.ticksLeft <= 0) {
      const t = b.telegraph;
      b.telegraph = null;
      if (t.type === 'charge') {
        b.chargeAngle = t.angle;
        b.chargeTicksLeft = E.charge.ticks;
        b.chargeHit = false;
        b.facing = q(t.angle);
      } else {
        resolveSlam(state, t.x, t.y);
      }
    }
    return;
  }

  if (b.chargeTicksLeft > 0) {
    advanceCharge(state);
    return;
  }

  const view: BossView = buildBossView(state);
  const result = runner.decide(view);

  let action: BossAction = { type: 'idle' };
  if (!result.ok) {
    pushViolation(state, `runner ${result.failure.kind}`);
    if (result.failure.kind === 'timeout' || result.failure.kind === 'memory') {
      state.strategyKilled = true;
    }
  } else {
    const validated = validateAction(result.action, view);
    if (validated.ok) {
      action = validated.action;
    } else {
      pushViolation(state, validated.reason);
    }
  }

  applyAction(state, action);
}

// --------------------------------------------------------------- d. minions

function updateMinions(state: GameState): void {
  const p = state.player;
  const r = E.minion.radius;
  const contact = E.minion.radius + E.player.radius;
  for (const m of state.minions) {
    const dx = p.x - m.x;
    const dy = p.y - m.y;
    const d = Math.hypot(dx, dy);
    // Stop ON contact rather than walking through the player: a naive chaser that
    // overshoots every tick oscillates around the target and reads as a bug.
    if (d > contact) {
      m.x = clamp(q(m.x + (dx / d) * E.minion.speed), r, state.arena.w - r);
      m.y = clamp(q(m.y + (dy / d) * E.minion.speed), r, state.arena.h - r);
    }
    const after = Math.hypot(p.x - m.x, p.y - m.y);
    if (after < contact + 0.5 && m.hitCooldown === 0) {
      if (damagePlayer(state, E.minion.damage)) m.hitCooldown = E.minion.hitCooldown;
    }
  }
}

// ----------------------------------------------------------- e. projectiles

function damageBoss(state: GameState, amount: number): void {
  const b = state.boss;
  b.hp = Math.max(0, q(b.hp - amount));
  state.damageDealt += amount;
  pushEvent(state, 'bossHit', b.hp);
}

function updateProjectiles(state: GameState): void {
  const kept: Projectile[] = [];
  const pl = state.player;

  for (const pr of state.projectiles) {
    pr.x = q(pr.x + pr.vx);
    pr.y = q(pr.y + pr.vy);
    pr.ttl = pr.ttl - 1;

    if (pr.ttl <= 0) continue;
    if (pr.x < 0 || pr.x > state.arena.w || pr.y < 0 || pr.y > state.arena.h) continue;

    let consumed = false;

    if (pr.owner === 'player') {
      const dmg = E.projectile.player.damage;
      if (
        state.boss.hp > 0 &&
        Math.hypot(state.boss.x - pr.x, state.boss.y - pr.y) < E.boss.radius + E.projectile.radius
      ) {
        damageBoss(state, dmg);
        consumed = true;
      } else {
        for (const m of state.minions) {
          if (m.hp <= 0) continue;
          if (Math.hypot(m.x - pr.x, m.y - pr.y) < E.minion.radius + E.projectile.radius) {
            m.hp = Math.max(0, q(m.hp - dmg));
            state.damageToMinions += dmg;
            consumed = true;
            break;
          }
        }
      }
    } else if (Math.hypot(pl.x - pr.x, pl.y - pr.y) < E.player.radius + E.projectile.radius) {
      // Boss shots pass harmlessly THROUGH an invulnerable (dashing or just-hit)
      // player rather than being absorbed — dashing through a burst is the reward.
      consumed = damagePlayer(state, E.projectile.boss.damage);
    }

    if (!consumed) kept.push(pr);
  }

  state.projectiles = kept;

  if (state.minions.length > 0) {
    const alive: Minion[] = [];
    for (const m of state.minions) {
      if (m.hp > 0) alive.push(m);
      else pushEvent(state, 'minionDown', m.id);
    }
    state.minions = alive;
  }
}

// --------------------------------------------------------------- f. outcome

function resolveOutcome(state: GameState): void {
  if (state.boss.hp <= 0) state.outcome = 'playerWon';
  else if (state.player.hp <= 0) state.outcome = 'bossWon';
  // Running out the clock is a BOSS win for balance purposes (spec §6.2 measures
  // `win_rate(boss vs ...)`): a boss that survives 60 seconds was not beaten.
  else if (state.tick >= E.round.maxTicks) state.outcome = 'timeout';

  if (state.outcome !== 'playing') pushEvent(state, 'outcome', state.outcome);
}

/** Advance the world exactly one tick. Mutates and returns `state`. */
export function step(state: GameState, input: PlayerInput, runner: StrategyRunner): GameState {
  if (state.outcome !== 'playing') return state;

  state.tick += 1;
  tickTimers(state);
  updatePlayer(state, input);
  updateBoss(state, runner);
  updateMinions(state);
  updateProjectiles(state);
  resolveOutcome(state);

  return state;
}
