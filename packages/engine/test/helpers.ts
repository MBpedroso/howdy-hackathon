/**
 * Test-only helpers: fake runners and a deterministic scripted player.
 *
 * The scripted player is what stands in for a human in the determinism tests and the
 * bench. It is driven entirely by the engine's own PRNG from a *separate* seed, so a
 * whole match is reproducible from `(matchSeed, playerSeed)` and the input log it
 * produces replays byte-for-byte.
 */
import type { BossAction, BossView, DecideResult, RunnerFailure, StrategyMeta, StrategyRunner } from '@rematch/contract';
import { ENGINE_CONSTANTS as E } from '../src/constants.ts';
import { createGame } from '../src/game.ts';
import { createRng } from '../src/prng.ts';
import { step } from '../src/step.ts';
import type { GameState } from '../src/state.ts';
import type { InputLog, PlayerInput } from '../src/input.ts';

const META: StrategyMeta = { name: 'test', rationale: 'test runner', version: 1 };

/** A runner that always returns the same raw action. */
export function constantRunner(action: unknown, meta: StrategyMeta = META): StrategyRunner {
  return {
    meta,
    init(): void {},
    decide(): DecideResult {
      return { ok: true, action, elapsedMs: 0.01 };
    },
    memoryBytes(): number {
      return 2;
    },
    dispose(): void {},
  };
}

/** A runner that always fails with `failure` — used to test violation / kill handling. */
export function failingRunner(failure: RunnerFailure, meta: StrategyMeta = META): StrategyRunner {
  return {
    meta,
    init(): void {},
    decide(): DecideResult {
      return { ok: false, failure, elapsedMs: 0.01 };
    },
    memoryBytes(): number {
      return 2;
    },
    dispose(): void {},
  };
}

/** A runner driven by a callback, so a test can react to the view. */
export function scriptedRunner(fn: (view: BossView, tick: number) => unknown, meta: StrategyMeta = META): StrategyRunner {
  let calls = 0;
  return {
    meta,
    init(): void {
      calls = 0;
    },
    decide(view: BossView): DecideResult {
      const action = fn(view, calls);
      calls += 1;
      return { ok: true, action, elapsedMs: 0.01 };
    },
    memoryBytes(): number {
      return 2;
    },
    dispose(): void {},
  };
}

export const IDLE_RUNNER_ACTION: BossAction = { type: 'idle' };
export const idleRunner = (): StrategyRunner => constantRunner(IDLE_RUNNER_ACTION);

/** Digitize a unit component into a WASD axis. */
function axis(v: number): -1 | 0 | 1 {
  if (v > 0.4) return 1;
  if (v < -0.4) return -1;
  return 0;
}

/**
 * A stand-in for a competent human: kites at ~330 px, aims and shoots continuously,
 * walks out of slam circles, and spends the dash on the two things a player can
 * actually read — a charge telegraph and an inbound burst.
 *
 * It is deliberately a *player proxy*, not an optimal agent: it never predicts, and it
 * only reacts to things the renderer shows (telegraphs and live projectiles). The bench
 * uses it as the balance yardstick, so its win rate is the closest thing this package
 * has to spec AC 4 ("a human beats Round 1 in under 60 s").
 */
