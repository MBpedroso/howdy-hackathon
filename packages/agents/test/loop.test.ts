/**
 * THE LOOP TEST — spec §6.3 and AC 6, with real gates.
 *
 * The Coder is scripted to fail twice and then succeed, and the assertions are
 * about the *sequence*: two rejections with the right gate and the right reason,
 * an approval on attempt 3, and — the one that matters most — the second
 * rejection's sentence appearing **verbatim** in the third prompt. That last
 * assertion is the whole autonomous loop: if the reason does not reach the Coder,
 * nothing in this product is closing a feedback loop.
 *
 * The harness is real. Gate 1 really rejects `Date`, Gate 3 really simulates
 * matches and really rates `chaser` above the round 2 band. Only the model is
 * mocked, because the model is the part that is not deterministic.
 */
import { describe, expect, it } from 'vitest';
import { gate3Plan } from '@rematch/harness';
import {
  PROGRESS_MIN_GAP_MS,
  mockProvider,
  recorder,
  rewrite,
  type Analysis,
  type LLMProvider,
  type RewriteEvent,
} from '../src/index.ts';
import { asAnalystReply, asCoderReply, cannedSummary, readGood, readHarnessFixture } from './helpers.ts';

const ANALYSIS: Analysis = {
  observations: [
    'Lived in cell 63 (x=750, y=750) for 93% of the round.',
    'Never dashed in 1301 ticks.',
    'Fired 163 shots and took no damage.',
  ],
  playerArchetype: 'camper',
  counterPlan: 'Put every slam on the bottom-right corner and hold mid range so the corner stops being safe.',
};

/**
 * 60 matches instead of the spec's 200. The verdicts are the same ones
 * `harness/test/balance.test.ts` measures at 120 (`chaser` well above the band,
 * `round2-candidate` inside it), and it keeps this file under 10 s.
 */
const MATCHES = 60;

function eventsOf<T extends RewriteEvent['type']>(
  events: readonly RewriteEvent[],
  type: T,
): Extract<RewriteEvent, { type: T }>[] {
  return events.filter((e): e is Extract<RewriteEvent, { type: T }> => e.type === type);
}

