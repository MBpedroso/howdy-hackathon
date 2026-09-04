/**
 * The fallback pool (spec §3, §5): pre-approved boss strategies, at least two per
 * round, used when the rewrite loop does not produce an approved `strategy.js` in
 * time.
 *
 * The interlude has a 45-second budget (spec AC 5) and the loop that fills it calls
 * an LLM up to four times, so it *will* sometimes miss. When it does, the round must
 * still start against a boss that is a real boss — which means the fallback cannot be
 * a placeholder. Every file in `fallback/` is a hand-written strategy that has been
 * put through all four gates at its own round's fairness band, and
 * `test/fallback.test.ts` re-proves that on every run so a change to the engine, the
 * bots or the bands cannot quietly turn the safety net into a hole.
 *
 * ## Why the sources are read at module load
 * The server is Node-only, the pool is eight small files, and a fallback is needed at
 * exactly the moment something has already gone wrong — so the read happens once at
 * startup, where a missing or unreadable file is a loud boot failure, rather than
 * inside a request handler where it would be a second failure on top of the first.
 * `POOL_BYTES` exists so the boot log can show the pool was actually loaded.
 *
 * ## Why the choice is seeded
 * `pickFallback(round, seed)` is a pure function of its arguments. The round's seed is
 * already the thing that makes the fight replayable (spec AC 3), so deriving the
 * fallback from it means "the loop timed out and we used a fallback" replays
 * byte-for-byte too, exactly like an approved strategy would. A random pick would
 * make the one path that only runs when something went wrong the one path nobody can
 * reproduce.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BALANCE_ROUNDS, type BalanceRound } from '@rematch/harness';

/** One pre-approved strategy: the name the player is shown, and its source. */
export type FallbackStrategy = {
  /** The file's basename without `.js` — stable, and what the logs refer to. */
  name: string;
  /** `strategy.js` source, ready to hand to the sandbox. */
  source: string;
};

/** `fallback/` lives next to `src/`, not inside it: it is data, not TypeScript. */
export const FALLBACK_DIR = fileURLToPath(new URL('../fallback/', import.meta.url));

/** Rounds that have a fallback pool — the rounds with a fairness band (spec §6.2). */
export const FALLBACK_ROUNDS = BALANCE_ROUNDS;

/** Spec §3: "Pre-generated fallback strategies (≥ 2 per round)". Asserted at load. */
export const MIN_PER_ROUND = 2;

function loadRound(round: BalanceRound): FallbackStrategy[] {
  const dir = join(FALLBACK_DIR, `round${round}`);
  // Sorted, so the pool order — and therefore `pickFallback` — does not depend on
  // the order the filesystem happens to hand back.
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .sort();
  const out = files.map((file) => ({
    name: file.slice(0, -'.js'.length),
    source: readFileSync(join(dir, file), 'utf8'),
  }));
  if (out.length < MIN_PER_ROUND) {
    throw new Error(
      `fallback pool for round ${round} has ${out.length} strategies; spec §3 requires at least ${MIN_PER_ROUND} (looked in ${dir})`,
    );
  }
  return out;
}

/**
 * Every pre-approved strategy, by round. Read from disk once, at module load.
 *
 * Populated eagerly rather than lazily on purpose: see the note above — a broken pool
 * should fail at boot, not during the one request that needed it.
 */
export const FALLBACK_POOL: Readonly<Record<BalanceRound, readonly FallbackStrategy[]>> =
  Object.freeze(
    Object.fromEntries(FALLBACK_ROUNDS.map((round) => [round, Object.freeze(loadRound(round))])),
  ) as Readonly<Record<BalanceRound, readonly FallbackStrategy[]>>;

/** Total source bytes held in memory. For the boot log. */
export const POOL_BYTES: number = FALLBACK_ROUNDS.reduce(
  (total, round) =>
    total + FALLBACK_POOL[round].reduce((sum, s) => sum + Buffer.byteLength(s.source, 'utf8'), 0),
  0,
);

/**
 * Pick this round's fallback. Deterministic in `(round, seed)`.
 *
 * The seed is mixed before it is reduced rather than used directly: round seeds are
 * consecutive in some callers, and `seed % 2` on consecutive integers would alternate
 * between exactly two strategies in a fixed order, which is a rotation rather than a
 * choice. A multiplicative hash (the same constant `balanceConfig.seedsFor` uses, for
 * the same reason) spreads adjacent seeds across the pool.
 *
 * @throws if `round` has no pool — the caller has asked for a round the game has not
 * got, and silently substituting another round's boss would be worse than failing.
 */
export function pickFallback(round: BalanceRound, seed: number): FallbackStrategy {
  const pool = FALLBACK_POOL[round];
  if (pool === undefined || pool.length === 0) {
    throw new Error(`no fallback pool for round ${round}`);
  }
  const mixed = (Math.imul(Math.trunc(seed) >>> 0, 0x9e3779b1) ^ 0x85ebca6b) >>> 0;
  const strategy = pool[mixed % pool.length];
  if (strategy === undefined) throw new Error(`no fallback at index ${mixed % pool.length}`);
  return strategy;
}
