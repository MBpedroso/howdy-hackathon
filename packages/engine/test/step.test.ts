import { describe, expect, it } from 'vitest';
import { CONSTANTS } from '@rematch/contract';
import { ENGINE_CONSTANTS as E } from '../src/constants.ts';
import { createGame } from '../src/game.ts';
import { makeInput } from '../src/input.ts';
import { dirBin, step } from '../src/step.ts';
import { constantRunner, failingRunner, idleRunner, scriptedRunner } from './helpers.ts';
import type { GameState } from '../src/state.ts';

function run(state: GameState, runner: Parameters<typeof step>[2], ticks: number, input = makeInput()): void {
  for (let i = 0; i < ticks; i += 1) step(state, input, runner);
}

describe('player movement', () => {
  it('caps speed and normalizes diagonals', () => {
    const runner = idleRunner();
    const straight = createGame(1, runner);
    step(straight, makeInput({ moveX: 1 }), runner);
    expect(Math.hypot(straight.player.vx, straight.player.vy)).toBeCloseTo(E.player.speed, 3);

    const diagonal = createGame(1, runner);
    step(diagonal, makeInput({ moveX: 1, moveY: 1 }), runner);
    expect(Math.hypot(diagonal.player.vx, diagonal.player.vy)).toBeCloseTo(E.player.speed, 3);
  });

  it('clamps the player inside the arena', () => {
    const runner = idleRunner();
    const state = createGame(1, runner);
    run(state, runner, 600, makeInput({ moveX: -1, moveY: -1 }));
    expect(state.player.x).toBe(E.player.radius);
    expect(state.player.y).toBe(E.player.radius);

    run(state, runner, 600, makeInput({ moveX: 1, moveY: 1 }));
    expect(state.player.x).toBe(E.arena.w - E.player.radius);
    expect(state.player.y).toBe(E.arena.h - E.player.radius);
  });

  it('accumulates position heat into the 8x8 grid', () => {
    const runner = idleRunner();
    const state = createGame(1, runner);
    run(state, runner, 10);
    // Player starts at (400, 620): col 4, row 6 -> cell 52.
    expect(state.history.playerPosHeat[52]).toBe(10);
    expect(state.history.playerPosHeat.reduce((a, b) => a + b, 0)).toBe(10);
  });
});

describe('dash', () => {
  it('bursts speed for dashTicks then reverts, and sets the cooldown', () => {
    const runner = idleRunner();
    const state = createGame(1, runner);
    step(state, makeInput({ dash: true, moveX: 1 }), runner);

    expect(state.player.dashTicksLeft).toBe(E.player.dashTicks);
    expect(state.player.dashCooldown).toBe(E.player.dashCooldown);
    expect(Math.hypot(state.player.vx, state.player.vy)).toBeCloseTo(E.player.dashSpeed, 3);

    run(state, runner, E.player.dashTicks, makeInput({ moveX: 1 }));
    expect(state.player.dashTicksLeft).toBe(0);
    expect(Math.hypot(state.player.vx, state.player.vy)).toBeCloseTo(E.player.speed, 3);
  });

  it('grants invulnerability: boss projectiles pass through a dashing player', () => {
    const runner = idleRunner();
    const dashing = createGame(1, runner);
    dashing.projectiles.push({ x: dashing.player.x, y: dashing.player.y, vx: 0, vy: 0, owner: 'boss', ttl: 60 });
    step(dashing, makeInput({ dash: true }), runner);
    expect(dashing.player.hp).toBe(E.player.hp);
    expect(dashing.projectiles).toHaveLength(1); // passed through, not absorbed

    const walking = createGame(1, runner);
    walking.projectiles.push({ x: walking.player.x, y: walking.player.y, vx: 0, vy: 0, owner: 'boss', ttl: 60 });
    step(walking, makeInput(), runner);
    expect(walking.player.hp).toBe(E.player.hp - E.projectile.boss.damage);
    expect(walking.projectiles).toHaveLength(0);
  });

  it('records the dash direction in the right one of 8 bins', () => {
    const runner = idleRunner();
    const state = createGame(1, runner);
    step(state, makeInput({ dash: true, moveX: 1 }), runner);
    expect(state.history.playerDashDirs[0]).toBe(1);
    expect(state.counts.dashes).toBe(1);

    run(state, runner, E.player.dashCooldown);
    step(state, makeInput({ dash: true, moveY: 1 }), runner);
    expect(state.history.playerDashDirs[2]).toBe(1);
    expect(state.counts.dashes).toBe(2);
  });

  it('dirBin: bin 0 is +x, counter-clockwise, 8 bins', () => {
    expect(dirBin(1, 0)).toBe(0);
    expect(dirBin(1, 1)).toBe(1);
    expect(dirBin(0, 1)).toBe(2);
    expect(dirBin(-1, 0)).toBe(4);
    expect(dirBin(0, -1)).toBe(6);
    expect(dirBin(1, -1)).toBe(7);
  });

  it('ignores a dash request while on cooldown', () => {
    const runner = idleRunner();
    const state = createGame(1, runner);
    run(state, runner, 20, makeInput({ dash: true, moveX: 1 }));
    expect(state.counts.dashes).toBe(1);
  });
});

