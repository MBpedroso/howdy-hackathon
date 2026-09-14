/**
 * THE THROTTLE — the injected wrapper, the search, and the loop that drives them.
 *
 * Four levels, and they are deliberately separate:
 *
 *  - `withThrottle` is text, and the text has to be *legal*. The block is injected
 *    into a file nobody reviewed, so the tests append it to a real shipped fallback
 *    and run the real Gate 1 and Gate 2 over the result. The first draft of this
 *    feature asked the *Coder* for the knob and it did not survive one live run
 *    (see `src/calibrate.ts`); the second one has to survive the gates on paper
 *    before it is trusted in a loop.
 *  - the hold arithmetic is the monotonicity guarantee, stated as four numbers.
 *  - `nextThrottle` is the policy, and it is a pure function of the measured
 *    numbers. Feeding it panel rates and asserting the sequence it asks for is the
 *    only way to test a search without waiting for 200 simulated matches a step.
 *  - the loop tests are the real thing: a real too-hard fixture, real gates, and a
 *    mock only where the model is.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runGates } from '@rematch/harness';
import { staticCheck } from '@rematch/contract';
import {
  CALIBRATION_MAX_STEPS,
  THROTTLE_BASE_TICKS,
  THROTTLE_MAX,
  THROTTLE_MIN,
  canThrottle,
  clampThrottle,
  fairMiss,
  formatThrottle,
  mockProvider,
  nextThrottle,
  readThrottle,
  recorder,
  rewrite,
  throttleHoldTicks,
  withThrottle,
  type Analysis,
  type LLMProvider,
  type RewriteEvent,
  type ThrottlePoint,
} from '../src/index.ts';
import { asAnalystReply, asCoderReply, cannedSummary, readAgentFixture, readGood } from './helpers.ts';

/** Round 2's band, which every policy case below is judged against. */
const BAND: readonly [number, number] = [0.35, 0.5];

const ANALYSIS: Analysis = {
  observations: [
    'Lived in cell 63 (x=750, y=750) for 93% of the round.',
    'Never dashed in 1301 ticks.',
    'Fired 163 shots and took no damage.',
  ],
  playerArchetype: 'camper',
  counterPlan: 'Put every slam on the bottom-right corner and hold mid range so the corner stops being safe.',
};

/** The same reduced count `loop.test.ts` uses: the verdicts are the spec's, the wall clock is not. */
const MATCHES = 60;

/** A real shipped boss, to inject the block into. Nothing in `agents` may edit it. */
const FALLBACK = readFileSync(
  new URL('../../server/fallback/round2/metronome.js', import.meta.url),
  'utf8',
);

function eventsOf<T extends RewriteEvent['type']>(
  events: readonly RewriteEvent[],
  type: T,
): Extract<RewriteEvent, { type: T }>[] {
  return events.filter((e): e is Extract<RewriteEvent, { type: T }> => e.type === type);
}

describe('the hold arithmetic', () => {
  it('is zero at 1 and strictly longer as the throttle falls', () => {
    // The monotonicity guarantee, as four numbers: `hold = (1/p - 1) x BASE`.
    expect(throttleHoldTicks(1)).toBe(0);
    expect(throttleHoldTicks(0.5)).toBe(THROTTLE_BASE_TICKS);
    expect(throttleHoldTicks(0.5)).toBe(45);
    expect(throttleHoldTicks(0.25)).toBe(135);
    expect(throttleHoldTicks(0.1)).toBe(405);
    let previous = -1;
    for (const p of [1, 0.8, 0.62, 0.5, 0.354, 0.25, 0.177, 0.125, 0.1]) {
      const hold = throttleHoldTicks(p);
      expect(hold).toBeGreaterThan(previous);
      previous = hold;
    }
  });

  it('clamps and formats the way the file is written', () => {
    expect(clampThrottle(10)).toBe(THROTTLE_MAX);
    expect(clampThrottle(0.01)).toBe(THROTTLE_MIN);
    expect(formatThrottle(1)).toBe('1.0');
    expect(formatThrottle(0.5)).toBe('0.5');
    // Quantized to three decimals: the value in the file and the value in the run
    // log have to be the same number, or the artifact is not reproducible.
    expect(formatThrottle(Math.sqrt(0.25 * 0.5))).toBe('0.354');
  });
});

