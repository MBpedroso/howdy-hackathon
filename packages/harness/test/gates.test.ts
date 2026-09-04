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
import { gate1Static, gate2Fuzz, gate3Balance, gate4Perf } from '../src/index.ts';
import { GOOD_FIXTURES, readBad, readGood } from './helpers.ts';

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

describe('Gates 3 and 4 — stubs', () => {
  it('gate 3 rejects with "not implemented"', () => {
    const result = gate3Balance(readGood('chaser'));
    expect(result).toMatchObject({ gate: 3, name: 'balance', ok: false, reason: 'not implemented' });
  });

  it('gate 4 rejects with "not implemented"', () => {
    const result = gate4Perf(readGood('chaser'));
    expect(result).toMatchObject({ gate: 4, name: 'perf', ok: false, reason: 'not implemented' });
  });
});
