/**
 * Seeded PRNG — xorshift32.
 *
 * Chosen over a bigger generator on purpose: the whole state is a single uint32, so it
 * round-trips through JSON inside `GameState` with no loss and no BigInt. That is what
 * makes a replay reproducible from `{ seed, rngState, inputLog }` alone.
 *
 * Uses only `^`, `<<`, `>>>`, `/` and `Math.floor` — no `Math.random`, no `Date`.
 */

/** 2^32, the divisor that maps a uint32 onto [0, 1). */
const UINT32_SPAN = 4294967296;

/** Golden-ratio constant, substituted for a zero seed (xorshift is stuck at 0). */
const NONZERO_FALLBACK = 0x9e3779b9;

export type Rng = {
  /** Next value in [0, 1). */
  next(): number;
  /** Next integer in [0, n). Returns 0 for n <= 0. */
  int(n: number): number;
  /** Current state as a uint32 — serialize this, not the closure. */
  state(): number;
};

/** Coerce any number to a usable uint32 xorshift state. */
export function normalizeSeed(seed: number): number {
  const s = Number.isFinite(seed) ? Math.floor(seed) >>> 0 : 0;
  return s === 0 ? NONZERO_FALLBACK : s;
}

/** Resume a generator from a previously serialized `state()`. */
export function createRngFromState(state: number): Rng {
  let s = normalizeSeed(state);

  function next(): number {
    s = (s ^ (s << 13)) >>> 0;
    s = (s ^ (s >>> 17)) >>> 0;
    s = (s ^ (s << 5)) >>> 0;
    return s / UINT32_SPAN;
  }

  return {
    next,
    int(n: number): number {
      if (!Number.isFinite(n) || n <= 0) return 0;
      return Math.floor(next() * n);
    },
    state(): number {
      return s;
    },
  };
}

/** Create a generator from a round seed. */
export function createRng(seed: number): Rng {
  return createRngFromState(seed);
}
