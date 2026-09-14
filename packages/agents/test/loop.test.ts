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
  AbortError,
  PROGRESS_MIN_GAP_MS,
  STRAGGLER_LATENCY_RATIO,
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

/**
 * The same provider, with a per-dial delay before the reply lands.
 *
 * The K Coder calls are concurrent on every provider (`providerClaudeCli` spawns
 * one child process each), so they finish in whatever order the model answers in —
 * and until 2026-09-11 the loop awaited them by *index*, which meant a file that
 * had already arrived waited for a slower sibling before it could be gated. On the
 * 45 s interlude that is the difference between three measured points and one.
 */
function delayedDialProvider(byDial: Record<string, { source: string; delayMs: number }>): {
  provider: LLMProvider;
  order: string[];
} {
  const order: string[] = [];
  const provider = {
    name: 'mock-delayed',
    model: 'mock-delayed',
    async *stream(req: {
      system: string;
      messages: readonly { content: string }[];
      signal?: AbortSignal;
    }) {
      const text = [req.system, ...req.messages.map((m) => m.content)].join('\n');
      const dial =
        Object.keys(byDial).find((name) => text.includes(`# YOUR AIM POINT: ${name.toUpperCase()}`)) ??
        Object.keys(byDial)[0]!;
      const entry = byDial[dial]!;
      // The signal is honoured, because the straggler cut *is* an abort: a mock that
      // ignored it would make every straggler test pass for the wrong reason.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, entry.delayMs);
        req.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new AbortError());
          },
          { once: true },
        );
      });
      order.push(dial);
      const reply = asCoderReply(entry.source);
      yield { type: 'text' as const, delta: reply };
      yield {
        type: 'done' as const,
        text: reply,
        model: 'mock-delayed',
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
  return { provider: provider as unknown as LLMProvider, order };
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

    // Three files, tagged 0/1/2 out of 3, each labelled with its aim point — and
    // the aim points are in `DIAL_ORDER`, not low-to-high: candidate 0 is the one
    // aimed at the middle of the band, because on a budget that judges one file it
    // has to be that one (2026-09-11).
    const written = eventsOf(events, 'rewrite.done');
    expect(written.map((e) => e.candidate)).toEqual([0, 1, 2]);
    expect(written.map((e) => e.candidates)).toEqual([3, 3, 3]);
    expect(written.map((e) => e.dial)).toEqual(['balanced', 'aggressive', 'conservative']);

    // One verdict per *judged* candidate — the balanced one rejected by Gate 3 and
    // the aggressive one approved — then exactly one attempt-level verdict with no
    // `candidate`, which is all a K-unaware client sees. The conservative one is
    // never judged: candidate 1 passed, and the attempt stops the moment it has an
    // answer rather than spending the interlude on a file it cannot ship.
    const verdicts = eventsOf(events, 'verdict');
    expect(verdicts.filter((v) => v.candidate !== undefined).map((v) => [v.candidate, v.approved])).toEqual([
      [0, false],
      [1, true],
    ]);
    const attemptLevel = verdicts.filter((v) => v.candidate === undefined);
    expect(attemptLevel).toHaveLength(1);
    expect(attemptLevel[0]).toMatchObject({ attempt: 1, approved: true });

    // Gate events carry the candidate they belong to, so the Trial panel can group
    // them. Candidate 2 has none: it was written, and then the approval landed.
    const gates = eventsOf(events, 'trial.gate');
    expect(gates.filter((g) => g.candidate === 0).map((g) => g.gate.gate)).toEqual([1, 2, 3]);
    expect(gates.filter((g) => g.candidate === 1).map((g) => g.gate.gate)).toEqual([1, 2, 3, 4]);
    expect(gates.filter((g) => g.candidate === 2)).toEqual([]);

    const log = result.attempts[0]!;
    // All three files are still in the log — the third with its source, its diff and
    // the reason it was never judged.
    expect(log.candidates).toHaveLength(3);
    expect(log.candidates![2]).toMatchObject({ skipped: true, skippedReason: 'approved-sibling' });
    expect(log.candidates![2]!.gates).toEqual([]);
    expect(log.chosen).toBe(1);
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

/**
 * ONE ATTEMPT, K JUDGED — the 2026-09-11 fix.
 *
 * Three real interludes on `REMATCH_PROVIDER=claude-cli` (Sonnet, effort low) each
 * produced exactly one judged candidate inside the 45 s client budget
 * (`artifacts/server/rewrite-2026-09-11T16-18-39-211Z.json` and the two after it):
 * the Analyst took 14-16 s, candidate 0's Coder call 14-22 s, its gates ~2 s, and
 * the deadline aborted candidates 1 and 2 while they were still streaming. The
 * model calls were already concurrent — the artifacts show all three candidates'
 * `rewrite.delta` events interleaved from the start, and `providerClaudeCli` spawns
 * one child process per call with nothing shared between them. What was serial was
 * the *judging*: `await pending[index]` made the gates wait on candidate 0 even
 * when a sibling had already landed.
 */
describe('candidates are judged in completion order', () => {
  it('gates whichever file lands first, and judges all K in one attempt', async () => {
    const analyst = mockProvider([asAnalystReply(ANALYSIS)]);
    // Candidate 1 (`aggressive`, DIAL_ORDER) lands first and candidate 0
    // (`balanced`) is not first in index order either — exactly the case index order
    // got wrong. The one that *passes* is deliberately the one judged last, because
    // an approval now ends the attempt (see `approvedIndex` in `loop.ts`) and this
    // test is about all K being judged inside one attempt. The other two are `idle`:
    // too easy, and motionless, so the Judge's throttle declines them and they are
    // judged in well under a second each.
    const { provider: coder, order } = delayedDialProvider({
      aggressive: { source: readGood('idle'), delayMs: 20 },
      balanced: { source: readGood('idle'), delayMs: 120 },
      conservative: { source: readHarnessFixture('round2-candidate'), delayMs: 260 },
    });

    const { emit, events } = recorder();
    const result = await rewrite(
      {
        summary: cannedSummary('camper-a'),
        round: 2,
        prevSource: readGood('idle'),
        providers: { analyst, coder },
        candidates: 3,
        // Long enough that nothing is cut: the point of this test is the order the
        // three are judged in, not the straggler guillotine.
        stragglerMs: 30_000,
        harnessOpts: { gate3: { matches: MATCHES } },
      },
      emit,
    );

    // The three model calls really did run at once, and answered out of index order.
    expect(order).toEqual(['aggressive', 'balanced', 'conservative']);

    // …and the gates followed them. Candidate 1 answered first, so candidate 1 is
    // gated first — under index order it would have waited behind candidate 0's
    // whole model call. (Only the *first* is asserted: candidate 1's four real
    // gates take longer than the other two calls have left to run, so by the time
    // the loop races again both are settled and `Promise.race` falls back to
    // iteration order — which is the behaviour wanted, not a coincidence to pin.)
    const written = eventsOf(events, 'rewrite.done');
    expect(written[0]!.candidate).toBe(1);
    expect([...written.map((e) => e.candidate)].sort()).toEqual([0, 1, 2]);
    const firstGateOf = (candidate: number): number =>
      events.findIndex((e) => e.type === 'trial.gate' && e.candidate === candidate);
    expect(firstGateOf(1)).toBeLessThan(firstGateOf(0));
    expect(firstGateOf(1)).toBeLessThan(firstGateOf(2));

    // Every candidate reached a verdict inside the one attempt — the acceptance
    // criterion the live runs missed three times in a row.
    const perCandidate = eventsOf(events, 'verdict').filter((v) => v.candidate !== undefined);
    expect(perCandidate[0]!.candidate).toBe(1);
    expect([...perCandidate.map((v) => v.candidate)].sort()).toEqual([0, 1, 2]);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]!.candidates).toHaveLength(3);

    // Judged in completion order, reported in candidate order: `chosen` indexes
    // this array, so two identical runs must not produce two different artifacts.
    expect(result.attempts[0]!.candidates!.map((c) => c.candidate)).toEqual([0, 1, 2]);
    expect(result.attempts[0]!.outcomes!.map((o) => o.candidate)).toEqual([0, 1, 2]);
    expect(result.attempts[0]!.candidates!.map((c) => c.dial)).toEqual([
      'balanced',
      'aggressive',
      'conservative',
    ]);

    // The approved file ships whichever slot it arrived in — here the last one.
    expect(result.approved).toBe(true);
    expect(result.attempts[0]!.chosen).toBe(2);
  }, 40_000);
});

