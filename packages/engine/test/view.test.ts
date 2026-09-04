import { describe, expect, it } from 'vitest';
import { CONSTANTS } from '@rematch/contract';
import { buildBossView, normalizeHeat } from '../src/view.ts';
import { createGame } from '../src/game.ts';
import { step } from '../src/step.ts';
import { makeInput } from '../src/input.ts';
import { constantRunner, idleRunner } from './helpers.ts';

describe('buildBossView', () => {
  it('returns fresh copies — mutating the view cannot touch the state', () => {
    const runner = constantRunner({ type: 'burst', angle: 0, count: 8 });
    const state = createGame(1, runner);
    step(state, makeInput({ shoot: true, aimX: 0, aimY: -1 }), runner);

    const view = buildBossView(state);
    expect(view.projectiles.length).toBeGreaterThan(0);

    const before = JSON.stringify(state);

    view.tick = 9999;
    view.arena.w = 1;
    view.boss.x = -500;
    view.boss.cooldowns.burst = 0;
    view.player.hp = 0;
    view.projectiles.length = 0;
    view.history.playerPosHeat[0] = 42;
    view.history.playerDashDirs[0] = 42;
    view.history.playerShotsDuring.slam = 42;

    expect(JSON.stringify(state)).toBe(before);
  });

  it('does not alias the projectile objects', () => {
    const runner = constantRunner({ type: 'burst', angle: 0, count: 3 });
    const state = createGame(2, runner);
    step(state, makeInput(), runner);

    const view = buildBossView(state);
    const first = view.projectiles[0];
    const stateFirst = state.projectiles[0];
    expect(first).toBeDefined();
    expect(stateFirst).toBeDefined();
    expect(first).not.toBe(stateFirst);
    if (first) first.x = -1234;
    expect(state.projectiles[0]?.x).not.toBe(-1234);
  });

  it('cooldowns in the view match the state', () => {
    const runner = constantRunner({ type: 'charge', angle: 0 });
    const state = createGame(3, runner);
    step(state, makeInput(), runner);

    const view = buildBossView(state);
    expect(view.boss.cooldowns).toEqual(state.boss.cooldowns);
    expect(view.boss.cooldowns.charge).toBe(CONSTANTS.cooldowns.charge - 0);
  });

  it('exposes isDashing and lastShotTick', () => {
    const runner = idleRunner();
    const state = createGame(4, runner);
    step(state, makeInput({ dash: true, shoot: true, aimX: 1, aimY: 0 }), runner);

    const view = buildBossView(state);
    expect(view.player.isDashing).toBe(true);
    expect(view.player.lastShotTick).toBe(1);
  });

  it('normalizes the heat map so the 64 cells sum to 1', () => {
    const runner = idleRunner();
    const state = createGame(5, runner);
    for (let i = 0; i < 120; i += 1) step(state, makeInput({ moveX: 1 }), runner);

    const view = buildBossView(state);
    expect(view.history.playerPosHeat).toHaveLength(64);
    const sum = view.history.playerPosHeat.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 3);
    for (const v of view.history.playerPosHeat) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    // Raw state keeps accumulated counts, not the normalized values.
    expect(state.history.playerPosHeat.reduce((a, b) => a + b, 0)).toBe(120);
  });

  it('normalizeHeat returns all zeros for an empty grid rather than NaN', () => {
    const out = normalizeHeat(new Array<number>(64).fill(0));
    expect(out).toHaveLength(64);
    expect(out.every((v) => v === 0)).toBe(true);
  });

  it('normalizeHeat preserves relative weight', () => {
    const counts = new Array<number>(64).fill(0);
    counts[0] = 30;
    counts[7] = 10;
    const out = normalizeHeat(counts);
    expect(out[0]).toBeCloseTo(0.75, 6);
    expect(out[7]).toBeCloseTo(0.25, 6);
  });

  it('contains no fields outside the contract', () => {
    const runner = idleRunner();
    const state = createGame(6, runner);
    step(state, makeInput(), runner);
    const view = buildBossView(state);

    expect(Object.keys(view).sort()).toEqual(['arena', 'boss', 'history', 'player', 'projectiles', 'tick']);
    expect(Object.keys(view.boss).sort()).toEqual(['cooldowns', 'facing', 'hp', 'x', 'y']);
    expect(Object.keys(view.player).sort()).toEqual(['hp', 'isDashing', 'lastShotTick', 'vx', 'vy', 'x', 'y']);
    // Minions, telegraphs, violations and the rng state are deliberately absent.
    expect(view).not.toHaveProperty('minions');
    expect(view.boss).not.toHaveProperty('telegraph');
  });
});
