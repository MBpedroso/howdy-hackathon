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
 * finished screen open so the assertions run before it hands over — which is also
 * the real-play default now (a 2026-09-09 playtest finding; see
 * `docs/AI-DEV-LOG.md`): nothing advances past a finished interlude without an
 * explicit click, here or in front of a player. Clicking FIGHT then opens a brief
 * pre-fight interstitial (the same "boss learned" banner, moved off the live fight
 * by a second playtest finding) before Round 2's simulation takes its first tick.
 */
import { readFileSync } from 'node:fs';

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

  // A run with no calibration in it has no strip and keeps its meter — this is the
  // screenshot that must not move when the Judge's search is added to the panel.
  await expect(page.locator('.il-cal')).toHaveCount(0);
  await expect(page.getByTestId('il-beat-trial')).not.toHaveAttribute('data-calibrated', '1');
  await expect(page.locator('.il-meter-wrap')).toBeVisible();

  await root.screenshot({ path: `${ARTIFACTS}interlude-approved.png` });
  await page.getByTestId('il-beat-trial').screenshot({ path: `${ARTIFACTS}interlude-cast-judge.png` });

  // -------------------------------------------------- and then: round 2
  // Manual by default (a 2026-09-09 playtest finding — see `docs/AI-DEV-LOG.md`):
  // nothing advances until this click. If the interlude's own auto-continue were
  // still armed, `il-root` would already be gone by the time the test gets here.
  await expect(page.getByTestId('il-root')).toBeVisible();
  await page.getByTestId('il-fight').click();
  await expect(page.getByTestId('il-root')).toHaveCount(0);
  await expect.poll(async () => page.evaluate(() => window.__rematch?.round ?? 0)).toBe(2);

  // The payoff, and the only assertion that cannot be faked: the HUD reads the
  // strategy name out of the loaded QuickJS module, so Round 2 really is being
  // driven by the source the interlude said was approved. True immediately — the
  // HUD panel is drawn from the round's first (static) frame, before the
  // interstitial below ever opens.
  await expect(page.locator('.hud-strategy .name')).toHaveText('Warden');
  await expect(page.locator('.hud-round')).toContainText('Round 2');
  await expect(page.locator('.hud-strategy .rationale')).toContainText('where you live');

  // The mission this feature exists for: the interlude already said the boss was
  // rewritten for this player, and the fight itself said so only in a small HUD
  // panel nobody reads mid-combat. This is that claim again, said once more, loudly
  // — but now as a pre-fight interstitial rather than something layered over the
  // live fight (a second 2026-09-09 playtest finding moved it here; see the log).
  // The simulation must not have taken a single tick while it is up.
  const banner = page.getByTestId('round-banner');
  await expect(banner).toBeVisible();
  await expect(page.getByTestId('round-banner-name')).toHaveText('Warden');
  await expect(page.getByTestId('round-banner-rationale')).toContainText('where you live');
  expect(await page.evaluate(() => window.__rematch?.state?.tick ?? -1)).toBe(0);
  await page.locator('#stage').screenshot({ path: `${ARTIFACTS}round-banner.png` });

  // It closes on its own — nothing to click — and only then does the round start
  // stepping. Waited for on the real wall clock (~3.5 s): unlike the old
  // over-the-fight version, this timing no longer depends on how fast the sim
  // itself is ticking, so there is nothing flaky to work around here.
  await expect(banner).toBeHidden({ timeout: 8_000 });
  await expect.poll(async () => page.evaluate(() => window.__rematch?.state?.tick ?? 0)).toBeGreaterThan(0);

  await page.locator('#stage').screenshot({ path: `${ARTIFACTS}interlude-round2-boss.png` });

  expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
});

