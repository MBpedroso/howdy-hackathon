/**
 * Balance regression (spec §7): every shipped strategy's win rate against the
 * reference panel, measured through Gate 3 and printed as a table.
 *
 * Two things this suite is for, beyond catching a regression in one strategy:
 *
 *  1. **The band has to be reachable.** A fairness band that no strategy lands in
 *     is not a gate, it is a wall — the rewrite loop would burn all four attempts
 *     and fall back every round. So it asserts that at least one strategy is inside
 *     the Round 2 band *and* at least one is above it: the band is neither
 *     impossible nor free.
 *  2. **The panel has to discriminate.** `idle.js` (a boss that does nothing) must
 *     sit below the band and `orbiter.js` above it. If the panel ever rated those
 *     two the same, every Gate 3 verdict after that would be noise.
 *  3. **ACTIVE has to bite, and only where it should.** The table's `idle run`
 *     column is Gate 3's third assertion (`sim/activity.ts`): `idle.js` has to be
 *     over the limit and the shipped Round 2 boss has to be well under it. A gate
 *     that rejected everything, or nothing, would be the same as no gate.
 *
 * ## Why three of the four `contract` fixtures now read `frozen`
 *
 * `chaser`, `cornerbreaker` and `orbiter` all end `decide` with "nothing to do,
 * return `idle`", so ACTIVE rejects them (`cornerbreaker` sits *inside* the round 2
 * band and is rejected on that alone). They were deliberately **not** fixed. They
 * are `contract`'s *calibration* corpus, not shipped bosses: this suite's whole
 * argument in point 2 is that the panel rates `idle.js` at 0.00 and `orbiter` above
 * the band, and `gates.test.ts` leans on the same fixed numbers. Changing them would
 * silently re-baseline every calibration assertion in two packages to fix files no
 * player ever meets. The shipped strategies — the two in `web/src/strategies`, the
 * eight in `server/fallback`, and `round2-candidate` here — were all fixed, and
 * `harness/test/activity.test.ts` is what holds them to it.
 *
 * `pnpm test:balance`. Match count is reduced from the spec's 200 so the suite stays
 * a few seconds; the rates are stable to ±0.03 at this count (see the AI-DEV-LOG).
 */
import { describe, expect, it } from 'vitest';
import { ACTIVITY, BAND, adaptedMinFor, gate3Balance } from '../src/index.ts';
import { readCandidate, readGood, readSummary, type GoodFixture } from './helpers.ts';

/** Half of these go to the panel, half to the Mimic. */
const MATCHES = 120;
const [LO, HI] = BAND[2];
/** Round 2's ADAPTED target. Advisory there, and this suite is a round-2 suite. */
const ADAPTED_GOAL = adaptedMinFor(2);

type Row = {
  name: string;
  panel: number;
  perBot: Array<{ name: string; winRate: number }>;
  mimic: number;
  /** ACTIVE's measurement: the worst motionless run over every match, in ticks. */
  idleRun: number;
  approved: boolean;
};

type Gate3Detail = {
  panel: { winRate: number; perBot: Array<{ name: string; winRate: number }> };
  mimic?: { winRate: number };
  activity: { longestIdleRun: number };
};

/** The strategies that ship. `round2-candidate` is the hand-written Round 2 boss. */
const STRATEGIES: Array<{ name: string; source: () => string }> = [
  { name: 'idle', source: () => readGood('idle') },
  { name: 'chaser', source: () => readGood('chaser') },
  { name: 'cornerbreaker', source: () => readGood('cornerbreaker') },
  { name: 'orbiter', source: () => readGood('orbiter') },
  { name: 'round2-candidate', source: readCandidate },
];

async function measure(name: string, source: string): Promise<Row> {
  // The Mimic is built from a camper's round: the archetype the Round 2 boss is
  // expected to counter, and the one the heat map describes most sharply.
  const result = await gate3Balance(source, {
    round: 2,
    matches: MATCHES,
    mimicSummary: readSummary('camper'),
  });
  const detail = result.detail as Gate3Detail;
  return {
    name,
    panel: detail.panel.winRate,
    perBot: detail.panel.perBot,
    mimic: detail.mimic?.winRate ?? Number.NaN,
    idleRun: detail.activity.longestIdleRun,
    approved: result.ok,
  };
}