describe('the autonomous rewrite loop', () => {
  it('gets rejected by Gate 1, then by Gate 3, then ships on attempt 3', async () => {
    const summary = cannedSummary('camper-a');
    // Prose first, then the fenced JSON block — the shape the Analyst prompt asks
    // for, so the streaming assertions below are about what really arrives.
    const analyst = mockProvider([asAnalystReply(ANALYSIS)]);
    // The Coder pre-checks its own file against `staticCheck` and gets one free
    // self-retry, so a Gate 1 rejection only reaches the harness when the model
    // makes the same mistake twice — hence `uses-date` scripted twice.
    const usesDate = asCoderReply(readHarnessFixture('uses-date'));
    const coder = mockProvider([
      // Attempt 1, both passes: mentions `Date`. Gate 1 rejects it before any code
      // executes (spec AC 8).
      usesDate,
      usesDate,
      // Attempt 2: valid, but wins 0.78 against the panel — Gate 3, too hard.
      asCoderReply(readGood('chaser')),
      // Attempt 3: the hand-written Round 2 boss — inside the band, beats the Mimic.
      asCoderReply(readHarnessFixture('round2-candidate')),
    ]);

    const { emit, events } = recorder();
    // When each `trial.progress` was emitted, for the throttle assertion below.
    const progressTimes: number[] = [];
    const timed: typeof emit = (event) => {
      if (event.type === 'trial.progress') progressTimes.push(Date.now());
      emit(event);
    };
    const started = Date.now();
    const result = await rewrite(
      {
        summary,
        round: 2,
        prevSource: readGood('idle'),
        providers: { analyst, coder },
        // The legacy single-candidate loop: this file's assertions are about the
        // rejection -> retry sequence, one file at a time (see `parallel candidates`).
        candidates: 1,
        harnessOpts: { gate3: { matches: MATCHES } },
      },
      timed,
    );
    const wall = Date.now() - started;

    // ---------------------------------------------------------- the verdicts
    const verdicts = eventsOf(events, 'verdict');
    expect(verdicts.map((v) => [v.attempt, v.approved])).toEqual([
      [1, false],
      [2, false],
      [3, true],
    ]);

    expect(verdicts[0]!.reason).toMatch(/forbidden identifier 'Date'/);
    expect(verdicts[0]!.reason).toMatch(/^line \d+/);
    expect(verdicts[1]!.reason).toMatch(/vs panel — too hard/);
    expect(verdicts[1]!.reason).toMatch(/band 0\.35–0\.50 for round 2/);

    // ------------------------------------------------- the rejecting gates
    const gates = eventsOf(events, 'trial.gate');
    const attempt1 = gates.filter((g) => g.attempt === 1);
    expect(attempt1).toHaveLength(1);
    expect(attempt1[0]!.gate).toMatchObject({ gate: 1, name: 'static', ok: false });

    const attempt2 = gates.filter((g) => g.attempt === 2);
    expect(attempt2.map((g) => [g.gate.gate, g.gate.ok])).toEqual([
      [1, true],
      [2, true],
      [3, false],
    ]);

    const attempt3 = gates.filter((g) => g.attempt === 3);
    expect(attempt3.map((g) => [g.gate.gate, g.gate.ok])).toEqual([
      [1, true],
      [2, true],
      [3, true],
      [4, true],
    ]);

    // ---------------- the feedback loop: the reason reaches the Coder verbatim
    // Model calls: 0 and 1 are attempt 1 (the file, then its static self-retry),
    // 2 is attempt 2, 3 is attempt 3.
    expect(coder.calls).toHaveLength(4);

    const secondReason = verdicts[1]!.reason;
    expect(secondReason).toBeDefined();
    const thirdPrompt = coder.promptOf(3);
    expect(thirdPrompt).toContain(secondReason!);
    expect(thirdPrompt).toContain('ATTEMPT 2 WAS REJECTED BY GATE 3 (balance)');

    const secondAttemptPrompt = coder.promptOf(2);
    expect(secondAttemptPrompt).toContain(verdicts[0]!.reason!);
    expect(secondAttemptPrompt).toContain('ATTEMPT 1 WAS REJECTED BY GATE 1 (static)');

    // The first prompt has no rejection at all — nothing to answer yet.
    expect(coder.promptOf(0)).not.toContain('WAS REJECTED BY GATE');
    // The self-retry prompt carries the static violations, not a harness verdict.
    expect(coder.promptOf(1)).toContain('DID NOT PASS THE STATIC CHECK');

    // ------------------------------------------------------------- the result
    expect(result.approved).toBe(true);
    if (!result.approved) return;
    expect(result.attempts).toHaveLength(3);
    expect(result.attempts.map((a) => a.approved)).toEqual([false, false, true]);
    expect(result.meta.name).toBe('Warden');
    expect(result.source).toContain('export function decide');
    expect(result.analysis.playerArchetype).toBe('camper');

    expect(result.attempts[0]!.coder.calls).toBe(2);
    expect(result.attempts[0]!.coder.staticInvalid).toBe(true);
    expect(result.attempts[0]!.coder.selfRetry).toContain('forbidden-identifier');
    expect(result.attempts[1]!.coder.calls).toBe(1);

    // Every attempt logged with prompt size, tokens, gates and wall time.
    for (const attempt of result.attempts) {
      expect(attempt.coder.promptChars).toBeGreaterThan(1000);
      expect(attempt.coder.usage.inputTokens).toBeGreaterThan(0);
      expect(attempt.coder.usage.outputTokens).toBeGreaterThan(0);
      expect(attempt.gates.length).toBeGreaterThan(0);
      expect(attempt.ms).toBeGreaterThanOrEqual(0);
      expect(attempt.diff).toContain('@@');
    }

    // ------------------------------------------------------- the four beats
    expect(eventsOf(events, 'replay')).toHaveLength(1);
    expect(eventsOf(events, 'analysis.delta').length).toBeGreaterThan(0);
    expect(eventsOf(events, 'analysis.done')).toHaveLength(1);
    expect(eventsOf(events, 'rewrite.delta').length).toBeGreaterThan(2);
    expect(eventsOf(events, 'rewrite.done').map((e) => e.attempt)).toEqual([1, 2, 3]);

    // Beat 2 streams the prose and withholds the JSON block (spec §2.2's
    // typewriter); the whole reply survives on `analysis.done.raw` for the log.
    const streamed = eventsOf(events, 'analysis.delta').map((e) => e.delta).join('');
    expect(streamed).toContain(ANALYSIS.observations[0]!);
    expect(streamed).not.toContain('```');
    expect(streamed).not.toContain('"playerArchetype"');
    const analysisDone = eventsOf(events, 'analysis.done')[0]!;
    expect(analysisDone.raw).toContain('```json');
    expect(analysisDone.raw).toContain('"playerArchetype"');

    // Beat 3 names each attempt with the `meta` parsed out of its own source — the
    // rejected files included, which is why it is parsed and not loaded.
    expect(eventsOf(events, 'rewrite.done').map((e) => e.meta?.name)).toEqual([
      'Clockwork',
      'Hound',
      'Warden',
    ]);
    expect(eventsOf(events, 'fallback')).toHaveLength(0);
    expect(eventsOf(events, 'done')).toHaveLength(1);

    // Gate 3 reports real progress: the opening event, then a batch at a time as
    // results arrive, then the total. Attempt 1 never reached Gate 3 (Gate 1
    // rejected it), so only attempts 2 and 3 have a series.
    const progress = eventsOf(events, 'trial.progress');
    expect(progress.filter((p) => p.attempt === 1)).toHaveLength(0);
    // The total is `gate3Plan`'s, not the requested `matches`: 60 requested is 62
    // run (8 seeds x 4 bots, plus 30 vs the Mimic), and the meter is labelled with
    // the number that will actually arrive.
    const total = gate3Plan({ matches: MATCHES, mimicSummary: summary }).total;
    expect(total).toBeGreaterThanOrEqual(MATCHES);

    for (const attempt of [2, 3]) {
      const series = progress.filter((p) => p.attempt === attempt);
      expect(series.length).toBeGreaterThan(2);
      expect(series[0]).toMatchObject({ matchesDone: 0, matchesTotal: total, gate: 'balance' });
      expect(series.at(-1)).toMatchObject({ matchesDone: total, matchesTotal: total });

      let previous = -1;
      for (const step of series) {
        expect(step.matchesTotal).toBe(total);
        expect(step.matchesDone).toBeGreaterThan(previous);
        previous = step.matchesDone;
      }
    }

    // Throttled to PROGRESS_MIN_GAP_MS apart, so a 200-match gate cannot put 200
    // frames on the SSE connection. The last event of a series is exempt: it is
    // what closes the meter, and it always fires.
    for (let i = 1; i < progress.length; i += 1) {
      const step = progress[i]!;
      const previous = progress[i - 1]!;
      const sameSeries = step.attempt === previous.attempt;
      const isFinal = step.matchesDone >= step.matchesTotal;
      if (!sameSeries || isFinal) continue;
      // -5 ms of slack: the timestamps are taken in the emit callback, one hop
      // after the throttle read the clock.
      expect(progressTimes[i]! - progressTimes[i - 1]!).toBeGreaterThanOrEqual(PROGRESS_MIN_GAP_MS - 5);
    }

    // The events arrive in beat order: replay, analysis, then per-attempt.
    const order = events.map((e) => e.type);
    expect(order[0]).toBe('replay');
    expect(order.indexOf('analysis.done')).toBeLessThan(order.indexOf('rewrite.done'));
    expect(order.at(-1)).toBe('done');

    // Spec AC 5 gives the whole interlude 45 s; this is 3 attempts and 2 real
    // simulations at 60 matches, so it has to be a small fraction of that.
    expect(wall).toBeLessThan(10_000);
  });

  it('feeds each rejected file forward as the next attempt\'s baseline', async () => {
    const analyst = mockProvider([JSON.stringify(ANALYSIS)]);
    const chaser = readGood('chaser');
    const coder = mockProvider([asCoderReply(chaser), asCoderReply(readHarnessFixture('round2-candidate'))]);

    const result = await rewrite({
      summary: cannedSummary('camper-a'),
      round: 2,
      prevSource: readGood('idle'),
      providers: { analyst, coder },
      candidates: 1,
      harnessOpts: { gate3: { matches: MATCHES } },
    });

    expect(result.approved).toBe(true);
    // Attempt 2's prompt shows attempt 1's file, not the round's opening boss: a
    // near-miss is a better starting point than the boss that already lost.
    const second = coder.promptOf(1);
    expect(second).toContain(chaser.trim().slice(0, 120));
    expect(second).not.toContain(readGood('idle').trim().slice(0, 120));
  });

  it('measures ADAPTED against this player, so Gate 3 is never skipped', async () => {
    // A boss that ignores the player entirely fails FAIR as too easy and misses
    // ADAPTED. Both halves must appear in the reason, which is what proves
    // `mimicSummary` reached the gate — ADAPTED advises rather than rejects now
    // (2026-09-08), so its sentence rides along with a rejection rather than
    // causing one, and the relative baseline proves `prevSource` got measured too.
    const analyst = mockProvider([JSON.stringify(ANALYSIS)]);
    const idle = asCoderReply(readGood('idle'));
    const coder = mockProvider([idle, idle, idle, idle]);

    const { emit, events } = recorder();
    const result = await rewrite(
      {
        summary: cannedSummary('rusher-a'),
        round: 2,
        prevSource: readGood('chaser'),
        providers: { analyst, coder },
        // The legacy single-candidate loop: this file's assertions are about the
        // rejection -> retry sequence, one file at a time (see `parallel candidates`).
        candidates: 1,
        harnessOpts: { gate3: { matches: 16 } },
        maxAttempts: 2,
      },
      emit,
    );

    expect(result.approved).toBe(false);
    if (result.approved) return;
    expect(result.reason).toBe('max-attempts');
    expect(result.attempts).toHaveLength(2);

    const verdicts = eventsOf(events, 'verdict');
    expect(verdicts.every((v) => !v.approved)).toBe(true);
    expect(verdicts[0]!.reason).toMatch(/vs Mimic — aim for >= 0\.70/);
    expect(verdicts[0]!.reason).toMatch(/\(not blocking\)/);
    expect(verdicts[0]!.reason).toMatch(/too easy/);
    // `measureMimicWinRate(prevSource, …)` ran and its number reached the reason.
    expect(verdicts[0]!.reason).toMatch(/to beat the boss you are replacing/);

    const fallback = eventsOf(events, 'fallback');
    expect(fallback).toHaveLength(1);
    expect(fallback[0]!.reason).toBe('max-attempts');
    expect(eventsOf(events, 'done')).toHaveLength(1);
  });

  it('falls back on the deadline when the provider stalls, and aborts the stream', async () => {
    const analyst = mockProvider([{ text: JSON.stringify(ANALYSIS), stall: true }]);
    const coder = mockProvider([asCoderReply(readGood('idle'))]);

    const { emit, events } = recorder();
    const started = Date.now();
    const result = await rewrite(
      {
        summary: cannedSummary('camper-a'),
        round: 2,
        prevSource: readGood('idle'),
        providers: { analyst, coder },
        // The legacy single-candidate loop: this file's assertions are about the
        // rejection -> retry sequence, one file at a time (see `parallel candidates`).
        candidates: 1,
        deadlineMs: 250,
      },
      emit,
    );
    const wall = Date.now() - started;

    expect(result.approved).toBe(false);
    if (result.approved) return;
    expect(result.reason).toBe('deadline');
    expect(result.attempts).toEqual([]);

    const fallback = eventsOf(events, 'fallback');
    expect(fallback).toHaveLength(1);
    expect(fallback[0]!.reason).toBe('deadline');
    expect(eventsOf(events, 'done')).toHaveLength(1);
    // It really aborted, rather than waiting the stall out.
    expect(wall).toBeLessThan(3_000);
    // The Coder was never called: the deadline was gone before an attempt started.
    expect(coder.calls).toHaveLength(0);
  });

  it('falls back on the deadline when the Coder stalls mid-attempt', async () => {
    const analyst = mockProvider([JSON.stringify(ANALYSIS)]);
    const coder = mockProvider([{ text: asCoderReply(readGood('idle')), stall: true }]);

    const { emit, events } = recorder();
    const result = await rewrite(
      {
        summary: cannedSummary('camper-a'),
        round: 2,
        prevSource: readGood('idle'),
        providers: { analyst, coder },
        // The legacy single-candidate loop: this file's assertions are about the
        // rejection -> retry sequence, one file at a time (see `parallel candidates`).
        candidates: 1,
        deadlineMs: 300,
      },
      emit,
    );

    expect(result.approved).toBe(false);
    if (result.approved) return;
    expect(result.reason).toBe('deadline');
    expect(result.analysis?.playerArchetype).toBe('camper');
    expect(eventsOf(events, 'analysis.done')).toHaveLength(1);
    expect(eventsOf(events, 'fallback')[0]!.reason).toBe('deadline');
  });

  it('falls back with reason `error` when the Analyst never returns usable JSON', async () => {
    const analyst = mockProvider(['no', 'still no']);
    const coder = mockProvider([asCoderReply(readGood('idle'))]);

    const { emit, events } = recorder();
    const result = await rewrite(
      {
        summary: cannedSummary('kiter-a'),
        round: 2,
        prevSource: readGood('idle'),
        providers: { analyst, coder },
        // The legacy single-candidate loop: this file's assertions are about the
        // rejection -> retry sequence, one file at a time (see `parallel candidates`).
        candidates: 1,
      },
      emit,
    );

    expect(result.approved).toBe(false);
    if (result.approved) return;
    expect(result.reason).toBe('error');
    expect(result.message).toMatch(/Analyst/);
    expect(eventsOf(events, 'fallback')[0]!.reason).toBe('error');
    expect(coder.calls).toHaveLength(0);
  });

  it('honours a caller abort', async () => {
    const controller = new AbortController();
    const analyst = mockProvider([{ text: JSON.stringify(ANALYSIS), stall: true }]);
    const coder = mockProvider([asCoderReply(readGood('idle'))]);
    setTimeout(() => controller.abort(), 100);

    const result = await rewrite({
      summary: cannedSummary('camper-a'),
      round: 2,
      prevSource: readGood('idle'),
      providers: { analyst, coder },
      candidates: 1,
      signal: controller.signal,
      deadlineMs: 30_000,
    });

    expect(result.approved).toBe(false);
    if (result.approved) return;
    expect(result.reason).toBe('deadline');
  });

  it('accepts one provider for both agents', async () => {
    const provider = mockProvider([
      JSON.stringify(ANALYSIS),
      asCoderReply(readHarnessFixture('round2-candidate')),
    ]);
    const result = await rewrite({
      summary: cannedSummary('camper-a'),
      round: 2,
      prevSource: readGood('idle'),
      providers: provider,
      candidates: 1,
      harnessOpts: { gate3: { matches: MATCHES } },
    });
    expect(result.approved).toBe(true);
    expect(provider.calls).toHaveLength(2);
  });
});

