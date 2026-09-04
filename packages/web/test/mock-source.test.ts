/**
 * The mock event source — the interlude's demo floor.
 *
 * `?agent=mock` is what plays on a laptop with no server, no API key and no network,
 * so its script is not decoration: if the ordering is wrong, or the "approved"
 * strategy is not a real strategy, the fallback demo lies. These tests pin the three
 * things the UI and the game depend on:
 *
 * 1. The event sequence is spec §6.3's loop with exactly one rejection.
 * 2. The `done` result carries a real, loadable `strategy.js` whose `meta.name` is
 *    what the HUD will show in Round 2.
 * 3. `speed` scales the whole thing, and an abort stops it without inventing an
 *    ending the caller did not ask for.
 */
import { CONSTANTS } from '@rematch/contract';
import { ENGINE_CONSTANTS, type ReplaySummary } from '@rematch/engine';
import { describe, expect, it } from 'vitest';

import { isRewriteEvent, type RewriteEvent } from '../src/interlude/events.ts';
import {
  APPROVED_META,
  APPROVED_SOURCE,
  ATTEMPT1_META,
  MATCH_BATCH,
  buildMockScript,
  mockAnalysis,
  mockAnalysisProse,
  mockSource,
  scriptDuration,
} from '../src/interlude/mock.ts';
import type { RewriteRequest } from '../src/interlude/source.ts';

/** A `ReplaySummary` shaped like a real camper's round, for the canned analysis. */
function summaryFixture(overrides: Partial<ReplaySummary> = {}): ReplaySummary {
  const heat = new Array<number>(64).fill(0.004);
  // The bottom-left corner, which is cell (row 7, col 0) = index 56.
  heat[56] = 0.31;
  heat[57] = 0.12;
  return {
    seed: 424_242,
    strategy: { name: 'Cornerbreaker', rationale: 'I slam the corner you hide in.', version: 1 },
    outcome: 'playerWon',
    durations: { ticks: 1980, seconds: 33, firstBossHitTick: 96, firstPlayerHitTick: 340 },
    player: { hpStart: ENGINE_CONSTANTS.player.hp, hpEnd: 3, dashes: 11, shots: 274, damageTaken: 2 },
    boss: {
      hpStart: ENGINE_CONSTANTS.boss.hp,
      hpEnd: 0,
      damageTaken: ENGINE_CONSTANTS.boss.hp,
      primitives: { move: 1400, burst: 18, charge: 0, slam: 9, spawn: 4 },
      minionsSpawned: 4,
      damageToMinions: 12,
    },
    history: {
      playerPosHeat: heat,
      playerDashDirs: [1, 0, 2, 1, 6, 1, 0, 0],
      playerShotsDuring: { move: 190, burst: 44, charge: 0, slam: 33, spawn: 7 },
    },
    contract: { violations: 0, strategyKilled: false, droppedEvents: 0 },
    timeline: [
      { tick: 30, kind: 'playerShot' },
      { tick: 96, kind: 'bossHit' },
      { tick: 140, kind: 'playerDash', detail: 4 },
      { tick: 300, kind: 'bossSlamStart' },
      { tick: 340, kind: 'playerHit' },
      { tick: 1980, kind: 'outcome', detail: 'playerWon' },
    ],
    timelineTotal: 712,
    ...overrides,
  } as ReplaySummary;
}

function requestFixture(overrides: Partial<RewriteRequest> = {}): RewriteRequest {
  const summary = overrides.summary ?? summaryFixture();
  return {
    round: 2,
    summary,
    prevSource: 'export const meta = { name: "Cornerbreaker", rationale: "x", version: 1 };\nexport function init() { return {}; }\nexport function decide() { return { type: "idle" }; }\n',
    prevMeta: summary.strategy,
    seed: 3_221_225_473,
    ...overrides,
  };
}

