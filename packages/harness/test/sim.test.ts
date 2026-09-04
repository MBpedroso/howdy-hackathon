/**
 * The balance simulator.
 *
 * The property that earns the worker pool its complexity is that it does not change
 * the answer: `1 worker` and `4 workers` must produce **identical** numbers, because
 * a verdict that depended on how many cores the machine has would not be evidence of
 * anything (spec §7: "fixed seed set → identical results on every machine"). Every
 * other test here exists to protect that one.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { hashValue } from '@rematch/engine';
import { createSandbox, type SandboxFactory } from '@rematch/sandbox';
import { camper, kiter } from '../src/bots/index.ts';
import { resolveWorkers, simulate, type SimulateResult } from '../src/sim/simulate.ts';
import { runMatch, runMatchWith } from '../src/sim/runMatch.ts';
import type { BotSpec } from '../src/sim/protocol.ts';
import { seedsFor } from '../src/gates/balanceConfig.ts';
import { readBad, readGood } from './helpers.ts';

const PANEL_SPECS: BotSpec[] = [{ kind: 'camper' }, { kind: 'kiter' }, { kind: 'rusher' }, { kind: 'dodger' }];
const SEEDS = seedsFor(6);

let sandbox: SandboxFactory;
beforeAll(async () => {
  sandbox = await createSandbox();
});

/** Everything in a result except wall-clock time and the schedule that produced it. */
function verdict(result: SimulateResult): unknown {
  const { ms: _ms, workers: _workers, ...rest } = result;
  return rest;
}

describe('simulate', () => {
  it('gives byte-identical results at 1 worker and at 4', async () => {
    const source = readGood('chaser');
    const one = await simulate({ source, bots: PANEL_SPECS, seeds: SEEDS, workers: 1 });
    const four = await simulate({ source, bots: PANEL_SPECS, seeds: SEEDS, workers: 4 });

    expect(one.workers).toBe(1);
    expect(four.workers).toBe(4);
    expect(hashValue(verdict(four))).toBe(hashValue(verdict(one)));
    // Not vacuously equal: the strategy has to actually win some and lose some.
    expect(one.bossWins).toBeGreaterThan(0);
    expect(one.bossWins).toBeLessThan(one.matches);
  }, 60_000);

  it('runs every bot on every seed, and reports them in the requested order', async () => {
    const result = await simulate({ source: readGood('idle'), bots: PANEL_SPECS, seeds: SEEDS, workers: 2 });
    expect(result.matches).toBe(PANEL_SPECS.length * SEEDS.length);
    expect(result.perBot.map((b) => b.name)).toEqual(['Camper', 'Kiter', 'Rusher', 'Dodger']);
    for (const bot of result.perBot) expect(bot.matches).toBe(SEEDS.length);
    // The null boss loses every match, by construction.
    expect(result.winRate).toBe(0);
  }, 60_000);

  it('aggregates the per-bot rates it reports', async () => {
    const result = await simulate({ source: readGood('chaser'), bots: PANEL_SPECS, seeds: SEEDS, workers: 1 });
    const summed = result.perBot.reduce((n, b) => n + b.bossWins, 0);
    expect(summed).toBe(result.bossWins);
    expect(result.winRate).toBeCloseTo(result.bossWins / result.matches, 10);
  }, 60_000);

  it('handles an empty job list', async () => {
    const result = await simulate({ source: readGood('idle'), bots: [], seeds: SEEDS });
    expect(result).toMatchObject({ matches: 0, bossWins: 0, winRate: 0, perBot: [] });
  });

  it('reports a strategy that cannot be loaded as a rejected promise', async () => {
    await expect(
      simulate({ source: readBad('uses-date'), bots: [{ kind: 'kiter' }], seeds: [1], workers: 2 }),
    ).rejects.toThrow(/static check failed|could not|failed/i);
  }, 60_000);

  it('counts the violations and the kills it saw', async () => {
    // `ignores-cooldowns` bursts every tick; the engine coerces most of those to
    // idle and counts a contract violation each time.
    const result = await simulate({ source: readBad('ignores-cooldowns'), bots: [{ kind: 'kiter' }], seeds: [1], workers: 1 });
    expect(result.violations).toBeGreaterThan(100);
    expect(result.killed).toBe(0);
  }, 60_000);
});

describe('resolveWorkers', () => {
  it('never exceeds the work, and never drops below 1', () => {
    expect(resolveWorkers(8, 3)).toBe(3);
    expect(resolveWorkers(0, 100)).toBe(1);
    expect(resolveWorkers(-4, 100)).toBe(1);
    expect(resolveWorkers(1, 100)).toBe(1);
    expect(resolveWorkers(undefined, 1)).toBe(1);
    // The default leaves a core for the main thread.
    expect(resolveWorkers(undefined, 1000)).toBeGreaterThanOrEqual(1);
  });
});

describe('runMatch', () => {
  it('accepts strategy source, loading and disposing a sandbox around the match', async () => {
    const result = await runMatch(readGood('chaser'), kiter(), 3, { sandbox });
    expect(result.ticks).toBeGreaterThan(0);
    expect(['playerWon', 'bossWon', 'timeout']).toContain(result.outcome);
  });

  it('accepts an already-loaded runner, and agrees with the source path', async () => {
    const runner = sandbox.load(readGood('chaser'));
    try {
      const fromRunner = runMatchWith(runner, kiter(), 3);
      const fromSource = await runMatch(readGood('chaser'), kiter(), 3, { sandbox });
      expect(fromRunner).toEqual(fromSource);
      // One runner, many matches: `init(seed)` is what resets the strategy.
      expect(runMatchWith(runner, kiter(), 3)).toEqual(fromRunner);
    } finally {
      runner.dispose();
    }
  });

  it('counts a timeout as a boss win (spec §6.2)', async () => {
    // Nobody can beat a boss they cannot damage... and the Camper never shoots at
    // one that keeps something on the board, so this runs the clock out.
    const result = await runMatch(readGood('orbiter'), camper(), 1, { sandbox });
    expect(result.bossWon).toBe(true);
    expect(result.outcome).not.toBe('playerWon');
  });
});
