/**
 * Gate 3's thresholds — spec §6.2, in one place because they are the numbers the
 * whole product is balanced against and every one of them is arguable.
 *
 * ```
 * ADAPTED :  win_rate(boss vs Mimic)  >= ADAPTED_MIN[round]   "it countered how you played"
 * FAIR    :  win_rate(boss vs panel)  in BAND[round]          "…but a different approach still beats it"
 * ACTIVE  :  longest motionless run   <= 90 ticks             "…and it never looks crashed"
 *            boss range over a match   >= 56 px               "…and it is not stuck in one spot"
 * ```
 *
 * Both of the first two are per-round tables, and they escalate in opposite
 * directions on purpose (delta 24): FAIR's band rises slowly, because it is the cap
 * on raw strength, while ADAPTED's threshold rises fast and *blocks* from round 3
 * on, because the difficulty the player is supposed to feel across a fight is the
 * boss learning their movement rather than the boss spamming harder.
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
 *
 * ## Why the bands moved on 2026-09-11 (spec §13, delta 24)
 *
 * Rounds 3–5 were raised (0.45–0.60 / 0.50–0.65 / 0.55–0.70 → the numbers below) and
 * round 2 was left **byte-for-byte unchanged**, because round 2's numbers are quoted
 * in the published recorded run and in `SYSTEM.md` §6 and a band that moves under
 * them makes that evidence unreadable.
 *
 * The bands are still the cap on *raw* strength, and they are deliberately the
 * smaller half of the escalation: a band alone gets harder by letting the boss spam
 * more, which is the difficulty a player resents. The escalation the player is meant
 * to feel is `ADAPTED_MIN` below, which blocks from round 3 on. Round 5's ceiling is
 * 0.95 rather than 0.70 so that a boss which has genuinely read the player is allowed
 * to be very hard; the floor is what still stops a boss from being a pushover.
 */
export const BAND: Readonly<Record<BalanceRound, readonly [number, number]>> = {
  2: [0.35, 0.5],
  3: [0.5, 0.65],
  4: [0.6, 0.75],
  5: [0.65, 0.95],
};

/**
 * ADAPTED, route 1: the boss beats a bot built from the player's own replay this
 * often. The absolute claim — "it counters how you played".
 *
 * Per-round since 2026-09-11 (spec §13, delta 24), and paired with `ADAPTED_BLOCKS`
 * below, which says whether missing it rejects the candidate or only advises.
 *
 * Round 2 keeps 0.70 **and keeps advising rather than blocking** — delta 23's
 * argument is unchanged there, and its numbers are the ones the recorded run and
 * `SYSTEM.md` §6 quote. Rounds 3, 4 and 5 escalate 0.75 → 0.85 → 0.95 and reject.
 *
 * ## Why the escalation lives here rather than in `BAND`
 *
 * Both tables can make a round harder, and they make it harder in different ways.
 * Raising `BAND` buys difficulty by letting the boss be stronger against four
 * scripted bots that never change — more projectiles, more area denial, a boss that
 * wins because it is spamming. Raising this buys difficulty by demanding the boss
 * beat a bot built from **this player's own replay**, which it cannot do by firing
 * more: the Mimic reproduces the player's positions, dodges and trigger discipline,
 * so the only way past it is to read where that player goes. That is the difficulty
 * the product promises, so that is the dial the rounds escalate on.
 *
 * ## Why blocking is survivable now when delta 23 said it was not
 *
 * Delta 23 retired ADAPTED as a blocker because it was unsatisfiable *for round 2*:
 * the incumbent scored 0.710 against a Mimic of a flawless human run, so a candidate
 * had to beat a bar its predecessor could barely reach while FAIR capped it at 0.50
 * against the panel. Round 2 is therefore exactly where this stays advisory. From
 * round 3 the arithmetic is different: FAIR's ceiling is 0.65–0.95 rather than 0.50,
 * so there is room above the panel for a boss that also beats the Mimic, and the
 * **relative route** (`ADAPTED_MARGIN`) is always open — a candidate that beats the
 * incumbent's rate against the identical Mimic by 0.10 has adapted whatever the
 * absolute number says. Either route satisfies the assertion; the absolute one is
 * not a wall on its own.
 *
 * The thresholds are not calibrated against a recorded eval, because there is no
 * recorded eval for rounds 3–5 — every committed run is a round-2 run. They are set
 * from the round-2 corpus's own shape: the ten committed `ReplaySummary` fixtures put
 * the incumbent between 0.54 and 1.00 against their Mimics (mean 0.804,
 * `scripts/mimic-calibration.ts`), so 0.75 is above the middle of that distribution,
 * 0.85 is near its top quartile, and 0.95 is reachable only against a player the boss
 * has genuinely solved — or by the relative route.
 */
export const ADAPTED_MIN: Readonly<Record<BalanceRound, number>> = {
  2: 0.7,
  3: 0.75,
  4: 0.85,
  5: 0.95,
};

/**
 * Whether missing ADAPTED **rejects** the candidate, per round.
 *
 * Round 2 is `false` and that is delta 23 standing exactly as it was: measured,
 * reported in the artifact (`detail.adapted`), appended to any rejection so the Coder
 * still aims at it, and never the reason a candidate is refused. Rounds 3–5 are
 * `true` (delta 24).
 *
 * A separate table from `ADAPTED_MIN` rather than `number | null` in one, because the
 * two facts are independent: round 2 has a threshold it reports and does not enforce,
 * and folding "report only" into the threshold's own value would delete the 0.70 that
 * round 2's advisory sentence still has to print.
 */
export const ADAPTED_BLOCKS: Readonly<Record<BalanceRound, boolean>> = {
  2: false,
  3: true,
  4: true,
  5: true,
};

/** The absolute ADAPTED target for a round. */
export function adaptedMinFor(round: BalanceRound): number {
  return ADAPTED_MIN[round];
}

/** Whether ADAPTED rejects in this round, or only advises (round 2). */
export function adaptedBlocks(round: BalanceRound): boolean {
  return ADAPTED_BLOCKS[round];
}

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
 *
 * ## 2026-09-10 note: the 0.710 baseline above predates calibration
 *
 * That measurement used a `Mimic` whose aim (`makeMimic`'s `accuracy`) was fixed
 * at 0.72 for every player, regardless of how well they actually shot
 * (`bots/mimic.ts`, `accuracyFromSummary`, analysis item 3). The Mimic is now
 * calibrated to the summary it imitates, so 0.710 is a pre-calibration number and
 * a fresh 12-attempt live run would not reproduce it exactly. What *is* re-verified
 * (`scripts/mimic-calibration.ts`, before/after on every committed replay
 * summary): the mean incumbent-vs-Mimic win rate across the ten committed
 * `ReplaySummary` fixtures moved from 0.822 to 0.804 — a modest drop, in the
 * direction the analysis predicted, not the dramatic one. The closest committed
 * analogue to the flawless zero-damage run this comment describes
 * (`packages/agents/canned/mimic-camper.json`, the "Statue" replay) did not drop
 * at all (0.980 → 1.000 at 100 matches): for that specific replay, accuracy was
 * never the bottleneck — its heat map is a single static corner cell, so
 * `round1.js` wins on positioning regardless of aim (verified by sweeping
 * `accuracy` 0.3→0.85 against it directly; the win rate stayed 0.96–1.00
 * throughout). That is evidence for, not against, this file's own read of
 * analysis §5 Q3: aim was a real and fixable weak channel for most of the
 * corpus, but not the one this specific flawless-run analogue needed.
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
