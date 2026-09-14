/**
 * The recorded mode — the demo video's source, and spec AC 6 as a player sees it.
 *
 * This is the same journey `interlude.spec.ts` proves against the mock, run instead
 * against the committed assets in `public/recorded/`. Two legs, because the index
 * holds two generations of recording and the deployed site plays the newer one:
 *
 *  - **the default** (`?agent=recorded`, no `&run=`) is `silo-r2-calibrated`, a live
 *    2026-09-11 `claude-cli` round on `sonnet` that the Judge approved by calibrating
 *    the throttle. Its test is at the bottom of this file;
 *  - **`mimic-camper`**, named explicitly below, is a `gpt-5.4-mini` run from
 *    `pnpm eval:agents` on 2026-09-03, in which the harness rejected three candidate
 *    files at attempt 1 and approved one at attempt 2. It is still the leg that
 *    proves the disclosure footer, because it is one of the three recordings that
 *    predate Gate 3's ACTIVE assertion and has something to disclose.
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

import { armReplay, collectErrors, loadFixture, waitForRound } from './helpers.ts';

const fixture = loadFixture();
const ARTIFACTS = new URL('../../../artifacts/web/', import.meta.url).pathname;

/** The named 2026-09-03 run, and the facts its eval artifact records about it. */
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
  // The caveat, on screen and not only in the JSON. The three 2026-09-03 recordings
  // predate Gate 3's ACTIVE assertion, so the bosses they approved visibly freeze; a
  // viewer who can see that has to be able to read why. See `recorded.ts`'
  // `knownIssue` — and the default run below, which has none and shows none.
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

/**
 * The default recorded run — what a visitor to the deployed site actually gets.
 *
 * `?agent=recorded` with no `&run=` takes the first entry of `index.json`, and since
 * 2026-09-11 that is `silo-r2-calibrated`: a **live** round on the developer's own
 * Claude Code session (`REMATCH_PROVIDER=claude-cli`, model `sonnet`), approved on
 * attempt 1 in 44 s. It is the default because it shows the one beat the September
 * evals could not — the Judge's own deterministic calibration — and because it is
 * from after Gate 3 grew its ACTIVE assertion, so the boss it ships marches rather
 * than freezing and the file has no `knownIssue` to disclose.
 *
 * The three claims worth a test of their own, over and above the ones the
 * `mimic-camper` leg already makes:
 *
 *  1. **The default really is this run.** The badge names `sonnet` and `2026-09-11`,
 *     and the KNOWN ISSUE footer that the 09-03 recordings carry is *absent* — a
 *     caveat shown over a run that does not have the fault is its own small lie.
 *  2. **The calibration is on screen.** `CALIBRATED · throttle 1.00 → 0.50` is the
 *     Judge doing arithmetic in public: Gate 3 measured the Coder's file at 0.78,
 *     one step at half the pressure measured 0.49, and the band for round 2 is
 *     0.35–0.50. The `✓ APPROVED — 49%` stamp is that same number.
 *  3. **The calibrated file runs.** The approved `source` is not the Coder's file:
 *     it is that file with the Judge's block appended, which renames `init`/`decide`
 *     to `__initRaw`/`__decideRaw` and wraps them. Round 2 loading `Silo I` through
 *     QuickJS and the boss then *moving* is the only proof that the rename survives
 *     the recorder, the sandbox and the replay — it is far more code than any 09-03
 *     recording put through that path.
 */
const DEFAULT_RUN = {
  model: 'sonnet',
  date: '2026-09-11',
  strategy: 'Silo I',
  /** The chain the strip prints: the Coder's file, then the one step that passed. */
  chain: 'CALIBRATED · throttle 1.00 → 0.50',
  stamp: '✓ APPROVED — 49%',
  /**
   * Rejection *sentences* in the log — one, not two.
   *
   * Two candidate files failed a gate in this run, which is the number `index.json`
   * carries (`countRejections` counts failing gates). Only one of them was handed
   * back to the player as a rejection: the conservative candidate, which threw in
   * Gate 2's fuzz. The other failure is the balanced candidate missing Gate 3's band
   * — and that one is not a rejection at all, it is what *started* the calibration,
   * so it appears as a `✗ Gate 3` row with the strip underneath it rather than as a
   * verdict. The gap between these two numbers is the whole point of the run.
   */
  rejections: 1,
};

