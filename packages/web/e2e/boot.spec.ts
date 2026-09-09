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
import type { Page } from '@playwright/test';
import { collectErrors, waitForBoot, waitForRound } from './helpers.ts';

/**
 * Advance the intro to a named beat by pressing its primary button.
 *
 * The four beats live behind one `#screen[data-screen='start']` with `data-intro`
 * naming the current one (`src/ui/introSequence.ts`), so "go to the agents screen"
 * is a walk rather than a URL. Every spec below that needs a later beat says so by
 * calling this, which is also the assertion that the walk *works*.
 */
async function toBeat(page: Page, beat: 'hook' | 'concept' | 'agents' | 'arena'): Promise<void> {
  const order = ['hook', 'concept', 'agents', 'arena'] as const;
  const screen = page.locator('#screen');
  await expect(screen).toHaveAttribute('data-intro', 'hook');
  for (const step of order.slice(1, order.indexOf(beat) + 1)) {
    await page.getByTestId('primary').click();
    await expect(screen).toHaveAttribute('data-intro', step);
  }
}

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
  // Beat 1 is the hook and it carries seven words plus the crew: the title, the
  // subtitle, START and a way past it. Anything else here would be the old screen.
  await expect(screen).toHaveAttribute('data-intro', 'hook');
  await expect(screen).toContainText('Howdy Hackathon');
  await expect(screen).toContainText('A boss that learns');
  await expect(screen).toContainText('Five rounds. One boss. It adapts.');
  await expect(page.getByTestId('primary')).toHaveText('START');
  await expect(page.getByTestId('skip-intro')).toBeVisible();
  // Four dots, one lit — the player can see how long this is going to take.
  await expect(page.getByTestId('intro-dots').locator('.intro-dot')).toHaveCount(4);

  // The controls and the tells moved to the last beat, next to the fight.
  await toBeat(page, 'arena');
  await expect(screen).toContainText('WASD');
  await expect(screen).toContainText('dash');
  // Spec §2.3: the tells are what make the fight fair to read, so they are taught.
  await expect(screen).toContainText('a filling line = charge');
  await expect(screen).toContainText('a shrinking ring = slam');
  await expect(screen).toContainText('424242');
  await expect(page.getByTestId('primary')).toHaveText('ENTER THE ARENA');

  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
});

test('the intro fits the projector without scrolling on any beat', async ({ page }) => {
  // 1280x800 is what the interlude is laid out against, and the intro shares it.
  await page.goto('/?seed=424242&intro=1');
  await waitForBoot(page);
  for (const beat of ['hook', 'concept', 'agents', 'arena'] as const) {
    await expect(page.locator('#screen')).toHaveAttribute('data-intro', beat);
    const overflow = await page.evaluate(() => {
      const el = document.querySelector('#screen');
      return el === null ? 0 : el.scrollHeight - el.clientHeight;
    });
    // A few pixels of rounding is fine; a beat you have to scroll is not.
    expect(overflow, `${beat} overflows by ${overflow}px`).toBeLessThan(8);
    if (beat !== 'arena') await page.getByTestId('primary').click();
  }
});

/**
 * The other desktop the intro is judged on.
 *
 * 1280x800 is the projector; 1440x900 is what the layout brief asked it to feel
 * balanced at, and the two disagree — the bands are sized in `vh`, so a taller
 * viewport gives the content band its room back and a beat that fits one can still
 * be wrong on the other. Both sizes are asserted, and this one keeps its own
 * screenshots so the composition can be looked at rather than only measured.
 */
test.describe('at 1440x900', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('every beat still fits, and is shot for review', async ({ page }) => {
    await page.goto('/?seed=424242&intro=1');
    await waitForBoot(page);
    const beats = ['hook', 'concept', 'agents', 'arena'] as const;
    for (const [i, beat] of beats.entries()) {
      await expect(page.locator('#screen')).toHaveAttribute('data-intro', beat);
      const overflow = await page.evaluate(() => {
        const el = document.querySelector('#screen');
        return el === null ? 0 : el.scrollHeight - el.clientHeight;
      });
      expect(overflow, `${beat} overflows by ${overflow}px`).toBeLessThan(8);
      await page.waitForTimeout(320);
      await page.screenshot({ path: `${ARTIFACTS}intro-wide-${i + 1}-${beat}.png` });
      if (beat !== 'arena') await page.getByTestId('primary').click();
    }
  });
});

test('the concept and the agents beats explain the loop and who runs it', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/?seed=424242');
  await waitForBoot(page);
  const screen = page.locator('#screen');

  // ------------------------------------------------------- beat 2: the concept
  await toBeat(page, 'concept');
  await expect(screen).toContainText('The boss learns');
  await expect(screen.locator('.concept-step')).toHaveCount(3);
  await expect(screen).toContainText('You fight');
  await expect(screen).toContainText('The system watches');
  await expect(screen).toContainText('The boss changes');
  // The loop, as three nouns and two arrows.
  const flow = screen.locator('.concept-flow .flow-node');
  await expect(flow).toHaveText(['YOU', 'REPLAY', 'NEW BOSS']);
  await expect(page.getByTestId('primary')).toHaveText('NEXT →');

  // -------------------------------------------------------- beat 3: the agents
  await page.getByTestId('primary').click();
  await expect(screen).toHaveAttribute('data-intro', 'agents');
  await expect(screen).toContainText('Three agents. One fight.');
  for (const id of ['analyst', 'coder', 'judge']) {
    const card = page.getByTestId(`cast-${id}`);
    await expect(card).toBeVisible();
    // The portrait is there whether or not the raster art has landed: the SVG
    // placeholder is the same element (see `src/ui/portrait.ts`).
    await expect(card.getByTestId(`portrait-${id}`)).toBeVisible();
  }
  await expect(page.getByTestId('cast-analyst')).toContainText('Reads your replay');
  await expect(page.getByTestId('cast-coder')).toContainText('Rewrites');
  // The thesis: the thing with the final say is a deterministic harness. Said by the
  // chip, by the count, and by the line under the three cards.
  await expect(page.getByTestId('cast-judge')).toContainText('200 simulated fights');
  await expect(page.getByTestId('cast-deterministic')).toHaveText('DETERMINISTIC');
  await expect(screen).toContainText('The Judge decides what gets through.');

  // The screen fades in over 140 ms (`@keyframes fade`) and each beat wipes in over
  // 260 ms; a capture inside either window is semi-transparent and looks like a
  // layering bug that is not there. Wait, then shoot each beat.
  await page.waitForTimeout(320);
  await page.screenshot({ path: `${ARTIFACTS}intro-3-agents.png` });

  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
});