export function scriptedInput(state: GameState, rng: { next(): number }): PlayerInput {
  const p = state.player;
  const b = state.boss;
  const dx = b.x - p.x;
  const dy = b.y - p.y;
  const dist = Math.max(Math.hypot(dx, dy), 0.0001);
  const ux = dx / dist;
  const uy = dy / dist;

  let mx = 0;
  let my = 0;
  let dash = false;

  // A human shoots the thing that is about to touch them, so aim can switch targets.
  let aimX = ux;
  let aimY = uy;
  let nearMinionX = 0;
  let nearMinionY = 0;
  let nearMinionDist = Number.POSITIVE_INFINITY;
  for (const m of state.minions) {
    const d = Math.hypot(m.x - p.x, m.y - p.y);
    if (d < nearMinionDist) {
      nearMinionDist = d;
      nearMinionX = (m.x - p.x) / Math.max(d, 0.0001);
      nearMinionY = (m.y - p.y) / Math.max(d, 0.0001);
    }
  }
  if (nearMinionDist < 150) {
    aimX = nearMinionX;
    aimY = nearMinionY;
  }

  // 1. Inbound boss projectile: sidestep, dashing through it when the dash is up.
  let threatX = 0;
  let threatY = 0;
  let threatDist = Number.POSITIVE_INFINITY;
  for (const pr of state.projectiles) {
    if (pr.owner !== 'boss') continue;
    const rx = p.x - pr.x;
    const ry = p.y - pr.y;
    const d = Math.hypot(rx, ry);
    if (d > 110 || d >= threatDist) continue;
    // Only a projectile actually closing on us counts.
    if (pr.vx * rx + pr.vy * ry <= 0) continue;
    threatDist = d;
    threatX = rx / Math.max(d, 0.0001);
    threatY = ry / Math.max(d, 0.0001);
  }

  const telegraph = b.telegraph;
  const slamTarget = telegraph !== null && telegraph.type === 'slam' ? telegraph : null;
  const chargeTelegraph = telegraph !== null && telegraph.type === 'charge' ? telegraph : null;

  if (slamTarget !== null) {
    // 2. Walk (or dash) out of the circle.
    const sx = p.x - slamTarget.x;
    const sy = p.y - slamTarget.y;
    const sd = Math.max(Math.hypot(sx, sy), 0.0001);
    if (sd < 170) {
      mx = sx / sd;
      my = sy / sd;
      dash = sd < 120 && slamTarget.ticksLeft < 14;
    }
  }

  if (mx === 0 && my === 0 && chargeTelegraph !== null && dist < 320) {
    // 3. Step perpendicular to the charge line.
    const spin = rng.next() < 0.5 ? 1 : -1;
    mx = -Math.sin(chargeTelegraph.angle) * spin;
    my = Math.cos(chargeTelegraph.angle) * spin;
    dash = chargeTelegraph.ticksLeft < 8;
  }

  if (mx === 0 && my === 0 && threatDist < 70) {
    const spin = rng.next() < 0.5 ? 1 : -1;
    mx = -threatY * spin;
    my = threatX * spin;
    dash = threatDist < 40;
  }

  if (mx === 0 && my === 0 && nearMinionDist < 60) {
    // 4. Back off a minion that is closing to contact range.
    mx = -nearMinionX;
    my = -nearMinionY;
  }

  if (mx === 0 && my === 0) {
    // 5. Hold range and strafe.
    if (dist > 380) {
      mx = ux;
      my = uy;
    } else if (dist < 290) {
      mx = -ux;
      my = -uy;
    } else {
      const spin = rng.next() < 0.5 ? 1 : -1;
      mx = -uy * spin;
      my = ux * spin;
    }
  }

  // Stay off the walls: a cornered player cannot dodge, and a human learns that fast.
  const margin = 90;
  if (p.x < margin) mx = Math.abs(mx) + 0.5;
  else if (p.x > state.arena.w - margin) mx = -Math.abs(mx) - 0.5;
  if (p.y < margin) my = Math.abs(my) + 0.5;
  else if (p.y > state.arena.h - margin) my = -Math.abs(my) - 0.5;

  return {
    moveX: axis(mx),
    moveY: axis(my),
    dash,
    aimX,
    aimY,
    shoot: true,
  };
}

export type MatchResult = { final: GameState; log: InputLog };

/**
 * Play a full match with the scripted player and record the input log.
 * `replay(seed, result.log, runner)` reproduces `result.final` exactly.
 */
export function playMatch(
  seed: number,
  runner: StrategyRunner,
  playerSeed: number,
  maxTicks: number = E.round.maxTicks,
): MatchResult {
  const state = createGame(seed, runner);
  const rng = createRng(playerSeed);
  const log: InputLog = [];

  for (let i = 0; i < maxTicks; i += 1) {
    const input = scriptedInput(state, rng);
    log.push(input);
    step(state, input, runner);
    if (state.outcome !== 'playing') break;
  }

  return { final: state, log };
}

/** A purely PRNG-driven log — no state feedback, so it can be built up front. */
export function randomInputLog(seed: number, ticks: number): InputLog {
  const rng = createRng(seed);
  const log: InputLog = [];
  let moveX: -1 | 0 | 1 = 0;
  let moveY: -1 | 0 | 1 = 0;
  let angle = 0;

  for (let t = 0; t < ticks; t += 1) {
    if (t % 24 === 0) {
      moveX = (rng.int(3) - 1) as -1 | 0 | 1;
      moveY = (rng.int(3) - 1) as -1 | 0 | 1;
      angle = rng.next() * Math.PI * 2;
    }
    log.push({
      moveX,
      moveY,
      dash: rng.next() < 0.02,
      aimX: Math.cos(angle),
      aimY: Math.sin(angle),
      shoot: rng.next() < 0.8,
    });
  }
  return log;
}
