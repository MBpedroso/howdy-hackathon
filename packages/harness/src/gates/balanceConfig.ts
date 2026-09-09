/**
 * Gate 3's thresholds — spec §6.2, in one place because they are the numbers the
 * whole product is balanced against and every one of them is arguable.
 *
 * ```
 * ADAPTED :  win_rate(boss vs Mimic)  >= 0.70          "it countered how you played"
 * FAIR    :  win_rate(boss vs panel)  in BAND[round]   "…but a different approach still beats it"
 * ACTIVE  :  longest motionless run   <= 90 ticks      "…and it never looks crashed"
 *            boss range over a match   >= 56 px        "…and it is not stuck in one spot"
 * ```
 *
 * ACTIVE is the one that is not in the spec's §6.2, and it is here because a human
 * playtest found what §6.2 cannot: a boss frozen in a corner for four seconds,
 * which every gate approved. Its span clause is here because an independent review
 * found what the run clause cannot: a boss oscillating on the spot, which every
 * gate also approved. See `ACTIVITY` below and `sim/activity.ts`.
 */

import { ENGINE_CONSTANTS } from '@rematch/engine';

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

/**
 * ADAPTED, route 1: the boss beats a bot built from the player's own replay this
 * often. The absolute claim — "it counters how you played".
 */
export const ADAPTED_MIN = 0.7;

/**
 * ADAPTED, route 2: how much the new boss must beat the *incumbent's* rate against
 * the same Mimic by, when the absolute threshold is out of reach.
 *
 * ## Why a second route exists at all
 *
 * A live run on 2026-09-08 (12 attempts, no time ceiling) produced 23 candidates.
 * Eight of them were **inside** the round's FAIR band and were rejected by ADAPTED
 * alone; the best of them scored 0.60 against the Mimic. The round in question was
 * one the player had won taking **zero damage** — so the Mimic was a bot that
 * reproduced a flawless run, and no rewrite was going to beat it 70% of the time.
 *
 * That is the two assertions contradicting each other. FAIR caps how strong the
 * boss may be against the scripted panel; ADAPTED demands a rate against this
 * player that, for a player who plays well, sits above that cap. The better the
 * human, the more certainly every rewrite is rejected — which is backwards, because
 * a good player is exactly who the feature exists for.
 *
 * So ADAPTED now asks the question it was always reaching for: *is this rewrite
 * better against this player than the boss it replaces?* The incumbent's rate
 * against the identical Mimic on the identical seeds is the baseline, and a
 * candidate that clears it by this margin has adapted, whatever the absolute number.
 *
 * ## Why 0.10, and why nothing weaker
 *
 * The Mimic half is 100 matches by default, so a win rate near 0.5 carries a
 * standard error of about 0.05. A margin of 0.05 would approve one standard error
 * of noise; 0.10 is two, which makes "better" mean better rather than luckier.
 *
 * ## Why this cannot make the gate toothless
 *
 * It only ever *adds* a way to pass — nothing that passes the absolute threshold
 * today stops passing, so every recorded run and every calibration fixture stays
 * valid. And the relative route has no floor of its own on purpose: FAIR is the
 * floor. A boss that clears its predecessor against one player while losing 80% to
 * the scripted panel fails FAIR's lower bound and never reaches this check.
 *
 * ## What it does **not** fix, measured
 *
 * It does not open the wall it was written for, and the numbers say so plainly.
 *
 *  - Across the 58 recorded candidates (`scripts/recheck-adapted.ts`,
 *    `docs/evidence/recheck-adapted-2026-09-08.json`): **0 regressions and 0 newly
 *    approved.** Seven were rejected by ADAPTED alone and all seven still are.
 *  - On the 12-attempt live run itself: the incumbent — `web/src/strategies/round1.js`,
 *    "Cornerbreaker" — scores **0.710** against a Mimic of the very run the human
 *    had just *won* (`scripts/live-base.ts`). The relative bar is therefore 0.810,
 *    which is **stricter** than the absolute 0.70, and the best of the eight in-band
 *    candidates was 0.60.
 *
 * That last number is the real finding, and it is not about a threshold. A boss the
 * human beat, taking no damage, beats a bot built from that same run 71% of the
 * time — so the Mimic is a far weaker player than the person it imitates, and
 * "≥ 0.70 vs Mimic" is not the difficulty claim it reads as. Whether ADAPTED should
 * therefore stop being a blocking assertion is a decision about what the gate
 * promises (spec AC 7), not a constant to retune, and it is recorded as an open
 * question rather than quietly changed. The relative route stays because it is
 * sound, costs one simulation per interlude, and binds whenever the incumbent is
 * weak — a round following a fallback boss, most obviously.
 */
export const ADAPTED_MARGIN = 0.1;

/**
 * ACTIVE: how still a shipped boss is allowed to be.
 *
 * The measurement is in `sim/activity.ts`; these are the two thresholds Gate 3
 * rejects on.
 *
 * `maxIdleRunTicks` is 90 (1.5 s at 60 ticks/second). The legitimate reason to be
 * perfectly still is a telegraph, and those are excluded from the count outright,
 * so this is pure slack: it leaves room for a boss that lands a slam, pauses a beat
 * and slams again, and it still rejects the 263-tick stall the playtest reported.
 * Below about 60 it would start rejecting honest hesitation; above about 150 a
 * player reads the boss as crashed and reloads the page.
 *
 * `maxIdleFractionP90` is the companion the max cannot express: a boss that idles
 * 80 ticks, moves one, and idles 80 again never trips the run limit and is still
 * dead on screen. p90 rather than the mean, because a two-second match the player
 * won instantly is allowed to be idle-heavy — see `SimulateActivity`.
 *
 * `minSpanPx` is the companion *both* of those cannot express, because both are
 * about stalling. A boss that alternates `move` left and `move` right every tick
 * never stalls for even one tick — it steps a full 2.6 px each way — so its idle
 * run is 0 and its idle fraction is 0, and until 2026-09-08 that was enough to be
 * called 100% active. Five lines of it passed all four gates
 * (`docs/REVIEW-2026-09-08.md`; the strategy is kept as
 * `test/fixtures/jitter.js` and asserted in `test/activity.test.ts`).
 *
 * 56 px is the boss's own diameter (`ENGINE_CONSTANTS.boss.radius * 2`), and it is
 * deliberately a floor rather than a tuned percentile: over a whole 60-second match
 * the boss must range at least its own width. Anything below that is broken by any
 * reading; plenty above it may still be poor, which is what the two clauses above
 * are for. Measured against the eleven shipped strategies, the narrowest is
 * `fallback/round5/tollkeeper` at 155.7 px — 2.8x of headroom — and the jittering
 * attack measures 2.6 px, 21x below the line. A threshold set anywhere in that
 * two-order-of-magnitude gap would work; the boss's diameter is the one choice that
 * can be justified without appealing to the sample.
 */
export const ACTIVITY = {
  /** Longest run of motionless ticks a shipped boss may have. 90 = 1.5 s. */
  maxIdleRunTicks: 90,
  /** p90, across matches, of the fraction of ticks the boss spent doing nothing. */
  maxIdleFractionP90: 0.25,
  /**
   * Smallest bounding-box diagonal, in px, the boss may confine itself to over a
   * whole match. The boss's own diameter — see the note above.
   */
  minSpanPx: ENGINE_CONSTANTS.boss.radius * 2,
} as const;

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