test('every beat of the intro is legible on its own — the demo screenshots', async ({ page }) => {
  await page.goto('/?seed=424242');
  await waitForBoot(page);
  const beats = ['hook', 'concept', 'agents', 'arena'] as const;
  for (const [i, beat] of beats.entries()) {
    if (i > 0) await page.getByTestId('primary').click();
    await expect(page.locator('#screen')).toHaveAttribute('data-intro', beat);
    await page.waitForTimeout(320);
    await page.screenshot({ path: `${ARTIFACTS}intro-${i + 1}-${beat}.png` });
  }
});

/**
 * SKIP INTRO, and the two ways to use it.
 *
 * It was a checkbox on the old single screen — "skip this intro next time" — and it
 * is a button on beat 1 now, which changes the semantics on purpose: pressing it
 * goes to the fight *and* remembers, because a player who skips an attract sequence
 * has said what they want for next time too. `?intro=1` is the documented way back
 * (`src/ui/intro.ts`), and it is how the beats get demoed and screenshotted.
 */
test('SKIP INTRO starts the fight and is remembered; ?intro=1 brings the intro back', async ({ page }) => {
  await page.goto('/?seed=424242');
  await waitForBoot(page);

  await page.getByTestId('skip-intro').click();
  await waitForRound(page);
  await expect(page.locator('#screen')).not.toHaveClass(/active/);
  expect(await page.evaluate(() => window.localStorage.getItem('rematch.skipIntro'))).toBe('1');

  // A fresh load now goes straight into Round 1.
  await page.goto('/?seed=424242');
  await waitForRound(page);
  await expect(page.locator('#screen')).not.toHaveClass(/active/);

  // …and `?intro=1` overrides the memory.
  await page.goto('/?seed=424242&intro=1');
  await waitForBoot(page);
  await expect(page.locator('#screen')).toHaveAttribute('data-intro', 'hook');
});

/**
 * The keyboard contract: ENTER/SPACE advance, ESC skips. An arcade intro where
 * Enter sometimes skips and sometimes advances is worse than no intro, and the
 * mapping lives in one function (`introKeyAction`) precisely so it cannot drift.
 */
test('ENTER advances the intro and ESC skips it', async ({ page }) => {
  await page.goto('/?seed=424242&intro=1');
  await waitForBoot(page);
  const screen = page.locator('#screen');

  await page.keyboard.press('Enter');
  await expect(screen).toHaveAttribute('data-intro', 'concept');
  await page.keyboard.press('Space');
  await expect(screen).toHaveAttribute('data-intro', 'agents');

  // ESC from the middle of the sequence goes straight to the fight.
  await page.keyboard.press('Escape');
  await waitForRound(page);
  await expect(screen).not.toHaveClass(/active/);
});

test('starting the fight loads the strategy through QuickJS', async ({ page }) => {
  await page.goto('/?seed=424242');
  await waitForBoot(page);
  await toBeat(page, 'arena');
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
  // The picker is the last beat's: it is the thing you set right before fighting.
  await toBeat(page, 'arena');

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
  await toBeat(page, 'arena');
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

  // The concept beat is the one with a three-up grid to reorganise.
  await toBeat(page, 'concept');

  for (const [width, height, steps] of [
    [1280, 800, 3],
    [1000, 820, 3],
    [700, 900, 1],
    [430, 900, 1],
  ] as const) {
    await page.setViewportSize({ width, height });
    // One frame for the media query to settle before anything is measured.
    await page.waitForTimeout(120);

    expect(await columns('.concept-row > .concept-step'), `concept columns at ${width}px`).toBe(steps);

    // The primary action is reachable without hunting for it at any width.
    const btn = page.getByTestId('primary');
    await expect(btn).toBeVisible();
    const box = await btn.boundingBox();
    expect(box, `the primary button has a box at ${width}px`).not.toBeNull();
    if (box !== null) {
      // Centred on the card at every width — it is the middle cell of the footer
      // band, and it stays the middle cell when that band stacks.
      const centre = box.x + box.width / 2;
      expect(Math.abs(centre - width / 2), `primary centred at ${width}px`).toBeLessThan(40);
    }
  }

  // The two stacked layouts, for the record — the hook beat, since that is the one
  // whose artwork has to survive being squeezed.
  await page.goto('/?seed=424242&intro=1');
  await waitForBoot(page);
  await page.setViewportSize({ width: 700, height: 900 });
  await page.waitForTimeout(320);
  await page.screenshot({ path: `${ARTIFACTS}start-screen-narrow.png`, fullPage: true });
  await page.setViewportSize({ width: 430, height: 900 });
  await page.waitForTimeout(320);
  await page.screenshot({ path: `${ARTIFACTS}start-screen-phone.png`, fullPage: true });
});
