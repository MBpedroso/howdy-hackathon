/**
 * Balance regression for the fallback pool (spec §7, "Balance regression": *"Each
 * shipped fallback strategy still lands in its round's band"*).
 *
 * The pool is the game's safety net: it is what the player fights when the rewrite
 * loop misses its 45-second budget (spec AC 5). A safety net that has quietly stopped
 * being fair is worse than no net, because nothing else in the system will notice —
 * the loop's own output is checked by Gate 3 on every generation, but a fallback is
 * only checked here. So this suite re-proves the whole claim on every run: every
 * strategy in `fallback/roundN/` passes Gates 1, 2 and 4 and lands inside round N's
 * fairness band.
 *
 * ADAPTED is deliberately **not** asserted. A fallback exists precisely because there
 * was no usable analysis of the player's round, so there is no `ReplaySummary` to build
 * a Mimic from; `gate3Balance` skips the assertion when no summary is supplied
 * (see its docstring) and FAIR is the whole promise a pre-approved boss can make.
 *
 * ACTIVE **is** asserted, and it is the reason this file changed on 2026-09-04: seven
 * of the eight strategies here used `idle` as their resting state and froze for
 * between 89 and 630 consecutive ticks. Gate 3 rejects that now, so `result.ok`
 * already covers it — but the table prints the worst run per strategy anyway, because
 * a run at 80 of the 90 allowed ticks is a strategy about to regress and the pass/fail
 * bit cannot say so.
 *
 * ## Match count
 * 120, against the spec's 200. The bands are checked at 200 by hand (`pnpm harness
 * <file> --round N --matches 200`) and every strategy is tuned to sit at least 0.03
 * inside both edges at *both* counts, so the reduced count here buys a ~30 s suite
 * without turning a passing pool into a coin flip. The seed set is a fixed prefix of
 * the 200-match one (`seedsFor`), so this is a real subsample rather than a different
 * experiment — but it is a coarser one: 120 matches is 15 seeds per bot, so a per-bot
 * rate moves in steps of ~0.067 and the panel rate in steps of ~0.017. Read the table
 * it prints, not just the pass.
 *
 * It used to be 60, and 60 turned out to be too coarse for the margin this suite
 * asserts: at 8 seeds per bot the panel rate moves in steps of 0.031, so a 0.03 margin
 * is one grid point wide, and two strategies could not be tuned to satisfy it at both
 * 60 and 200 without over-fitting the first eight seeds. Doubling the sample is the
 * honest fix; it is the assertion that had to be affordable, not the number.
 */
import { describe, expect, it } from 'vitest';
import { ACTIVITY, bandFor, gate3Balance, runGates, type BalanceRound, type GateResult } from '@rematch/harness';
import { FALLBACK_POOL, FALLBACK_ROUNDS, MIN_PER_ROUND, POOL_BYTES, pickFallback } from '../src/fallback.ts';

/** Half go to the panel, half would go to the Mimic — which we do not use here. */
const MATCHES = 120;

/** The margin every strategy is tuned to keep from both edges of its band. */
const MIN_MARGIN = 0.03;

/**
 * Simulation threads, deliberately far below `availableParallelism() - 1`.
 *
 * `pnpm verify` runs `pnpm -r run test`, which runs packages **concurrently**, and
 * `@rematch/harness`'s Gates 2 and 4 measure *wall clock* against a 2 ms per-`decide`
 * deadline. A Gate 3 suite that takes every core makes a known-good fixture over there
 * miss its budget purely by being descheduled — which is the exact flake
 * `packages/harness/vitest.config.ts` sets `fileParallelism: false` to avoid, and that
 * setting cannot protect against another package. So this suite leaves the machine
 * room on purpose: it costs a few seconds here and buys back a verdict that means what
 * it says over there. This one is the neighbour, so this one yields.
 */
const WORKERS = 2;

