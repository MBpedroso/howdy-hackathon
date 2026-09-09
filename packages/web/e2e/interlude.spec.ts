/**
 * The interlude — spec §2.2, AC 5, and the reason the whole project exists.
 *
 * A scripted player wins Round 1 (the same recorded input log the determinism spec
 * uses), the interlude takes the screen, all four beats fill with real streamed
 * content, one attempt is visibly rejected by Gate 3 and the next is approved, and
 * Round 2 starts against the strategy that was approved — proved by the HUD naming
 * it, which is only possible if the source really loaded through QuickJS.
 *
 * The source here is `?agent=mock`: a scripted, timed replay of one realistic run,
 * whose "approved" strategy is `packages/harness/test/fixtures/round2-candidate.js`
 * — a strategy the harness's balance suite actually measures in the round-2 band. So
 * this test is about the interlude, not about the model: it must pass with no API
 * key, no server and no network, which is also how the demo is expected to survive a
 * conference wifi.
 *
 * `?speed=20` compresses the mock's ~25 s to ~1.3 s. `?autofight=0` holds the
 * finished screen open so the assertions run before it hands over.
 */
import { expect, test, type Page } from '@playwright/test';

import { armReplay, collectErrors, loadFixture, waitForRound } from './helpers.ts';

const fixture = loadFixture();
const ARTIFACTS = new URL('../../../artifacts/web/', import.meta.url).pathname;

/** A projector, which is what the layout was designed against (see interlude.css). */
test.use({ viewport: { width: 1280, height: 800 } });

/** Win Round 1 by replaying the recorded log, then wait for the interlude to mount. */
async function winRound1(page: Page, query: string): Promise<void> {
  await page.goto(`/?seed=${fixture.sessionSeed}&autostart=1&${query}`);
  await waitForRound(page);
  await armReplay(page, fixture.log);
  await page.evaluate(() => window.__rematch?.fastForward());
  await expect(page.getByTestId('il-root')).toBeVisible();
}

/** Wait until the interlude has received an event satisfying `predicate`. */
async function waitForEvent(page: Page, type: string): Promise<void> {
  await page.waitForFunction(
    (want) => (window.__rematch?.interlude?.events ?? []).some((e) => e.type === want),
    type,
    { timeout: 30_000 },
  );
}