describe('balance regression', () => {
  it(`rates every shipped strategy against the panel (${MATCHES} matches each)`, async () => {
    const rows: Row[] = [];
    for (const { name, source } of STRATEGIES) rows.push(await measure(name, source()));

    const header = [
      'strategy'.padEnd(17),
      'panel',
      ...rows[0]!.perBot.map((b) => b.name.padStart(7)),
      '  Mimic',
      'idle run',
      ' round 2',
    ];
    const lines = [
      `\nGate 3, round 2 — band ${LO.toFixed(2)}–${HI.toFixed(2)}, ADAPTED >= ${ADAPTED_GOAL.toFixed(2)}, ACTIVE <= ${ACTIVITY.maxIdleRunTicks} ticks, ${MATCHES} matches each`,
      header.join(' '),
      ...rows.map((r) =>
        [
          r.name.padEnd(17),
          r.panel.toFixed(2).padStart(5),
          ...r.perBot.map((b) => b.winRate.toFixed(2).padStart(7)),
          r.mimic.toFixed(2).padStart(7),
          `${r.idleRun}t`.padStart(8),
          (r.approved
            ? '  PASS'
            : r.idleRun > ACTIVITY.maxIdleRunTicks
              ? ' frozen'
              : r.panel > HI
                ? '  hard'
                : r.panel < LO
                  ? '  easy'
                  : ' adapt?'
          ).padStart(8),
        ].join(' '),
      ),
    ];
    console.log(lines.join('\n'));

    // 1. Every strategy is rated, and the rate is a rate.
    for (const row of rows) {
      expect(row.panel, row.name).toBeGreaterThanOrEqual(0);
      expect(row.panel, row.name).toBeLessThanOrEqual(1);
      expect(row.perBot).toHaveLength(4);
    }

    // 2. The panel discriminates: a boss that does nothing must not rate like one
    //    that wins every match.
    const rate = (name: string): number => rows.find((r) => r.name === name)!.panel;
    expect(rate('idle')).toBe(0);
    expect(rate('orbiter')).toBeGreaterThan(HI);
    expect(rate('chaser')).toBeGreaterThan(HI);

    // 3. The band is reachable, and it is not free.
    const inBand = rows.filter((r) => r.panel >= LO && r.panel <= HI);
    const aboveBand = rows.filter((r) => r.panel > HI);
    expect(inBand.map((r) => r.name), 'at least one strategy must land in the Round 2 band').not.toHaveLength(0);
    expect(aboveBand.map((r) => r.name), 'at least one strategy must be above the band').not.toHaveLength(0);

    // 4. ACTIVE discriminates too, and in the right direction: the boss that does
    //    nothing is over the limit, and the one that ships is nowhere near it.
    const idleRun = (name: string): number => rows.find((r) => r.name === name)!.idleRun;
    expect(idleRun('idle')).toBeGreaterThan(ACTIVITY.maxIdleRunTicks);
    expect(idleRun('round2-candidate')).toBeLessThanOrEqual(ACTIVITY.maxIdleRunTicks);

    // 5. The hand-written Round 2 boss passes all three assertions: in the band, it
    //    counters the camper it was written for, and it never stops moving.
    const candidate = rows.find((r) => r.name === 'round2-candidate')!;
    expect(candidate.panel).toBeGreaterThanOrEqual(LO);
    expect(candidate.panel).toBeLessThanOrEqual(HI);
    expect(candidate.mimic).toBeGreaterThanOrEqual(ADAPTED_GOAL);
    expect(candidate.idleRun).toBeLessThanOrEqual(ACTIVITY.maxIdleRunTicks);
    expect(candidate.approved).toBe(true);
  }, 120_000);

  it('the reference bots each measure something different', async () => {
    // A panel whose members agree is one bot with four names. `cornerbreaker` is
    // the counter-camper, so it must beat the Camper and lose to the Kiter — that
    // spread is the whole reason Gate 3 reports per-bot rates in `detail`.
    const row = await measure('cornerbreaker', readGood('cornerbreaker'));
    const byName = new Map(row.perBot.map((b) => [b.name, b.winRate]));
    expect(byName.get('Camper')!).toBeGreaterThan(0.8);
    expect(byName.get('Kiter')!).toBeLessThan(0.4);
  }, 120_000);
});

/** Compile-time guard: the table's fixture names are real fixtures. */
const _fixtures: readonly GoodFixture[] = ['idle', 'chaser', 'cornerbreaker', 'orbiter'];
void _fixtures;
