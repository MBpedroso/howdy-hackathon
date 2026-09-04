/**
 * Seeds — the only place in the client that is allowed to be non-deterministic, and
 * even here only once, at boot, outside the engine.
 *
 * A whole session is described by one 32-bit `sessionSeed`. Every round's seed is
 * *derived* from it, so `?seed=<n>` reproduces the entire five-round session — and a
 * bug report is a URL. `crypto.getRandomValues` is used only when no seed is given.
 */

/** 2^32. */
const SPAN = 4294967296;

/** Coerce anything to a uint32; 0 is remapped because a zero seed is degenerate. */
export function toSeed(value: number): number {
  const n = Number.isFinite(value) ? Math.floor(value) >>> 0 : 0;
  return n === 0 ? 0x9e3779b9 : n;
}

/**
 * Round seed = a bit-mixed function of `(sessionSeed, round)`.
 *
 * MurmurHash3's 32-bit finalizer over `sessionSeed ^ (round * 0x9e3779b1)`: two
 * consecutive rounds must not produce correlated seeds (the boss's own PRNG is seeded
 * from this), and a plain `sessionSeed + round` does exactly that.
 */
export function roundSeed(sessionSeed: number, round: number): number {
  let h = (toSeed(sessionSeed) ^ (Math.imul(round >>> 0, 0x9e3779b1) >>> 0)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return toSeed(h >>> 0);
}

/**
 * Read `?seed=` from a query string. Accepts decimal or `0x`-prefixed hex.
 * Returns `null` when absent or unparseable, so the caller can decide the fallback.
 */
export function seedFromQuery(search: string): number | null {
  const raw = new URLSearchParams(search).get('seed');
  if (raw === null || raw.trim() === '') return null;
  const n = raw.trim().toLowerCase().startsWith('0x') ? Number.parseInt(raw.trim().slice(2), 16) : Number(raw);
  if (!Number.isFinite(n)) return null;
  return toSeed(n);
}

/** A fresh session seed. The one call to a randomness source in the whole client. */
export function randomSessionSeed(random: Crypto = globalThis.crypto): number {
  const buf = new Uint32Array(1);
  random.getRandomValues(buf);
  return toSeed(buf[0] ?? Math.floor(SPAN / 2));
}

/** `?seed=` if present, else a fresh random one. */
export function resolveSessionSeed(search: string): number {
  return seedFromQuery(search) ?? randomSessionSeed();
}

/** Render a seed the way it is shown in the HUD and accepted back in `?seed=`. */
export function formatSeed(seed: number): string {
  return String(seed >>> 0);
}
