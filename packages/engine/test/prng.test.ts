import { describe, expect, it } from 'vitest';
import { createRng, createRngFromState, normalizeSeed } from '../src/prng.ts';

describe('createRng', () => {
  it('produces a known sequence for a known seed', () => {
    const rng = createRng(1);
    const seq = Array.from({ length: 8 }, () => rng.next());
    expect(seq).toMatchSnapshot();
  });

  it('is reproducible: two generators on the same seed agree', () => {
    const a = createRng(12345);
    const b = createRng(12345);
    for (let i = 0; i < 1000; i += 1) expect(a.next()).toBe(b.next());
  });

  it('different seeds diverge', () => {
    const a = createRng(1);
    const b = createRng(2);
    const seqA = Array.from({ length: 16 }, () => a.next());
    const seqB = Array.from({ length: 16 }, () => b.next());
    expect(seqA).not.toEqual(seqB);
  });

  it('stays in [0, 1)', () => {
    const rng = createRng(0xdeadbeef);
    for (let i = 0; i < 200_000; i += 1) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('int(n) stays in [0, n) and never returns a non-integer', () => {
    const rng = createRng(7);
    for (let i = 0; i < 20_000; i += 1) {
      const v = rng.int(5);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(5);
    }
  });

  it('int(n) degrades to 0 for non-positive or non-finite n', () => {
    const rng = createRng(7);
    expect(rng.int(0)).toBe(0);
    expect(rng.int(-3)).toBe(0);
    expect(rng.int(Number.NaN)).toBe(0);
    expect(rng.int(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('state() round-trips: resuming from a serialized state continues the sequence', () => {
    const a = createRng(99);
    for (let i = 0; i < 10; i += 1) a.next();

    const saved = a.state();
    expect(Number.isInteger(saved)).toBe(true);
    expect(saved).toBeGreaterThanOrEqual(0);
    expect(saved).toBeLessThanOrEqual(0xffffffff);

    // Survives a JSON round trip, which is how it lives inside GameState.
    const revived = createRngFromState(JSON.parse(JSON.stringify(saved)) as number);
    const expected = Array.from({ length: 20 }, () => a.next());
    const actual = Array.from({ length: 20 }, () => revived.next());
    expect(actual).toEqual(expected);
  });

  it('a zero seed is substituted (xorshift is stuck at 0)', () => {
    expect(normalizeSeed(0)).toBe(0x9e3779b9);
    const rng = createRng(0);
    expect(rng.next()).toBeGreaterThan(0);
  });

  it('normalizes fractional, negative and non-finite seeds to a uint32', () => {
    expect(normalizeSeed(3.7)).toBe(3);
    expect(normalizeSeed(-1)).toBe(0xffffffff);
    expect(normalizeSeed(Number.NaN)).toBe(0x9e3779b9);
    expect(createRng(3.7).state()).toBe(createRng(3).state());
  });
});
