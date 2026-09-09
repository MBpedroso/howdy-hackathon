/**
 * Harness self-test (spec §7): known-broken fixtures are rejected **at the
 * expected gate**, known-good fixtures pass, and every rejection reason says
 * something the Coder agent can act on.
 *
 * The reason assertions are regexes rather than exact strings on purpose: the
 * wording is allowed to improve, but a reason that stopped naming the primitive,
 * the percentage or the thrown message would be a regression — that text is the
 * only feedback the next attempt gets.
 */
import { describe, expect, it } from 'vitest';
import { CONSTANTS } from '@rematch/contract';
import { MONOTONIC_STEP_MS } from '@rematch/sandbox';
import {
  ACTIVITY,
  ADAPTED_MIN,
  BAND,
  DEFAULT_MATCHES,
  MEASURE_SLACK,
  gate1Static,
  gate2Fuzz,
  gate3Balance,
  gate3Plan,
  gate4Perf,
} from '../src/index.ts';
import { GOOD_FIXTURES, readBad, readCandidate, readGood, readSummary } from './helpers.ts';

describe('Gate 1 — static', () => {
  it.each(GOOD_FIXTURES)('%s passes', (name) => {
    const result = gate1Static(readGood(name));
    expect(result.ok).toBe(true);
  });

  it('rejects a strategy that uses Date, naming the line', () => {
    const result = gate1Static(readBad('uses-date'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/line \d+: forbidden identifier 'Date'/);
    expect(result.detail).toMatchObject({ rules: expect.arrayContaining(['forbidden-identifier']) });
  });

  it('names at most three violations and counts the rest', () => {
    const source = `export const meta = { name: 'x', rationale: 'y', version: 1 };
export function init() { return { a: Date.now() }; }
export function decide() {
  fetch('/x');
  console.log(process.pid);
  eval('1');
  return { type: 'idle', r: Math.random() };
}`;
    const result = gate1Static(source);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.split('; ')).toHaveLength(3);
    expect(result.reason).toMatch(/and \d+ more violations\)$/);
  });

  it('is fast enough to run first', () => {
    const result = gate1Static(readGood('orbiter'));
    expect(result.ms).toBeLessThan(200);
  });
});

