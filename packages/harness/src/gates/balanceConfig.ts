/**
 * Gate 3's thresholds — spec §6.2, in one place because they are the numbers the
 * whole product is balanced against and every one of them is arguable.
 *
 * ```
 * ADAPTED :  win_rate(boss vs Mimic)  >= 0.70          "it countered how you played"
 * FAIR    :  win_rate(boss vs panel)  in BAND[round]   "…but a different approach still beats it"
 * ```
 */

export type BalanceRound = 2 | 3 | 4 | 5;
export const BALANCE_ROUNDS = [2, 3, 4, 5] as const satisfies readonly BalanceRound[];

/**
 * Boss win-rate band against the scripted panel, per round. It escalates so the
 * boss gets harder over the fight without ever becoming unwinnable — the upper
 * bound is the promise to the player, the lower bound is the promise to the demo
 * (a boss that loses 80% of the time is not a boss).
 */
export const BAND: Readonly<Record<BalanceRound, readonly [number, number]>> = {
  2: [0.35, 0.5],
  3: [0.45, 0.6],
  4: [0.5, 0.65],
  5: [0.55, 0.7],
};

/** ADAPTED: the boss must beat a bot built from the player's own replay this often. */
export const ADAPTED_MIN = 0.7;

/** Matches per Gate 3 verdict (spec §6.2). Half vs the Mimic, half across the panel. */
export const DEFAULT_MATCHES = 200;

/** The round used when a caller does not say. Round 2 is the first rewrite. */
export const DEFAULT_ROUND: BalanceRound = 2;

export function bandFor(round: BalanceRound): readonly [number, number] {
  return BAND[round];
}

/** `0.35–0.50` — the band, rendered for a rejection reason. */
export function formatBand(round: BalanceRound): string {
  const [lo, hi] = BAND[round];
  return `${lo.toFixed(2)}–${hi.toFixed(2)}`;
}

/**
 * The **fixed seed set**. Spec §6.2: "N = 200 matches per assertion (parallelized
 * across workers), fixed seed set → identical results on every machine."
 *
 * A multiplicative hash rather than `base + i`: consecutive seeds are consecutive
 * xorshift32 states, and xorshift32 mixes slowly, so `1001` and `1002` would give
 * two bots nearly the same aim noise for the first few hundred ticks. `offset`
 * separates one assertion's seed set from another's, so the panel and the Mimic are
 * never measured on the same 25 matches.
 */
export function seedsFor(count: number, offset = 0): number[] {
  const out: number[] = [];
  for (let i = 0; i < Math.max(0, Math.trunc(count)); i += 1) {
    out.push((Math.imul(i + 1 + offset * 7919, 0x9e3779b1) ^ 0x85ebca6b) >>> 0);
  }
  return out;
}

/** Seed-set offsets, so each assertion gets its own matches. */
export const SEED_OFFSET = { panel: 0, mimic: 1 } as const;
