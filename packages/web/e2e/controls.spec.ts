/**
 * The live input path — the one thing the deterministic replay cannot cover, because
 * a replay bypasses the keyboard and the mouse entirely.
 *
 * Also where the frame budget is measured: `stats()` reports the averaged cost of one
 * simulated tick (including the QuickJS `decide` call) and of one full render, which
 * is the number to watch if the fight ever starts to feel heavy.
 */
import { expect, test } from '@playwright/test';
import { waitForRound } from './helpers.ts';

test('WASD moves, the mouse aims, click shoots, Space dashes', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto('/?seed=1234&autostart=1');
  await waitForRound(page);

  const before = await page.evaluate(() => ({
    x: window.__rematch?.state?.player.x ?? 0,
    y: window.__rematch?.state?.player.y ?? 0,
    scrollY: window.scrollY,
  }));

  // Move right.
  await page.keyboard.down('KeyD');
  await page.waitForTimeout(350);
  await page.keyboard.up('KeyD');
  const moved = await page.evaluate(() => window.__rematch?.state?.player.x ?? 0);
  expect(moved).toBeGreaterThan(before.x + 20);

  // Aim at the boss (top of the arena) and hold the trigger. The player starts at the
  // bottom, so the boss is straight up; bullets need ~40 ticks to cross the gap.
  const box = await page.locator('#arena').boundingBox();
  expect(box).not.toBeNull();
  const cx = (box?.x ?? 0) + (box?.width ?? 0) / 2;
  await page.mouse.move(cx, (box?.y ?? 0) + 8);
  await page.mouse.down();
  await page.waitForTimeout(1200);
  await page.mouse.up();

  const afterShooting = await page.evaluate(() => ({
    shots: window.__rematch?.state?.counts.shots ?? 0,
    bossHp: window.__rematch?.state?.boss.hp ?? 100,
    facing: window.__rematch?.state?.player.facing ?? 0,
  }));
  expect(afterShooting.shots).toBeGreaterThan(3);
  // Aiming up is a negative facing angle (-pi/2 straight up).
  expect(afterShooting.facing).toBeLessThan(0);
  expect(afterShooting.bossHp).toBeLessThan(100);

  // Dash.
  await page.keyboard.press('Space');
  await page.waitForTimeout(120);
  expect(await page.evaluate(() => window.__rematch?.state?.counts.dashes ?? 0)).toBeGreaterThan(0);

  // Space and the arrow keys must not scroll the page.
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(60);
  expect(await page.evaluate(() => window.scrollY)).toBe(before.scrollY);

  // Frame budget. Generous bounds — this is a smoke test on unknown CI hardware, not
  // a benchmark; the measured numbers are logged for the record.
  const stats = await page.evaluate(() => window.__rematch?.stats());
  console.log(
    `frame budget: tick ${(stats?.avgTickMs ?? 0).toFixed(3)} ms, render ${(stats?.avgRenderMs ?? 0).toFixed(3)} ms` +
      `, ticks ${stats?.ticks ?? 0}, dropped ${stats?.droppedTicks ?? 0}`,
  );
  expect(stats?.ticks ?? 0).toBeGreaterThan(60);
  expect(stats?.avgTickMs ?? 99).toBeLessThan(8);
  expect(stats?.avgRenderMs ?? 99).toBeLessThan(8);
  // A 60 Hz loop on an idle machine must not be hitting the catch-up cap.
  expect(stats?.droppedTicks ?? 99).toBe(0);

  expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
});

test('the round-won screen appears with a replay hash and starts the next round', async ({ page }) => {
  await page.goto('/?seed=424242&autostart=1');
  await waitForRound(page);

  // Rather than beating the boss by hand, replay a won round: the outcome path (and
  // the seam the interlude will hook) is what is under test here.
  const fixture = (await import('./helpers.ts')).loadFixture();
  await page.evaluate(async (log) => {
    await window.__rematch?.driveWith(log);
    window.__rematch?.fastForward();
  }, fixture.log);

  const screen = page.locator('#screen');
  await expect(screen).toHaveAttribute('data-screen', 'roundWon');
  await expect(screen).toContainText('Round 1 cleared');
  await expect(page.getByTestId('hash')).toContainText(fixture.hash);

  await page.getByTestId('primary').click();
  await expect
    .poll(async () => page.evaluate(() => window.__rematch?.round ?? 0))
    .toBe(2);
  // Round 2 is a different seed, derived from the same session seed.
  const seeds = await page.evaluate(() => window.__rematch?.seed);
  expect(seeds).not.toBe(fixture.seed);
  await expect(page.locator('.hud-round')).toContainText('Round 2');
});
