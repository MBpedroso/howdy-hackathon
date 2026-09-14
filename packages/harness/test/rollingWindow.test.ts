/**
 * Feasibility check for analysis item 1 / open question Q2
 * (`docs/ANALYSIS-learning-signal-2026-09-09.md`, §5 Q2): before any model is asked
 * to write a rolling-window strategy, does the pattern itself — a 60-entry ring of
 * the player's recent cell, sampled every 10 ticks and kept in `mem` alongside
 * everything else the strategy remembers — fit inside the contract's 4 KB memory
 * cap and 2 ms `decide` budget?
 *
 * `fixtures/rolling-window.js` is the hand-written proof (the same pattern
 * `harnessHints`, `packages/agents/src/context/prompts.ts`, now asks the Coder to
 * write); this file is the measurement. Whether a *model* reproduces the pattern
 * reliably is a separate, spend-gated question (no LLM call happens here or
 * anywhere in this file) — this only bounds the mechanics.
 *
 * The fixture is not tuned to any fairness band and is deliberately not asserted
 * against Gate 3: only Gates 1, 2 and 4 are what this file's claim needs.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONSTANTS } from '@rematch/contract';
import { gate1Static, gate2Fuzz, gate4Perf, getSandbox, kiter, runMatchWith } from '../src/index.ts';

function readRollingWindow(): string {
  return readFileSync(new URL('./fixtures/rolling-window.js', import.meta.url), 'utf8');
}

describe('rolling-window mem feasibility (analysis item 1, Q2)', () => {
  const source = readRollingWindow();

  it('passes Gate 1 (static)', () => {
    const result = gate1Static(source);
    expect(result.ok).toBe(true);
  });

  it('passes Gate 2 (fuzz): no memory or timeout failures on ~500 generated states', async () => {
    const result = await gate2Fuzz(source);
    if (!result.ok) throw new Error(`rejected: ${result.reason}`);
    // The empty `failures` object is the same thing `gates.test.ts` checks for
    // every known-good fixture — no failure of any kind, `memory` and `timeout`
    // included, on the fuzz corpus or the 60-tick sequence pass.
    expect(result.detail).toMatchObject({ failures: {} });
  });

  it('passes Gate 4 (perf): p99 stays inside the 2 ms budget', async () => {
    const result = await gate4Perf(source);
    if (!result.ok) throw new Error(`rejected: ${result.reason}`);
    const detail = result.detail as { p99: number };
    expect(detail.p99).toBeGreaterThan(0);
    expect(detail.p99).toBeLessThanOrEqual(CONSTANTS.limits.decideBudgetMs);
  }, 60_000);

  it('keeps the serialized ring buffer under the 4 KB memory cap over a full match', async () => {
    // Gate 2 and Gate 4 already reject a strategy whose memory blows the cap —
    // they would have failed above if this one did — so this is the direct
    // measurement they imply: load the runner, play it out to the engine's own
    // clock (3600 ticks, well past the 600 ticks / 10 s the ring takes to fill
    // completely), and read the size the sandbox itself measured.
    const sandbox = await getSandbox();
    const runner = sandbox.load(source);
    try {
      const result = runMatchWith(runner, kiter(), 1);
      expect(result.strategyKilled).toBe(false);
      expect(runner.memoryBytes()).toBeLessThan(CONSTANTS.limits.memoryBytes);
      // Ballpark, pinned as a number rather than left as pass/fail: 60 small
      // integers plus two counters is nowhere near the 4 KB ceiling, and a
      // regression that changed the ring to store, say, cell centres instead of
      // indices would still pass the cap but show up here.
      expect(runner.memoryBytes()).toBeLessThan(600);
    } finally {
      runner.dispose();
    }
  }, 30_000);
});