describe('withThrottle', () => {
  it('wraps a real shipped fallback and leaves exactly three exports', () => {
    expect(canThrottle(FALLBACK)).toBe(true);
    const out = withThrottle(FALLBACK, 0.5) as string;
    // The Coder's own functions are renamed, not deleted, and not exported.
    expect(out).toContain('function __initRaw()');
    expect(out).toContain('function __decideRaw(view, mem)');
    expect(out).not.toContain('export function __');
    expect((out.match(/^export /gm) ?? []).length).toBe(3);
    expect(readThrottle(out)).toBe(0.5);
    // Everything above the block is the original file, bar the two renames.
    const restored = out
      .slice(0, out.indexOf('// ---- calibrated by the Judge'))
      .replace('function __initRaw(', 'export function init(')
      .replace('function __decideRaw(', 'export function decide(');
    expect(restored.trim()).toBe(FALLBACK.trim());
  });

  it('is idempotent: re-throttling replaces the constant, it does not nest', () => {
    const once = withThrottle(FALLBACK, 0.5) as string;
    const twice = withThrottle(once, 0.25) as string;
    expect(readThrottle(twice)).toBe(0.25);
    expect((twice.match(/calibrated by the Judge/g) ?? []).length).toBe(1);
    expect((twice.match(/^const THROTTLE = /gm) ?? []).length).toBe(1);
    expect((twice.match(/__decideRaw/g) ?? []).length).toBe(once.match(/__decideRaw/g)?.length);
    // Two throttles of the same file differ by exactly the one constant.
    expect(twice.replace('const THROTTLE = 0.25;', 'const THROTTLE = 0.5;')).toBe(once);
  });

  it('declines a file whose init/decide are not plain exported declarations', () => {
    const arrow = `export const meta = { name: 'A', rationale: 'r', version: 1 };\nexport const init = () => ({});\nexport const decide = () => ({ type: 'idle' });\n`;
    expect(canThrottle(arrow)).toBe(false);
    expect(withThrottle(arrow, 0.5)).toBeUndefined();
    // Two decide declarations: which one is the boss's is a guess, so it is left alone.
    const twice = `${FALLBACK}\nexport function decide(view, mem) { return { type: 'idle' }; }\n`;
    expect(canThrottle(twice)).toBe(false);
    expect(withThrottle(twice, 0.5)).toBeUndefined();
  });

  it('reads no throttle out of a file that has none', () => {
    expect(readThrottle(FALLBACK)).toBeUndefined();
    expect(readThrottle(readGood('chaser'))).toBeUndefined();
    // Not at column zero, so it is the strategy's own local and not the Judge's.
    expect(readThrottle('  const THROTTLE = 0.5;\n')).toBeUndefined();
  });
});

/**
 * THE BLOCK IS LEGAL — the assertion the first design of this feature did not have.
 *
 * Gate 1 walks the AST before anything executes and Gate 2 calls `decide` on ~500
 * generated states, including every cooldown blocked, the boss in each corner, the
 * player on top of the boss, tick 0 and tick 3599. The injected block is written into
 * a file nobody reviews, so it is checked against both, on a real shipped boss, at
 * every throttle the search can ask for.
 */
