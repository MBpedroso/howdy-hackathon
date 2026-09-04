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
import { ADAPTED_MIN, BAND, DEFAULT_MATCHES, MEASURE_SLACK, gate1Static, gate2Fuzz, gate3Balance, gate4Perf } from '../src/index.ts';
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

  it('is deterministic: the same seed gives the same verdict and the same counts', async () => {
    const a = await gate2Fuzz(readBad('nan-angle'), { seed: 42, states: 200 });
    const b = await gate2Fuzz(readBad('nan-angle'), { seed: 42, states: 200 });
    expect(a.ok).toBe(false);
    if (a.ok || b.ok) return;
    expect(b.reason).toBe(a.reason);
    // Everything except the timing distribution is a pure function of
    // (source, seed, states) — `elapsedMs` is wall clock and never repeats.
    const strip = (detail: unknown): unknown => {
      const { elapsedMs: _elapsedMs, ...rest } = detail as Record<string, unknown>;
      return rest;
    };
    expect(strip(b.detail)).toEqual(strip(a.detail));
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

  it('reports both failures in one reason when both assertions fail', async () => {
    const result = await gate3Balance(readGood('idle'), {
      round: 2,
      matches: 40,
      mimicSummary: readSummary('camper'),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/too easy/);
    expect(result.reason).toMatch(/0\.00 vs Mimic — didn't adapt \(need >= 0\.70\)/);
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
