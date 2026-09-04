/**
 * The Node half of spec AC 3, run on every `pnpm verify`.
 *
 * `e2e/fixtures/inputlog-round1.json` carries a recorded Round 1 and the final-state
 * hash Node produced for it. The Playwright suite asserts the *browser* reproduces
 * that hash; this test asserts *Node still does*, through the real QuickJS sandbox.
 *
 * That matters because the fixture is a recorded expectation: if an engine constant or
 * `src/strategies/round1.js` changes, the browser and Node would still agree with each
 * other (nothing about determinism broke) but both would disagree with the recording,
 * and the e2e failure would be misleading. This test fails first, and says exactly
 * what to do about it.
 */
import { describe, expect, it } from 'vitest';
import fixture from '../e2e/fixtures/inputlog-round1.json' with { type: 'json' };
import type { InputLog } from '@rematch/engine';
import { roundSeed } from '../src/game/seeds.ts';
import { readStrategySource, replayInNode } from '../scripts/replay-node.ts';

describe('recorded Round 1', () => {
  it('derives its seed from the session seed the e2e passes in `?seed=`', () => {
    expect(roundSeed(fixture.sessionSeed, fixture.round)).toBe(fixture.seed);
  });

  it('still replays to the recorded hash in Node', async () => {
    const source = readStrategySource(fixture.strategy);
    const result = await replayInNode(fixture.seed, fixture.log as InputLog, source);

    expect(
      result.hash,
      'The recorded fixture is stale: an engine rule or round1.js changed.\n' +
        'Re-run `pnpm --filter @rematch/web gen:inputlog` and re-check the e2e hash.',
    ).toBe(fixture.hash);
    expect(result.ticks).toBe(fixture.ticks);
    expect(result.outcome).toBe(fixture.outcome);
  }, 30_000);

  it('is a round the player wins, so it exercises the whole fight', () => {
    expect(fixture.outcome).toBe('playerWon');
    expect(fixture.ticks).toBeGreaterThan(300);
    expect(fixture.log.length).toBe(fixture.ticks);
  });
});
