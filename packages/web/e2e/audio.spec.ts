/**
 * Audio's UI, and the shape of its arming paths — the mute toggle
 * (`ui/audioToggle.ts`, mounted once at boot, independent of every screen), the
 * intro's mount-time autoplay attempt (`audio/engine.ts`'s `attemptAutoStart()`,
 * called once by `ui/screens.ts` the instant the intro appears), the intro-only
 * document-level gesture fallback (`ui/screens.ts`'s `armIntroFallback`), and the
 * page-level one-shot fallback behind them all (`audio/engine.ts`'s
 * `armGestureFallback()`, armed by `app.ts`'s `boot()`).
 *
 * As of 2026-09-11 the music is one continuous bed for the whole session that only
 * *ducks* under the interlude — it is never stopped, and `startRound` no longer says
 * anything to the audio engine at all. The old shape of this suite assumed the
 * opposite (intro-only music, stopped at the fight); what replaced that assumption
 * is the last test in this file, which walks intro → fight → interlude → next fight
 * in one page and asserts the whole journey is console-error-free — because the
 * headless bar on "did the music keep playing" is exactly that: every duck, every
 * restore and every `Tone` call along the way happened without a single throw.
 *
 * What this file does *not* try to assert: whether a sound actually played, or
 * whether the mount-time attempt actually succeeded. There is no reliable way to
 * observe `AudioContext` output from outside the page, and a headless Chromium under
 * Playwright's default launch flags has no media-engagement history to make the
 * gestureless attempt succeed — so in this suite it is expected to fail every time,
 * silently, and fall back to the gesture path (`test/audio-music.test.ts` pins both
 * halves of that decision in Node). What *is* asserted headless, and is the actual
 * contract with a player, is: the toggle is visible from the moment the game boots
 * and reflects/persists the mute preference (the same round-trip
 * `test/audio-mute.test.ts` proves in Node for the storage half alone); the
 * mount-time attempt and its silent failure produce zero console errors on their
 * own, with no gesture at all; the broader gesture fallback does not interfere with
 * the intro's own navigation (a non-navigation key or a stray click still does
 * nothing *but* arm audio); and nothing about any of this leaks into an error once
 * the fight has begun.
 */
import { expect, test } from '@playwright/test';
import { armReplay, collectErrors, loadFixture, waitForBoot, waitForRound } from './helpers.ts';

const fixture = loadFixture();

test('the mute toggle is visible before and after the start screen, and clicking it mutes', async ({ page }) => {
  const errors = collectErrors(page);

  await page.goto('/?seed=424242');
  await waitForBoot(page);

  const toggle = page.getByTestId('audio-toggle');
  // Visible over the start screen — audio's UI is not one of the screens themselves.
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(toggle).toHaveAttribute('data-muted', 'false');

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle).toHaveAttribute('data-muted', 'true');
  expect(
    await page.evaluate(() => window.localStorage.getItem('rematch.audio.muted')),
    'the mute preference persists under its own namespaced key',
  ).toBe('1');

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => window.localStorage.getItem('rematch.audio.muted'))).toBeNull();

  // Still there once a fight is underway — it is mounted independent of `#hud`/`#screen`
  // and survives every round transition (`main.ts`).
  await page.getByTestId('skip-intro').click();
  await waitForRound(page);
  await expect(toggle).toBeVisible();

  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
});

test('the muted preference survives a reload', async ({ page }) => {
  await page.goto('/?seed=424242');
  await waitForBoot(page);

  await page.getByTestId('audio-toggle').click();
  await expect(page.getByTestId('audio-toggle')).toHaveAttribute('data-muted', 'true');

  await page.reload();
  await waitForBoot(page);
  await expect(page.getByTestId('audio-toggle')).toHaveAttribute('data-muted', 'true');
  await expect(page.getByTestId('audio-toggle')).toHaveAttribute('aria-pressed', 'true');
});

test('clicking a screen\'s primary button does not error, whether or not audio can actually start', async ({ page }) => {
  // Chromium under Playwright generally permits audio to start on a dispatched click,
  // but this asserts the contract that matters regardless of whether it does on any
  // given CI machine: `audio/engine.ts` never lets a failed `tone` load, a blocked
  // `AudioContext`, or a rejected `Tone.start()` reach the console (see its header).
  const errors = collectErrors(page);
  await page.goto('/?seed=424242&intro=1');
  await waitForBoot(page);
  await page.getByTestId('primary').click(); // hook -> concept: the first real gesture.
  await page.waitForTimeout(200);
  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
});

