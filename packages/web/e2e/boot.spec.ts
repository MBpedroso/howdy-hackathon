/**
 * Test 1 — the game boots.
 *
 * Proves the whole client path in the *built* bundle: module graph, CSS, the canvas,
 * and — on the click — that QuickJS instantiated and loaded `round1.js` for real. If
 * the sandbox had not survived bundling, `round` would never leave 0.
 */
import { expect, test } from '@playwright/test';
import { waitForBoot, waitForRound } from './helpers.ts';

test('boots to a start screen with a visible arena', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto('/?seed=424242');
  await waitForBoot(page);

  const canvas = page.locator('#arena');
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(300);
  // The arena is square, whatever the window is.
  expect(Math.abs((box?.width ?? 0) - (box?.height ?? 1))).toBeLessThan(2);

  const screen = page.locator('#screen');
  await expect(screen).toHaveAttribute('data-screen', 'start');
  await expect(screen).toContainText('Click to fight');
  await expect(screen).toContainText('WASD');
  await expect(screen).toContainText('424242');

  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
});

test('starting the fight loads the strategy through QuickJS', async ({ page }) => {
  await page.goto('/?seed=424242');
  await waitForBoot(page);
  await page.getByTestId('primary').click();
  await waitForRound(page);

  // The HUD names the strategy the sandbox actually reported (spec §12: the player
  // sees the boss's strategy), which is only possible if the module really loaded.
  await expect(page.locator('.hud-strategy .name')).toHaveText('Cornerbreaker');
  await expect(page.locator('.hud-strategy .rationale')).toContainText('slam');
  await expect(page.locator('.hud-round')).toContainText('Round 1');
  await expect(page.locator('#screen')).not.toHaveClass(/active/);

  // The loop is running: ticks accumulate without any input from us.
  await expect
    .poll(async () => page.evaluate(() => window.__rematch?.state?.tick ?? 0))
    .toBeGreaterThan(30);
});
