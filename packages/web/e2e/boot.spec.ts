/**
 * Test 1 — the game boots, and the start screen introduces the cast.
 *
 * Proves the whole client path in the *built* bundle: module graph, CSS, the canvas,
 * and — on the click — that QuickJS instantiated and loaded `round1.js` for real. If
 * the sandbox had not survived bundling, `round` would never leave 0.
 *
 * The start screen grew from "Click to fight" into the game's front door after a
 * playtest of the interlude: *"the player can't connect what's happening to who is
 * doing it."* So the screen names the three agents before the first fight, and the
 * assertions below are about that promise — three cast cards, the Judge visibly
 * marked as the one that is not a model, one round explained in four steps, and the
 * controls including the dash and the two tells.
 */
import { expect, test } from '@playwright/test';
import { collectErrors, waitForBoot, waitForRound } from './helpers.ts';

const ARTIFACTS = new URL('../../../artifacts/web/', import.meta.url).pathname;

/** The projector the interlude is laid out against; the intro must fit it too. */
test.use({ viewport: { width: 1280, height: 800 } });

/**
 * The determinism footer is opt-in, and the flag really works.
 *
 * It used to render during every normal fight. That was deliberate — it is the
 * clearest evidence in the UI that the simulation is seed-deterministic — but to a
 * non-technical viewer it is an unfinished screen, permanently
 * (`docs/REVIEW-2026-09-08.md`, question 5). Both halves are asserted here because
 * only one of them is the risk: a default that quietly flips back on is the
 * regression, and a flag that silently stops working takes the evidence with it.
 */
test('the determinism footer is absent by default and present with ?debug=1', async ({ page }) => {
  const errors = collectErrors(page);

  await page.goto('/?seed=424242&autostart=1');
  await waitForRound(page);
  // Absent from the DOM, not merely hidden — see `createHud`.
  await expect(page.locator('.hud-foot')).toHaveCount(0);

  await page.goto('/?seed=424242&autostart=1&debug=1');
  await waitForRound(page);
  const foot = page.locator('.hud-foot');
  await expect(foot).toBeVisible();
  // The two numbers it exists to show: the seed pair and the tick.
  await expect(foot).toContainText('seed 424242/');
  await expect(foot).toContainText('tick ');

  expect(errors).toEqual([]);
});

test('boots to a start screen with a visible arena', async ({ page }) => {
  const errors = collectErrors(page);

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
  await expect(screen).toContainText('REMATCH');
  await expect(screen).toContainText('The boss that learns');
  // The controls, still on the first screen the player sees.
  await expect(screen).toContainText('WASD');
  await expect(screen).toContainText('dash');
  // Spec §2.3: the tells are what make the fight fair to read, so they are taught.
  await expect(screen).toContainText('a filling line = charge');
  await expect(screen).toContainText('a shrinking ring = slam');
  await expect(screen).toContainText('424242');

  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
});

test('introduces the three agents, and marks the one that is not an AI', async ({ page }) => {
  await page.goto('/?seed=424242');
  await waitForBoot(page);

  // ------------------------------------------------------------------ the cast
  for (const id of ['analyst', 'coder', 'judge']) {
    const card = page.getByTestId(`cast-${id}`);
    await expect(card).toBeVisible();
    // The portrait is there whether or not the raster art has landed: the SVG
    // placeholder is the same element (see `src/ui/portrait.ts`).
    await expect(card.getByTestId(`portrait-${id}`)).toBeVisible();
  }
  await expect(page.getByTestId('cast-analyst')).toContainText('Watches your replay');
  await expect(page.getByTestId('cast-coder')).toContainText('Rewrites');
  // The thesis: the thing with the final say is a deterministic harness.
  await expect(page.getByTestId('cast-judge')).toContainText('Not an AI');
  await expect(page.getByTestId('cast-judge')).toContainText('200 simulated fights');
  await expect(page.getByTestId('cast-deterministic')).toHaveText('DETERMINISTIC');

  // -------------------------------------------------------- one round, in four
  const how = page.getByTestId('start-how');
  await expect(how.locator('.step')).toHaveCount(4);
  await expect(how).toContainText('You fight');
  await expect(how).toContainText('The Analyst reads');
  await expect(how).toContainText('The Coder rewrites');
  await expect(how).toContainText('The Judge decides');

  // The screen fades in over 140 ms (`@keyframes fade`), and a capture taken inside
  // that window is semi-transparent — which shows the arena and the HUD skeleton
  // faintly through it, and makes the artifact look like a layering bug that is not
  // there. Wait for the animation, then shoot.
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${ARTIFACTS}start-screen.png` });
});

test('the skip-intro box is remembered, and ?intro=1 brings the screen back', async ({ page }) => {
  await page.goto('/?seed=424242');
  await waitForBoot(page);

  const box = page.getByTestId('skip-intro');
  await expect(box).not.toBeChecked();
  await box.check();
  // The whole overlay is the primary action's hit box, so this is also a check that
  // ticking the box does not start the fight.
  await expect(page.locator('#screen')).toHaveAttribute('data-screen', 'start');
  expect(await page.evaluate(() => window.localStorage.getItem('rematch.skipIntro'))).toBe('1');

  // A fresh load now goes straight into Round 1.
  await page.goto('/?seed=424242');
  await waitForRound(page);
  await expect(page.locator('#screen')).not.toHaveClass(/active/);

  // …and `?intro=1` overrides the memory, which is how the screen gets demoed.
  await page.goto('/?seed=424242&intro=1');
  await waitForBoot(page);
  await expect(page.locator('#screen')).toHaveAttribute('data-screen', 'start');
  await expect(page.getByTestId('skip-intro')).toBeChecked();
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
