/**
 * Spec §7 / AC 3: same seed + same input log -> identical state hash.
 *
 * Every good reference strategy from `@rematch/contract` is run against a scripted
 * player over five seeds, three ways:
 *   1. play the match live and record the input log,
 *   2. `replay` that log twice,
 *   3. step the same log tick by tick by hand.
 * All four final states must hash identically.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { StrategyModule } from '@rematch/contract';
import { createGame, hashState, replay, summarizeReplay } from '../src/game.ts';
import { cloneState } from '../src/state.ts';
import { step } from '../src/step.ts';
import { nativeRunner } from '../src/nativeRunner.ts';
import { GOOD_FIXTURES, loadAllGoodStrategies, type GoodFixture } from './fixtures.ts';
import { playMatch } from './helpers.ts';

const SEEDS = [1, 2, 7, 42, 999];

let strategies: Array<{ name: GoodFixture; module: StrategyModule }> = [];

beforeAll(async () => {
  strategies = await loadAllGoodStrategies();
});

describe('determinism', () => {
  it('loads every good fixture strategy', () => {
    expect(strategies.map((s) => s.name)).toEqual([...GOOD_FIXTURES]);
    for (const { module } of strategies) {
      expect(typeof module.decide).toBe('function');
      expect(typeof module.init).toBe('function');
      expect(typeof module.meta.name).toBe('string');
    }
  });

  it('replay is reproducible for every strategy on every seed', () => {
    for (const { name, module } of strategies) {
      for (const seed of SEEDS) {
        const live = playMatch(seed, nativeRunner(module), seed * 31 + 7);
        const liveHash = hashState(live.final);

        const a = replay(seed, live.log, nativeRunner(module));
        const b = replay(seed, live.log, nativeRunner(module));

        expect(hashState(a.final), `${name}/${seed} replay#1`).toBe(liveHash);
        expect(hashState(b.final), `${name}/${seed} replay#2`).toBe(liveHash);

        // Tick-by-tick by hand must agree with `replay`.
        const runner = nativeRunner(module);
        const manual = createGame(seed, runner);
        for (const input of live.log) {
          step(manual, input, runner);
          if (manual.outcome !== 'playing') break;
        }
        expect(hashState(manual), `${name}/${seed} manual`).toBe(liveHash);
      }
    }
  });

  it('a JSON round trip does not change the hash', () => {
    for (const { name, module } of strategies) {
      const { final } = playMatch(3, nativeRunner(module), 11);
      expect(hashState(cloneState(final)), name).toBe(hashState(final));
    }
  });

  it('keepFrames yields one frame per tick, starting at tick 0', () => {
    const module = strategies[0]?.module;
    expect(module).toBeDefined();
    if (!module) return;

    const live = playMatch(1, nativeRunner(module), 5, 120);
    const { final, frames } = replay(1, live.log, nativeRunner(module), { keepFrames: true });
    expect(frames).toBeDefined();
    expect(frames?.[0]?.tick).toBe(0);
    expect(frames?.length).toBe(final.tick + 1);
    expect(hashState(frames?.[frames.length - 1] as never)).toBe(hashState(final));
  });

  it('different seeds produce different states', () => {
    const module = strategies.find((s) => s.name === 'chaser')?.module;
    expect(module).toBeDefined();
    if (!module) return;
    const hashes = new Set(
      SEEDS.map((seed) => hashState(playMatch(seed, nativeRunner(module), seed * 31 + 7).final)),
    );
    expect(hashes.size).toBe(SEEDS.length);
  });

  it('SNAPSHOT: chaser on seed 1 — any engine change that alters the simulation breaks this', () => {
    const module = strategies.find((s) => s.name === 'chaser')?.module;
    expect(module).toBeDefined();
    if (!module) return;

    const live = playMatch(1, nativeRunner(module), 38);
    const summary = summarizeReplay(live.final);

    expect({
      hash: hashState(live.final),
      ticks: live.final.tick,
      outcome: live.final.outcome,
      bossHp: live.final.boss.hp,
      playerHp: live.final.player.hp,
      violations: live.final.violations,
      primitives: summary.boss.primitives,
    }).toMatchSnapshot();
  });
});