describe('the injected block passes the real gates', () => {
  it('passes staticCheck at every throttle the search can reach', () => {
    for (const p of [1, 0.5, 0.354, 0.25, 0.125, 0.1]) {
      const out = withThrottle(FALLBACK, p) as string;
      const check = staticCheck(out);
      if (!check.ok) throw new Error(`throttle ${p}: ${JSON.stringify(check.violations)}`);
      expect(check.ok).toBe(true);
    }
  });

  it('passes Gate 1 and Gate 2 on a real shipped fallback', async () => {
    for (const p of [0.5, 0.1]) {
      const out = withThrottle(FALLBACK, p) as string;
      const run = await runGates(out, { gates: [1, 2] });
      for (const result of run.results) {
        if (!result.ok) throw new Error(`throttle ${p}, gate ${result.gate}: ${result.reason}`);
      }
      expect(run.results.map((r) => [r.gate, r.ok])).toEqual([
        [1, true],
        [2, true],
      ]);
    }
  }, 40_000);

  it('keeps the boss moving, so ACTIVE survives the rest it forces', async () => {
    // The whole reason the held tick returns a straight-leg `move` rather than
    // `idle`: 1.5 s of a motionless boss reads to a player as a crashed game, and
    // Gate 3 rejects it. At throttle 0.1 the boss rests 405 ticks between attacks,
    // which is the worst case the search can produce.
    const out = withThrottle(FALLBACK, 0.1) as string;
    const run = await runGates(out, { gates: [3], gate3: { matches: MATCHES, round: 2 } });
    const gate = run.results[0]!;
    const detail = gate.detail as {
      activity: { longestIdleRun: number; idleFractionP90: number; minSpanPx: number };
      thresholds: { maxIdleRunTicks: number; maxIdleFractionP90: number; minSpanPx: number };
    };
    expect(detail.activity.longestIdleRun).toBeLessThanOrEqual(detail.thresholds.maxIdleRunTicks);
    expect(detail.activity.idleFractionP90).toBeLessThanOrEqual(detail.thresholds.maxIdleFractionP90);
    expect(detail.activity.minSpanPx).toBeGreaterThanOrEqual(detail.thresholds.minSpanPx);
    // …and the only thing it was rejected for is being too easy, which is the
    // throttle working.
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toMatch(/too easy/);
  }, 40_000);
});

/**
 * MONOTONE, MEASURED.
 *
 * This is the property the whole redesign turns on, and the reason the knob is not
 * the Coder's: asked for one, the model wired half its levers to it and the response
 * came back 1.0 → 0.86, 0.5 → 0.90, 0.25 → 0.84
 * (`artifacts/server/rewrite-2026-09-11T18-27-02-444Z.json`). The harness's own
 * throttle has to do better than that, and it is re-measured here on every run rather
 * than quoted from a comment.
 */
describe('the throttle is monotone on a real too-hard boss', () => {
  it('drops the panel rate strictly as the throttle falls', async () => {
    const fixture = readAgentFixture('too-hard-pacer');
    const rates: number[] = [];
    for (const p of [1, 0.5, 0.25]) {
      const source = withThrottle(fixture, p) as string;
      const run = await runGates(source, { gates: [3], gate3: { matches: MATCHES, round: 2 } });
      const detail = run.results[0]!.detail as { panel: { winRate: number } };
      rates.push(detail.panel.winRate);
    }
    // Measured 2026-09-11 on this fixture at 60 matches: 0.75 / 0.41 / 0.00. The
    // assertion is the *shape*, not the three numbers — a seed set is fixed but a
    // future engine change may move them, and what must not change is the direction.
    expect(rates[0]).toBeGreaterThan(0.6);
    expect(rates[1]).toBeLessThan(rates[0]!);
    expect(rates[2]).toBeLessThan(rates[1]!);
    // …and the middle one is the answer the search is about to find.
    expect(rates[1]).toBeGreaterThanOrEqual(BAND[0]);
    expect(rates[1]).toBeLessThanOrEqual(BAND[1]);
  }, 60_000);
});

/**
 * THE SEARCH POLICY, as arithmetic.
 *
 * Every case here is a list of measured points and the one move that follows. The
 * throttle is multiplicative so the search is: ×0.5 to bracket down, geometric mean
 * to bisect — the midpoint in octaves. Downward only, because the throttle has no
 * other direction.
 */
