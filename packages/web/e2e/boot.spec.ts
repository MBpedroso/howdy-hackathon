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
 * assertions below are about that promise — the Judge visibly marked as the one that
 * is not a model, one round explained in four steps that carry the three faces, and
 * the controls including the dash and the two tells.
 *
 * It then grew a second job (2026-09-08): saying *why the thing exists* to a judge
 * who has thirty seconds and has never heard of the project, and letting the player
 * choose a costume for both fighters. The costume is the part with a trap in it —
 * see the last test in this file.
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
  await expect(page.getByTestId('cast-analyst')).toContainText('Reads your replay');
  await expect(page.getByTestId('cast-coder')).toContainText('Rewrites');
  // The thesis: the thing with the final say is a deterministic harness. It is said
  // in full in the "why" block above and carried here by the chip plus the count.
  await expect(page.getByTestId('cast-judge')).toContainText('200 simulations');
  await expect(page.getByTestId('cast-deterministic')).toHaveText('DETERMINISTIC');

  // ------------------------------------------------------------------- the why
  // Three key points, and the middle one is the project's argument. A judge who
  // reads only this block should already know what is unusual here.
  const why = page.getByTestId('start-why');
  await expect(why.locator('.why')).toHaveCount(3);
  await expect(why).toContainText('The boss writes itself');
  await expect(why).toContainText('200 simulated fights');

  // -------------------------------------------------------- one round, in four
  const how = page.getByTestId('start-how');
  await expect(how.locator('.step')).toHaveCount(4);
  await expect(how).toContainText('You fight');
  await expect(how).toContainText('The Analyst');
  await expect(how).toContainText('The Coder');
  await expect(how).toContainText('The Judge');
  // Numbered, so the four read as a sequence and not as four unrelated cards.
  await expect(how.locator('.step-n').first()).toHaveText('01');

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

/**
 * The fighter picker, and the trap in it.
 *
 * The whole start overlay is the primary action's hit box — "click anywhere to
 * fight" — which is exactly right until the screen grows eight buttons that are not
 * that action. So the interesting assertion here is not that a pick highlights; it
 * is that picking **twice** is still possible, i.e. that the first click did not
 * start Round 1 underneath the menu. The same trap exists on the keyboard, where
 * Enter on a focused button would otherwise choose a costume and start the fight in
 * one press.
 *
 * The picks are cosmetic by construction (`src/ui/fighters.ts`), so nothing here
 * asserts anything about the fight itself — that guarantee is checked structurally
 * in `test/fighters.test.ts`, where it cannot be faked by a passing screenshot.
 */
test('picking a fighter for each side is remembered, and does not start the fight', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/?seed=424242');
  await waitForBoot(page);

  const pick = page.getByTestId('start-pick');
  await expect(pick).toBeVisible();
  // Four faces per side, and both sides present.
  await expect(pick.locator('.pick-side[data-side="player"] .pick-btn')).toHaveCount(4);
  await expect(pick.locator('.pick-side[data-side="boss"] .pick-btn')).toHaveCount(4);

  const you = page.getByTestId('pick-player-neptune');
  await you.click();
  await expect(you).toHaveAttribute('aria-checked', 'true');
  // The screen is still up: the click was a pick, not the primary action.
  await expect(page.locator('#screen')).toHaveAttribute('data-screen', 'start');

  // A second pick, on the other side. Reachable only because the first did not fight.
  const boss = page.getByTestId('pick-boss-earth');
  await boss.click();
  await expect(boss).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('pick-boss-jupiter')).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('#screen')).toHaveAttribute('data-screen', 'start');

  // Enter on a focused pick is that button's, not the screen's.
  await page.getByTestId('pick-player-saturn').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('pick-player-saturn')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#screen')).toHaveAttribute('data-screen', 'start');

  expect(await page.evaluate(() => window.localStorage.getItem('rematch.fighter.player'))).toBe('saturn');
  expect(await page.evaluate(() => window.localStorage.getItem('rematch.fighter.boss'))).toBe('earth');

  // And they come back on the next visit.
  await page.goto('/?seed=424242&intro=1');
  await waitForBoot(page);
  await expect(page.getByTestId('pick-player-saturn')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('pick-boss-earth')).toHaveAttribute('aria-checked', 'true');

  expect(errors).toEqual([]);
});

/**
 * The start screen at three widths.
 *
 * The brief for this screen (2026-09-08) asked for narrow layouts that *reorganise*
 * rather than shrink — four steps squeezed into 90 px each is not a smaller version
 * of the screen, it is an unreadable one. So the assertion is about column counts
 * and about the one element that must never fall below the fold: FIGHT.
 *
 * Measured with `boundingBox`, not by reading CSS: the media queries are the
 * implementation, and what matters is where the cards actually land.
 */
test('the start screen reorganises at narrow widths and keeps FIGHT in view', async ({ page }) => {
  /** How many distinct left edges a row's children have = how many columns. */
  const columns = async (selector: string): Promise<number> => {
    const boxes = await page.locator(selector).evaluateAll((els) =>
      els.map((el) => Math.round(el.getBoundingClientRect().left)),
    );
    return new Set(boxes).size;
  };

  await page.goto('/?seed=424242&intro=1');
  await waitForBoot(page);

  for (const [width, height, why, steps] of [
    [1280, 800, 3, 4],
    [1000, 820, 2, 2],
    [700, 900, 1, 2],
    [430, 900, 1, 1],
  ] as const) {
    await page.setViewportSize({ width, height });
    // One frame for the media query to settle before anything is measured.
    await page.waitForTimeout(120);

    expect(await columns('.why-row > .why'), `why columns at ${width}px`).toBe(why);
    expect(await columns('.step-row > .step'), `step columns at ${width}px`).toBe(steps);

    // FIGHT is reachable without hunting for it: on screen, or at worst one short
    // scroll from the bottom of a screen that is allowed to scroll.
    const btn = page.getByTestId('primary');
    await expect(btn).toBeVisible();
    const box = await btn.boundingBox();
    expect(box, `FIGHT has a box at ${width}px`).not.toBeNull();
    if (box !== null) {
      // Centred on the card at every width — it is the middle cell of the footer
      // band, and it stays the middle cell when that band stacks.
      const centre = box.x + box.width / 2;
      expect(Math.abs(centre - width / 2), `FIGHT centred at ${width}px`).toBeLessThan(40);
    }
  }

  // The two stacked layouts, for the record.
  await page.setViewportSize({ width: 700, height: 900 });
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${ARTIFACTS}start-screen-narrow.png`, fullPage: true });
  await page.setViewportSize({ width: 430, height: 900 });
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${ARTIFACTS}start-screen-phone.png`, fullPage: true });
});