describe('Gate 2 — fuzz', () => {
  it.each(GOOD_FIXTURES)('%s passes with a clean detail', async (name) => {
    const result = await gate2Fuzz(readGood(name));
    if (!result.ok) throw new Error(`${name} was rejected: ${result.reason}`);
    expect(result.detail).toMatchObject({
      states: 500,
      failures: {},
      sequence: { ticks: 60 },
    });
    const detail = result.detail as { invalid: number; onCooldown: number; states: number };
    expect(detail.invalid).toBe(0);
    // Even a good strategy may ask for something on cooldown occasionally; it is
    // the *rate* that has to stay under the 20% limit.
    expect(detail.onCooldown / detail.states).toBeLessThanOrEqual(0.2);
  });

  it('rejects a strategy that throws, quoting the message and the first state', async () => {
    const result = await gate2Fuzz(readBad('throws-on-corner'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/^decide\(\) threw '.+' on \d+\/\d+ states/);
    expect(result.reason).toMatch(/first at state \d+: tick \d+/);
    expect(result.detail).toMatchObject({ failures: { throw: expect.any(Number) } });
  });

  it('rejects an infinite loop as a timeout, and does not hang', async () => {
    const started = performance.now();
    const result = await gate2Fuzz(readBad('infinite-loop'), { states: 40, sequenceTicks: 0 });
    const wall = performance.now() - started;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(new RegExp(`exceeded its ${CONSTANTS.limits.decideBudgetMs} ms budget`));
    // 40 states x ~2 ms of deadline is the floor; anything near a hang fails.
    expect(wall).toBeLessThan(5000);
  });

  it('rejects a 5 ms decide as a timeout (Gate 4 would only see it as a p99)', async () => {
    const result = await gate2Fuzz(readBad('slow-decide'), { states: 20, sequenceTicks: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/exceeded its \d+ ms budget on \d+\/\d+ states/);
  });

  it('rejects a memory hog, naming the limit', async () => {
    const result = await gate2Fuzz(readBad('memory-hog'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(
      new RegExp(`memory grew past the ${CONSTANTS.limits.memoryBytes}-byte limit \\(\\d+ bytes\\)`),
    );
  });

  it('rejects a strategy that returns a string, grouped by validator reason', async () => {
    const result = await gate2Fuzz(readBad('returns-string'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/returned an invalid action on 100\.0% of states/);
    expect(result.reason).toMatch(/action must be a plain object, got "burst"/);
  });

  it('rejects NaN angles, and the reason says NaN', async () => {
    const result = await gate2Fuzz(readBad('nan-angle'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/returned an invalid action on \d+\.\d% of states/);
    expect(result.reason).toMatch(/burst\.angle must be a finite number, got NaN/);
  });

  it('rejects out-of-arena slams, grouping the varying coordinates into one bug', async () => {
    const result = await gate2Fuzz(readBad('out-of-bounds'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/out of arena bounds/);
    // The numbers differ on every state; grouping has to collapse them, or the
    // "most common" count would always be 1.
    const detail = result.detail as { byReason: Record<string, number> };
    expect(Math.max(...Object.values(detail.byReason))).toBeGreaterThan(5);
  });

  it('rejects a strategy that ignores cooldowns, naming the primitive and the fix', async () => {
    const result = await gate2Fuzz(readBad('ignores-cooldowns'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/still on cooldown on \d+\.\d% of states/);
    expect(result.reason).toMatch(/burst \(\d+ states\)/);
    expect(result.reason).toMatch(/view\.boss\.cooldowns/);
    expect(result.detail).toMatchObject({ byPrimitive: { burst: expect.any(Number) } });
  });

  /**
   * The whole detail, timing included — which is the part that used to be untrue.
   *
   * This test used to strip `elapsedMs` before comparing, on the grounds that it
   * "is wall clock and never repeats". That was the bug, not a caveat: the gate
   * loaded the sandbox on `performance.now()` while promising that "(states, seed)
   * is all you need to reproduce a rejection", and because *any* single runner
   * failure is a rejection here, one GC pause inside one `decide` was the whole
   * verdict. A strategy sitting near the 2 ms budget measured 0 over-budget states
   * on an idle machine and 4 of 560 on a loaded one
   * (`docs/REVIEW-2026-09-08.md` §2).
   *
   * Since 2026-09-08 the gate loads on `monotonicClock()`, so the budget bounds
   * *work* rather than time and the timing distribution is a pure function of the
   * source too — `p50` comes back as an exact multiple of `MONOTONIC_STEP_MS`.
   * Asserting `toEqual` on the unstripped detail is the assertion that says so.
   */
  it('is deterministic: the same seed gives the same verdict, counts and timings', async () => {
    const a = await gate2Fuzz(readBad('nan-angle'), { seed: 42, states: 200 });
    const b = await gate2Fuzz(readBad('nan-angle'), { seed: 42, states: 200 });
    expect(a.ok).toBe(false);
    if (a.ok || b.ok) return;
    expect(b.reason).toBe(a.reason);
    expect(b.detail).toEqual(a.detail);
    // Not merely equal by luck: a wall clock cannot land on an exact multiple of
    // the monotonic step twice, so this is what proves *which* clock ran.
    const { elapsedMs } = a.detail as { elapsedMs: { p50: number; max: number } };
    expect(elapsedMs.p50 % MONOTONIC_STEP_MS).toBe(0);
    expect(elapsedMs.max % MONOTONIC_STEP_MS).toBe(0);
  });

  /**
   * ...and the caller can still ask for the real clock, which is what
   * `test/gates.test.ts`' own timeout tests and a live browser tab need. The
   * monotonic clock is a *default*, not a lock.
   */
  it('lets a caller override the clock, so a real-time budget is still testable', async () => {
    const result = await gate2Fuzz(readBad('slow-decide'), {
      states: 20,
      sequenceTicks: 0,
      sandboxOptions: { now: () => performance.now() },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/exceeded its \d+ ms budget/);
    const { elapsedMs } = result.detail as { elapsedMs: { max: number } };
    // A real clock does not land on the monotonic grid.
    expect(elapsedMs.max % MONOTONIC_STEP_MS).not.toBe(0);
  });

  it('a different seed still rejects the same broken strategy', async () => {
    for (const seed of [1, 7, 999, 0x1234]) {
      const result = await gate2Fuzz(readBad('nan-angle'), { seed, states: 200 });
      expect(result.ok, `seed ${seed}`).toBe(false);
    }
  });

  it('covers the corner states before any random ones', async () => {
    // `throws-on-corner` only throws when player.x < 50, which the corner list
    // guarantees regardless of seed — so 20 states are enough to catch it.
    const result = await gate2Fuzz(readBad('throws-on-corner'), { states: 20, sequenceTicks: 0, seed: 1 });
    expect(result.ok).toBe(false);
  });

  it('records an elapsedMs distribution for Gate 4 to reuse', async () => {
    const result = await gate2Fuzz(readGood('chaser'), { states: 120 });
    expect(result.ok).toBe(true);
    const detail = result.detail as { elapsedMs: { samples: number; p50: number; p99: number } };
    expect(detail.elapsedMs.samples).toBe(180); // 120 fuzz states + 60 sequence ticks
    expect(detail.elapsedMs.p50).toBeGreaterThan(0);
    expect(detail.elapsedMs.p99).toBeGreaterThanOrEqual(detail.elapsedMs.p50);
  });

  it('reports a runtime load failure as its own reason', async () => {
    // Passes Gate 1 (no forbidden names, correct shape) but cannot evaluate.
    const source = `export const meta = { name: 'x', rationale: 'y', version: 1 };
export function init() { return {}; }
export function decide() { return { type: 'idle' }; }
const boom = null;
boom.explode();`;
    expect(gate1Static(source).ok).toBe(true);
    const result = await gate2Fuzz(source);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/could not be loaded/);
  });

  it('reports a throwing init as its own reason', async () => {
    const source = `export const meta = { name: 'x', rationale: 'y', version: 1 };
export function init() { throw new Error('no memory for you'); }
export function decide() { return { type: 'idle' }; }`;
    const result = await gate2Fuzz(source);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/init\(\) failed: no memory for you/);
  });

  it('a strategy that only grows memory on consecutive ticks is caught by the sequence pass', async () => {
    // Grows only when the tick is exactly one more than the last one seen, which
    // the jumping fuzz states almost never satisfy.
    const source = `export const meta = { name: 'Creep', rationale: 'y', version: 1 };
export function init() { return { last: -1, log: [] }; }
export function decide(view, mem) {
  if (view.tick === mem.last + 1) { for (let i = 0; i < 40; i++) mem.log.push(view.tick); }
  mem.last = view.tick;
  return { type: 'idle' };
}`;
    const result = await gate2Fuzz(source, { states: 60, sequenceTicks: 60 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/memory grew past/);
  });
});

describe('Gate 3 — balance', () => {
  it('rejects the null boss as too easy, quantitatively', async () => {
    const result = await gate3Balance(readGood('idle'), { round: 2, matches: 40 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/^0\.00 vs panel — too easy \(band 0\.35–0\.50 for round 2;/);
    // The per-bot breakdown is what tells the Coder which approach to threaten.
    expect(result.reason).toMatch(/Camper 0\.00, Kiter 0\.00, Rusher 0\.00, Dodger 0\.00/);
    expect(result.detail).toMatchObject({ round: 2, panel: { winRate: 0 } });
  });

  it('rejects a dominant boss as too hard, naming the band', async () => {
    const result = await gate3Balance(readGood('orbiter'), { round: 2, matches: 40 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/vs panel — too hard \(band 0\.35–0\.50 for round 2;/);
    const detail = result.detail as { panel: { winRate: number } };
    expect(detail.panel.winRate).toBeGreaterThan(0.5);
  });

  it('approves the hand-written Round 2 candidate on both assertions', async () => {
    const result = await gate3Balance(readCandidate(), {
      round: 2,
      matches: DEFAULT_MATCHES,
      mimicSummary: readSummary('camper'),
    });
    if (!result.ok) throw new Error(`round2-candidate was rejected: ${result.reason}`);
    const detail = result.detail as {
      panel: { winRate: number; matches: number };
      mimic: { winRate: number; matches: number };
    };
    const [lo, hi] = BAND[2];
    expect(detail.panel.winRate).toBeGreaterThanOrEqual(lo);
    expect(detail.panel.winRate).toBeLessThanOrEqual(hi);
    expect(detail.mimic.winRate).toBeGreaterThanOrEqual(ADAPTED_MIN);
    // The budget is split down the middle (spec §6.2), N/2 each.
    expect(detail.panel.matches).toBe(DEFAULT_MATCHES / 2);
    expect(detail.mimic.matches).toBe(DEFAULT_MATCHES / 2);
  }, 60_000);

  it('reports every failed assertion in one reason, blocking ones first', async () => {
    const result = await gate3Balance(readGood('idle'), {
      round: 2,
      matches: 40,
      mimicSummary: readSummary('camper'),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/too easy/);
    expect(result.reason).toMatch(/boss motionless for \d+ consecutive ticks/);
    // ADAPTED advises rather than blocks (2026-09-08), and the wording says so —
    // the Coder should still aim at it, and must not read it as the rejection.
    expect(result.reason).toMatch(/0\.00 vs Mimic — aim for >= 0\.70 \(not blocking\)/);
    expect(result.reason).not.toMatch(/didn't adapt/);
    // The order is fixed and it is a judgement about what the Coder reads first:
    // the two assertions that actually refused the file, then the goal it missed.
    const fair = result.reason.indexOf('too easy');
    const active = result.reason.indexOf('boss motionless');
    const advice = result.reason.indexOf('aim for');
    expect(fair).toBeLessThan(active);
    expect(active).toBeLessThan(advice);
  });

  /**
   * The change of 2026-09-08, as the one case that proves it.
   *
   * `hound.js` is in band and active, and it scores 0.00 against a Mimic built from
   * a *different* player than the one it was written for. Before this change that
   * was a rejection — and on the 12-attempt live run it was eight rejections in a
   * row, on a round the human had won without taking damage, because the Mimic of a
   * flawless run is a bot no in-band boss can beat 70% of the time.
   */
  it('approves a candidate whose only shortfall is ADAPTED, and still reports it', async () => {
    // In band at 0.35, active, and 0.65 against a Mimic of the kiter — a real file
    // that misses the 0.70 target by five points and nothing else. It was a
    // rejection until 2026-09-08.
    const result = await gate3Balance(readCandidate(), {
      round: 2,
      matches: 40,
      mimicSummary: readSummary('kiter'),
    });
    const detail = result.detail as {
      mimic: { winRate: number };
      adapted: { met: boolean; blocking: false };
    };
    // The premise of the test: it really did miss ADAPTED.
    expect(detail.adapted.met).toBe(false);
    expect(detail.mimic.winRate).toBeLessThan(ADAPTED_MIN);
    // …and it shipped anyway, with the miss on the record.
    expect(result.ok).toBe(true);
    expect(detail.adapted.blocking).toBe(false);
  }, 60_000);

  /**
   * ACTIVE, the assertion a human playtest bought.
   *
   * `idle.js` used to be rejected as "too easy" alone, and that was the whole
   * problem: a boss can be frozen *and* in band — a stationary boss is easy to
   * shoot, so freezing helped the win rate — and then nothing in the harness had
   * anything to say about it. See `sim/activity.ts`.
   */
  it('rejects a boss that stands still, quantitatively and with the fix in the sentence', async () => {
    const result = await gate3Balance(readGood('idle'), { round: 2, matches: 40 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(
      /boss motionless for \d+ consecutive ticks \(\d+\.\d s\) vs \w+ — never return idle as a resting state; patrol, reposition or feint instead \(limit 90 ticks\)/,
    );
    const detail = result.detail as {
      thresholds: { maxIdleRunTicks: number; maxIdleFractionP90: number };
      activity: { longestIdleRun: number; worstBot: string; idleFractionP90: number };
      panel: { perBot: Array<{ name: string; maxIdleRun: number }> };
    };
    expect(detail.thresholds.maxIdleRunTicks).toBe(ACTIVITY.maxIdleRunTicks);
    expect(detail.thresholds.maxIdleFractionP90).toBe(ACTIVITY.maxIdleFractionP90);
    // The null boss never moves at all, so its worst run is the whole match and
    // every tick of it is idle.
    expect(detail.activity.longestIdleRun).toBeGreaterThan(ACTIVITY.maxIdleRunTicks);
    expect(detail.activity.idleFractionP90).toBe(1);
    expect(detail.activity.worstBot).not.toBe('');
    // Per bot too, so a rejection can say which approach froze the boss.
    for (const bot of detail.panel.perBot) {
      expect(bot.maxIdleRun, bot.name).toBeGreaterThan(ACTIVITY.maxIdleRunTicks);
    }
  });

  it('approves the Round 2 candidate on ACTIVE, so the assertion is not just strict', async () => {
    const result = await gate3Balance(readCandidate(), { round: 2, matches: 40 });
    expect(result.ok).toBe(true);
    const detail = result.detail as {
      activity: { longestIdleRun: number; idleFractionP90: number; minSpanPx: number };
    };
    expect(detail.activity.longestIdleRun).toBeLessThanOrEqual(ACTIVITY.maxIdleRunTicks);
    expect(detail.activity.idleFractionP90).toBeLessThanOrEqual(ACTIVITY.maxIdleFractionP90);
    expect(detail.activity.minSpanPx).toBeGreaterThanOrEqual(ACTIVITY.minSpanPx);
  }, 60_000);

  /**
   * ACTIVE's span clause, the assertion an independent review bought.
   *
   * The mirror image of the `idle.js` case above, and the reason one number was
   * not enough. `jitter.js` never stalls for a single tick — `move` is normalized
   * to a unit vector, so it steps its full 2.6 px every tick — so it posts the
   * *best possible* values on both of the clauses that came first, and it does it
   * inside the fairness band. Before this clause it was approved for Round 2. See
   * `sim/activity.ts` and `docs/REVIEW-2026-09-08.md`.
   */
  it('rejects a boss that vibrates on the spot, which the idle clauses call 100% active', async () => {
    const result = await gate3Balance(readBad('jitter'), { round: 2, matches: 40 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(
      /boss never left a \d+ px patch of floor over a whole match vs \w+ — moving back and forth on the spot is not playing; commit to a direction for long enough to change the range you fight at \(need \d+ px\)/,
    );
    const detail = result.detail as {
      thresholds: { minSpanPx: number };
      activity: {
        longestIdleRun: number;
        idleFractionP90: number;
        minSpanPx: number;
        narrowestBot: string;
      };
    };
    expect(detail.thresholds.minSpanPx).toBe(ACTIVITY.minSpanPx);
    // What makes this the interesting counter-example: the two older clauses are
    // not merely passed, they are passed perfectly.
    expect(detail.activity.longestIdleRun).toBe(0);
    expect(detail.activity.idleFractionP90).toBe(0);
    // And the span is the only thing that noticed.
    expect(detail.activity.minSpanPx).toBeLessThan(ACTIVITY.minSpanPx);
    expect(detail.activity.narrowestBot).not.toBe('');
  }, 60_000);

  /**
   * The rejection has to name *both* problems when there are both.
   *
   * The span clause is deliberately outside the `else if` chain the two idle
   * clauses share: a boss that freezes for a stretch and creeps around a corner
   * for the rest has two things to fix, and this string is the whole of the
   * Coder's feedback (spec §6.3). `idle.js` is the case that has both — it never
   * moves, so its span is 0 and its idle run is the whole match.
   */
  it('reports the stall and the span together when a boss has both', async () => {
    const result = await gate3Balance(readGood('idle'), { round: 2, matches: 40 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/boss motionless for \d+ consecutive ticks/);
    expect(result.reason).toMatch(/boss never left \d+ px patch|boss never left a \d+ px patch/);
  });

  it('skips ADAPTED when no replay summary is supplied', async () => {
    const result = await gate3Balance(readCandidate(), { round: 2, matches: 40 });
    expect(result.detail).toMatchObject({ adapted: expect.stringContaining('skipped') });
    expect(JSON.stringify(result.detail)).not.toContain('"mimic"');
  });

  it('escalates the band per round, so the same boss can be fair in 2 and too easy in 5', async () => {
    const source = readCandidate();
    const round2 = await gate3Balance(source, { round: 2, matches: 40 });
    const round5 = await gate3Balance(source, { round: 5, matches: 40 });
    expect(round2.ok).toBe(true);
    expect(round5.ok).toBe(false);
    if (!round5.ok) expect(round5.reason).toMatch(/too easy \(band 0\.55–0\.70 for round 5/);
  }, 60_000);

  it('reports one progress bar across both halves of the budget', async () => {
    const summary = readSummary('camper');
    const opts = { round: 2, matches: 40, mimicSummary: summary } as const;
    const plan = gate3Plan(opts);
    const reported: Array<[number, number]> = [];

    const result = await gate3Balance(readCandidate(), {
      ...opts,
      onProgress: (done, total) => void reported.push([done, total]),
    });

    // The plan is the same arithmetic the gate ran, so a meter can be labelled
    // before the first match: 20 panel matches (5 seeds x 4 bots) plus 20 Mimic.
    expect(plan).toMatchObject({ perBotSeeds: 5, mimicSeeds: 20, panelMatches: 20, total: 40 });
    expect((result.detail as { matches: number }).matches).toBe(plan.total);

    expect(reported.length).toBeGreaterThan(1);
    // One bar, not two: the Mimic's matches continue the panel's count instead of
    // restarting it, and the total never changes underneath the meter.
    let previous = 0;
    for (const [done, total] of reported) {
      expect(total).toBe(plan.total);
      expect(done).toBeGreaterThan(previous);
      previous = done;
    }
    expect(reported.at(-1)).toEqual([plan.total, plan.total]);
    // The panel's own final callback lands mid-bar, not at 100%.
    expect(reported.some(([done]) => done === plan.panelMatches)).toBe(true);
  }, 60_000);

  it('plans no Mimic matches when there is no replay to mimic', () => {
    expect(gate3Plan({ matches: 40 })).toMatchObject({ mimicSeeds: 0, mimicMatches: 0, total: 20 });
    // The panel's half is spent identically either way, so FAIR stays comparable.
    expect(gate3Plan({ matches: 40 }).panelMatches).toBe(gate3Plan({ matches: 40, mimicSummary: readSummary('camper') }).panelMatches);
  });

  it('is deterministic, and independent of the worker count', async () => {
    const opts = { round: 2, matches: 40, mimicSummary: readSummary('kiter') } as const;
    const one = await gate3Balance(readGood('cornerbreaker'), { ...opts, workers: 1 });
    const many = await gate3Balance(readGood('cornerbreaker'), { ...opts, workers: 3 });
    expect(one.ok).toBe(many.ok);
    if (one.ok || many.ok) return;
    expect(many.reason).toBe(one.reason);
    // Every number in `detail` is part of the verdict except the timings.
    const strip = (detail: unknown): unknown => {
      const clone = JSON.parse(JSON.stringify(detail)) as Record<string, unknown>;
      delete (clone['panel'] as Record<string, unknown>)['ms'];
      delete (clone['mimic'] as Record<string, unknown>)['ms'];
      delete clone['workers'];
      return clone;
    };
    expect(strip(many.detail)).toEqual(strip(one.detail));
  }, 60_000);
});

describe('Gate 4 — perf', () => {
  it('passes a normal strategy over at least 2000 real calls', async () => {
    const result = await gate4Perf(readCandidate());
    if (!result.ok) throw new Error(`round2-candidate was rejected: ${result.reason}`);
    const detail = result.detail as { samples: number; matchCalls: number; fuzzCalls: number; p99: number };
    expect(detail.samples).toBeGreaterThanOrEqual(2000);
    // Both corpora are represented: real match trajectories and Gate 2's states.
    expect(detail.matchCalls).toBeGreaterThan(0);
    expect(detail.fuzzCalls).toBeGreaterThan(0);
    expect(detail.p99).toBeGreaterThan(0);
    expect(detail.p99).toBeLessThanOrEqual(CONSTANTS.limits.decideBudgetMs);
  }, 60_000);

  it('rejects a slow decide with the p99 and the budget', async () => {
    const result = await gate4Perf(readBad('slow-decide'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(
      new RegExp(`^decide\\(\\) p99 = \\d+\\.\\dms > ${CONSTANTS.limits.decideBudgetMs}ms over \\d+ calls`),
    );
    expect(result.reason).toMatch(/p50 = \d+\.\d+ms/);
  }, 60_000);

  it('stops measuring once the p99 allowance is spent, so a hang cannot stall the gate', async () => {
    const started = performance.now();
    const result = await gate4Perf(readBad('infinite-loop'));
    const wall = performance.now() - started;
    expect(result.ok).toBe(false);
    expect(result.detail).toMatchObject({ stoppedEarly: true });
    // 2000 calls x a 16 ms deadline would be 32 s; the allowance caps it at ~21.
    expect(wall).toBeLessThan(5000);
  }, 60_000);

  it('rejects a memory failure regardless of timing', async () => {
    const result = await gate4Perf(readBad('memory-hog'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(
      new RegExp(`memory grew past the ${CONSTANTS.limits.memoryBytes}-byte limit \\(\\d+ bytes\\)`),
    );
  }, 60_000);

  it('measures with a relaxed deadline so the reported p99 is the real cost', () => {
    // Gate 2 enforces the shipping 2 ms as a hard interrupt, so measuring there
    // would report every slow strategy as "p99 = 2.0 ms" — see MEASURE_SLACK.
    expect(MEASURE_SLACK).toBeGreaterThan(1);
  });
});