describe('nextThrottle', () => {
  const point = (throttle: number, panel: number, ok?: boolean): ThrottlePoint =>
    ok === undefined ? { throttle, panel } : { throttle, panel, ok };

  it('brackets downwards by half from the Coder\'s own file', () => {
    expect(nextThrottle([point(1, 0.75)], BAND)).toEqual({ kind: 'step', throttle: 0.5, mode: 'bracket' });
    expect(nextThrottle([point(1, 0.75), point(0.5, 0.68)], BAND)).toEqual({
      kind: 'step',
      throttle: 0.25,
      mode: 'bracket',
    });
  });

  it('refuses a boss that is not over the band: the throttle only subtracts', () => {
    expect(nextThrottle([point(1, 0.1)], BAND)).toEqual({ kind: 'stop', reason: 'not-too-hard' });
    expect(nextThrottle([point(1, 0.44)], BAND)).toEqual({ kind: 'stop', reason: 'not-too-hard' });
  });

  it('bisects geometrically once a step lands under the band', () => {
    // sqrt(0.25 x 0.5) = 0.3536 — the midpoint in log2 space, not the arithmetic 0.375.
    expect(nextThrottle([point(1, 0.75), point(0.5, 0.68), point(0.25, 0.1)], BAND)).toEqual({
      kind: 'step',
      throttle: 0.354,
      mode: 'bisect',
    });
  });

  it('stops the moment a step passed every gate', () => {
    expect(nextThrottle([point(1, 0.75), point(0.5, 0.41, true)], BAND)).toEqual({
      kind: 'stop',
      reason: 'passed',
    });
  });

  it('keeps descending when a fair step failed the other assertion', () => {
    // 0.5 is FAIR and was rejected anyway (ADAPTED, or ACTIVE): its rate is right and
    // something else is wrong, so it becomes the new ceiling and the search continues
    // in the one direction it has.
    expect(nextThrottle([point(1, 0.75), point(0.5, 0.41)], BAND)).toEqual({
      kind: 'step',
      throttle: 0.25,
      mode: 'bracket',
    });
  });

  it('gives up after two more steps past the first fair one', () => {
    const points = [point(1, 0.75), point(0.5, 0.41), point(0.25, 0.1), point(0.354, 0.3)];
    expect(nextThrottle(points, BAND)).toEqual({ kind: 'stop', reason: 'fair-exhausted' });
    // …and not before: three points is one extra step, which is still allowed.
    expect(nextThrottle(points.slice(0, 3), BAND)).toMatchObject({ kind: 'step' });
  });

  it('stops on a boss the throttle makes harder, twice', () => {
    // The live PRESSURE failure, in the shape the search sees it: less pressure, a
    // higher rate. Once is inside the 0.03 noise floor of a four-bot mean; twice is a
    // boss whose damage does not come from its attacks.
    const points = [point(1, 0.86), point(0.5, 0.9), point(0.25, 0.95)];
    expect(nextThrottle(points, BAND)).toEqual({ kind: 'stop', reason: 'non-monotone' });
    expect(nextThrottle([point(1, 0.86), point(0.5, 0.88)], BAND)).toMatchObject({ kind: 'step' });
  });

  it('stops when a higher throttle measured easier than a lower one', () => {
    // The inverted bracket: `easy` above `hard` is the same failure the wrong-way
    // counter catches, arriving from the other side.
    expect(nextThrottle([point(1, 0.75), point(0.5, 0.1), point(0.25, 0.9)], BAND)).toEqual({
      kind: 'stop',
      reason: 'non-monotone',
    });
  });

  it(`stops after ${CALIBRATION_MAX_STEPS} steps`, () => {
    const points = [
      point(1, 0.95),
      point(0.9, 0.9),
      point(0.8, 0.85),
      point(0.7, 0.8),
      point(0.6, 0.75),
      point(0.5, 0.7),
      point(0.4, 0.65),
    ];
    expect(points).toHaveLength(CALIBRATION_MAX_STEPS + 1);
    expect(nextThrottle(points, BAND)).toEqual({ kind: 'stop', reason: 'max-steps' });
    expect(nextThrottle(points.slice(0, -1), BAND)).toMatchObject({ kind: 'step' });
  });

  it('stops at the 0.1 floor rather than turning the boss into furniture', () => {
    // 0.125 halves to 0.0625, which clamps back onto a value already measured.
    const walk = [point(1, 0.9), point(0.5, 0.85), point(0.25, 0.8), point(0.125, 0.75)];
    expect(nextThrottle(walk, BAND)).toEqual({ kind: 'step', throttle: 0.1, mode: 'bracket' });
    expect(nextThrottle([...walk, point(0.1, 0.7)], BAND)).toEqual({ kind: 'stop', reason: 'exhausted' });
  });

  it('has nothing to say about nothing', () => {
    expect(nextThrottle([], BAND)).toEqual({ kind: 'stop', reason: 'no-points' });
  });

  it('is a pure function of the numbers: same points, same move', () => {
    const points = [point(1, 0.86), point(0.5, 0.22)];
    const first = nextThrottle(points, BAND);
    for (let i = 0; i < 5; i += 1) expect(nextThrottle(points, BAND)).toEqual(first);
    expect(first).toEqual({ kind: 'step', throttle: 0.707, mode: 'bisect' });
    // The band is an argument, not a constant: one that makes 0.22 fair turns the
    // same two points into a descent rather than a bisection.
    expect(nextThrottle(points, [0.2, 0.3])).toEqual({ kind: 'step', throttle: 0.25, mode: 'bracket' });
  });
});