describe('shooting', () => {
  it('respects the shot cooldown and records lastShotTick', () => {
    const runner = idleRunner();
    const state = createGame(1, runner);
    run(state, runner, E.player.shotCooldown, makeInput({ shoot: true, aimX: 0, aimY: -1 }));
    expect(state.counts.shots).toBe(1);
    expect(state.player.lastShotTick).toBe(1);

    step(state, makeInput({ shoot: true, aimX: 0, aimY: -1 }), runner);
    expect(state.counts.shots).toBe(2);
    expect(state.player.lastShotTick).toBe(E.player.shotCooldown + 1);
  });

  it('credits shots to the primitive that was active', () => {
    const runner = constantRunner({ type: 'slam', x: 400, y: 400 });
    const state = createGame(1, runner);
    // Tick 1 starts the slam telegraph; from tick 2 on, 'slam' is active.
    run(state, runner, 30, makeInput({ shoot: true, aimX: 0, aimY: -1 }));
    expect(state.history.playerShotsDuring.slam).toBeGreaterThan(0);
    expect(state.history.playerShotsDuring.burst).toBe(0);
  });
});

describe('boss actions and cooldowns', () => {
  it('caps boss move speed and normalizes the vector', () => {
    const runner = constantRunner({ type: 'move', dx: 3, dy: 4 });
    const state = createGame(1, runner);
    const { x, y } = state.boss;
    step(state, makeInput(), runner);
    expect(Math.hypot(state.boss.x - x, state.boss.y - y)).toBeCloseTo(E.boss.speed, 3);
  });

  it('sets the cooldown on action START for every primitive', () => {
    const cases = [
      { action: { type: 'burst', angle: 0, count: 3 }, name: 'burst' },
      { action: { type: 'charge', angle: 0 }, name: 'charge' },
      { action: { type: 'slam', x: 400, y: 400 }, name: 'slam' },
      { action: { type: 'spawn', x: 400, y: 400 }, name: 'spawn' },
    ] as const;

    for (const { action, name } of cases) {
      const runner = constantRunner(action);
      const state = createGame(1, runner);
      step(state, makeInput(), runner);
      expect(state.boss.cooldowns[name], name).toBe(CONSTANTS.cooldowns[name]);
      expect(state.violations, name).toBe(0);
    }
  });

  it('coerces an on-cooldown action to idle and counts one violation per tick', () => {
    const runner = constantRunner({ type: 'burst', angle: 0, count: 3 });
    const state = createGame(1, runner);
    step(state, makeInput(), runner);
    expect(state.violations).toBe(0);
    expect(state.counts.primitives.burst).toBe(1);

    step(state, makeInput(), runner);
    expect(state.violations).toBe(1);
    expect(state.counts.primitives.burst).toBe(1);
    expect(state.boss.lastAction).toBe('idle');

    step(state, makeInput(), runner);
    expect(state.violations).toBe(2);
  });

  it('counts a violation for a malformed action but keeps simulating', () => {
    const runner = constantRunner({ type: 'burst', angle: Number.NaN, count: 4 });
    const state = createGame(1, runner);
    run(state, runner, 5);
    expect(state.violations).toBe(5);
    expect(state.projectiles).toHaveLength(0);
    expect(state.outcome).toBe('playing');
  });

  it('does not count a violation for a zero-length move (canonicalized to idle)', () => {
    const runner = constantRunner({ type: 'move', dx: 0, dy: 0 });
    const state = createGame(1, runner);
    run(state, runner, 5);
    expect(state.violations).toBe(0);
    expect(state.boss.lastAction).toBe('idle');
  });

  it('burst spawns `count` boss projectiles at boss projectile speed', () => {
    for (const count of [3, 5, 8] as const) {
      const runner = constantRunner({ type: 'burst', angle: Math.PI / 2, count });
      const state = createGame(1, runner);
      step(state, makeInput(), runner);
      expect(state.projectiles, `count=${count}`).toHaveLength(count);
      for (const p of state.projectiles) {
        expect(p.owner).toBe('boss');
        expect(Math.hypot(p.vx, p.vy)).toBeCloseTo(E.projectile.boss.speed, 2);
      }
    }
  });

  it('burst counts 3 and 5 are cones centred on the angle', () => {
    for (const count of [3, 5] as const) {
      const angle = Math.PI / 2;
      const runner = constantRunner({ type: 'burst', angle, count });
      const state = createGame(1, runner);
      step(state, makeInput(), runner);

      const angles = state.projectiles.map((p) => Math.atan2(p.vy, p.vx));
      // Symmetric about `angle`, `spreadPerShot` between neighbours, total width < 2PI.
      for (let i = 0; i < angles.length; i += 1) {
        expect(angles[i]!, `count=${count} shot=${i}`).toBeCloseTo(
          angle + E.burst.spreadPerShot * (i - (count - 1) / 2),
          3,
        );
      }
      const width = angles[angles.length - 1]! - angles[0]!;
      expect(width, `count=${count}`).toBeCloseTo(E.burst.spreadPerShot * (count - 1), 3);
      expect(width).toBeLessThan(Math.PI * 2);
    }
  });

  it('burst count 8 is a full 2PI ring: evenly spaced, first shot on the angle', () => {
    const count = E.burst.ringCount;
    const angle = 0.7;
    const runner = constantRunner({ type: 'burst', angle, count });
    const state = createGame(1, runner);
    step(state, makeInput(), runner);

    expect(state.projectiles).toHaveLength(count);
    const step2Pi = (Math.PI * 2) / count;
    const norm = (a: number): number => {
      let v = a % (Math.PI * 2);
      if (v < 0) v += Math.PI * 2;
      return v;
    };

    for (let i = 0; i < count; i += 1) {
      const p = state.projectiles[i]!;
      // Direction: evenly spaced, starting exactly at `angle`.
      expect(norm(Math.atan2(p.vy, p.vx)), `shot=${i}`).toBeCloseTo(norm(angle + step2Pi * i), 3);
      // Spawn point sits on the ring around the boss, in the same direction. It has
      // already been integrated once by this tick's projectile phase, so the radius is
      // the spawn offset plus one tick of travel.
      const dx = p.x - state.boss.x;
      const dy = p.y - state.boss.y;
      expect(norm(Math.atan2(dy, dx)), `spawn=${i}`).toBeCloseTo(norm(angle + step2Pi * i), 3);
      expect(Math.hypot(dx, dy)).toBeCloseTo(
        E.boss.radius + E.projectile.radius + E.projectile.boss.speed,
        2,
      );
    }

    // A ring covers every direction: the 8 dash bins are all hit exactly once.
    const bins = state.projectiles.map((p) => dirBin(p.vx, p.vy)).sort((a, b) => a - b);
    expect(bins).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});

describe('telegraphs', () => {
  it('charge telegraphs for exactly 20 ticks, then charges for chargeTicks', () => {
    const runner = constantRunner({ type: 'charge', angle: Math.PI / 2 });
    const state = createGame(1, runner);
    step(state, makeInput(), runner);
    expect(state.boss.telegraph).toEqual({ type: 'charge', ticksLeft: CONSTANTS.telegraphs.charge, angle: Math.PI / 2 });

    run(state, runner, CONSTANTS.telegraphs.charge - 1);
    expect(state.boss.telegraph?.ticksLeft).toBe(1);
    expect(state.boss.chargeTicksLeft).toBe(0);

    step(state, makeInput(), runner);
    expect(state.boss.telegraph).toBeNull();
    expect(state.boss.chargeTicksLeft).toBe(E.charge.ticks);

    const before = state.boss.y;
    step(state, makeInput(), runner);
    expect(state.boss.y - before).toBeCloseTo(E.charge.speed, 3);
  });

  it('slam telegraphs for exactly 40 ticks, then resolves once', () => {
    const runner = constantRunner({ type: 'slam', x: 400, y: 620 });
    const state = createGame(1, runner);
    step(state, makeInput(), runner);
    expect(state.boss.telegraph?.type).toBe('slam');
    expect(state.boss.telegraph?.ticksLeft).toBe(CONSTANTS.telegraphs.slam);

    run(state, runner, CONSTANTS.telegraphs.slam - 1);
    expect(state.boss.telegraph?.ticksLeft).toBe(1);
    expect(state.player.hp).toBe(E.player.hp);

    step(state, makeInput(), runner);
    expect(state.boss.telegraph).toBeNull();
    // Player never moved, so the slam lands on them.
    expect(state.player.hp).toBe(E.player.hp - E.slam.damage);
    expect(state.events.some((e) => e.kind === 'bossSlamHit')).toBe(true);
  });

  it('a slam that misses deals no damage', () => {
    const runner = constantRunner({ type: 'slam', x: 40, y: 40 });
    const state = createGame(1, runner);
    run(state, runner, CONSTANTS.telegraphs.slam + 1);
    expect(state.player.hp).toBe(E.player.hp);
    expect(state.events.some((e) => e.kind === 'bossSlamMiss')).toBe(true);
  });

  it('does not call decide while telegraphing', () => {
    let calls = 0;
    const runner = scriptedRunner(() => {
      calls += 1;
      return { type: 'charge', angle: 0 };
    });
    const state = createGame(1, runner);
    run(state, runner, CONSTANTS.telegraphs.charge);
    expect(calls).toBe(1);
  });
});

describe('minions', () => {
  it('caps concurrent minions at 2 and counts a violation past the cap', () => {
    const runner = constantRunner({ type: 'spawn', x: 400, y: 400 });
    const state = createGame(1, runner);
    state.player.hp = 1000; // survive long enough to hit the cap

    let maxAlive = 0;
    for (let i = 0; i < 700; i += 1) {
      step(state, makeInput(), runner);
      maxAlive = Math.max(maxAlive, state.minions.length);
      expect(state.minions.length).toBeLessThanOrEqual(CONSTANTS.limits.maxMinionsAlive);
    }

    expect(maxAlive).toBe(CONSTANTS.limits.maxMinionsAlive);
    expect(state.minionsSpawned).toBe(2);
    expect(state.violations).toBeGreaterThan(0);
  });

  it('minions chase the player and deal contact damage on their own cooldown', () => {
    const runner = constantRunner({ type: 'spawn', x: 400, y: 500 });
    const state = createGame(1, runner);
    run(state, runner, 90);
    expect(state.minions).toHaveLength(1);
    expect(state.player.hp).toBeLessThan(E.player.hp);
  });

  it('player projectiles kill minions', () => {
    const runner = constantRunner({ type: 'spawn', x: 400, y: 560 });
    const state = createGame(1, runner);
    run(state, runner, 120, makeInput({ shoot: true, aimX: 0, aimY: -1 }));
    expect(state.damageToMinions).toBeGreaterThan(0);
    expect(state.events.some((e) => e.kind === 'minionDown')).toBe(true);
  });
});

describe('projectiles', () => {
  it('culls projectiles that leave the arena', () => {
    const runner = idleRunner();
    const state = createGame(1, runner);
    state.projectiles.push({ x: 795, y: 400, vx: 11, vy: 0, owner: 'player', ttl: 90 });
    step(state, makeInput(), runner);
    expect(state.projectiles).toHaveLength(0);
  });

  it('culls projectiles when the ttl runs out', () => {
    const runner = idleRunner();
    const state = createGame(1, runner);
    state.projectiles.push({ x: 400, y: 400, vx: 0, vy: 0, owner: 'player', ttl: 3 });
    run(state, runner, 2);
    expect(state.projectiles).toHaveLength(1);
    step(state, makeInput(), runner);
    expect(state.projectiles).toHaveLength(0);
  });

  it('player projectiles damage the boss and are consumed', () => {
    const runner = idleRunner();
    const state = createGame(1, runner);
    state.projectiles.push({ x: state.boss.x, y: state.boss.y, vx: 0, vy: 0, owner: 'boss', ttl: 60 });
    state.projectiles.push({ x: state.boss.x, y: state.boss.y, vx: 0, vy: 0, owner: 'player', ttl: 60 });
    step(state, makeInput(), runner);
    expect(state.boss.hp).toBe(E.boss.hp - E.projectile.player.damage);
    expect(state.damageDealt).toBe(E.projectile.player.damage);
    // The boss's own shot is not consumed by the boss.
    expect(state.projectiles).toHaveLength(1);
    expect(state.projectiles[0]?.owner).toBe('boss');
  });
});

describe('outcomes', () => {
  it('playerWon when the boss reaches 0 hp', () => {
    const runner = idleRunner();
    const state = createGame(1, runner);
    state.boss.hp = 3;
    run(state, runner, 90, makeInput({ shoot: true, aimX: 0, aimY: -1 }));
    expect(state.boss.hp).toBe(0);
    expect(state.outcome).toBe('playerWon');
  });

  it('bossWon when the player reaches 0 hp', () => {
    const runner = constantRunner({ type: 'burst', angle: Math.PI / 2, count: 3 });
    const state = createGame(1, runner);
    state.player.hp = 1;
    run(state, runner, 150);
    expect(state.player.hp).toBe(0);
    expect(state.outcome).toBe('bossWon');
  });

  it('timeout at the tick cap, and stops simulating afterwards', () => {
    const runner = idleRunner();
    const state = createGame(1, runner);
    run(state, runner, E.round.maxTicks);
    expect(state.tick).toBe(E.round.maxTicks);
    expect(state.outcome).toBe('timeout');

    run(state, runner, 10);
    expect(state.tick).toBe(E.round.maxTicks);
  });
});

describe('runner failures', () => {
  it('sets strategyKilled on a timeout failure and keeps the round alive', () => {
    const runner = failingRunner({ kind: 'timeout', ms: 6.2 });
    const state = createGame(1, runner);
    run(state, runner, 3);
    expect(state.strategyKilled).toBe(true);
    expect(state.violations).toBe(3);
    expect(state.outcome).toBe('playing');
    expect(state.boss.lastAction).toBe('idle');
  });

  it('sets strategyKilled on a memory failure', () => {
    const runner = failingRunner({ kind: 'memory', bytes: 999_999 });
    const state = createGame(1, runner);
    step(state, makeInput(), runner);
    expect(state.strategyKilled).toBe(true);
  });

  it('does NOT set strategyKilled on a throw or a load failure', () => {
    for (const failure of [{ kind: 'throw', message: 'boom' }, { kind: 'load', message: 'nope' }] as const) {
      const runner = failingRunner(failure);
      const state = createGame(1, runner);
      run(state, runner, 3);
      expect(state.strategyKilled, failure.kind).toBe(false);
      expect(state.violations, failure.kind).toBe(3);
    }
  });

  it('caps the number of logged violation events', () => {
    const runner = failingRunner({ kind: 'throw', message: 'boom' });
    const state = createGame(1, runner);
    run(state, runner, 400);
    expect(state.violations).toBe(400);
    expect(state.events.filter((e) => e.kind === 'violation')).toHaveLength(E.limits.maxViolationEvents);
    expect(state.droppedEvents).toBeGreaterThan(0);
  });
});