test('plays all four beats, shows a rejection and an approval, and starts round 2', async ({ page }) => {
  const errors = collectErrors(page);

  await winRound1(page, 'agent=mock&speed=20&autofight=0');

  const root = page.getByTestId('il-root');
  // `MOCK` / `LIVE` / `RECORDED RUN` — the three honest answers (see `KIND_LABEL`).
  await expect(page.getByTestId('il-kind')).toHaveText('MOCK');
  await expect(page.getByTestId('il-provenance')).toHaveText('MOCK');
  // The disclosure line is for a source with something to disclose. The mock has
  // nothing, so it must not appear — an always-on caveat is noise, not honesty.
  await expect(page.getByTestId('il-provenance-note')).toBeHidden();
  await expect(page.getByTestId('il-rounds')).toContainText('Round 1 → 2');

  // ------------------------------------------------------------------- the cast
  // The playtester's complaint, as an assertion: every beat is attributed, and the
  // four panels between them name the three agents. The Replay belongs to the
  // Analyst (its three figures are literally that agent's input).
  await expect(page.getByTestId('il-agent-replay')).toHaveText('ANALYST');
  await expect(page.getByTestId('il-agent-analysis')).toHaveText('ANALYST');
  await expect(page.getByTestId('il-agent-rewrite')).toHaveText('CODER');
  await expect(page.getByTestId('il-agent-trial')).toHaveText('JUDGE');
  for (const beat of ['replay', 'analysis', 'rewrite', 'trial']) {
    // The portrait is present whether or not the raster art has landed.
    await expect(page.getByTestId(`il-beat-${beat}`).locator('.rm-portrait').first()).toBeVisible();
    // And the status line is never blank: "watching your replay…" is true from the
    // first frame, and a blank header would be the bug this replaced.
    await expect(page.getByTestId(`il-status-${beat}`)).not.toHaveText('');
  }

  // Wait for the run to finish. Everything below is asserted on the finished
  // screen precisely because nothing on it is allowed to clear.
  await page.waitForFunction(() => window.__rematch?.interlude?.state.done === true, undefined, { timeout: 30_000 });

  // ---------------------------------------------------------------- beat 1
  // The replay figures come from the summary the Analyst is given, so a caption
  // with this round's real numbers proves the panel was fed the real thing.
  await expect(page.getByTestId('il-replay-caption')).toContainText('shots');
  await expect(page.getByTestId('il-replay-caption')).toContainText('dashes');
  const drew = await page.evaluate(() => {
    // A canvas with content: at least one pixel that is not the panel background.
    const canvas = document.querySelector<HTMLCanvasElement>('#il-heat');
    const ctx = canvas?.getContext('2d') ?? null;
    if (canvas === null || ctx === null) return false;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const first = [data[0], data[1], data[2]].join();
    for (let i = 4; i < data.length; i += 4) {
      if ([data[i], data[i + 1], data[i + 2]].join() !== first) return true;
    }
    return false;
  });
  expect(drew, 'the heat grid rendered nothing but one flat colour').toBe(true);

  // ---------------------------------------------------------------- beat 2
  const analysis = page.getByTestId('il-analysis-structured');
  await expect(analysis).toBeVisible();
  await expect(analysis.locator('.il-obs li')).not.toHaveCount(0);
  await expect(analysis.locator('.il-tag')).toContainText('archetype');
  await expect(analysis.locator('.il-plan')).toContainText('counter-plan');
  // The streamed prose is still there, not replaced by the tidy version — and it is
  // prose: the Analyst's JSON block never reaches the stream (`analysisGate`).
  const streamed = (await page.getByTestId('il-analysis-stream').textContent()) ?? '';
  expect(streamed.length).toBeGreaterThan(200);
  expect(streamed).not.toContain('```');
  expect(streamed).not.toContain('"playerArchetype"');

  // ---------------------------------------------------------------- beat 3
  // Three candidate files per attempt, aimed at the low edge, the middle and the
  // high edge of the band — the tab strip is the search, and the pane below it is
  // whichever file the harness last touched.
  const cands = page.getByTestId('il-cands');
  await expect(cands).toBeVisible();
  await expect(cands.locator('.il-cand')).toHaveCount(3);
  await expect(cands.locator('[data-status="ok"]')).toHaveCount(1);
  await expect(cands.locator('[data-status="fail"]')).toHaveCount(2);
  // The approved file is what the screen is left on, not the last one measured.
  await expect(cands.locator('[data-selected="true"]')).toHaveAttribute('data-status', 'ok');

  const diff = page.getByTestId('il-diff');
  await expect(diff).toBeVisible();
  await expect(diff).toContainText('+++ strategy.js (attempt 2)');
  await expect(diff.locator('.add')).not.toHaveCount(0);
  await expect(diff.locator('.del')).not.toHaveCount(0);
  // No total: the server's attempt ceiling is configurable and never crosses the wire,
  // so the label is the attempt number alone. See `MAX_ATTEMPTS` in `interlude/events.ts`.
  await expect(page.getByTestId('il-note-rewrite')).toContainText('attempt 2');
  await expect(page.getByTestId('il-note-rewrite')).toContainText('Warden');

  // ---------------------------------------------------------------- beat 4
  const gates = page.getByTestId('il-gates');
  // Attempt 2's three candidates: two stopped at Gate 3, one ran all four. The
  // rows are grouped by candidate and nothing from an earlier candidate clears.
  await expect(gates.locator('.il-gate-group')).toHaveCount(3);
  await expect(gates.locator('.il-gate')).toHaveCount(10);
  await expect(gates).toContainText('REJECTED');
  await expect(gates.locator('[data-ok="false"]')).toHaveCount(2);
  await expect(gates.locator('[data-ok="false"]').first()).toContainText('Gate 3 balance');

  // Spec §2.2: "the player must be able to read every rejection." Five files were
  // rejected across the two attempts and all five reasons are still readable.
  const rejections = page.getByTestId('il-rejections');
  await expect(rejections.locator('li')).toHaveCount(5);
  await expect(rejections).toContainText('rejected by Gate 3 balance');
  await expect(rejections).toContainText('0.91 vs panel');
  await expect(rejections).toContainText('too hard');
  await expect(rejections).toContainText('too easy');
  await expect(rejections).toContainText('0.41 vs Mimic');

  // The verdict is the Judge's stamp: the mark, what it means in words, and the
  // harness's own quantitative sentence underneath — spec §2.2's "readable"
  // for a player and for someone checking the numbers.
  await expect(page.getByTestId('il-verdict')).toContainText('APPROVED');
  await expect(page.getByTestId('il-verdict')).toContainText('45%');
  await expect(page.getByTestId('il-verdict')).toHaveAttribute('data-kind', 'approved');
  await expect(page.getByTestId('il-verdict').locator('.rm-portrait')).toBeVisible();
  await expect(page.getByTestId('il-verdict')).toContainText('it countered you');
  await expect(page.getByTestId('il-stamp-raw')).toContainText('vs the reference panel');
  await expect(page.getByTestId('il-stamp-raw')).toContainText('vs a bot built from your own replay');
  // The Gate 3 meter finished on the harness's own count, rather than on a timer.
  await expect(page.getByTestId('il-meter')).toHaveClass(/done/);
  // No AC 5 fallback on the happy path.
  await expect(page.getByTestId('il-banner')).toBeHidden();

  // The whole run, inside AC 5's budget even before the 20× speed-up is undone.
  const state = await page.evaluate(() => window.__rematch?.interlude?.state);
  expect(state?.rejections).toHaveLength(5);
  expect(state?.candidates).toBe(3);
  expect(state?.approved).toBe(true);
  expect(state?.strategyName).toBe('Warden');
  expect(state?.phase).toBe('done');
  expect(state?.analysisChars ?? 0).toBeGreaterThan(200);
  expect(state?.codeChars ?? 0).toBeGreaterThan(1000);
  // Every simulated match was accounted for: the meter is a readout of
  // `trial.progress`, so this is the harness's count reaching the screen.
  expect(state?.matchesTotal ?? 0).toBeGreaterThan(0);
  expect(state?.matchesDone).toBe(state?.matchesTotal);
  expect(state?.elapsedMs ?? 1e9).toBeLessThan(45_000);

  // ------------------------------------------------- the three of them, finished
  // Every status line has become a past-tense report of what that agent did, and
  // each names its own number: the Analyst's observation count, the Coder's file
  // count, the Judge's approval by name.
  await expect(page.getByTestId('il-status-analysis')).toContainText('found 4 patterns');
  await expect(page.getByTestId('il-status-analysis')).toContainText('you play like a');
  await expect(page.getByTestId('il-status-rewrite')).toContainText('3 strategies written');
  await expect(page.getByTestId('il-status-trial')).toHaveText('✓ approved Warden');

  // The hand-off: the boss that was just written, by name, in its own words. The
  // rationale comes out of the approved file's `meta`, so this is the strategy
  // talking — the same sentence the Round 2 HUD is about to show.
  const boss = page.getByTestId('il-boss');
  await expect(boss).toContainText('Warden');
  await expect(boss).toContainText('says');
  await expect(boss).toContainText('where you live');

  await root.screenshot({ path: `${ARTIFACTS}interlude-approved.png` });
  await page.getByTestId('il-beat-trial').screenshot({ path: `${ARTIFACTS}interlude-cast-judge.png` });

  // -------------------------------------------------- and then: round 2
  await page.getByTestId('il-fight').click();
  await expect(page.getByTestId('il-root')).toHaveCount(0);
  await expect.poll(async () => page.evaluate(() => window.__rematch?.round ?? 0)).toBe(2);

  // The payoff, and the only assertion that cannot be faked: the HUD reads the
  // strategy name out of the loaded QuickJS module, so Round 2 really is being
  // driven by the source the interlude said was approved.
  await expect(page.locator('.hud-strategy .name')).toHaveText('Warden');
  await expect(page.locator('.hud-round')).toContainText('Round 2');
  await expect(page.locator('.hud-strategy .rationale')).toContainText('where you live');
  await expect.poll(async () => page.evaluate(() => window.__rematch?.state?.tick ?? 0)).toBeGreaterThan(30);

  await page.locator('#stage').screenshot({ path: `${ARTIFACTS}interlude-round2-boss.png` });

  expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
});

