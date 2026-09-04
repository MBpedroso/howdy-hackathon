/**
 * Test 2 — spec AC 3: *"same seed + same input log produces an identical final state
 * hash in browser and Node"*. The most important test in this package.
 *
 * `e2e/fixtures/inputlog-round1.json` is a Round 1 recorded in Node
 * (`scripts/gen-inputlog.ts`) together with the final-state hash Node computed. Here
 * the browser is handed the same session seed, the same log and the same strategy, and
 * must arrive at the same 64-bit hash — through its own QuickJS instance, its own
 * WASM, its own JIT.
 *
 * Both sides use the sandbox's injectable deterministic clock (see `src/game/clock.ts`
 * for why the 2 ms `decide` deadline would otherwise make a replay non-reproducible).
 */
import { expect, test } from '@playwright/test';
import { armReplay, loadFixture, waitForRound } from './helpers.ts';

const fixture = loadFixture();

test('browser and Node agree on the replay hash', async ({ page }) => {
  await page.goto(`/?seed=${fixture.sessionSeed}&autostart=1`);
  await waitForRound(page);

  // The round seed must come from the same derivation the fixture was recorded with,
  // or the rest of the test is meaningless.
  expect(await page.evaluate(() => window.__rematch?.seed)).toBe(fixture.seed);

  await armReplay(page, fixture.log);

  const result = await page.evaluate((ticks) => {
    const api = window.__rematch;
    if (api === undefined) throw new Error('no debug api');
    const ran = api.fastForward(ticks);
    return {
      ran,
      tick: api.state?.tick ?? -1,
      outcome: api.state?.outcome ?? 'missing',
      hash: api.hash(),
      seed: api.seed,
    };
  }, fixture.ticks);

  expect(result.seed).toBe(fixture.seed);
  expect(result.ran).toBe(fixture.ticks);
  expect(result.tick).toBe(fixture.ticks);
  expect(result.outcome).toBe(fixture.outcome);
  expect(
    result.hash,
    `browser hash ${String(result.hash)} != node hash ${fixture.hash} — the browser and Node have diverged`,
  ).toBe(fixture.hash);
});

test('replaying the same log twice in one page is idempotent', async ({ page }) => {
  await page.goto(`/?seed=${fixture.sessionSeed}&autostart=1`);
  await waitForRound(page);

  const hashes: Array<string | null | undefined> = [];
  for (let i = 0; i < 2; i += 1) {
    await armReplay(page, fixture.log);
    hashes.push(
      await page.evaluate((ticks) => {
        window.__rematch?.fastForward(ticks);
        return window.__rematch?.hash();
      }, fixture.ticks),
    );
  }

  // A leaked runner, leftover strategy memory or a stale RNG would show up here.
  expect(hashes[0]).toBe(fixture.hash);
  expect(hashes[1]).toBe(fixture.hash);
});