/**
 * THE APPROVAL CUT — the 2026-09-11 follow-up.
 *
 * An attempt cannot ship two bosses. Measured on a live round 3 run
 * (`artifacts/server/rewrite-2026-09-11T18-47-05-340Z.json`, 57 s) candidate 0 was
 * approved and the loop then waited for candidates 1 and 2, ran both through the
 * gates, and spent four more throttle steps on candidate 1 — 10-15 s of interlude in
 * which nothing that happened could change the outcome.
 *
 * So the first pass ends the attempt. Both halves of that are tested here, because
 * the two look nothing alike from inside the loop: a sibling whose model call is
 * still streaming is aborted and never produces a file at all, while one that had
 * already landed has a file and is recorded with it, unjudged. Neither is a straggler
 * cut — the grace is set far out of reach in both.
 */
describe('an approved candidate ends its attempt', () => {
  it('aborts siblings that are still streaming, and logs nothing for them', async () => {
    const analyst = mockProvider([asAnalystReply(ANALYSIS)]);
    // Candidate 1 (`aggressive`) lands in 20 ms and passes; the other two are five
    // seconds out and are cut mid-stream. The mock rejects with `AbortError` when its
    // signal fires, so a loop that did not abort would fail this on wall clock.
    const { provider: coder, order } = delayedDialProvider({
      aggressive: { source: readHarnessFixture('round2-candidate'), delayMs: 20 },
      balanced: { source: readGood('chaser'), delayMs: 5_000 },
      conservative: { source: readGood('orbiter'), delayMs: 5_000 },
    });

    const { emit, events } = recorder();
    const started = Date.now();
    const result = await rewrite(
      {
        summary: cannedSummary('camper-a'),
        round: 2,
        prevSource: readGood('idle'),
        providers: { analyst, coder },
        candidates: 3,
        // Far out of reach: whatever cuts the siblings here, it is not the straggler.
        stragglerMs: 30_000,
        harnessOpts: { gate3: { matches: MATCHES } },
      },
      emit,
    );
    const wall = Date.now() - started;

    expect(result.approved).toBe(true);
    // Only the winner ever answered; the other two calls were aborted where they were.
    expect(order).toEqual(['aggressive']);
    expect(eventsOf(events, 'rewrite.done').map((e) => e.candidate)).toEqual([1]);
    expect(result.attempts[0]!.candidates).toHaveLength(1);
    expect(result.attempts[0]!.chosen).toBe(0);
    // The attempt did not sit out the five seconds it had no use for.
    expect(wall).toBeLessThan(4_000);
    // An aborted sibling is the loop's own doing, never a run failure.
    expect(eventsOf(events, 'fallback')).toEqual([]);
  }, 40_000);

  it('records a sibling that had already landed, unjudged, with the reason', async () => {
    const analyst = mockProvider([asAnalystReply(ANALYSIS)]);
    // Every call resolves immediately, so by the time candidate 0's gates finish both
    // siblings are settled and sitting in `outstanding`. They are still not judged:
    // in the live run that motivated this, both had landed too, and gating them was
    // most of the 10-15 s.
    const written = readHarnessFixture('round2-candidate');
    const { provider: coder } = dialProvider({
      balanced: [written],
      aggressive: [written],
      conservative: [written],
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
    // All three files exist and are on screen…
    expect(eventsOf(events, 'rewrite.done').map((e) => e.candidate)).toEqual([0, 1, 2]);
    const candidates = result.attempts[0]!.candidates!;
    expect(candidates).toHaveLength(3);
    // …and exactly one of them was judged.
    expect(candidates.map((c) => [c.candidate, c.approved, c.skippedReason])).toEqual([
      [0, true, undefined],
      [1, false, 'approved-sibling'],
      [2, false, 'approved-sibling'],
    ]);
    for (const sibling of candidates.slice(1)) expect(sibling.gates).toEqual([]);
    expect(eventsOf(events, 'trial.gate').filter((g) => g.candidate !== 0)).toEqual([]);
    // Skipped candidates emit no verdict of their own. The client counts files from
    // `rewrite.done` and never waits on a per-candidate verdict, so this cannot hang
    // the interlude (`packages/web/src/interlude/castStatus.ts`).
    expect(eventsOf(events, 'verdict').filter((v) => v.candidate !== undefined).map((v) => v.candidate)).toEqual([0]);
  }, 40_000);

  it('cuts the same candidates on every run, so two identical runs log the same thing', async () => {
    // `Promise.race` over already-settled promises resolves in iteration order, which
    // is why an immediate mock judges candidate 0 and skips 1 and 2 every time. The
    // cut is a consequence of the measured verdicts, never of who answered first.
    const shape = async (): Promise<unknown> => {
      const { provider: coder } = dialProvider({
        balanced: [readHarnessFixture('round2-candidate')],
        aggressive: [readGood('chaser')],
        conservative: [readGood('orbiter')],
      });
      const result = await rewrite({
        summary: cannedSummary('camper-a'),
        round: 2,
        prevSource: readGood('idle'),
        providers: { analyst: mockProvider([asAnalystReply(ANALYSIS)]), coder },
        candidates: 3,
        harnessOpts: { gate3: { matches: MATCHES } },
      });
      return {
        approved: result.approved,
        chosen: result.attempts[0]?.chosen,
        candidates: result.attempts[0]?.candidates?.map((c) => [c.candidate, c.approved, c.skippedReason]),
      };
    };
    expect(await shape()).toEqual(await shape());
  }, 60_000);
});

/**
 * THE FIRST ATTEMPT'S ANCHOR.
 *
 * Every quantitative thing the Coder is told arrives on a *retry*. On the
 * `claude-cli` path there is no retry, and the uncalibrated first attempt landed at
 * 0.26 / 0.20 / 0.00 vs panel against band middles of 0.42 / 0.58 / 0.68.
 */
describe('the first Coder prompt carries the incumbent, measured', () => {
  it('shows the boss it is replacing against the same bots and the same seeds', async () => {
    const analyst = mockProvider([asAnalystReply(ANALYSIS)]);
    const { provider: coder, prompts } = dialProvider({
      balanced: [readHarnessFixture('round2-candidate')],
      aggressive: [readHarnessFixture('round2-candidate')],
      conservative: [readHarnessFixture('round2-candidate')],
    });

    await rewrite({
      summary: cannedSummary('camper-a'),
      round: 2,
      // The null boss: it wins nothing against anything, which is the whole point
      // of quoting it — 0.00 is what the live runs kept writing and calling
      // "conservative".
      prevSource: readGood('idle'),
      prevMeta: { name: 'Statue', rationale: 'I do nothing.', version: 1 },
      providers: { analyst, coder },
      candidates: 3,
      harnessOpts: { gate3: { matches: MATCHES } },
    });

    for (const prompt of prompts) {
      expect(prompt).toContain('# THE BOSS YOU ARE REPLACING, MEASURED');
      expect(prompt).toContain('"Statue"');
      // The per-bot table, measured on Gate 3's own panel seeds.
      expect(prompt).toMatch(/Camper\s+0\.00/);
      expect(prompt).toContain('That is 0.00 vs the panel. You need 0.35–0.50, so aim at 0.42');
      // The sentence the 0.00 files needed.
      expect(prompt).toContain('it is absent');
    }
  }, 40_000);
});

/**
 * THE STRAGGLER CUT, SCALED — the other half of "one attempt, one candidate".
 *
 * The three 2026-09-11 artifacts each ended their attempt 6 000 ms after the first
 * Coder call resolved, to within 3 ms — `STRAGGLER_GRACE_MS` exactly, with 17 s of
 * deadline still unspent and both siblings still streaming. A fixed grace cannot
 * tell a broken call from a merely slower one without knowing what a healthy call
 * costs, so it is a floor now and the measured first call sets the rest.
 */
describe('the straggler grace scales with the first call that lands', () => {
  it('waits for a sibling that is slower than the winner but not broken', async () => {
    const analyst = mockProvider([asAnalystReply(ANALYSIS)]);
    const { provider: coder } = delayedDialProvider({
      balanced: { source: readGood('chaser'), delayMs: 1_500 },
      aggressive: { source: readHarnessFixture('round2-candidate'), delayMs: 2_100 },
      conservative: { source: readGood('orbiter'), delayMs: 2_100 },
    });

    const { emit, events } = recorder();
    const result = await rewrite(
      {
        summary: cannedSummary('camper-a'),
        round: 2,
        prevSource: readGood('idle'),
        providers: { analyst, coder },
        candidates: 3,
        // A floor far below the siblings' 600 ms lag: under the old fixed grace the
        // attempt would have been cut at 1 700 ms and judged one file. Scaled, the
        // grace is 1 500 × 0.6 = 900 ms, so the cut is at 2 400 ms and all three
        // land first.
        stragglerMs: 200,
        harnessOpts: { gate3: { matches: MATCHES } },
      },
      emit,
    );

    expect(STRAGGLER_LATENCY_RATIO).toBe(0.6);
    expect(200).toBeLessThan(1_500 * STRAGGLER_LATENCY_RATIO);
    expect(result.attempts[0]!.candidates).toHaveLength(3);
    expect(eventsOf(events, 'rewrite.done')).toHaveLength(3);
    // All three model calls landed, which is what this test is about. A candidate may
    // still go unjudged because a sibling passed first — that is the approval cut,
    // not the straggler one — so the assertion is on the *reason*.
    for (const log of result.attempts[0]!.candidates!) expect(log.skippedReason).not.toBe('deadline');
  }, 40_000);
});