/** Ticks sampled in Round 2, and the floor `boss-activity.spec.ts` uses for travel. */
const ROUND2_TICKS = 300;
const MIN_TRAVEL_PX = 100;

test('the default recorded run is the calibrated claude-cli one, and its boss really runs', async ({ page }) => {
  const errors = collectErrors(page);

  // No `&run=`: this is the URL the deployed site boots with (`VITE_DEFAULT_AGENT`).
  await page.goto(`/?seed=${fixture.sessionSeed}&autostart=1&agent=recorded&speed=20&autofight=0`);
  await waitForRound(page);
  await armReplay(page, fixture.log);
  await page.evaluate(() => window.__rematch?.fastForward());
  await expect(page.getByTestId('il-root')).toBeVisible();

  // ------------------------------------------------------------ 1. the provenance
  await expect(page.getByTestId('il-kind')).toHaveText('RECORDED RUN');
  await expect(page.getByTestId('il-provenance')).toHaveText(
    `RECORDED RUN · ${DEFAULT_RUN.model} · ${DEFAULT_RUN.date}`,
  );
  // Post-ACTIVE, so there is nothing to disclose and the footer stays empty.
  await expect(page.getByTestId('il-provenance-note')).toBeHidden();

  await page.waitForFunction(() => window.__rematch?.interlude?.state.done === true, undefined, { timeout: 30_000 });

  // ------------------------------------------------------------ 2. the calibration
  const strip = page.locator('.il-cal');
  await expect(strip).toHaveCount(1);
  await expect(strip).toContainText(DEFAULT_RUN.chain);
  // One row per measured value, and the Judge's note explaining why an APPROVED
  // stamp is allowed to sit under a `✗ Gate 3` row.
  await expect(strip.locator('.il-cal-step')).toHaveCount(1);
  await expect(strip).toContainText('panel 0.49');
  await expect(strip).toContainText('shipped at 0.50');
  await expect(strip).toContainText('every throttle here is a full four-gate re-run');

  const verdict = page.getByTestId('il-verdict');
  await expect(verdict).toContainText(DEFAULT_RUN.stamp);
  await expect(verdict).toHaveAttribute('data-kind', 'approved');
  // Every rejection stays readable, verbatim, numbers included (spec §2.2).
  await expect(page.getByTestId('il-rejections').locator('li')).toHaveCount(DEFAULT_RUN.rejections);
  await expect(page.getByTestId('il-rejections')).toContainText("'clamp' is not defined");
  // And the Gate 3 miss that started the search — the sentence the calibration is an
  // answer to — is on screen in the gate rows above the strip.
  await expect(page.getByTestId('il-gates')).toContainText('band 0.35–0.50 for round 2');
  await expect(page.getByTestId('il-gates')).toContainText('0.78 vs panel — too hard');

  const state = await page.evaluate(() => window.__rematch?.interlude?.state);
  expect(state?.approved).toBe(true);
  expect(state?.strategyName).toBe(DEFAULT_RUN.strategy);
  expect(state?.calibrations).toHaveLength(1);
  // `pressure` is the wire's older name for the throttle the search landed on.
  expect(state?.pressure).toBe(0.5);
  // The player is shown the file that actually shipped, not only the Coder's draft.
  expect(state?.calibratedDiff).toBe(true);

  await page.getByTestId('il-root').screenshot({ path: `${ARTIFACTS}recorded-calibrated.png` });

  // ------------------------------------------ 3. the calibrated file actually runs
  await page.getByTestId('il-fight').click();
  await expect.poll(async () => page.evaluate(() => window.__rematch?.round ?? 0)).toBe(2);
  // `Silo I` on the HUD is `meta.name` read out of the module QuickJS loaded — the
  // recorded bytes, rename block and all, went through the sandbox.
  await expect(page.locator('.hud-strategy .name')).toHaveText(DEFAULT_RUN.strategy);
  await expect(page.getByTestId('boss-origin')).toHaveText('written for you');

  // And it plays. The same human log replayed into Round 2, so a wrapper that threw
  // (or a rename that did not survive) shows up as a boss that never moves rather
  // than as a passing test. `__judgeRest` marches straight legs between attacks.
  await armReplay(page, fixture.log);
  const probe = await page.evaluate((ticks) => {
    const api = window.__rematch!;
    let travel = 0;
    let px = api.state!.boss.x;
    let py = api.state!.boss.y;
    for (let i = 0; i < ticks; i += 1) {
      if (api.fastForward(1) === 0) break;
      const s = api.state!;
      travel += Math.hypot(s.boss.x - px, s.boss.y - py);
      px = s.boss.x;
      py = s.boss.y;
    }
    const runner = api.runnerStats();
    return {
      ticks: api.state?.tick ?? 0,
      travelPx: travel,
      killed: api.state?.strategyKilled ?? true,
      failures: runner?.failures ?? null,
      calls: runner?.calls ?? 0,
    };
  }, ROUND2_TICKS);

  expect(probe.ticks, 'Round 2 did not simulate').toBeGreaterThan(ROUND2_TICKS / 2);
  expect(probe.travelPx, `boss travel over ${probe.ticks} ticks`).toBeGreaterThan(MIN_TRAVEL_PX);
  // A strategy the sandbox is killing looks the same on screen as one that works, so
  // the throw is checked directly: `__decideRaw` must be reachable on every call.
  expect(probe.killed).toBe(false);
  expect(probe.failures, 'the calibrated file fails no decide call').toEqual({});
  expect(probe.calls).toBeGreaterThan(ROUND2_TICKS / 4);

  await page.locator('#stage').screenshot({ path: `${ARTIFACTS}recorded-calibrated-round2.png` });

  expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
});

