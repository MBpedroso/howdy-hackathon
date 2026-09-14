/**
 * `render/effects.ts` — the transient-visual layer, and specifically the four
 * pure helpers the 90s hit feedback is built on: spark geometry, the sprite
 * flash, the dash afterimages and the hard-cut screen flash.
 *
 * They live in `effects.ts` rather than in the renderer so they can be tested
 * without a canvas, and so the property that actually matters can be asserted:
 * every one of them is a function of (event index, tick) alone. The renderer
 * promises to be idempotent (`renderer.ts` header) and the e2e screenshots cash
 * that promise in — a spark that moved between two draws of the same tick, or a
 * `Math.random` anywhere in this file, would break both.
 *
 * The tracker tests are built on a real `GameState` (via `createGame`/`pushEvent`,
 * as `habit-highlight.test.ts` does) rather than a hand-rolled fake.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createGame, pushEvent, type GameState } from '@rematch/engine';

import {
  createEffectTracker,
  flashAlpha,
  ghosts,
  sparks,
  FLASH_TICKS,
  GHOST_ALPHAS,
  HIT_FLASH_TICKS,
  SPARK_KINDS,
  SPARK_LENGTH_MAX,
  SPARK_LENGTH_MIN,
  SPARK_MAX,
  SPARK_MIN,
  TRAIL_TICKS,
  type TrailPoint,
} from '../src/render/effects.ts';

const noopRunner = {
  meta: { name: 'Test', rationale: 'x', version: 1 },
  init: () => {},
  decide: () => ({ ok: true as const, action: { type: 'idle' as const }, elapsedMs: 0 }),
  memoryBytes: () => 0,
  dispose: () => {},
};

function game(): GameState {
  return createGame(1, noopRunner);
}

describe('spark geometry', () => {
  it('is a pure function of the seed — the same hit throws the same sparks', () => {
    for (const seed of [0, 1, 7, 42, 1000]) {
      expect(sparks(seed)).toEqual(sparks(seed));
    }
  });

  it('throws 5 to 8 sparks, each 6 to 14 units long', () => {
    for (let seed = 0; seed < 200; seed += 1) {
      const fan = sparks(seed);
      expect(fan.length).toBeGreaterThanOrEqual(SPARK_MIN);
      expect(fan.length).toBeLessThanOrEqual(SPARK_MAX);
      for (const s of fan) {
        expect(s.length).toBeGreaterThanOrEqual(SPARK_LENGTH_MIN);
        expect(s.length).toBeLessThanOrEqual(SPARK_LENGTH_MAX);
        expect(Number.isFinite(s.angle)).toBe(true);
      }
    }
  });

  it('spreads consecutive hits apart — two hits in a row are not the same fan', () => {
    // The seed is the event index, so hits arrive as 0, 1, 2, ... A hash that did
    // not mix would make every hit in a burst look identical.
    const fans = [0, 1, 2, 3, 4, 5].map((seed) => JSON.stringify(sparks(seed)));
    expect(new Set(fans).size).toBe(fans.length);
  });

  it('covers the circle rather than firing every spark the same way', () => {
    const fan = sparks(3);
    const angles = fan.map((s) => s.angle).sort((a, b) => a - b);
    const first = angles[0] ?? 0;
    const last = angles[angles.length - 1] ?? 0;
    expect(last - first).toBeGreaterThan(Math.PI);
  });

  it('is thrown by the four kinds that mean damage, and by nothing else', () => {
    expect([...SPARK_KINDS].sort()).toEqual(['bossHit', 'chargeHit', 'minionDown', 'playerHit']);
    expect(SPARK_KINDS).not.toContain('burst');
    expect(SPARK_KINDS).not.toContain('spawn');
  });
});

describe('the sprite flash', () => {
  it('peaks on the tick of the hit and is gone four ticks later', () => {
    expect(flashAlpha(0)).toBeGreaterThan(0.5);
    expect(flashAlpha(FLASH_TICKS)).toBe(0);
    expect(flashAlpha(FLASH_TICKS + 20)).toBe(0);
  });

  it('decays, and never rises', () => {
    for (let age = 1; age < FLASH_TICKS + 3; age += 1) {
      expect(flashAlpha(age)).toBeLessThan(flashAlpha(age - 1) + 1e-9);
      expect(flashAlpha(age)).toBeLessThanOrEqual(flashAlpha(age - 1));
    }
  });

  it('is 0 for a negative age — an effect from a tick that has not happened', () => {
    expect(flashAlpha(-1)).toBe(0);
    expect(flashAlpha(-100)).toBe(0);
  });

  it('stays a legal alpha for every age', () => {
    for (let age = -5; age < 40; age += 1) {
      expect(flashAlpha(age)).toBeGreaterThanOrEqual(0);
      expect(flashAlpha(age)).toBeLessThanOrEqual(1);
    }
  });
});

describe('the dash afterimages', () => {
  function trailOf(length: number, tick: number): TrailPoint[] {
    // Oldest first, one per tick, ending on the current tick — exactly the shape
    // the tracker keeps.
    return Array.from({ length }, (_, i) => ({ x: 100 + i * 5, y: 200, tick: tick - (length - 1 - i) }));
  }

  it('reduce a full trail to three discrete ghosts with stepped alpha', () => {
    const ghostList = ghosts(trailOf(TRAIL_TICKS + 1, 100), 100);
    expect(ghostList.length).toBe(3);
    expect(ghostList.map((g) => g.alpha)).toEqual([...GHOST_ALPHAS]);
  });

  it('are spread across the trail, nearest first', () => {
    const ghostList = ghosts(trailOf(TRAIL_TICKS + 1, 100), 100);
    const xs = ghostList.map((g) => g.x);
    // x grows with age in the fixture, so nearest-first means descending x.
    expect(xs[0]).toBeGreaterThan(xs[1] ?? 0);
    expect(xs[1]).toBeGreaterThan(xs[2] ?? 0);
  });

  it('never include the current position — that is where the player is drawn', () => {
    const trail = trailOf(5, 100);
    const here = trail[trail.length - 1];
    for (const g of ghosts(trail, 100)) expect(g.x).not.toBe(here?.x);
  });

  it('degrade to fewer ghosts on a short trail, and none on a standing player', () => {
    expect(ghosts([], 100)).toEqual([]);
    expect(ghosts(trailOf(1, 100), 100)).toEqual([]);
    expect(ghosts(trailOf(2, 100), 100).length).toBe(1);
    expect(ghosts(trailOf(3, 100), 100).length).toBe(2);
  });

  it('ignore points older than the trail window', () => {
    const stale: TrailPoint[] = [{ x: 1, y: 1, tick: 0 }];
    expect(ghosts(stale, TRAIL_TICKS + 5)).toEqual([]);
  });

  it('are a pure function of (trail, tick)', () => {
    const trail = trailOf(9, 60);
    expect(ghosts(trail, 60)).toEqual(ghosts(trail, 60));
  });
});

describe('the tracker, hit feedback', () => {
  it('seeds each effect with the index of the event it came from', () => {
    const tracker = createEffectTracker();
    const state = game();
    pushEvent(state, 'bossHit');
    pushEvent(state, 'playerHit');
    tracker.sync(state);

    const seeds = tracker.effects().map((e) => e.seed);
    expect(seeds).toEqual([0, 1]);
    // Which is what makes two simultaneous hits look different rather than doubled.
    expect(sparks(0)).not.toEqual(sparks(1));
  });

  it('flashes the boss white for four ticks after a bossHit, and not the player', () => {
    const tracker = createEffectTracker();
    const state = game();
    pushEvent(state, 'bossHit');
    tracker.sync(state);

    const born = state.tick;
    expect(tracker.flash('boss', born)).toBeGreaterThan(0);
    expect(tracker.flash('player', born)).toBe(0);
    expect(tracker.flash('boss', born + FLASH_TICKS - 1)).toBeGreaterThan(0);
    expect(tracker.flash('boss', born + FLASH_TICKS)).toBe(0);
  });

  it('flashes the player white for four ticks after a playerHit, and not the boss', () => {
    const tracker = createEffectTracker();
    const state = game();
    pushEvent(state, 'playerHit');
    tracker.sync(state);

    const born = state.tick;
    expect(tracker.flash('player', born)).toBeGreaterThan(0);
    expect(tracker.flash('boss', born)).toBe(0);
    expect(tracker.flash('player', born + FLASH_TICKS)).toBe(0);
  });

  it('cuts the screen flash hard — two frames on, then nothing', () => {
    const tracker = createEffectTracker();
    const state = game();
    pushEvent(state, 'playerHit');
    tracker.sync(state);

    const born = state.tick;
    for (let age = 0; age < HIT_FLASH_TICKS; age += 1) {
      expect(tracker.hitFlash(born + age)).toBe(1);
    }
    expect(tracker.hitFlash(born + HIT_FLASH_TICKS)).toBe(0);
    // And it is a step, not a ramp: no intermediate value exists.
    for (let age = 0; age < 20; age += 1) {
      expect([0, 1]).toContain(tracker.hitFlash(born + age));
    }
  });

  it('forgets both flashes on reset — a new round starts clean', () => {
    const tracker = createEffectTracker();
    const state = game();
    pushEvent(state, 'playerHit');
    pushEvent(state, 'bossHit');
    tracker.sync(state);
    tracker.reset();

    expect(tracker.flash('player', state.tick)).toBe(0);
    expect(tracker.flash('boss', state.tick)).toBe(0);
    expect(tracker.hitFlash(state.tick)).toBe(0);
  });
});

/**
 * The determinism guarantee, checked structurally — the same argument
 * `fighters.test.ts` makes about costumes, made about particles.
 *
 * A renderer that rolled dice would still look fine to a human and would still
 * pass every assertion above, and it would quietly break the e2e screenshots and
 * the "drawing the same state twice produces the same picture" contract. So the
 * absence of a random source is asserted by reading the source.
 */
describe('nothing in the effects layer rolls dice', () => {
  it('uses no `Math.random` — spark variation comes from a hash of the event index', () => {
    for (const file of ['render/effects.ts', 'render/renderer.ts']) {
      const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
      expect(source).not.toContain('Math.random');
      expect(source).not.toContain('Date.now');
      expect(source).not.toContain('performance.now');
    }
  });

  it('never reaches the simulation — the effects layer is not imported by game code', () => {
    const url = new URL('../src/', import.meta.url);
    for (const file of ['game/round.ts', 'game/strategy.ts', 'game/loop.ts', 'game/seeds.ts']) {
      const source = readFileSync(new URL(file, url), 'utf8');
      expect(source).not.toContain('effects.ts');
      expect(source).not.toContain('renderer.ts');
    }
  });
});
