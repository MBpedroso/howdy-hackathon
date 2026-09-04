/**
 * The status lines: events in, "who is doing what" out.
 *
 * This is the mapping a playtester's complaint bought — *"the player can't connect
 * what's happening to who is doing it"* — and it is the whole of the fix that can be
 * tested without a browser, so it is tested here rather than only in a screenshot.
 * `reduceCast` and `castStatus` are pure (`src/interlude/castStatus.ts`); the DOM
 * side is asserted by `e2e/interlude.spec.ts`.
 *
 * The sequence matters more than any single line, because what the player watches is
 * the *change*: "watching your replay…" → "found 6 patterns", "running 200 simulated
 * fights…" → "✗ rejected Warden I — too easy". So most of these tests fold a run of
 * events and assert the line at each step.
 */
import { describe, expect, it } from 'vitest';

import {
  INITIAL_CAST,
  castStatus,
  fallbackHeadline,
  plainVerdict,
  reduceCast,
  replayStatus,
  type CastState,
} from '../src/interlude/castStatus.ts';
import type { Analysis, GateResult, RewriteEvent } from '../src/interlude/events.ts';

const ANALYSIS: Analysis = {
  observations: ['a', 'b', 'c', 'd', 'e', 'f'],
  playerArchetype: 'camper',
  counterPlan: 'hold the middle',
};

/** Enough of a `ReplaySummary` for the reducer, which reads none of it. */
const SUMMARY = { seed: 1 } as unknown as Extract<RewriteEvent, { type: 'replay' }>['summary'];

const gate = (over: Partial<GateResult> = {}): GateResult =>
  ({ gate: 3, name: 'balance', ok: true, ms: 10, ...over }) as GateResult;

/** Fold a run of events and return the state, so a test can assert one moment. */
function play(events: readonly RewriteEvent[], from: CastState = INITIAL_CAST): CastState {
  return events.reduce(reduceCast, from);
}

const status = (events: readonly RewriteEvent[]): Record<'analyst' | 'coder' | 'judge', string> =>
  castStatus(play(events));

describe('the Analyst', () => {
  it('watches, then writes, then reports what it found', () => {
    expect(castStatus(INITIAL_CAST).analyst).toBe('watching your replay…');
    expect(status([{ type: 'replay', summary: SUMMARY, round: 2 }]).analyst).toBe('watching your replay…');
    expect(status([{ type: 'analysis.delta', delta: 'You camped' }]).analyst).toBe('writing down your habits…');

    const done = status([
      { type: 'analysis.delta', delta: 'You camped' },
      { type: 'analysis.done', analysis: ANALYSIS, calls: 1, promptChars: 10, usage: { inputTokens: 1, outputTokens: 2 }, ms: 1200 },
    ]);
    // The number is the Analyst's own count of observations, and the archetype is
    // the word it used — the line is a reading of the JSON, not a summary of it.
    expect(done.analyst).toBe('found 6 patterns · you play like a camper');
  });

  it('counts one pattern in the singular', () => {
    const one = status([
      { type: 'analysis.done', analysis: { ...ANALYSIS, observations: ['only this'] }, calls: 1, promptChars: 1, usage: { inputTokens: 1, outputTokens: 1 }, ms: 1 },
    ]);
    expect(one.analyst).toBe('found 1 pattern · you play like a camper');
  });

  // The Replay beat's portrait is dimmed until this flips: an agent that is present
  // but has not started working yet.
  it('does not count as started until the first delta', () => {
    expect(play([{ type: 'replay', summary: SUMMARY, round: 2 }]).analysisStarted).toBe(false);
    expect(play([{ type: 'analysis.delta', delta: 'x' }]).analysisStarted).toBe(true);
  });
});