type Row = {
  round: BalanceRound;
  name: string;
  panel: number;
  perBot: Array<{ name: string; winRate: number }>;
  margin: number;
  /** ACTIVE: the worst motionless run over every match, in ticks (60 = 1 s). */
  idleRun: number;
  fair: boolean;
};

type Gate3Detail = {
  round: BalanceRound;
  panel: { winRate: number; perBot: Array<{ name: string; winRate: number }> };
  /** `gate3Balance` sets this string instead of a `mimic` block when no summary is given. */
  adapted?: string;
  /** ACTIVE's measurement. See `@rematch/harness`'s `sim/activity.ts`. */
  activity: { longestIdleRun: number; worstBot: string; idleFractionP90: number };
};

/** Every strategy in the pool, flattened, in round order. */
const ENTRIES = FALLBACK_ROUNDS.flatMap((round) =>
  FALLBACK_POOL[round].map((s) => ({ round, ...s })),
);

async function measure(round: BalanceRound, name: string, source: string): Promise<Row> {
  const result = await gate3Balance(source, { round, matches: MATCHES, workers: WORKERS });
  const detail = result.detail as Gate3Detail;
  const [lo, hi] = bandFor(round);
  const panel = detail.panel.winRate;
  return {
    round,
    name,
    panel,
    perBot: detail.panel.perBot,
    margin: Math.min(panel - lo, hi - panel),
    idleRun: detail.activity.longestIdleRun,
    fair: result.ok,
  };
}

