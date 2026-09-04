/**
 * The boss has to keep playing — the regression test for a real playtest report.
 *
 * "After winning Round 1 the interlude ran and the Round 2 boss just stood still in
 * a corner of the screen for the whole round."
 *
 * It did. `round2-candidate.js` drifted onto the centre of the player's hottest heat
 * cell and returned `idle` from then on: the heat map never decays, so the "habit"
 * was a cell the player had left, and with the player outside the slam box and
 * outside the burst window every other branch declined too. Against this very input
 * log that was 219 idle ticks out of 510 and one motionless run of 263 ticks — 4.4
 * seconds of a boss that reads as crashed.
 *
 * Nothing in the existing suite could see it. `idle` is a legal action, it costs no
 * cooldown and it is not a contract violation; Gate 3 only reads the win rate, which
 * stayed inside the band (in fact the strategy was *only* in band because standing
 * still made it easy to shoot — the fix moved it from 0.38 to 0.45 against the
 * panel). `interlude.spec.ts` asserts Round 2 reaches tick 30, which a frozen boss
 * does perfectly well.
 *
 * So this spec asserts the three things a watchable boss owes the player, against a
 * *moving* player — the recorded human log, replayed into Round 2 through
 * `driveWith`, because a stationary player is exactly the case the stall does not
 * reproduce in:
 *
 *   1. it travels (the demo's floor: > 100 px in the first 300 ticks),
 *   2. it is never motionless for longer than one telegraph plus slack,
 *   3. it is not failing quietly — violations under 5% of ticks, and no `decide`
 *      timeouts or memory failures at all.
 *
 * (3) is the sandbox half of the same question: an engine that answers a runner
 * failure with an idle tick produces the identical picture, so the test has to be
 * able to tell the two apart. `window.__rematch.runnerStats()` is what does that,
 * and it is the same readout the HUD's diagnostics line shows a human.
 */
import { expect, test } from '@playwright/test';

import { armReplay, loadFixture, waitForRound } from './helpers.ts';

const fixture = loadFixture();

/** Ticks sampled in Round 2. 600 = 10 s, twice the window the report described. */
const TICKS = 600;
/** The brief's floor, over the first 300 ticks. */
const MIN_TRAVEL_PX = 100;
const TRAVEL_WINDOW = 300;
/**
 * Longest run of ticks the boss may stay motionless.
 *
 * A boss legitimately stands still while a telegraph runs — 40 ticks for a slam,
 * which is the longest one — and `decide` is not even called during it. 90 ticks
 * (1.5 s) leaves room for a slam bracketed by a burst on either side and still
 * rejects the 263-tick stall this spec exists for.
 */
const MAX_STILL_TICKS = 90;

type Probe = {
  strategy: string;
  round: number;
  ticks: number;
  travelPx: number;
  travelAt300: number;
  longestStill: number;
  violations: number;
  strategyKilled: boolean;
  idleActions: number;
  samples: Array<{ tick: number; x: number; y: number; travel: number; violations: number }>;
  runner: {
    calls: number;
    failures: Record<string, number | undefined>;
    worstStreak: number;
    p50Ms: number;
    p99Ms: number;
  } | null;
};