/**
 * THE TRIGGER.
 *
 * The throttle runs on a too-hard FAIR miss and only on that, and the direction comes
 * out of Gate 3's `detail` rather than out of its sentence — the sentence is the
 * Coder's feedback channel and nothing in the loop is allowed to parse it.
 */
describe('fairMiss', () => {
  const detail = (over: Record<string, unknown> = {}): unknown => ({
    round: 2,
    band: [0.35, 0.5],
    thresholds: { maxIdleRunTicks: 90, maxIdleFractionP90: 0.25, minSpanPx: 56 },
    activity: { longestIdleRun: 1, idleFractionP90: 0.01, minSpanPx: 304 },
    panel: { winRate: 0.75, perBot: [] },
    adapted: { met: false, blocking: false },
    ...over,
  });
  const gate = (over: Record<string, unknown> = {}, ok = false): unknown[] => [
    { gate: 3, name: 'balance', ok, ms: 1, reason: 'unread', detail: detail(over) },
  ];

  it('reports the panel rate and the band for a boss that is only too hard', () => {
    expect(fairMiss(gate() as never)).toEqual({ panel: 0.75, band: [0.35, 0.5] });
  });

  it('declines a boss that is too easy — no rest between attacks adds pressure', () => {
    expect(fairMiss(gate({ panel: { winRate: 0.1, perBot: [] } }) as never)).toBeUndefined();
  });

  it('declines an in-band rate: the rate is not what is wrong with that file', () => {
    expect(fairMiss(gate({ panel: { winRate: 0.44, perBot: [] } }) as never)).toBeUndefined();
  });

  it('declines a frozen boss — the throttle cannot make a still boss move', () => {
    expect(
      fairMiss(gate({ activity: { longestIdleRun: 263, idleFractionP90: 0.4, minSpanPx: 304 } }) as never),
    ).toBeUndefined();
    expect(
      fairMiss(gate({ activity: { longestIdleRun: 1, idleFractionP90: 0.01, minSpanPx: 12 } }) as never),
    ).toBeUndefined();
  });

  it('declines a boss ADAPTED rejected, since the throttle never changes what it reads', () => {
    expect(fairMiss(gate({ adapted: { met: false, blocking: true } }) as never)).toBeUndefined();
    // Round 2's advisory does not block, so it does not block the throttle either.
    expect(fairMiss(gate({ adapted: { met: false, blocking: false } }) as never)).toMatchObject({
      panel: 0.75,
    });
  });

  it('declines a gate that passed, or a detail it cannot read', () => {
    expect(fairMiss(gate({}, true) as never)).toBeUndefined();
    expect(fairMiss([] as never)).toBeUndefined();
    expect(
      fairMiss([
        {
          gate: 3,
          name: 'balance',
          ok: false,
          ms: 1,
          reason: 'the balance simulation could not run',
          detail: { round: 2, band: [0.35, 0.5], matches: 60 },
        },
      ] as never),
    ).toBeUndefined();
  });
});