test('each beat is legible on its own — the demo screenshots', async ({ page }) => {
  // Slower than the assertion test so each beat is caught mid-flight rather than
  // in its finished state: these five images are the demo evidence spec §7 asks
  // for, so they have to show the screen as a player sees it.
  await winRound1(page, 'agent=mock&speed=3&autofight=0');
  const root = page.getByTestId('il-root');

  await waitForEvent(page, 'analysis.delta');
  await root.screenshot({ path: `${ARTIFACTS}interlude-1-replay.png` });

  await waitForEvent(page, 'analysis.done');
  await root.screenshot({ path: `${ARTIFACTS}interlude-2-analysis.png` });
  // The Analyst, alone: portrait, name, status, and its observations in the speech
  // bubble. One panel per agent, for the write-up and the demo slides.
  await page.getByTestId('il-beat-analysis').screenshot({ path: `${ARTIFACTS}interlude-cast-analyst.png` });

  await waitForEvent(page, 'rewrite.done');
  await root.screenshot({ path: `${ARTIFACTS}interlude-3-rewrite.png` });
  // The Coder's diff, with its byline: who wrote it and what the boss is called now.
  await expect(page.getByTestId('il-diff-head')).toBeVisible();
  await page.getByTestId('il-beat-rewrite').screenshot({ path: `${ARTIFACTS}interlude-cast-coder.png` });

  // Mid-Gate 3 of attempt 1: the meter is moving on real batched progress and no
  // verdict exists yet. This is the frame that shows "waiting is content".
  await page.waitForFunction(
    () => (window.__rematch?.interlude?.events ?? []).some((e) => e.type === 'trial.progress'),
    undefined,
    { timeout: 30_000 },
  );
  await root.screenshot({ path: `${ARTIFACTS}interlude-4-trial.png` });

  await page.waitForFunction(
    () => (window.__rematch?.interlude?.state.rejections.length ?? 0) > 0,
    undefined,
    { timeout: 30_000 },
  );
  await expect(page.getByTestId('il-verdict')).toContainText('REJECTED');
  await root.screenshot({ path: `${ARTIFACTS}interlude-5-rejected.png` });

  // The rejection is fed back with no human in the loop, and the screen says so.
  await page.waitForFunction(
    () => (window.__rematch?.interlude?.events ?? []).some((e) => e.type === 'rewrite.delta' && e.attempt === 2),
    undefined,
    { timeout: 30_000 },
  );
  await expect(page.getByTestId('il-status')).toContainText('no human in the loop');
  await root.screenshot({ path: `${ARTIFACTS}interlude-6-rewriting.png` });
});