test('the Round 2 boss keeps playing after the mock interlude', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));

  // Round 1, won by the recorded log, then the mock interlude at 20x.
  await page.goto(`/?seed=${fixture.sessionSeed}&autostart=1&agent=mock&speed=20&autofight=0`);
  await waitForRound(page);
  await armReplay(page, fixture.log);
  await page.evaluate(() => window.__rematch?.fastForward());
  await expect(page.getByTestId('il-root')).toBeVisible();
  await page.waitForFunction(() => window.__rematch?.interlude?.state.done === true, undefined, { timeout: 30_000 });
  await page.getByTestId('il-fight').click();
  await expect.poll(async () => page.evaluate(() => window.__rematch?.round ?? 0)).toBe(2);

  // The strategy the interlude approved really is what Round 2 loaded.
  await expect(page.locator('.hud-strategy .name')).toHaveText('Warden');

  // Now replay the same human log *into Round 2*: same seed, same Warden, a player
  // that moves. `driveWith` restarts the round on the monotonic sandbox clock, so
  // the numbers below are the same on every machine.
  await armReplay(page, fixture.log);

  const probe: Probe = await page.evaluate((ticks) => {
    const api = window.__rematch!;
    const samples: Probe['samples'] = [];
    let travel = 0;
    let travelAt300 = 0;
    let still = 0;
    let longestStill = 0;
    let idleActions = 0;
    let px = api.state!.boss.x;
    let py = api.state!.boss.y;

    for (let i = 0; i < ticks; i += 1) {
      if (api.fastForward(1) === 0) break;
      const s = api.state!;
      const step = Math.hypot(s.boss.x - px, s.boss.y - py);
      travel += step;
      if (step < 0.01) {
        still += 1;
        if (still > longestStill) longestStill = still;
      } else {
        still = 0;
      }
      px = s.boss.x;
      py = s.boss.y;
      if (s.boss.lastAction === 'idle') idleActions += 1;
      if (s.tick === 300) travelAt300 = travel;
      if (s.tick % 60 === 0) {
        samples.push({
          tick: s.tick,
          x: Math.round(s.boss.x),
          y: Math.round(s.boss.y),
          travel: Math.round(travel),
          violations: s.violations,
        });
      }
    }

    const state = api.state!;
    const runner = api.runnerStats();
    return {
      strategy: state.strategy.name,
      round: api.round,
      ticks: state.tick,
      travelPx: travel,
      travelAt300: travelAt300 === 0 ? travel : travelAt300,
      longestStill,
      violations: state.violations,
      strategyKilled: state.strategyKilled,
      idleActions,
      samples,
      runner:
        runner === null
          ? null
          : {
              calls: runner.calls,
              failures: runner.failures,
              worstStreak: runner.worstStreak,
              p50Ms: runner.p50Ms,
              p99Ms: runner.p99Ms,
            },
    };
  }, TICKS);

  const where = JSON.stringify(probe.samples);

  expect(probe.round).toBe(2);
  expect(probe.strategy).toBe('Warden');
  expect(probe.ticks, 'Round 2 did not simulate').toBeGreaterThan(TRAVEL_WINDOW);

  // 1. It moves.
  expect(probe.travelAt300, `boss travel in the first ${TRAVEL_WINDOW} ticks — ${where}`).toBeGreaterThan(
    MIN_TRAVEL_PX,
  );

  // 2. It never freezes. This is the assertion the reported bug fails: it stood
  //    still for 263 consecutive ticks.
  expect(probe.longestStill, `longest motionless run of ticks — ${where}`).toBeLessThanOrEqual(MAX_STILL_TICKS);

  // 3. It is not failing quietly. A frozen boss whose strategy is being killed by
  //    the sandbox looks identical on screen, so both halves are checked.
  expect(probe.violations, `violations over ${probe.ticks} ticks`).toBeLessThan(probe.ticks * 0.05);
  expect(probe.strategyKilled).toBe(false);
  expect(probe.runner).not.toBeNull();
  expect(probe.runner?.failures, 'a healthy strategy fails no decide call').toEqual({});
  expect(probe.runner?.worstStreak).toBe(0);
  expect(probe.runner?.calls ?? 0).toBeGreaterThan(TRAVEL_WINDOW / 2);

  expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
});

/**
 * The same question for live play, where the sandbox runs on `performance.now` and
 * the relaxed live budget (`LIVE_BUDGET_FACTOR` in `game/strategy.ts`) rather than
 * on the monotonic replay clock. This is the leg that would catch a `decide` deadline
 * set too tight for a real browser: the strategy is the shipped Round 1 boss and it
 * must not fail a single call.
 */
test('live play never trips the decide deadline', async ({ page }) => {
  await page.goto('/?autostart=1');
  await waitForRound(page);

  const live = await page.evaluate(async () => {
    const api = window.__rematch!;
    const start = api.state!.tick;
    // Real frames, real clock: rAF drives the loop and the sandbox is timed by
    // `performance.now`, exactly as a player's tab is.
    while ((api.state?.tick ?? 0) - start < 240 && api.state?.outcome === 'playing') {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    }
    const runner = api.runnerStats();
    return {
      ticks: (api.state?.tick ?? 0) - start,
      violations: api.state?.violations ?? 0,
      killed: api.state?.strategyKilled ?? false,
      failures: runner?.failures ?? null,
      p50Ms: runner?.p50Ms ?? -1,
      p99Ms: runner?.p99Ms ?? -1,
      calls: runner?.calls ?? 0,
    };
  });

  expect(live.ticks).toBeGreaterThan(120);
  expect(live.calls).toBeGreaterThan(60);
  expect(live.failures, `decide failures in live play (p50 ${live.p50Ms}ms, p99 ${live.p99Ms}ms)`).toEqual({});
  expect(live.violations).toBe(0);
  expect(live.killed).toBe(false);
});