test('retrying a round the interstitial already opened for does not reopen it', async ({ page }) => {
  // The interstitial's whole reason to exist is a one-time reveal ("the boss
  // learned"); reopening it every time the player dies and retries would turn a
  // reveal into friction. `startRound`'s `showLearnedBanner` is what this guards —
  // a retry keeps the HUD's "written for you" chip (same `roundProvenance`) but
  // must never re-arm the banner.
  await winRound1(page, 'agent=mock&speed=20&autofight=0');
  await page.waitForFunction(() => window.__rematch?.interlude?.state.done === true, undefined, { timeout: 30_000 });
  await page.getByTestId('il-fight').click();
  await expect.poll(async () => page.evaluate(() => window.__rematch?.round ?? 0)).toBe(2);

  // Skip straight past the interstitial — `debug.fastForward` is documented to do
  // exactly that — and run Round 2 out with no player input, which loses it
  // (timeout or a hit either way count as `outcome !== 'playerWon'`).
  await page.evaluate(() => window.__rematch?.fastForward());
  const screen = page.locator('#screen');
  await expect(screen).toHaveAttribute('data-screen', 'gameOver');
  await expect(screen).toContainText('Warden');

  await page.getByTestId('primary').click();
  await expect.poll(async () => page.evaluate(() => window.__rematch?.round ?? 0)).toBe(2);
  expect(await page.evaluate(() => window.__rematch?.state?.strategy.name)).toBe('Warden');

  // The chip still says the fight is against a strategy the loop wrote...
  await expect(page.getByTestId('boss-origin')).toHaveText('written for you');
  // ...but the reveal itself does not come back, on this retry or the next couple
  // of frames after it (giving any wrongly-armed interstitial a chance to appear).
  await expect(page.getByTestId('round-banner')).toBeHidden();
  await page.waitForTimeout(200);
  await expect(page.getByTestId('round-banner')).toBeHidden();
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

/**
 * The Judge's own calibration, on screen — the strip, the sentence, the shipped diff.
 *
 * The loop can now fix a candidate that only misses the *number*: it rewrites the one
 * constant the file declares for it (`const PRESSURE`), re-runs all four gates, and
 * bisects until the panel rate lands in the band (`packages/agents/src/calibrate.ts`).
 * Three things then have to be true on screen, and none of them is testable without a
 * browser:
 *
 *  1. the search is visible as arithmetic — the chain of throttles with the rate
 *     measured at each, under the gate rows of the file it re-measured;
 *  2. an APPROVED stamp sitting under that file's own `✗ Gate 3` row explains itself,
 *     in the rates and in words;
 *  3. the diff the player is left looking at includes the change that actually
 *     shipped, labelled with the two files it compares.
 *
 * ## Why the stream is stubbed, and what is real in it
 *
 * No *local* source emits these events: the mock script and the three committed
 * recordings all predate calibration (`src/interlude/mock.ts`,
 * `public/recorded/*.json`), and the events only exist on the live server path, which
 * costs money and needs a key — neither of which an e2e run may assume. So this test
 * intercepts the recorded source's own fetch and serves a run whose first two beats
 * are the **real** 2026-09-03 `mimic-camper` recording (replay + the Analyst's
 * streamed prose, spliced out of the committed asset) and whose Trial beat is a
 * synthetic calibration stream written here.
 *
 * That is stated in the run's own header, so the screen says it too: the provenance
 * badge reads the stub's model name and the disclosure line under it says which half
 * is synthetic. Everything downstream of the fetch is production code — the source,
 * the event union's own type guard, the reducer, and every pixel of the panel.
 */
/** The file the Coder wrote. No throttle in it: the Judge's block is what adds one. */
const CODER_SOURCE = [
  'export const meta = { name: "Metronome II", rationale: "you camp; I bring the fight to the corner", version: 1 };',
  '',
  'export function init() {',
  '  return { t: 0 };',
  '}',
  '',
  'export function decide(view, mem) {',
  '  mem.t += 1;',
  '  return mem.t % 40 === 0 ? { type: "burst", dir: 0 } : { type: "move", x: view.player.x, y: view.player.y };',
  '}',
].join('\n');

/**
 * The file that shipped: the same source with the harness's block appended.
 *
 * Shaped like `throttleBlock` in `packages/agents/src/calibrate.ts` — the two renames
 * on `init`/`decide` and the `const THROTTLE` line the interlude reads back — rather
 * than copied whole, because what this test is about is the *diff being shown*, not
 * the wrapper's own behaviour (which `packages/agents/test/calibrate.test.ts` owns).
 */
const SHIPPED_SOURCE = `${CODER_SOURCE.replace('export function init(', 'function __initRaw(').replace(
  'export function decide(',
  'function __decideRaw(',
)}

// ---- calibrated by the Judge (deterministic; not written by the Coder) ----
const THROTTLE = 0.71;
const THROTTLE_HOLD = THROTTLE >= 1 ? 0 : Math.round((1 / THROTTLE - 1) * 45);

export function init() {
  const mem = __initRaw();
  mem.__judge = { holdUntil: 0 };
  return mem;
}

export function decide(view, mem) {
  return __decideRaw(view, mem);
}
`;

const STUB_META = {
  name: 'Metronome II',
  rationale: 'you camp; I bring the fight to the corner',
  version: 1,
};

/**
 * The synthetic run served to the recorded source.
 *
 * Beats 1-2 are lifted verbatim from the committed recording (everything before its
 * first `rewrite.delta`); beat 4 is one candidate that fails Gate 3 on FAIR alone and
 * is then calibrated into the band in two steps.
 */
function calibrationRun(): unknown {
  const real = JSON.parse(
    readFileSync(new URL('../public/recorded/mimic-camper.json', import.meta.url), 'utf8'),
  ) as { at: number[]; events: Array<{ type: string }> };
  const upTo = real.events.findIndex((event) => event.type === 'rewrite.delta');
  const head = real.events.slice(0, upTo);

  const band = [0.35, 0.5];
  const events = [
    ...head,
    { type: 'rewrite.delta', attempt: 1, delta: CODER_SOURCE },
    { type: 'rewrite.done', attempt: 1, source: CODER_SOURCE, diff: `--- strategy.js (previous)\n+++ strategy.js (next)\n@@ -1,3 +1,7 @@\n+${CODER_SOURCE.split('\n').join('\n+')}\n`, meta: STUB_META },
    { type: 'trial.gate', attempt: 1, gate: { gate: 1, name: 'static', ok: true, ms: 4 } },
    { type: 'trial.gate', attempt: 1, gate: { gate: 2, name: 'fuzz', ok: true, ms: 61 } },
    { type: 'trial.progress', attempt: 1, matchesDone: 0, matchesTotal: 200, gate: 'balance' },
    { type: 'trial.progress', attempt: 1, matchesDone: 200, matchesTotal: 200, gate: 'balance' },
    {
      type: 'trial.gate',
      attempt: 1,
      gate: {
        gate: 3,
        name: 'balance',
        ok: false,
        ms: 1042,
        reason: '0.91 vs panel — outside the band 0.35–0.50 for round 2 (too hard)',
        detail: { band, panel: { winRate: 0.91 }, mimic: { winRate: 0.88 } },
      },
    },
    // The Judge's search: the same file at two other numbers, each a full trial.
    {
      type: 'calibrate.step',
      attempt: 1,
      step: 1,
      pressure: 0.5,
      panel: 0.18,
      ok: false,
      reason: '0.18 vs panel — outside the band 0.35–0.50 for round 2 (too easy)',
    },
    { type: 'calibrate.step', attempt: 1, step: 2, pressure: 0.71, panel: 0.44, ok: true },
    { type: 'calibrate.done', attempt: 1, steps: 2, pressure: 0.71, approved: true },
    { type: 'verdict', attempt: 1, approved: true },
    {
      type: 'done',
      result: {
        approved: true,
        source: SHIPPED_SOURCE,
        meta: STUB_META,
        attempts: [],
        analysis: { observations: [], playerArchetype: 'camper', counterPlan: 'crowd the corner' },
      },
    },
  ];

  return {
    provider: 'e2e',
    model: 'calibration-stub',
    round: 2,
    archetype: 'camper',
    recordedAt: '2026-09-11T00:00:00.000Z',
    approved: true,
    attempts: 1,
    knownIssue:
      'SYNTHETIC TRIAL BEAT · beats 1-2 are the real 2026-09-03 mimic-camper recording; the Coder file, the gates and the calibration steps in this run were written by the e2e spec, so the spec controls every number; the committed recording silo-r2-calibrated carries the real ones.',
    timing: { method: 'e2e stub: beats 1-2 keep the recording’s cadence, the rest is paced by the spec' },
    // Beats 1-2 keep their measured offsets; the synthetic tail is paced evenly after
    // the last of them so the screen is watchable rather than instantaneous.
    at: [...real.at.slice(0, upTo), ...Array.from({ length: events.length - upTo }, (_v, i) => (real.at[upTo - 1] ?? 0) + (i + 1) * 260)],
    events,
  };
}

test('the Judge calibrates a candidate into the band, and says so in numbers', async ({ page }) => {
  const errors = collectErrors(page);
  const run = JSON.stringify(calibrationRun());

  await page.route('**/recorded/calibration-stub.json', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: run });
  });

  await winRound1(page, 'agent=recorded&run=calibration-stub&speed=20&autofight=0');
  await page.waitForFunction(() => window.__rematch?.interlude?.state.done === true, undefined, {
    timeout: 30_000,
  });

  // ------------------------------------------------------------------ the strip
  const strip = page.getByTestId('il-cal-0');
  await expect(strip).toBeVisible();
  // The whole search in one line, starting at the value the *Coder* wrote — which is
  // not in the stream at all; it is read out of the file the Rewrite panel is
  // displaying (`readPressure`).
  await expect(page.getByTestId('il-cal-head-0')).toHaveText(
    'CALIBRATED · throttle 1.00 → 0.50 → 0.71 · shipped at 0.71 (2 steps)',
  );
  await expect(strip).toHaveAttribute('data-state', 'ok');
  // Why an APPROVED stamp can sit under this candidate's own `✗ Gate 3` row.
  await expect(strip).toContainText('Gate 3 missed the band');
  const steps = strip.locator('.il-cal-step');
  await expect(steps).toHaveCount(2);
  // The rate measured at each value, and the harness's sentence where one failed.
  await expect(steps.nth(0)).toContainText('throttle 0.50');
  await expect(steps.nth(0)).toContainText('panel 0.18');
  await expect(steps.nth(0)).toContainText('too easy');
  await expect(steps.nth(0)).toHaveAttribute('data-ok', 'false');
  await expect(steps.nth(1)).toContainText('throttle 0.71');
  await expect(steps.nth(1)).toContainText('panel 0.44');
  await expect(steps.nth(1)).toHaveAttribute('data-ok', 'true');
  // The rejection it started from is untouched, verbatim (spec §2.2).
  await expect(page.getByTestId('il-gates')).toContainText('0.91 vs panel');

  // ---------------------------------------------------------------- the verdict
  const verdict = page.getByTestId('il-verdict');
  await expect(verdict).toHaveAttribute('data-kind', 'approved');
  // 44%, not the 91% its own Gate 3 row shows: the rate quoted is the shipped
  // file's, measured at the value the search landed on.
  await expect(verdict).toContainText('✓ APPROVED — 44%');
  await expect(page.getByTestId('il-stamp-raw')).toHaveText(
    '0.44 vs panel after the Judge throttled the boss to 0.71 (2 steps)',
  );
  await expect(page.locator('.il-stamp-plain')).toHaveText('Metronome II is fair once the Judge eased it off');
  // The Judge's own status line, in its own register — no spinner, nothing thinking.
  await expect(page.getByTestId('il-status-trial')).toHaveText('✓ approved Metronome II');

  // ----------------------------------------------- the diff that actually ships
  const shipped = page.getByTestId('il-shipped');
  await expect(shipped).toBeVisible();
  await expect(page.getByTestId('il-shipped-head')).toContainText('throttle 1.00 → 0.71');
  await expect(page.getByTestId('il-shipped-head')).toContainText('applied to the file above');
  const shippedDiff = page.getByTestId('il-shipped-diff');
  // The block the harness appends, as added lines — including the line that says
  // who wrote it, which is the point of showing this diff at all.
  await expect(shippedDiff).toContainText('+// ---- calibrated by the Judge');
  await expect(shippedDiff).toContainText('+const THROTTLE = 0.71;');
  await expect(shippedDiff).toContainText('-export function decide(view, mem) {');


  // ------------------------------------------------ nothing on this panel is cut
  // The strip used to live inside `.il-gates`, a ~40 px scroller, and the winning
  // `✓ throttle 0.71` row was sliced in half by its bottom edge — which reads as a
  // rendering bug in the one place the product is claiming rigour. It now has its
  // own block that sizes to its content, so this asserts the geometry rather than
  // the markup: every line of the strip inside its box, the box not scrolling, and
  // the stamp with both of its sentences still inside the panel.
  const fit = await page.evaluate(() => {
    const box = document.querySelector('[data-testid="il-cals"]') as HTMLElement | null;
    const panel = document.querySelector('[data-testid="il-beat-trial"]') as HTMLElement | null;
    const stamp = document.querySelector('[data-testid="il-verdict"]') as HTMLElement | null;
    if (box === null || panel === null || stamp === null) return null;
    const b = box.getBoundingClientRect();
    const p = panel.getBoundingClientRect();
    const lines = Array.from(box.querySelectorAll<HTMLElement>('.il-cal-head, .il-cal-step, .il-cal-note'));
    const clipped = lines.filter((line) => {
      const r = line.getBoundingClientRect();
      return r.top < b.top - 0.5 || r.bottom > b.bottom + 0.5 || r.bottom > p.bottom;
    }).length;
    return {
      lines: lines.length,
      clipped,
      boxScrolls: box.scrollHeight - box.clientHeight,
      stampInside: stamp.getBoundingClientRect().bottom <= p.bottom + 0.5,
      gatesInside: box.closest('.il-gates') === null,
    };
  });
  // head + two steps + footnote.
  expect(fit).toMatchObject({ lines: 4, clipped: 0, boxScrolls: 0, stampInside: true, gatesInside: true });
  // The finished meter stands down for the strip: `200 / 200` describes the Coder's
  // file only, and each step simulated another 200 with no bar of its own.
  await expect(page.getByTestId('il-beat-trial')).toHaveAttribute('data-calibrated', '1');
  await expect(page.locator('.il-meter-wrap')).toBeHidden();

  const state = await page.evaluate(() => window.__rematch?.interlude?.state);
  expect(state?.calibrations.map((c) => c.pressure)).toEqual([0.5, 0.71]);
  expect(state?.pressure).toBe(0.71);
  expect(state?.calibratedDiff).toBe(true);
  expect(state?.panelRate).toBe(0.44);
  // Not measured during calibration, so not quoted: the Mimic rate on screen would
  // otherwise be the pre-calibration file's.
  expect(state?.mimicRate).toBe(null);

  await page.getByTestId('il-root').screenshot({ path: `${ARTIFACTS}interlude-calibration.png` });
  await page.getByTestId('il-beat-trial').screenshot({ path: `${ARTIFACTS}interlude-calibration-trial.png` });
  await page.getByTestId('il-beat-rewrite').screenshot({ path: `${ARTIFACTS}interlude-calibration-shipped.png` });

  expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
});
