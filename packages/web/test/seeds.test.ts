/**
 * Seed derivation. The one place the client is allowed to be random, and the reason
 * `?seed=` can reproduce a whole session.
 */
import { describe, expect, it } from 'vitest';
import { formatSeed, randomSessionSeed, resolveSessionSeed, roundSeed, seedFromQuery, toSeed } from '../src/game/seeds.ts';

describe('toSeed', () => {
  it('coerces to uint32 and never returns 0', () => {
    expect(toSeed(7)).toBe(7);
    expect(toSeed(0)).toBe(0x9e3779b9);
    expect(toSeed(-1)).toBe(0xffffffff);
    expect(toSeed(4294967297)).toBe(1);
    expect(toSeed(Number.NaN)).toBe(0x9e3779b9);
    expect(toSeed(12.9)).toBe(12);
  });
});

describe('roundSeed', () => {
  it('is deterministic', () => {
    expect(roundSeed(424242, 1)).toBe(roundSeed(424242, 1));
  });

  it('pins the seed the e2e fixture was recorded with', () => {
    // If this changes, `e2e/fixtures/inputlog-round1.json` must be regenerated.
    expect(roundSeed(424242, 1)).toBe(1977791994);
  });

  it('decorrelates consecutive rounds', () => {
    const seeds = [1, 2, 3, 4, 5].map((r) => roundSeed(99, r));
    expect(new Set(seeds).size).toBe(5);
    // Adjacent rounds must not be adjacent seeds — the boss's PRNG is seeded from this.
    for (let i = 1; i < seeds.length; i += 1) {
      expect(Math.abs((seeds[i] ?? 0) - (seeds[i - 1] ?? 0))).toBeGreaterThan(1000);
    }
  });

  it('separates sessions', () => {
    expect(roundSeed(1, 1)).not.toBe(roundSeed(2, 1));
  });

  it('never returns 0', () => {
    for (let s = 0; s < 200; s += 1) {
      for (let r = 1; r <= 5; r += 1) expect(roundSeed(s, r)).not.toBe(0);
    }
  });
});

describe('seedFromQuery', () => {
  it('reads decimal and hex', () => {
    expect(seedFromQuery('?seed=123')).toBe(123);
    expect(seedFromQuery('?seed=0xff')).toBe(255);
    expect(seedFromQuery('?seed=%20123%20')).toBe(123);
  });

  it('returns null when absent or unusable', () => {
    expect(seedFromQuery('')).toBeNull();
    expect(seedFromQuery('?other=1')).toBeNull();
    expect(seedFromQuery('?seed=')).toBeNull();
    expect(seedFromQuery('?seed=abc')).toBeNull();
  });
});

describe('resolveSessionSeed', () => {
  it('prefers the query over randomness', () => {
    expect(resolveSessionSeed('?seed=5150')).toBe(5150);
  });

  it('falls back to crypto', () => {
    const seed = resolveSessionSeed('');
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThan(0);
  });

  it('round-trips through the format shown in the HUD', () => {
    const seed = randomSessionSeed();
    expect(resolveSessionSeed(`?seed=${formatSeed(seed)}`)).toBe(seed);
  });
});