describe('the Coder', () => {
  it('waits for the analysis, then counts the files it is writing', () => {
    expect(castStatus(INITIAL_CAST).coder).toBe('waiting for the analysis…');

    const writing = play([{ type: 'rewrite.delta', attempt: 1, delta: 'export', candidate: 0, candidates: 3 }]);
    expect(castStatus(writing).coder).toBe('writing candidate 1 of 3…');

    const one = play([{ type: 'rewrite.done', attempt: 1, source: 's', diff: 'd', candidate: 0, candidates: 3, meta: { name: 'Warden I', rationale: 'r', version: 2 } }], writing);
    expect(castStatus(one).coder).toBe('writing candidate 2 of 3…');
  });

  it('says how many strategies it wrote once they are all in', () => {
    const all = play([
      { type: 'rewrite.delta', attempt: 1, delta: 'a', candidate: 0, candidates: 3 },
      { type: 'rewrite.done', attempt: 1, source: 's', diff: 'd', candidate: 0, candidates: 3, meta: { name: 'A I', rationale: 'r', version: 2 } },
      { type: 'rewrite.done', attempt: 1, source: 's', diff: 'd', candidate: 2, candidates: 3, meta: { name: 'C III', rationale: 'r', version: 2 } },
      { type: 'rewrite.done', attempt: 1, source: 's', diff: 'd', candidate: 1, candidates: 3, meta: { name: 'B II', rationale: 'r', version: 2 } },
    ]);
    expect(castStatus(all).coder).toBe('3 strategies written');
    // The files finish in whatever order the model finishes them, and candidate 2
    // arriving before candidate 1 leaves a hole in the array. "candidate 4 of 3"
    // is what a naive counter puts on screen.
    expect(all.written).toBe(3);
  });

  it('names the attempt from the second one on — that is the story', () => {
    const retry = play([
      { type: 'rewrite.delta', attempt: 1, delta: 'a', candidate: 0, candidates: 3 },
      { type: 'rewrite.delta', attempt: 2, delta: 'a', candidate: 0, candidates: 3 },
    ]);
    expect(castStatus(retry).coder).toBe('attempt 2 of 4 · writing candidate 1 of 3…');
  });

  it('reads naturally for a single-candidate stream', () => {
    const single = play([{ type: 'rewrite.delta', attempt: 1, delta: 'a' }]);
    expect(castStatus(single).coder).toBe('writing a new strategy…');
    const done = play([{ type: 'rewrite.done', attempt: 1, source: 's', diff: 'd', meta: { name: 'Solo', rationale: 'r', version: 2 } }], single);
    expect(castStatus(done).coder).toBe('1 strategy written');
    expect(done.bossName).toBe('Solo');
  });
});

