/**
 * The recorded mode — the demo video's source, and spec AC 6 as a player sees it.
 *
 * This is the same journey `interlude.spec.ts` proves against the mock, run instead
 * against `public/recorded/mimic-camper.json`: a **real** `gpt-5.4-mini` run from
 * `pnpm eval:agents` on 2026-09-03, in which the harness rejected three candidate
 * files at attempt 1 and approved one at attempt 2.
 *
 * What makes it worth a separate spec rather than a parameter on the existing one:
 *
 * 1. **The provenance badge.** A recorded run must announce itself. If the footer ever
 *    stops saying `RECORDED RUN · <model> · <date>`, a demo video silently starts
 *    implying the model is running live, and that is the failure this file exists to
 *    catch.
 * 2. **The approved source really loads.** The recorded `done` carries the strategy
 *    the harness approved in September; Round 2's HUD reads `meta.name` out of the
 *    QuickJS module it loaded. `Warden I` on that HUD cannot be faked by a replay —
 *    it means the recorded bytes went through the sandbox and drove the fight.
 * 3. **The rejections survive the round trip.** The reason strings on screen are the
 *    harness's own sentences from the artifact, numbers included.
 *
 * `?speed=20` compresses the run's real 23.5 s to ~1.2 s. `?autofight=0` holds the
 * finished screen open so the assertions run before it hands over.
 *
 * No network beyond the static asset, no API key, no provider — which is the whole
 * point of the mode.
 */
import { expect, test } from '@playwright/test';

import { armReplay, loadFixture, waitForRound } from './helpers.ts';

const fixture = loadFixture();
const ARTIFACTS = new URL('../../../artifacts/web/', import.meta.url).pathname;

/** The run recorded as the default, and the facts the artifact records about it. */
const RUN = {
  name: 'mimic-camper',
  model: 'gpt-5.4-mini',
  date: '2026-09-03',
  strategy: 'Warden I',
  /** Candidate files the harness rejected across both attempts. */
  rejections: 5,
  attempts: 2,
};

test.use({ viewport: { width: 1280, height: 800 } });