describe('fallback pool', () => {
  it(`has at least ${MIN_PER_ROUND} strategies per round, with unique names`, () => {
    for (const round of FALLBACK_ROUNDS) {
      expect(FALLBACK_POOL[round].length, `round ${round}`).toBeGreaterThanOrEqual(MIN_PER_ROUND);
    }

    // Unique across the whole pool, not just within a round: the name is what the
    // player is shown and what the logs identify a fallback by, so two rounds sharing
    // one would make a bug report ambiguous.
    const names = ENTRIES.map((e) => e.name);
    expect(new Set(names).size, `duplicate names in ${names.join(', ')}`).toBe(names.length);

    // Every source is a real strategy file, not an empty placeholder.
    for (const entry of ENTRIES) {
      expect(entry.source, entry.name).toContain('export function decide');
      expect(entry.source.length, entry.name).toBeGreaterThan(400);
    }
    expect(POOL_BYTES).toBeGreaterThan(0);
  });

  it('picks deterministically by seed, and can pick every strategy', () => {
    for (const round of FALLBACK_ROUNDS) {
      const seen = new Set<string>();
      for (let seed = 0; seed < 400; seed += 1) {
        const picked = pickFallback(round, seed);
        // Same arguments, same answer — the whole point (spec AC 3).
        expect(pickFallback(round, seed).name).toBe(picked.name);
        expect(FALLBACK_POOL[round].some((s) => s.name === picked.name)).toBe(true);
        seen.add(picked.name);
      }
      // A pool member that no seed can reach is dead weight pretending to be a net.
      expect(seen.size, `round ${round} only ever picks ${[...seen].join(', ')}`).toBe(
        FALLBACK_POOL[round].length,
      );
    }
    expect(() => pickFallback(9 as unknown as BalanceRound, 1)).toThrow(/no fallback pool/);
  });

  it(
    `passes gates 1, 2 and 4, and lands in its round's band (${MATCHES} matches each)`,
    async () => {
      const rows: Row[] = [];
      const gateFailures: string[] = [];

      for (const { round, name, source } of ENTRIES) {
        // Gates 1, 2 and 4 — the cheap, strategy-only ones. Gate 3 is measured
        // separately below so the table can report the rate even when it fails.
        const quick = await runGates(source, { gates: [1, 2, 4] });
        if (!quick.approved) {
          const failed = quick.results.find((r: GateResult) => !r.ok);
          gateFailures.push(`${name} (round ${round}): gate ${failed?.gate} — ${failed?.reason}`);
        }
        rows.push(await measure(round, name, source));
      }

      const header = [
        'round'.padEnd(5),
        'strategy'.padEnd(13),
        'panel',
        ...(rows[0]?.perBot.map((b) => b.name.padStart(7)) ?? []),
        '        band',
        'margin',
        'idle run',
        ' FAIR',
      ];
      console.log(
        [
          `\nFallback pool — Gate 3 FAIR + ACTIVE per round, ${MATCHES} matches each (ADAPTED not asserted: a fallback has no replay to mimic)`,
          header.join(' '),
          ...rows.map((r) => {
            const [lo, hi] = bandFor(r.round);
            return [
              String(r.round).padEnd(5),
              r.name.padEnd(13),
              r.panel.toFixed(2).padStart(5),
              ...r.perBot.map((b) => b.winRate.toFixed(2).padStart(7)),
              `${lo.toFixed(2)}-${hi.toFixed(2)}`.padStart(12),
              `${r.margin >= 0 ? '+' : ''}${r.margin.toFixed(3)}`.padStart(6),
              `${r.idleRun}t/${ACTIVITY.maxIdleRunTicks}`.padStart(8),
              (r.fair
                ? ' PASS'
                : r.idleRun > ACTIVITY.maxIdleRunTicks
                  ? ' froz'
                  : r.panel > hi
                    ? ' hard'
                    : ' easy'
              ).padStart(5),
            ].join(' ');
          }),
        ].join('\n'),
      );

      expect(gateFailures, gateFailures.join('\n')).toHaveLength(0);

      for (const row of rows) {
        const [lo, hi] = bandFor(row.round);
        const where = `${row.name} (round ${row.round}) measured ${row.panel.toFixed(2)} against band ${lo}-${hi}`;
        expect(row.panel, where).toBeGreaterThanOrEqual(lo);
        expect(row.panel, where).toBeLessThanOrEqual(hi);
        expect(row.fair, where).toBe(true);
        // Inside the band is the requirement; a margin is what stops this suite
        // flapping on an unrelated engine tweak, so it is asserted separately with
        // its own message.
        expect(row.margin, `${where} — only ${row.margin.toFixed(3)} from an edge`).toBeGreaterThanOrEqual(
          MIN_MARGIN,
        );
        // ACTIVE. `row.fair` already covers it — the gate joins every failed
        // assertion into one reason — but asserting the number separately is what
        // makes a *near* miss visible: a boss resting at 85 of the 90 allowed ticks
        // has a resting `idle` waiting to be uncovered by the next engine tweak.
        expect(
          row.idleRun,
          `${row.name} (round ${row.round}) was motionless for ${row.idleRun} consecutive ticks; ` +
            `${ACTIVITY.maxIdleRunTicks} is the ACTIVE limit. Never return \`idle\` as a resting state.`,
        ).toBeLessThanOrEqual(ACTIVITY.maxIdleRunTicks);
      }

      // The pool escalates. Not strategy-by-strategy — the bands overlap, so two
      // adjacent rounds may legitimately share a rate — but the round's *mean* rate
      // has to climb, or "the boss gets harder" is a claim the pool does not keep.
      const meanFor = (round: BalanceRound): number => {
        const inRound = rows.filter((r) => r.round === round);
        return inRound.reduce((sum, r) => sum + r.panel, 0) / inRound.length;
      };
      const means = FALLBACK_ROUNDS.map(meanFor);
      for (let i = 1; i < means.length; i += 1) {
        expect(
          means[i]!,
          `round ${FALLBACK_ROUNDS[i]} mean ${means[i]!.toFixed(3)} is not above round ${FALLBACK_ROUNDS[i - 1]} mean ${means[i - 1]!.toFixed(3)}`,
        ).toBeGreaterThan(means[i - 1]!);
      }
    },
    120_000,
  );
});

/** Compile-time guard: the pool covers exactly the rounds that have a fairness band. */
const _rounds: readonly BalanceRound[] = FALLBACK_ROUNDS;
void _rounds;