describe('the Judge', () => {
  const wrote = (name: string): RewriteEvent[] => [
    { type: 'rewrite.delta', attempt: 1, delta: 'a', candidate: 0, candidates: 3 },
    { type: 'rewrite.done', attempt: 1, source: 's', diff: 'd', candidate: 0, candidates: 3, meta: { name, rationale: 'r', version: 2 } },
  ];

  it('waits, simulates with the harness\'s own count, then rules', () => {
    expect(castStatus(INITIAL_CAST).judge).toBe('waiting for a strategy…');

    const submitted = play(wrote('Warden I'));
    expect(castStatus(submitted).judge).toBe('checking the file…');

    const running = play(
      [{ type: 'trial.progress', attempt: 1, matchesDone: 40, matchesTotal: 200, gate: 'balance', candidate: 0 }],
      submitted,
    );
    // 200 is the harness's number, not a constant in the UI.
    expect(castStatus(running).judge).toBe('running 200 simulated fights…');

    const rejected = play(
      [
        { type: 'trial.progress', attempt: 1, matchesDone: 200, matchesTotal: 200, gate: 'balance', candidate: 0 },
        { type: 'trial.gate', attempt: 1, gate: gate({ ok: false, reason: '0.21 vs panel — too easy, band 0.35–0.50 for round 2' } as Partial<GateResult>), candidate: 0 },
        { type: 'verdict', attempt: 1, approved: false, reason: '0.21 vs panel — too easy, band 0.35–0.50 for round 2', candidate: 0 },
      ],
      running,
    );
    // Named, so the player can tell which of the three files was thrown out.
    expect(castStatus(rejected).judge).toBe('✗ rejected Warden I — too easy to be a fight');
    expect(rejected.rejections).toBe(1);
  });

  it('announces the approval by name', () => {
    const approved = play([
      ...wrote('Lantern III'),
      { type: 'verdict', attempt: 1, approved: true, candidate: 0 },
    ]);
    expect(castStatus(approved).judge).toBe('✓ approved Lantern III');
    expect(approved.approvedName).toBe('Lantern III');
  });

  // While the next candidate is being measured, "running…" outranks the last
  // rejection: the judge is doing something *now*, and the rejection is preserved in
  // the log and the stamp regardless (spec §2.2).
  it('goes back to simulating when the next candidate starts', () => {
    const next = play([
      ...wrote('Warden I'),
      { type: 'verdict', attempt: 1, approved: false, reason: 'too hard', candidate: 0 },
      { type: 'trial.progress', attempt: 1, matchesDone: 0, matchesTotal: 200, gate: 'balance', candidate: 1 },
    ]);
    expect(castStatus(next).judge).toBe('running 200 simulated fights…');
  });

  // The loop keeps measuring the remaining candidates after one passes (it ships
  // whichever lands closest to the middle of the band), so the newest file the
  // Coder wrote is not necessarily the one that was approved. The attempt-level
  // verdict that follows the per-candidate ones carries no `candidate` and must not
  // rename the approval.
  it('keeps the approved candidate\'s name when the attempt-level verdict lands', () => {
    const approved = play([
      { type: 'rewrite.delta', attempt: 1, delta: 'a', candidate: 0, candidates: 3 },
      { type: 'rewrite.done', attempt: 1, source: 's', diff: 'd', candidate: 1, candidates: 3, meta: { name: 'Warden II', rationale: 'r', version: 2 } },
      { type: 'verdict', attempt: 1, approved: true, candidate: 1 },
      // A later candidate finishes and is measured anyway.
      { type: 'rewrite.done', attempt: 1, source: 's', diff: 'd', candidate: 2, candidates: 3, meta: { name: 'Warden III', rationale: 'r', version: 2 } },
      { type: 'verdict', attempt: 1, approved: true },
    ]);
    expect(castStatus(approved).judge).toBe('✓ approved Warden II');
  });

  it('names it from the attempt-level verdict alone when the stream sends no per-candidate one', () => {
    const single = play([
      { type: 'rewrite.delta', attempt: 1, delta: 'a' },
      { type: 'rewrite.done', attempt: 1, source: 's', diff: 'd', meta: { name: 'Solo', rationale: 'r', version: 2 } },
      { type: 'verdict', attempt: 1, approved: true },
    ]);
    expect(castStatus(single).judge).toBe('✓ approved Solo');
  });

  it('takes the approved name from the terminal done, whatever came before', () => {
    const done = play([
      ...wrote('Warden I'),
      {
        type: 'done',
        result: { approved: true, source: 's', meta: { name: 'Lantern III', rationale: 'r', version: 2 }, attempts: [], analysis: ANALYSIS },
      },
    ]);
    expect(castStatus(done).judge).toBe('✓ approved Lantern III');
    expect(done.done).toBe(true);
    // Nothing is acting once it is over: every glow goes out.
    expect(done.active).toBeNull();
  });

  it('says the fallback out loud — spec AC 5 is a verdict too', () => {
    const timedOut = play([{ type: 'fallback', reason: 'deadline' }]);
    expect(castStatus(timedOut).judge).toBe('⏱ the coder ran out of time — shipping a pre-approved strategy');

    const exhausted = play([{ type: 'fallback', reason: 'max-attempts' }]);
    expect(castStatus(exhausted).judge).toBe('✗ 4 attempts, none approved — shipping a pre-approved strategy');
  });
});

