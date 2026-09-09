import { describe, expect, it } from 'vitest';
import { createGame, type GameState } from '@rematch/engine';
import { debugFooterEnabled, formatClock, formatRunnerLine, originLabel } from '../src/ui/hud.ts';
import type { RunnerStats } from '../src/game/runnerStats.ts';

describe('formatClock', () => {
  it('counts down from the 60-second round cap', () => {
    expect(formatClock(0)).toBe('1:00');
    expect(formatClock(60)).toBe('0:59');
    expect(formatClock(3600)).toBe('0:00');
  });

  it('never goes negative', () => {
    expect(formatClock(99999)).toBe('0:00');
  });
});

describe('formatRunnerLine', () => {
  const stats = (over: Partial<RunnerStats> = {}): RunnerStats => ({
    calls: 300,
    ok: 300,
    idle: 0,
    failures: {},
    worstStreak: 0,
    streak: 0,
    lastFailure: null,
    p50Ms: 0.03,
    p99Ms: 0.11,
    maxMs: 0.2,
    ...over,
  });

  const state = (over: Partial<GameState> = {}): GameState => {
    const s = createGame(1, {
      meta: { name: 'Test', rationale: 'x', version: 1 },
      init: () => {},
      decide: () => ({ ok: true, action: { type: 'idle' }, elapsedMs: 0 }),
      memoryBytes: () => 0,
      dispose: () => {},
    });
    return Object.assign(s, over);
  };

  it('shows only the decide quantiles while everything is healthy', () => {
    expect(formatRunnerLine(state(), stats())).toBe('d 0.03/0.11ms');
  });

  it('says nothing at all before the first decide call', () => {
    expect(formatRunnerLine(state(), stats({ calls: 0 }))).toBe('');
    expect(formatRunnerLine(state(), null)).toBe('');
  });

  // The whole point of the line: a stalled strategy has to be readable as one.
  it('names the failure kind, the count and the consecutive streak', () => {
    const line = formatRunnerLine(
      state({ violations: 42 }),
      stats({ failures: { timeout: 40, throw: 2 }, worstStreak: 37, p50Ms: 2.4, p99Ms: 20 }),
    );
    expect(line).toContain('d 2.40/20.00ms');
    expect(line).toContain('viol 42');
    expect(line).toContain('40 timeout');
    expect(line).toContain('2 throw');
    expect(line).toContain('x37');
  });

  // The counter the reported bug needed: 219 idle calls out of 510 and not one
  // violation, so nothing else on this line would have moved.
  it('calls out a strategy that keeps asking for nothing', () => {
    expect(formatRunnerLine(state(), stats({ idle: 219, calls: 510 }))).toContain('idle 43%');
    // A boss holding position for a beat is normal and must not cry wolf.
    expect(formatRunnerLine(state(), stats({ idle: 20, calls: 300 }))).not.toContain('idle');
  });

  it('shouts when the sandbox killed the strategy', () => {
    expect(formatRunnerLine(state({ strategyKilled: true }), stats())).toContain('KILLED');
  });
});

/**
 * The determinism footer's on/off decision, as a pure function.
 *
 * Whether the footer is *rendered* is a DOM question and belongs to the Playwright
 * suite (`e2e/boot.spec.ts`); what belongs here is the rule, because "off by default"
 * is the whole point and a default that flips silently is the regression. See
 * `debugFooterEnabled` for why the footer moved behind a flag at all.
 */
describe('debugFooterEnabled', () => {
  it('is off by default, which is the behaviour that changed', () => {
    expect(debugFooterEnabled('')).toBe(false);
    expect(debugFooterEnabled('?seed=424242&autostart=1')).toBe(false);
  });

  it('is on for the technical walkthrough', () => {
    expect(debugFooterEnabled('?debug=1')).toBe(true);
    // Bare `?debug` counts: nobody typing it means "off".
    expect(debugFooterEnabled('?debug')).toBe(true);
    expect(debugFooterEnabled('?seed=1&debug=on')).toBe(true);
  });

  it('treats the two ways of writing "no" as no, like `?interlude=0` does', () => {
    expect(debugFooterEnabled('?debug=0')).toBe(false);
    expect(debugFooterEnabled('?debug=false')).toBe(false);
  });
});

/**
 * The provenance chip.
 *
 * A boss the harness approved this session and a boss lifted from the pre-approved
 * pool are indistinguishable in the fight otherwise — same panel, same name, same
 * rationale — and only one of them supports the claim the product makes. The demo
 * showing "written for you" over a pool pick would be the one place the product
 * lies, so the mapping gets a test of its own.
 */
describe('originLabel', () => {
  it('claims authorship only for a strategy the harness approved', () => {
    expect(originLabel('approved')).toBe('written for you');
  });

  it('admits a pool pick, and never calls it authored', () => {
    expect(originLabel('fallback')).toBe('pre-approved');
    expect(originLabel('fallback')).not.toContain('for you');
  });

  it('says nothing for round 1, which claims nothing', () => {
    expect(originLabel('bundled')).toBe('');
  });
});