test('the 45-second deadline shows the AC 5 fallback instead of hanging', async ({ page }) => {
  // A source that never finishes: the mock at 1/50 speed will still be streaming
  // the Analyst when the deadline fires. Nothing here stubs the UI — the banner,
  // the verdict line and the FIGHT button are the real ones.
  await winRound1(page, 'agent=mock&speed=0.02&deadline=1200&autofight=0');

  const banner = page.getByTestId('il-banner');
  await expect(banner).toBeVisible({ timeout: 15_000 });
  // Spec AC 5's wording, verbatim, under a plain-words headline — the fallback is a
  // Judge verdict too ("nothing was approved, so something that already was ships"),
  // so it wears the same portrait and the same stamp as a rejection.
  await expect(banner).toContainText('Using a pre-approved strategy');
  await expect(banner).toContainText('the coder timed out');
  await expect(banner).toContainText('⏱ the coder ran out of time');
  await expect(banner.locator('.rm-portrait')).toBeVisible();
  await expect(page.getByTestId('il-verdict')).toContainText('NO APPROVAL');
  await expect(page.getByTestId('il-status-trial')).toContainText('shipping a pre-approved strategy');

  // The round still starts. A blank screen is the one outcome that is not allowed.
  await expect(page.getByTestId('il-fight')).toBeVisible();
  await page.getByTestId('il-fight').click();
  await expect.poll(async () => page.evaluate(() => window.__rematch?.round ?? 0)).toBe(2);
  await expect(page.locator('.hud-strategy .name')).toHaveText('Hound');
  // …and the fight says where it came from. This is the assertion that stops the
  // product overclaiming: nothing was approved this session, so the boss on screen
  // must not be labelled as one written for this player.
  const origin = page.getByTestId('boss-origin');
  await expect(origin).toHaveText('pre-approved');
  await expect(origin).not.toHaveText('written for you');
});