/** Drive the source to completion at a speed that makes the delays negligible. */
async function run(options: { speed?: number; req?: RewriteRequest; signal?: AbortSignal } = {}): Promise<RewriteEvent[]> {
  const events: RewriteEvent[] = [];
  const source = mockSource({ speed: options.speed ?? 2000 });
  const controller = new AbortController();
  await source(options.req ?? requestFixture(), (e) => void events.push(e), options.signal ?? controller.signal);
  return events;
}

describe('buildMockScript', () => {
  it('emits every event type in the union', async () => {
    const types = new Set((await run()).map((e) => e.type));
    expect([...types].sort()).toEqual(
      [
        'analysis.delta',
        'analysis.done',
        'done',
        'replay',
        'rewrite.delta',
        'rewrite.done',
        'trial.gate',
        'trial.progress',
        'verdict',
      ].sort(),
    );
    // `fallback` is deliberately absent: the mock always reaches an approval, so the
    // AC 5 banner is exercised by the deadline path in `app.ts`, not by the script.
    expect(types.has('fallback')).toBe(false);
  });

  it('every event survives JSON, like the SSE frames it stands in for', async () => {
    for (const event of await run()) {
      const round = JSON.parse(JSON.stringify(event)) as unknown;
      expect(isRewriteEvent(round)).toBe(true);
      expect(round).toEqual(event);
    }
  });

  it('plays spec §6.3: replay, analysis, then coder → gates → verdict per attempt', async () => {
    const events = await run();

    expect(events[0]?.type).toBe('replay');
    expect(events.at(-1)?.type).toBe('done');

    // Beat order is monotonic per attempt: no gate before its code, no verdict
    // before its gates.
    const order = events.map((e) => e.type);
    expect(order.indexOf('analysis.delta')).toBeGreaterThan(order.indexOf('replay'));
    expect(order.indexOf('analysis.done')).toBeGreaterThan(order.indexOf('analysis.delta'));
    expect(order.indexOf('rewrite.delta')).toBeGreaterThan(order.indexOf('analysis.done'));
    expect(order.indexOf('rewrite.done')).toBeGreaterThan(order.indexOf('rewrite.delta'));
    expect(order.indexOf('trial.gate')).toBeGreaterThan(order.indexOf('rewrite.done'));
    expect(order.indexOf('verdict')).toBeGreaterThan(order.indexOf('trial.gate'));
  });

  it('writes three candidates per attempt and rejects all three of attempt 1', async () => {
    const events = await run();
    const verdicts = events.filter((e): e is Extract<RewriteEvent, { type: 'verdict' }> => e.type === 'verdict');

    // Three per-candidate verdicts per attempt, then one attempt-level verdict with
    // no `candidate` — the only one a K-unaware client sees.
    const perCandidate = verdicts.filter((v) => v.candidate !== undefined);
    const perAttempt = verdicts.filter((v) => v.candidate === undefined);
    expect(perCandidate.map((v) => [v.attempt, v.candidate, v.approved])).toEqual([
      [1, 0, false],
      [1, 1, false],
      [1, 2, false],
      [2, 0, false],
      [2, 1, true],
      [2, 2, false],
    ]);
    expect(perCandidate.every((v) => v.candidates === 3)).toBe(true);
    expect(perAttempt).toHaveLength(2);
    expect(perAttempt[0]).toMatchObject({ attempt: 1, approved: false });
    expect(perAttempt[1]).toMatchObject({ attempt: 2, approved: true });

    // The three aim points bracket the band, which is what the retry interpolates
    // inside: one below it, two above.
    const panels = perCandidate.filter((v) => v.attempt === 1).map((v) => v.panel);
    expect(panels).toEqual([0.22, 0.55, 0.91]);

    // Every rejection is quantitative on both of spec §6.2's assertions: those
    // sentences are the Coder's only feedback and the player's only proof.
    const worst = perCandidate.find((v) => v.attempt === 1 && v.candidate === 2)?.reason ?? '';
    expect(worst).toContain('0.91 vs panel');
    expect(worst).toContain('too hard');
    expect(worst).toContain('0.35–0.50');
    expect(worst).toContain('round 2');
    expect(worst).toContain('0.41 vs Mimic');
    expect(worst).toMatch(/0\.70/);
    expect(perCandidate.find((v) => v.attempt === 1 && v.candidate === 0)?.reason).toContain('too easy');

    const gates = events.filter((e): e is Extract<RewriteEvent, { type: 'trial.gate' }> => e.type === 'trial.gate');
    // Each candidate stops at its first failure: 1, 2, 3 and no Gate 4 unless it passed.
    for (const candidate of [0, 1, 2]) {
      expect(gates.filter((g) => g.attempt === 1 && g.candidate === candidate).map((g) => g.gate.gate)).toEqual([1, 2, 3]);
    }
    expect(gates.filter((g) => g.attempt === 2 && g.candidate === 1).map((g) => g.gate.gate)).toEqual([1, 2, 3, 4]);
    // Five Gate 3 rejections in all, and nothing else ever fails.
    const failing = gates.filter((g) => !g.gate.ok);
    expect(failing).toHaveLength(5);
    expect(failing.every((g) => g.gate.gate === 3 && g.gate.name === 'balance')).toBe(true);
  });

  it('reports Gate 3 in batches: 0, then every batch, then the total', async () => {
    const progress = (await run()).filter(
      (e): e is Extract<RewriteEvent, { type: 'trial.progress' }> => e.type === 'trial.progress',
    );

    for (const attempt of [1, 2]) for (const candidate of [0, 1, 2]) {
      const series = progress.filter((p) => p.attempt === attempt && p.candidate === candidate);
      // The live simulator batches ~20 callbacks per gate; two events at the ends
      // would leave the meter with nothing to show for a second of work. One series
      // per candidate: the meter is redrawn for each file the harness picks up.
      expect(series.length).toBe(200 / MATCH_BATCH + 1);
      expect(series[0]).toMatchObject({ matchesDone: 0, matchesTotal: 200, gate: 'balance' });
      expect(series.at(-1)).toMatchObject({ matchesDone: 200, matchesTotal: 200 });

      // Monotonic, one total throughout, and never past the end.
      let previous = -1;
      for (const step of series) {
        expect(step.matchesTotal).toBe(200);
        expect(step.matchesDone).toBeGreaterThan(previous);
        expect(step.matchesDone).toBeLessThanOrEqual(step.matchesTotal);
        previous = step.matchesDone;
      }
    }
  });

  it('streams prose, not JSON — and keeps the whole reply on `analysis.done`', async () => {
    const events = await run();
    const streamed = events
      .filter((e): e is Extract<RewriteEvent, { type: 'analysis.delta' }> => e.type === 'analysis.delta')
      .map((e) => e.delta)
      .join('');
    const done = events.find(
      (e): e is Extract<RewriteEvent, { type: 'analysis.done' }> => e.type === 'analysis.done',
    );

    // Spec §2.2's Analysis beat is a typewriter for a human. The player must never
    // watch `{"observations": [` scroll past.
    expect(streamed).not.toContain('```');
    expect(streamed).not.toContain('"observations"');
    expect(streamed).toBe(mockAnalysisProse(done!.analysis));
    // The JSON half is kept for the run log, not thrown away.
    expect(done?.raw).toContain('```json');
    expect(done?.raw).toContain('"playerArchetype"');
    expect(done?.raw?.startsWith(streamed)).toBe(true);
  });

  it('names each attempt with the `meta` of the file it just streamed', async () => {
    const events = await run();
    const dones = events.filter(
      (e): e is Extract<RewriteEvent, { type: 'rewrite.done' }> => e.type === 'rewrite.done',
    );

    expect(dones).toHaveLength(6);
    expect(dones.map((d) => [d.attempt, d.candidate, d.dial])).toEqual([
      [1, 0, 'conservative'],
      [1, 1, 'balanced'],
      [1, 2, 'aggressive'],
      [2, 0, 'conservative'],
      [2, 1, 'balanced'],
      [2, 2, 'aggressive'],
    ]);
    // The Coder's suffix rule, so three candidates cannot collide on one boss name.
    expect(dones.slice(0, 3).map((d) => d.meta?.name)).toEqual(['Warden I', 'Warden II', 'Warden III']);
    // The one that ships is the fixture's own `meta`, byte for byte.
    expect(dones[4]?.meta).toEqual({ ...APPROVED_META });
    for (const done of dones) {
      expect(done.source).toContain(`name: '${done.meta?.name ?? ''}'`);
      expect(done.source).toContain(done.meta?.rationale ?? '');
    }
  });

  it('streams the code it later shows as a diff, byte for byte', async () => {
    const events = await run();
    for (const attempt of [1, 2]) for (const candidate of [0, 1, 2]) {
      const streamed = events
        .filter(
          (e): e is Extract<RewriteEvent, { type: 'rewrite.delta' }> =>
            e.type === 'rewrite.delta' && e.attempt === attempt && e.candidate === candidate,
        )
        .map((e) => e.delta)
        .join('');
      const done = events.find(
        (e): e is Extract<RewriteEvent, { type: 'rewrite.done' }> =>
          e.type === 'rewrite.done' && e.attempt === attempt && e.candidate === candidate,
      );
      // If these two ever disagree, the player watched one file being written and
      // was then shown a diff of a different one.
      expect(streamed).toBe(done?.source);
      expect(done?.diff).toMatch(/^--- strategy\.js \(previous\)\n\+\+\+ strategy\.js \(attempt \d\)\n@@ /);
      expect(done?.diff).toMatch(/\n\+/);
      expect(done?.diff).toMatch(/\n-/);
    }
  });

  it("ships a real strategy: the approved source is the harness's round-2 fixture", async () => {
    const done = (await run()).at(-1);
    expect(done?.type).toBe('done');
    if (done?.type !== 'done' || !done.result.approved) throw new Error('the mock must approve');

    expect(done.result.source).toBe(APPROVED_SOURCE);
    // The shape the sandbox requires (spec §4.1). Nothing else may be exported.
    expect(done.result.source).toContain('export const meta');
    expect(done.result.source).toMatch(/export function init\(/);
    expect(done.result.source).toMatch(/export function decide\(/);
    // Gate 1's forbidden identifiers must not be in the file the mock claims passed.
    for (const forbidden of ['Date', 'fetch(', 'Math.random', 'globalThis', 'eval(', 'import ']) {
      expect(done.result.source).not.toContain(forbidden);
    }
    // `meta` in the result must be the `meta` in the file: the HUD reads the
    // sandbox's, and the interlude promised this one.
    expect(done.result.meta).toEqual({ ...APPROVED_META });
    expect(done.result.source).toContain(`name: '${APPROVED_META.name}'`);
    expect(done.result.meta.name.length).toBeLessThanOrEqual(CONSTANTS.limits.metaNameMaxChars);

    expect(done.result.attempts).toHaveLength(2);
    expect(done.result.attempts[0]?.approved).toBe(false);
    expect(done.result.attempts[1]?.approved).toBe(true);
    expect(done.result.attempts[0]?.reason).toContain('too hard');
    // Every attempt logs all three files it wrote, and which one it settled on.
    expect(done.result.attempts[0]?.candidates).toHaveLength(3);
    expect(done.result.attempts[0]?.chosen).toBe(1);
    expect(done.result.attempts[1]?.chosen).toBe(1);
    expect(done.result.attempts[1]?.candidates?.filter((c) => c.approved)).toHaveLength(1);
    expect(done.result.analysis.observations.length).toBeGreaterThanOrEqual(3);
  });

  it('lasts about 25 seconds at speed 1, inside the AC 5 budget', () => {
    const total = scriptDuration(buildMockScript(requestFixture()));
    expect(total).toBeGreaterThan(20_000);
    expect(total).toBeLessThan(30_000);
    // The interlude's own deadline is 45 s; the mock must never be the thing that
    // trips it.
    expect(total).toBeLessThan(45_000);
  });
});

describe('mockAnalysis', () => {
  it('quotes this round: the hottest cell, the dash bias and the real counts', () => {
    const summary = summaryFixture();
    const analysis = mockAnalysis(requestFixture({ summary }));

    const joined = analysis.observations.join(' ');
    expect(joined).toContain('bottom-left corner');
    expect(joined).toContain('11 times');
    expect(joined).toContain('274 shots');
    expect(joined).toContain('33.0s');
    // Bin 4 dominates the fixture's dash rose, which is -x: "left".
    expect(joined).toContain('left;');
    expect(analysis.playerArchetype).toBe('camper');
    expect(analysis.counterPlan).toContain('bottom-left corner');
  });

  it('reads a different player differently', () => {
    // Spread out, mildly centre-weighted, and dashing constantly: a rusher, and the
    // hottest cell is the middle rather than a corner.
    const spread = new Array<number>(64).fill(0.014);
    spread[27] = 0.1;
    const rusher = mockAnalysis(
      requestFixture({
        summary: summaryFixture({
          history: {
            playerPosHeat: spread,
            playerDashDirs: [4, 5, 3, 2, 1, 1, 2, 2],
            playerShotsDuring: { move: 100, burst: 10, charge: 0, slam: 4, spawn: 1 },
          },
          player: { hpStart: 6, hpEnd: 1, dashes: 20, shots: 150, damageTaken: 5 },
        }),
      }),
    );
    expect(rusher.playerArchetype).toBe('rusher');
    expect(rusher.observations.join(' ')).toContain('the middle of the arena');
  });
});

describe('mockSource', () => {
  it('scales every delay by `speed`', async () => {
    const script = [
      { delay: 1000, event: { type: 'analysis.delta', delta: 'a' } as RewriteEvent },
      { delay: 1000, event: { type: 'analysis.delta', delta: 'b' } as RewriteEvent },
    ];
    const started = Date.now();
    const events: RewriteEvent[] = [];
    await mockSource({ speed: 100, script })(requestFixture(), (e) => void events.push(e), new AbortController().signal);
    const elapsed = Date.now() - started;

    expect(events).toHaveLength(2);
    // 2 s of script at 100× is 20 ms. Generous upper bound — this asserts the
    // division happens at all, not the timer's precision.
    expect(elapsed).toBeLessThan(600);
  });

  it('stops on abort and invents no ending', async () => {
    const controller = new AbortController();
    const events: RewriteEvent[] = [];
    const done = mockSource({ speed: 50 })(
      requestFixture(),
      (e) => {
        events.push(e);
        // Cancel as soon as the analysis starts, like the 45 s deadline would.
        if (e.type === 'analysis.delta') controller.abort();
      },
      controller.signal,
    );
    await expect(done).resolves.toBeUndefined();

    expect(events.at(-1)?.type).toBe('analysis.delta');
    // Nothing after the abort — in particular no `fallback` and no `done`. The
    // caller aborted, so the caller already knows what it is going to show.
    expect(events.some((e) => e.type === 'done')).toBe(false);
    expect(events.some((e) => e.type === 'fallback')).toBe(false);
  });

  it('accepts a script as a function of the request', async () => {
    const events: RewriteEvent[] = [];
    await mockSource({
      speed: 1000,
      script: (req) => [{ delay: 0, event: { type: 'replay', summary: req.summary, round: req.round } }],
    })(requestFixture({ round: 4 }), (e) => void events.push(e), new AbortController().signal);

    expect(events).toEqual([{ type: 'replay', summary: expect.anything(), round: 4 }]);
  });

  it('quotes the right fairness band for a later round', async () => {
    const events = await run({ req: requestFixture({ round: 4 }) });
    const rejected = events.find((e): e is Extract<RewriteEvent, { type: 'verdict' }> => e.type === 'verdict' && !e.approved);
    expect(rejected?.reason).toContain('0.50–0.65');
    expect(rejected?.reason).toContain('round 4');
  });
});