/**
 * The round 3 recording, which is the search the round 2 one does not show.
 *
 * `silo-r2-calibrated` lands on its first try; `cistern-r3-calibrated` is the harder
 * shape — the balanced candidate is measured at four values (0.50 too easy, 0.707
 * still too easy, 0.841 too hard, then 0.771 in band) and the aggressive candidate
 * spends four more before the Judge gives up on it. Eight strips' worth of
 * arithmetic is where a smeared timeline would be obvious, and where a second
 * committed asset breaking would otherwise only show up on stage.
 */
test('the round 3 recording plays its whole calibration search', async ({ page }) => {
  await page.goto(`/?seed=${fixture.sessionSeed}&autostart=1&agent=recorded&run=cistern-r3-calibrated&speed=40&autofight=0`);
  await waitForRound(page);
  await armReplay(page, fixture.log);
  await page.evaluate(() => window.__rematch?.fastForward());
  await expect(page.getByTestId('il-root')).toBeVisible();
  await page.waitForFunction(() => window.__rematch?.interlude?.state.done === true, undefined, { timeout: 30_000 });

  const state = await page.evaluate(() => window.__rematch?.interlude?.state);
  expect(state?.approved).toBe(true);
  expect(state?.strategyName).toBe('Cistern I');
  // Every step the Judge measured, across both calibrated candidates.
  expect(state?.calibrations).toHaveLength(8);
  // `state.pressure` is the *newest* search's landing, which here is the aggressive
  // candidate's abandoned 0.177 — the shipped number is the balanced candidate's, and
  // the screen is where the two are told apart.
  expect(state?.pressure).toBe(0.177);
  expect(state?.calibratedDiff).toBe(true);
  await expect(page.getByTestId('il-provenance')).toHaveText('RECORDED RUN · sonnet · 2026-09-11');
  await expect(page.getByTestId('il-provenance-note')).toBeHidden();
  // One strip per calibrated candidate; the one that shipped, and the one that did not.
  const strips = page.locator('.il-cal');
  await expect(strips).toHaveCount(2);
  await expect(strips.first()).toContainText('shipped at 0.77');
  await expect(strips.last()).toContainText('no throttle passed');
  await expect(page.getByTestId('il-verdict')).toContainText('APPROVED');
  // The stamp quotes the winning step's rate and the value it landed on, not the
  // Coder's own failing Gate 3 number above it.
  await expect(page.getByTestId('il-stamp-raw')).toHaveText(
    '0.60 vs panel after the Judge throttled the boss to 0.77 (4 steps)',
  );

  await page.getByTestId('il-root').screenshot({ path: `${ARTIFACTS}recorded-cistern-r3.png` });
});