/**
 * PARALLEL CANDIDATES — the fix for the loop's real-world pass rate.
 *
 * Five round-2 evals against gpt-5.4-mini put the loop at 0.2-0.3 approved with
 * 54 of 55 rejections coming from Gate 3, and the reasons alternating "too hard"
 * and "too easy" between attempts: the Coder was being handed one measured point
 * and over-correcting past the band every time. An attempt now writes K files at
 * once — same context, one differing line each — so a rejection comes back as an
 * interval instead of a point.
 *
 * These tests are about the mechanism, not the model: the provider is keyed on the
 * dial so each candidate's file is chosen by the test, and the gates are real.
 */

/** A Coder provider that answers by aim point, so candidate order cannot matter. */
function dialProvider(byDial: Record<string, readonly string[]>): {
  provider: LLMProvider;
  prompts: string[];
} {
  const prompts: string[] = [];
  const used = new Map<string, number>();
  const provider = {
    name: 'mock-dial',
    model: 'mock-dial',
    async *stream(req: { system: string; messages: readonly { content: string }[] }) {
      const text = [req.system, ...req.messages.map((m) => m.content)].join('\n');
      prompts.push(text);
      const dial =
        Object.keys(byDial).find((name) => text.includes(`# YOUR AIM POINT: ${name.toUpperCase()}`)) ??
        Object.keys(byDial)[0]!;
      const n = used.get(dial) ?? 0;
      used.set(dial, n + 1);
      const script = byDial[dial]!;
      const reply = asCoderReply(script[Math.min(n, script.length - 1)]!);
      yield { type: 'text' as const, delta: reply };
      yield {
        type: 'done' as const,
        text: reply,
        model: 'mock-dial',
        usage: { inputTokens: Math.ceil(text.length / 4), outputTokens: Math.ceil(reply.length / 4) },
      };
    },
  };
  return { provider: provider as unknown as LLMProvider, prompts };
}