test('replays a real recorded run: rejections, approval, and Round 2 loads its strategy', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  await page.goto(`/?seed=${fixture.sessionSeed}&autostart=1&agent=recorded&run=${RUN.name}&speed=20&autofight=0`);
  await waitForRound(page);
  await armReplay(page, fixture.log);
  await page.evaluate(() => window.__rematch?.fastForward());
  await expect(page.getByTestId('il-root')).toBeVisible();

  // ------------------------------------------------- the honesty claim on screen
  await expect(page.getByTestId('il-kind')).toHaveText('RECORDED RUN');
  const provenance = page.getByTestId('il-provenance');
  // Filled in from the file's own header once the fetch lands, so this asserts the
  // badge names *this* run's model and date rather than a hardcoded string.
  await expect(provenance).toHaveText(`RECORDED RUN · ${RUN.model} · ${RUN.date}`);
  await expect(provenance).toHaveAttribute('data-kind', 'recorded');
  // The caveat, on screen and not only in the JSON. All three recordings predate
  // Gate 3's ACTIVE assertion, so the bosses they approved visibly freeze; a viewer
  // who can see that has to be able to read why. See `recorded.ts`' `knownIssue`.
  const disclosure = page.getByTestId('il-provenance-note');
  await expect(disclosure).toBeVisible();
  await expect(disclosure).toContainText('KNOWN ISSUE');
  await expect(disclosure).toContainText('ACTIVE assertion');

  await page.waitForFunction(() => window.__rematch?.interlude?.state.done === true, undefined, { timeout: 30_000 });

  // ------------------------------------------------- the loop, as it really ran
  const state = await page.evaluate(() => window.__rematch?.interlude?.state);
  expect(state?.candidates).toBe(3);
  expect(state?.approved).toBe(true);
  expect(state?.strategyName).toBe(RUN.strategy);
  expect(state?.provenance).toBe(`RECORDED RUN · ${RUN.model} · ${RUN.date}`);
  // Spec §2.2: every rejection stays readable. Three candidates failed at attempt 1
  // and two more at attempt 2 — the artifact's own count.
  expect(state?.rejections).toHaveLength(RUN.rejections);
  // Real streamed content in both streaming beats, not a canned blob.
  expect(state?.analysisChars ?? 0).toBeGreaterThan(200);
  expect(state?.codeChars ?? 0).toBeGreaterThan(1000);

  // The harness's own sentences, numbers included, straight out of the artifact.
  const rejections = page.getByTestId('il-rejections');
  await expect(rejections.locator('li')).toHaveCount(RUN.rejections);
  await expect(rejections).toContainText('rejected by Gate 3 balance');
  await expect(rejections).toContainText('too easy');
  await expect(rejections).toContainText('too hard');
  await expect(rejections).toContainText('band 0.35–0.50 for round 2');
  // Attempt 1's conservative candidate missed the Mimic threshold as well as the band
  // — spec AC 7's number, failing, in the player's own words.
  await expect(rejections).toContainText("didn't adapt");

  await expect(page.getByTestId('il-verdict')).toContainText('APPROVED');
  await expect(page.getByTestId('il-verdict')).toHaveAttribute('data-kind', 'approved');
  await expect(page.getByTestId('il-meter')).toHaveClass(/done/);
  // Nothing fell back: this run was approved for real.
  await expect(page.getByTestId('il-banner')).toBeHidden();
  await expect(page.getByTestId('il-note-rewrite')).toContainText(`attempt ${RUN.attempts}`);

  await page.getByTestId('il-root').screenshot({ path: `${ARTIFACTS}recorded-approved.png` });

  // ------------------------------------------------------------ and then: round 2
  await page.getByTestId('il-fight').click();
  await expect(page.getByTestId('il-root')).toHaveCount(0);
  await expect.poll(async () => page.evaluate(() => window.__rematch?.round ?? 0)).toBe(2);

  // The assertion that cannot be faked by a replay: the HUD reads `meta.name` out of
  // the module QuickJS loaded, so `Warden I` here means the recorded source really
  // went through the sandbox and is driving the fight.
  await expect(page.locator('.hud-strategy .name')).toHaveText(RUN.strategy);
  await expect(page.locator('.hud-round')).toContainText('Round 2');
  // The recorded run ends in an approval, so the fight is entitled to claim
  // authorship. The opposite case — a pool pick that must *not* claim it — is in
  // `interlude.spec.ts`'s deadline test.
  await expect(page.getByTestId('boss-origin')).toHaveText('written for you');
  await expect.poll(async () => page.evaluate(() => window.__rematch?.state?.tick ?? 0)).toBeGreaterThan(30);

  await page.locator('#stage').screenshot({ path: `${ARTIFACTS}recorded-round2-boss.png` });

  expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
});

test('a named second run plays, so the video has variety', async ({ page }) => {
  // `dodger-a` is the long one: eight rejected candidates across three attempts before
  // "Lantern III" approved. Worth a check of its own because the index is what a demo
  // switches between, and a broken second asset would only show up on stage.
  await page.goto(`/?seed=${fixture.sessionSeed}&autostart=1&agent=recorded&run=dodger-a&speed=40&autofight=0`);
  await waitForRound(page);
  await armReplay(page, fixture.log);
  await page.evaluate(() => window.__rematch?.fastForward());
  await expect(page.getByTestId('il-root')).toBeVisible();

  await page.waitForFunction(() => window.__rematch?.interlude?.state.done === true, undefined, { timeout: 30_000 });

  const state = await page.evaluate(() => window.__rematch?.interlude?.state);
  expect(state?.approved).toBe(true);
  expect(state?.strategyName).toBe('Lantern III');
  expect(state?.rejections?.length ?? 0).toBeGreaterThan(RUN.rejections);
  await expect(page.getByTestId('il-provenance')).toContainText('RECORDED RUN · gpt-5.4-mini');

  await page.getByTestId('il-root').screenshot({ path: `${ARTIFACTS}recorded-dodger-a.png` });
});