/** A Coder provider that answers by aim point, so candidate order cannot matter. */
function dialProvider(byDial: Record<string, string>): LLMProvider {
  const provider = {
    name: 'mock-dial',
    model: 'mock-dial',
    async *stream(req: { system: string; messages: readonly { content: string }[] }) {
      const text = [req.system, ...req.messages.map((m) => m.content)].join('\n');
      const dial =
        Object.keys(byDial).find((name) => text.includes(`# YOUR AIM POINT: ${name.toUpperCase()}`)) ??
        (Object.keys(byDial)[0] as string);
      const reply = asCoderReply(byDial[dial] as string);
      yield { type: 'text' as const, delta: reply };
      yield {
        type: 'done' as const,
        text: reply,
        model: 'mock-dial',
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
  return provider as unknown as LLMProvider;
}

/**
 * THE LOOP, THROTTLING.
 *
 * `too-hard-pacer` is the round 2 fallback with its three measured levers turned up
 * until it is over the band. Measured through Gate 3 at 60 matches against round 2's
 * 0.35–0.50: **1.0 → 0.75, 0.5 → 0.41, 0.25 → 0.00**. So the file as written is too
 * hard, one ×0.5 bracket step lands it in band, and the correction costs one extra
 * gate pass instead of another 20-37 s Coder call.
 */
describe('the loop throttles a candidate instead of rewriting it', () => {
  it('ships the Coder\'s own file at the throttle the harness found', async () => {
    const analyst = mockProvider([asAnalystReply(ANALYSIS)]);
    const written = readAgentFixture('too-hard-pacer');
    const coder = dialProvider({ balanced: written, aggressive: written, conservative: written });

    const { emit, events } = recorder();
    const result = await rewrite(
      {
        summary: cannedSummary('camper-a'),
        round: 2,
        prevSource: readGood('idle'),
        providers: { analyst, coder },
        candidates: 3,
        harnessOpts: { gate3: { matches: MATCHES } },
      },
      emit,
    );

    // Attempt 1, approved — with a file Gate 3 rejected as written.
    expect(result.approved).toBe(true);
    if (!result.approved) return;
    expect(result.attempts).toHaveLength(1);
    expect(readThrottle(written)).toBeUndefined();
    expect(readThrottle(result.source)).toBe(0.5);
    expect(result.source).toContain('// ---- calibrated by the Judge');
    expect(result.source).toContain('const THROTTLE = 0.5;');
    // The boss the player is shown is still the boss the Coder wrote.
    expect(result.meta.name).toBe('Pacer');
    // And the shipped file is exactly the Coder's, wrapped — nothing was rewritten.
    expect(result.source).toBe(withThrottle(written.trim(), 0.5));

    // One search, on candidate 0 — one step, at 0.5, passing. Candidates 1 and 2 are
    // the same file and would have found the same throttle; the attempt stops the
    // moment it has an answer rather than proving that three times.
    const steps = eventsOf(events, 'calibrate.step');
    expect(steps.map((s) => [s.candidate, s.step, s.pressure, s.ok])).toEqual([[0, 1, 0.5, true]]);
    const step = steps[0]!;
    expect(step.attempt).toBe(1);
    expect(step.candidates).toBe(3);
    expect(step.panel).toBeGreaterThanOrEqual(0.35);
    expect(step.panel).toBeLessThanOrEqual(0.5);
    expect(step.reason).toBeUndefined();

    const done = eventsOf(events, 'calibrate.done');
    expect(done.map((d) => [d.candidate, d.steps, d.pressure, d.approved])).toEqual([[0, 1, 0.5, true]]);

    // The run log carries the search, so the artifact and the eval table can show it.
    const candidates = result.attempts[0]!.candidates!;
    expect(candidates).toHaveLength(3);
    const winner = candidates[0]!;
    expect(winner.pressure).toBe(0.5);
    expect(winner.calibration).toEqual({ steps: 1, from: 1, to: 0.5 });
    expect(winner.approved).toBe(true);
    // Its gates are the *throttled* file's — all four, so nothing shipped on a gate
    // it did not pass.
    expect(winner.gates.map((g) => [g.gate, g.ok])).toEqual([
      [1, true],
      [2, true],
      [3, true],
      [4, true],
    ]);
    expect(winner.panel).toBeGreaterThanOrEqual(0.35);
    expect(readThrottle(winner.source)).toBe(0.5);
    // The diff the player is shown is the file that ships, block included.
    expect(winner.diff).toContain('@@');
    expect(winner.diff).toContain('calibrated by the Judge');

    // The siblings are logged with their source and never judged or throttled.
    for (const sibling of candidates.slice(1)) {
      expect(sibling).toMatchObject({ skipped: true, skippedReason: 'approved-sibling' });
      expect(sibling.gates).toEqual([]);
      expect(sibling.calibration).toBeUndefined();
      expect(readThrottle(sibling.source)).toBeUndefined();
    }

    // The *events*, though, describe the file the Coder wrote: the candidate's
    // rejected Gate 3 is on screen, and the steps that followed it are reported as
    // `calibrate.step` rather than as a second series of gates inside one candidate.
    const gates = eventsOf(events, 'trial.gate').filter((g) => g.candidate === 0);
    expect(gates.map((g) => [g.gate.gate, g.gate.ok])).toEqual([
      [1, true],
      [2, true],
      [3, false],
    ]);
    const rejected = gates.at(-1)!.gate;
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.reason).toMatch(/vs panel — too hard/);
    // One progress series per candidate, still strictly increasing.
    let previous = -1;
    for (const step of eventsOf(events, 'trial.progress').filter((p) => p.candidate === 0)) {
      expect(step.matchesDone).toBeGreaterThan(previous);
      previous = step.matchesDone;
    }

    // And the per-candidate verdict is the throttled one, not the rejection that
    // started the search. Exactly one: the skipped siblings emit none, which the
    // client's reducer already tolerates — it counts files from `rewrite.done` and
    // never waits on a verdict per candidate.
    const verdicts = eventsOf(events, 'verdict').filter((v) => v.candidate !== undefined);
    expect(verdicts.map((v) => [v.candidate, v.approved])).toEqual([[0, true]]);
    expect(verdicts[0]!.reason).toBeUndefined();
    // The files were all written, so the interlude still shows three of three.
    expect(eventsOf(events, 'rewrite.done').map((e) => e.candidate)).toEqual([0, 1, 2]);
  }, 60_000);

  it('leaves a boss that is merely too easy to the Coder, as before', async () => {
    const analyst = mockProvider([asAnalystReply(ANALYSIS)]);
    // The null boss: 0.00 against the panel. The throttle only subtracts pressure, so
    // there is nothing for it to do here and it must not spend a gate pass finding out.
    const idle = readGood('idle');
    const coder = mockProvider([asCoderReply(idle), asCoderReply(idle)]);

    const { emit, events } = recorder();
    const result = await rewrite(
      {
        summary: cannedSummary('camper-a'),
        round: 2,
        prevSource: readGood('chaser'),
        providers: { analyst, coder },
        candidates: 1,
        maxAttempts: 1,
        harnessOpts: { gate3: { matches: 16 } },
      },
      emit,
    );

    expect(result.approved).toBe(false);
    if (result.approved) return;
    expect(eventsOf(events, 'calibrate.step')).toEqual([]);
    expect(eventsOf(events, 'calibrate.done')).toEqual([]);
    const verdict = eventsOf(events, 'verdict');
    expect(verdict).toHaveLength(1);
    expect(verdict[0]!.reason).toMatch(/too easy/);
    expect(result.attempts[0]!.candidates).toBeUndefined();
  }, 40_000);
});