describe('parallel candidates', () => {
  it('writes three files in one attempt and ships the one the harness likes', async () => {
    const analyst = mockProvider([asAnalystReply(ANALYSIS)]);
    const { provider: coder } = dialProvider({
      // Fails `staticCheck` twice, so it is submitted flagged and Gate 1 rejects it.
      conservative: [readHarnessFixture('uses-date')],
      // Valid, but 0.78 against the panel — Gate 3, too hard.
      balanced: [readGood('chaser')],
      // The hand-written Round 2 boss: inside the band and beats the Mimic.
      aggressive: [readHarnessFixture('round2-candidate')],
    });

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

    expect(result.approved).toBe(true);
    expect(result.attempts).toHaveLength(1);

    // Three files, tagged 0/1/2 out of 3, each labelled with its aim point.
    const written = eventsOf(events, 'rewrite.done');
    expect(written.map((e) => e.candidate)).toEqual([0, 1, 2]);
    expect(written.map((e) => e.candidates)).toEqual([3, 3, 3]);
    expect(written.map((e) => e.dial)).toEqual(['conservative', 'balanced', 'aggressive']);

    // One verdict per candidate — the conservative one rejected by Gate 1, the
    // balanced one by Gate 3, the aggressive one approved — then exactly one
    // attempt-level verdict with no `candidate`, which is all a K-unaware client sees.
    const verdicts = eventsOf(events, 'verdict');
    expect(verdicts.filter((v) => v.candidate !== undefined).map((v) => [v.candidate, v.approved])).toEqual([
      [0, false],
      [1, false],
      [2, true],
    ]);
    const attemptLevel = verdicts.filter((v) => v.candidate === undefined);
    expect(attemptLevel).toHaveLength(1);
    expect(attemptLevel[0]).toMatchObject({ attempt: 1, approved: true });

    // Gate events carry the candidate they belong to, so the Trial panel can group them.
    const gates = eventsOf(events, 'trial.gate');
    expect(gates.filter((g) => g.candidate === 0).map((g) => g.gate.gate)).toEqual([1]);
    expect(gates.filter((g) => g.candidate === 1).map((g) => g.gate.gate)).toEqual([1, 2, 3]);
    expect(gates.filter((g) => g.candidate === 2).map((g) => g.gate.gate)).toEqual([1, 2, 3, 4]);

    const log = result.attempts[0]!;
    expect(log.candidates).toHaveLength(3);
    expect(log.chosen).toBe(2);
    expect(log.source.trim()).toBe(readHarnessFixture('round2-candidate').trim());
    // The attempt's cost is the whole attempt's, not the winner's.
    expect(log.coder.calls).toBe(4); // 2 for the self-retrying candidate, 1 each for the others
  }, 40_000);

  it('hands the next attempt every candidate\'s rates, not just one point', async () => {
    const analyst = mockProvider([asAnalystReply(ANALYSIS)]);
    const { provider: coder, prompts } = dialProvider({
      // Below the band: a boss that does nothing.
      conservative: [readGood('idle'), readGood('idle')],
      // Above it: `chaser` is measured at 0.78 by the harness's own balance suite.
      balanced: [readGood('chaser'), readGood('chaser')],
      aggressive: [readGood('chaser'), readGood('chaser')],
    });

    const result = await rewrite({
      summary: cannedSummary('camper-a'),
      round: 2,
      prevSource: readGood('cornerbreaker'),
      providers: { analyst, coder },
      candidates: 3,
      maxAttempts: 2,
      harnessOpts: { gate3: { matches: MATCHES } },
    });

    expect(result.approved).toBe(false);

    // The attempt-2 prompts each carry the whole comparison table.
    const second = prompts.filter((p) => p.includes('CANDIDATES WERE REJECTED'));
    expect(second.length).toBeGreaterThanOrEqual(3);
    const table = second[0]!;
    for (const dial of ['conservative', 'balanced', 'aggressive']) expect(table).toContain(dial);
    expect(table).toContain('too easy');
    expect(table).toContain('too hard');
    // …and the bisection the bracket makes possible: the second attempt is aimed at
    // a point *between* the two measured files, and carries both of them.
    expect(table).toMatch(/# YOUR AIM POINT: \d+% OF THE WAY FROM TOO EASY TO TOO HARD/);
    expect(table).toContain('# FILE A — TOO EASY');
    expect(table).toContain('# FILE B — TOO HARD');
    expect(table).toContain('spawn cadence');
    // Three candidates at three different points on the same line.
    const fractions = second.map((p) => /AIM POINT: (\d+)%/.exec(p)?.[1]);
    expect(new Set(fractions).size).toBe(3);
    // Spec §6.3 still holds: the harness's own sentence is the last thing it reads.
    const reason = result.attempts[0]!.reason!;
    expect(table).toContain(reason);
    expect(table.indexOf(reason)).toBeGreaterThan(table.length - 400);
  }, 60_000);

  it('emits the byte-identical legacy stream at K = 1', async () => {
    const analyst = mockProvider([asAnalystReply(ANALYSIS)]);
    const coder = mockProvider([asCoderReply(readHarnessFixture('round2-candidate'))]);
    const { emit, events } = recorder();
    const result = await rewrite(
      {
        summary: cannedSummary('camper-a'),
        round: 2,
        prevSource: readGood('idle'),
        providers: { analyst, coder },
        candidates: 1,
        harnessOpts: { gate3: { matches: MATCHES } },
      },
      emit,
    );

    expect(result.approved).toBe(true);
    // No candidate fields anywhere, and one verdict for the attempt.
    for (const event of events) {
      expect(event).not.toHaveProperty('candidate');
      expect(event).not.toHaveProperty('candidates');
    }
    expect(eventsOf(events, 'verdict')).toHaveLength(1);
    expect(result.attempts[0]!.candidates).toBeUndefined();
    // And the prompt is the one the single-candidate loop always sent.
    expect(coder.promptOf(0)).not.toContain('YOUR AIM POINT');
  }, 40_000);
});