test('the mount-time autoplay attempt is silent, with no gesture at all', async ({ page }) => {
  // `attemptAutoStart()` fires the instant the intro screen mounts, with nothing to
  // wait for and nothing to click — this test dispatches no input whatsoever. Under
  // Playwright's default launch (no media-engagement history for this origin), the
  // attempt is expected to be *blocked*, and `AUTOPLAY_TIMEOUT_MS` (500ms) bounds how
  // long the attempt waits before giving up and falling back — waiting past that is
  // what proves the failure path (`autoplayFailed`) resolved cleanly rather than
  // hanging or throwing.
  const errors = collectErrors(page);
  await page.goto('/?seed=424242&intro=1');
  await waitForBoot(page);
  await page.waitForTimeout(700);
  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
});

test('a keypress the intro does not recognise still arms audio without navigating', async ({ page }) => {
  // Matt's playtest ask, narrowed to what is observable headless: "first user
  // gesture ANYWHERE" (`ui/screens.ts`'s document-level fallback) must not be
  // mistaken for the intro's own Enter/Space/click-to-continue handling — `onKey`
  // ignores any key `introKeyAction` does not recognise, and that must stay true
  // with the fallback listener also attached. (A pointer *click* anywhere on the
  // overlay already means "continue" by the existing, unrelated design — "the whole
  // overlay is the primary action's hit box" — so a key is the case worth pinning:
  // it is a gesture the fallback wants and the intro's own navigation does not.)
  const errors = collectErrors(page);
  await page.goto('/?seed=424242&intro=1');
  await waitForBoot(page);
  const screen = page.locator('#screen');
  await expect(screen).toHaveAttribute('data-intro', 'hook');

  await page.keyboard.press('KeyQ');
  await expect(screen).toHaveAttribute('data-intro', 'hook');

  // The fallback disarms itself after its first gesture (`onIntroFallbackGesture`);
  // a second one must still be harmless rather than erroring on a removed listener.
  await page.keyboard.press('KeyW');
  await expect(screen).toHaveAttribute('data-intro', 'hook');

  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
});

test('nothing from the intro\'s audio arming leaks an error into the fight', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/?seed=424242&intro=1');
  await waitForBoot(page);
  // A non-navigation gesture first, so the intro-only fallback listener is the one
  // that arms audio — then leave the intro for real (SKIP INTRO), which must
  // disarm it before any gameplay input exists to (wrongly) reach it.
  await page.keyboard.press('KeyQ');
  await page.getByTestId('skip-intro').click();
  await waitForRound(page);
  // Gameplay input, dispatched after the fallback should already be gone.
  await page.keyboard.press('KeyD');
  await page.mouse.click(100, 100);
  await page.waitForTimeout(150);
  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
});

test('the whole session — intro, fight, interlude, next fight — raises no audio error', async ({ page }) => {
  // The music bed's own e2e: it is started (or attempted) on the intro, it plays
  // through a fight, it ducks when the interlude mounts (`noteInterludeOpened`) and
  // it is restored when the interlude tears down (`noteInterludeClosed`, from
  // `dispose()`), and the thinking texture pulses and stops somewhere in the middle.
  // None of that is observable from outside the page — there is no way to read
  // `AudioContext` output, or a `Volume`'s ramp, from a Playwright assertion — so
  // what this pins is the contract that *is* observable and is the one that broke
  // before: none of it throws, on any of those transitions, with real gestures
  // driving it. `?agent=mock` keeps it offline and key-free (see `interlude.spec.ts`).
  const errors = collectErrors(page);

  await page.goto(`/?seed=${fixture.sessionSeed}&intro=1&agent=mock&speed=20&autofight=0`);
  await waitForBoot(page);

  // A real click on the intro: the gesture that starts the bed for the session
  // (`noteGesture`, from the primary button's own handler). It also advances the
  // intro a beat, which is why the way out below is Escape — `skip-intro` only
  // exists on the first beat, and `escapeAction` is set on all four.
  await page.getByTestId('primary').click();
  await page.keyboard.press('Escape');
  await waitForRound(page);

  // Gameplay input during the fight — under the old design this was the input the
  // page-level fallback listener was forbidden to hear; now it is allowed to, and
  // (because the intro click already started the music) it must find nothing to do.
  await page.keyboard.press('KeyD');

  // Win round 1 with the recorded log, which opens the interlude: the duck.
  await armReplay(page, fixture.log);
  await page.evaluate(() => window.__rematch?.fastForward());
  await expect(page.getByTestId('il-root')).toBeVisible();

  // Let the mock stream for real: the Analyst's prose and the Coder's code are what
  // feed `noteThinking`, so this is the window in which the thinking texture is
  // actually running and being rescheduled.
  await page.waitForFunction(() => window.__rematch?.interlude?.state.done === true, undefined, { timeout: 30_000 });

  // FIGHT: the interlude disposes, which must unduck the bed and silence the
  // texture before round 2's first tick.
  await page.getByTestId('il-fight').click();
  await waitForRound(page);
  await expect(page.getByTestId('audio-toggle')).toBeVisible();

  // A beat of round 2, with the interlude gone: a thinking pulse still firing, or a
  // ramp still queued against a disposed node, would surface here.
  await page.waitForTimeout(300);

  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
});
