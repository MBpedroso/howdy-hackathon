/**
 * Test 3 — visual evidence, saved to the repo-root `artifacts/` (spec §7: the
 * screenshots double as demo material).
 *
 * These are not pixel comparisons. They exist so a human can check the two things a
 * unit test cannot: that a mid-fight frame is legible, and that each boss telegraph is
 * *readable* (spec §2.3) — the slam ring filling toward its edge, and the charge lance
 * pointing where the boss is about to be.
 *
 * The frames are reached by replaying the recorded log and stopping on a chosen tick,
 * so each screenshot is of a deterministic frame and can be regenerated exactly.
 */
import { expect, test, type Page } from '@playwright/test';
import { armReplay, loadFixture, waitForRound } from './helpers.ts';

const fixture = loadFixture();
const ARTIFACTS = new URL('../../../artifacts/web/', import.meta.url).pathname;

/** Step one tick at a time until `kind` is telegraphing with a mid-tell countdown. */
async function stepToTelegraph(page: Page, kind: 'slam' | 'charge', maxTicks: number): Promise<number> {
  return page.evaluate(
    ({ kind: want, maxTicks: budget }) => {
      const api = window.__rematch;
      if (api === undefined) throw new Error('no debug api');
      for (let i = 0; i < budget; i += 1) {
        const tg = api.state?.boss.telegraph ?? null;
        // Halfway through the tell: the fill is unambiguous and so is the countdown.
        if (tg !== null && tg.type === want && tg.ticksLeft <= (want === 'slam' ? 24 : 12)) {
          api.renderFrame();
          return api.state?.tick ?? -1;
        }
        if (api.fastForward(1) === 0) break;
      }
      return -1;
    },
    { kind, maxTicks },
  );
}

test('mid-fight frame', async ({ page }) => {
  await page.goto(`/?seed=${fixture.sessionSeed}&autostart=1`);
  await waitForRound(page);
  await armReplay(page, fixture.log);

  // Tick 420 of the recording: the player is mid-round with both bullet streams alive.
  const ran = await page.evaluate(() => {
    const api = window.__rematch;
    const n = api?.fastForward(420) ?? 0;
    api?.renderFrame();
    return n;
  });
  expect(ran).toBe(420);

  await page.locator('#stage').screenshot({ path: `${ARTIFACTS}fight-tick420.png` });
});

test('slam telegraph is on screen and readable', async ({ page }) => {
  await page.goto(`/?seed=${fixture.sessionSeed}&autostart=1`);
  await waitForRound(page);
  await armReplay(page, fixture.log);

  const tick = await stepToTelegraph(page, 'slam', 400);
  expect(tick, 'no slam telegraph found in the first 400 ticks').toBeGreaterThan(0);

  await page.locator('#stage').screenshot({ path: `${ARTIFACTS}telegraph-slam.png` });
});

test('charge telegraph is on screen and readable', async ({ page }) => {
  // `round1` never charges, so the charge tell is exercised through the alternate
  // bundled strategy — the only other thing `?strategy=` accepts.
  await page.goto(`/?seed=${fixture.sessionSeed}&autostart=1&strategy=hound`);
  await waitForRound(page);
  await expect(page.locator('.hud-strategy .name')).toHaveText('Hound');
  await armReplay(page, fixture.log);

  const tick = await stepToTelegraph(page, 'charge', 900);
  expect(tick, 'no charge telegraph found in the first 900 ticks').toBeGreaterThan(0);

  await page.locator('#stage').screenshot({ path: `${ARTIFACTS}telegraph-charge.png` });
});

test('minions wear the boss’s face, smaller and violet', async ({ page }) => {
  await page.goto(`/?seed=${fixture.sessionSeed}&autostart=1`);
  await waitForRound(page);
  await armReplay(page, fixture.log);

  // Step until at least one minion is out of its materialization grace, so the frame
  // shows the armed look (face + violet wash), not the hollow one.
  const tick = await page.evaluate(() => {
    const api = window.__rematch;
    if (api === undefined) throw new Error('no debug api');
    for (let i = 0; i < 1200; i += 1) {
      const minions = api.state?.minions ?? [];
      if (minions.length > 0 && minions.some((m) => m.hitCooldown <= 90)) {
        api.renderFrame();
        return api.state?.tick ?? -1;
      }
      if (api.fastForward(1) === 0) break;
    }
    return -1;
  });
  expect(tick).toBeGreaterThan(0);

  await page.locator('#stage').screenshot({ path: `${ARTIFACTS}fight-minions.png` });
});