describe('replayStatus', () => {
  // The Analyst owns two panels. Repeating "found 4 patterns · you play like a
  // dodger" on both says the same thing twice on one screen, so the Replay panel's
  // line becomes a caption for the evidence once the reading exists.
  it('tracks the Analyst until it has read the tape, then captions it', () => {
    expect(replayStatus(INITIAL_CAST)).toBe('watching your replay…');
    expect(replayStatus(play([{ type: 'analysis.delta', delta: 'x' }]))).toBe('writing down your habits…');
    const read = play([
      { type: 'analysis.done', analysis: ANALYSIS, calls: 1, promptChars: 1, usage: { inputTokens: 1, outputTokens: 1 }, ms: 1 },
    ]);
    expect(replayStatus(read)).toBe('this is the tape it read');
    // The reading itself is next door, unchanged.
    expect(castStatus(read).analyst).toBe('found 6 patterns · you play like a camper');
  });
});

describe('plainVerdict', () => {
  // The harness's sentence stays on screen verbatim; this is the headline over it.
  it('turns each rejection shape into words a player can act on', () => {
    expect(plainVerdict('0.91 vs panel — too hard, band 0.35–0.50 for round 2')).toContain('too hard');
    expect(plainVerdict('0.21 vs panel — too easy, band 0.35–0.50 for round 2')).toContain('too easy');
    expect(plainVerdict("0.41 vs Mimic — didn't adapt, needs ≥ 0.70")).toBe("it didn't counter you");
    expect(plainVerdict('motionless for 183 ticks against Camper')).toBe('it stood still instead of fighting');
    expect(plainVerdict('meta.name must be a string literal', 1)).toBe('the file broke the boss contract');
    expect(plainVerdict('invalid action at tick 88', 2)).toBe('it broke a rule under fuzzing');
    expect(plainVerdict('p99 3.4ms over the 2ms budget', 4)).toBe('too slow to run inside a frame');
  });

  it('reads "too hard" before "Mimic", because a Gate 3 sentence names both', () => {
    // The real sentence lists the Mimic rate inline even when the band is what
    // failed, so the order of the checks is load-bearing.
    expect(plainVerdict('0.91 vs panel — too hard · 0.99 vs Mimic')).toContain('too hard');
  });

  it('never returns an empty line, whatever it is handed', () => {
    expect(plainVerdict(undefined)).toBe('rejected by the harness');
    expect(plainVerdict('')).toBe('rejected by the harness');
    expect(plainVerdict('something nobody anticipated')).toBe('rejected by the harness');
  });
});

describe('fallbackHeadline', () => {
  it('says which of the three ways it ended', () => {
    expect(fallbackHeadline('deadline')).toBe('⏱ the coder ran out of time');
    expect(fallbackHeadline('max-attempts')).toBe('✗ 4 attempts, none approved');
    expect(fallbackHeadline('error')).toBe('✗ the rewrite failed');
  });
});

describe('who is acting', () => {
  // The glow follows this, and the glow is how "who is doing it" is answered in one
  // glance. The hand-off happens on `analysis.done`, before the Coder's first
  // delta — the Coder has the floor from the moment it is called.
  it('hands off Analyst → Coder → Judge', () => {
    expect(play([{ type: 'replay', summary: SUMMARY, round: 2 }]).active).toBe('analyst');
    expect(play([{ type: 'analysis.delta', delta: 'x' }]).active).toBe('analyst');
    expect(
      play([{ type: 'analysis.done', analysis: ANALYSIS, calls: 1, promptChars: 1, usage: { inputTokens: 1, outputTokens: 1 }, ms: 1 }]).active,
    ).toBe('coder');
    expect(play([{ type: 'rewrite.delta', attempt: 1, delta: 'x' }]).active).toBe('coder');
    expect(play([{ type: 'trial.gate', attempt: 1, gate: gate() }]).active).toBe('judge');
  });

  it('hands back to the Coder for a retry', () => {
    const retry = play([
      { type: 'trial.gate', attempt: 1, gate: gate({ ok: false, reason: 'too hard' } as Partial<GateResult>) },
      { type: 'verdict', attempt: 1, approved: false, reason: 'too hard' },
      { type: 'rewrite.delta', attempt: 2, delta: 'x' },
    ]);
    expect(retry.active).toBe('coder');
    // And the Judge's last word is still readable while the Coder works.
    expect(castStatus(retry).judge).toContain('✗ rejected');
  });
});
