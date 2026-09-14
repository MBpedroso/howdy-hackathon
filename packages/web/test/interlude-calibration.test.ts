/**
 * The Judge's calibration, as the player reads it.
 *
 * The loop gained a deterministic search of its own: a candidate that misses the
 * fairness band and nothing else has its one declared constant (`const PRESSURE`)
 * rewritten by the harness, all four gates re-run, and the value bisected until the
 * panel rate lands in the round's band (`packages/agents/src/calibrate.ts`). On
 * screen that has to read as arithmetic — because it is — and it has to explain how
 * a file whose own `✗ Gate 3` row is visible ends up APPROVED.
 *
 * Everything asserted here is pure: the cast reducer (`castStatus.ts`) and the
 * strip/verdict formatters (`ui.ts`), which is where all the interesting behaviour
 * is. DOM-free, like the rest of `test/` (`vitest.config.ts` runs Node); the
 * rendering is covered by the Playwright suite — except for these events, which no
 * local source emits yet (see the note at the bottom of this file).
 */
import { describe, expect, it } from 'vitest';

import {
  castStatus,
  formatThrottle,
  INITIAL_CAST,
  reduceCast,
  type CastState,
} from '../src/interlude/castStatus.ts';
import { readThrottle, UNTHROTTLED, type RewriteEvent } from '../src/interlude/events.ts';
import {
  calibratedPlain,
  calibratedVerdictLine,
  calibrationHead,
  calibrationRow,
  throttleChain,
  type CalibrationStepView,
} from '../src/interlude/ui.ts';

/** Fold a run of events, so a test can assert one moment of the screen. */
function play(events: readonly RewriteEvent[], from: CastState = INITIAL_CAST): CastState {
  return events.reduce(reduceCast, from);
}

const step = (over: Partial<Extract<RewriteEvent, { type: 'calibrate.step' }>> = {}): RewriteEvent => ({
  type: 'calibrate.step',
  attempt: 1,
  candidate: 0,
  candidates: 3,
  step: 1,
  pressure: 0.5,
  panel: 0.22,
  ok: false,
  reason: '0.22 vs panel — outside the band 0.35–0.50 for round 2 (too easy)',
  ...over,
});

const wrote = (name: string): RewriteEvent => ({
  type: 'rewrite.done',
  attempt: 1,
  source: 'const PRESSURE = 1.0;\n',
  diff: '',
  meta: { name, rationale: 'y', version: 1 },
  candidate: 0,
  candidates: 3,
});

describe('the cast reducer', () => {
  it('says the Judge is calibrating, with the step and the value it is measuring', () => {
    const one = play([wrote('Warden'), step()]);
    expect(one.calibrating).toBe(true);
    expect(one.calibrationStep).toBe(1);
    expect(one.calibrationPressure).toBe(0.5);
    expect(castStatus(one).judge).toBe('calibrating the boss — step 1, throttle 0.50…');

    // Present tense with the ellipsis while it runs, and the number moves with the
    // search rather than being a generic "working".
    const two = play([step({ step: 2, pressure: 0.71, panel: 0.44 })], one);
    expect(castStatus(two).judge).toBe('calibrating the boss — step 2, throttle 0.71…');
  });

  it('is the Judge, not the Coder: no thinking, no spinner, no adjectives', () => {
    const line = castStatus(play([wrote('Warden'), step()])).judge;
    for (const word of ['think', 'reason', 'consider', 'trying', 'AI', 'model']) {
      expect(line.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });

  it('stops calibrating when the search lands, and keeps where it landed', () => {
    const state = play([
      wrote('Warden'),
      step(),
      { type: 'calibrate.step', attempt: 1, candidate: 0, candidates: 3, step: 2, pressure: 0.71, panel: 0.44, ok: true },
      { type: 'calibrate.done', attempt: 1, candidate: 0, candidates: 3, steps: 2, pressure: 0.71, approved: true },
    ]);
    expect(state.calibrating).toBe(false);
    expect(state.calibration).toEqual({ steps: 2, pressure: 0.71, approved: true });

    // The verdict that follows is the one the player reads — the calibrated file is
    // the candidate from there on, so the Judge's line is a plain approval.
    const approved = play([{ type: 'verdict', attempt: 1, approved: true, candidate: 0, candidates: 3, panel: 0.44 }], state);
    expect(castStatus(approved).judge).toBe('✓ approved Warden');
  });

  it('a search that found nothing leaves the rejection standing', () => {
    const state = play([
      wrote('Warden'),
      step(),
      step({ step: 2, pressure: 0.25, panel: 0.11 }),
      { type: 'calibrate.done', attempt: 1, candidate: 0, candidates: 3, steps: 2, pressure: 0.25, approved: false },
      {
        type: 'verdict',
        attempt: 1,
        approved: false,
        candidate: 0,
        candidates: 3,
        reason: '0.11 vs panel — outside the band 0.35–0.50 for round 2 (too easy)',
      },
    ]);
    expect(state.calibrating).toBe(false);
    expect(state.calibration?.approved).toBe(false);
    expect(castStatus(state).judge).toBe('✗ rejected Warden — too easy to be a fight');
  });

  it('a new attempt starts a clean search', () => {
    const state = play([
      wrote('Warden'),
      step(),
      { type: 'rewrite.delta', attempt: 2, delta: 'export ', candidate: 0, candidates: 3 },
    ]);
    expect(state.calibrating).toBe(false);
    expect(state.calibrationStep).toBe(0);
    expect(state.calibrationPressure).toBe(null);
    expect(state.calibration).toBe(null);
  });

  it('a new candidate re-measured in the same attempt starts a clean chain', () => {
    // `step: 1` is the marker for "a new search": the previous candidate's landing
    // must not still be on screen under the new one's first step.
    const state = play([
      wrote('Warden'),
      step(),
      { type: 'calibrate.done', attempt: 1, candidate: 0, candidates: 3, steps: 1, pressure: 0.5, approved: false },
      step({ candidate: 1, step: 1, pressure: 2 }),
    ]);
    expect(state.calibration).toBe(null);
    expect(state.calibrating).toBe(true);
  });
});

describe('the throttle chain', () => {
  const measured: CalibrationStepView[] = [
    {
      step: 1,
      pressure: 0.5,
      panel: 0.22,
      ok: false,
      reason: '0.22 vs panel — outside the band 0.35–0.50 for round 2 (too easy)',
    },
    { step: 2, pressure: 0.71, panel: 0.44, ok: true },
  ];

  it('starts at the value the Coder wrote and walks the ones the Judge measured', () => {
    expect(throttleChain(1, measured)).toBe('throttle 1.00 → 0.50 → 0.71');
  });

  it('starts at the first measurement when the file had no readable knob', () => {
    // Not "throttle ? → 0.50": the interlude prints numbers it has, and invents none.
    expect(throttleChain(null, measured)).toBe('throttle 0.50 → 0.71');
    expect(throttleChain(null, [])).toBe('throttle —');
  });

  it('is two decimals throughout, so the chain lines up as a search', () => {
    expect(formatThrottle(1)).toBe('1.00');
    expect(formatThrottle(0.5)).toBe('0.50');
    expect(formatThrottle(0.708)).toBe('0.71');
  });
});

describe('the strip', () => {
  const measured: CalibrationStepView[] = [
    {
      step: 1,
      pressure: 0.5,
      panel: 0.22,
      ok: false,
      reason: '0.22 vs panel — outside the band 0.35–0.50 for round 2 (too easy)',
    },
    { step: 2, pressure: 0.71, panel: 0.44, ok: true },
  ];

  it('reads CALIBRATING while the steps arrive', () => {
    expect(calibrationHead({ from: 1, measured: measured.slice(0, 1), done: null })).toBe(
      'CALIBRATING · throttle 1.00 → 0.50',
    );
  });

  it('says where it shipped, and what the search cost', () => {
    expect(calibrationHead({ from: 1, measured, done: { steps: 2, pressure: 0.71, approved: true } })).toBe(
      'CALIBRATED · throttle 1.00 → 0.50 → 0.71 · shipped at 0.71 (2 steps)',
    );
    expect(
      calibrationHead({ from: 1, measured, done: { steps: 1, pressure: 0.5, approved: false } }),
    ).toBe('CALIBRATED · throttle 1.00 → 0.50 → 0.71 · no throttle passed (1 step)');
  });

  it('names the file it re-measured, but only when there is more than one', () => {
    // The strip sits in its own block under the gate list now, not inside that
    // candidate's gate rows, so with K files it has to say which one it is about.
    expect(calibrationHead({ who: 'candidate 2', from: 1, measured, done: null })).toBe(
      'candidate 2 · CALIBRATING · throttle 1.00 → 0.50 → 0.71',
    );
    expect(calibrationHead({ who: null, from: 1, measured, done: null })).toBe(
      'CALIBRATING · throttle 1.00 → 0.50 → 0.71',
    );
  });

  it('puts the measured rate next to every step, and the harness sentence when it failed', () => {
    expect(calibrationRow(measured[0] as CalibrationStepView)).toEqual({
      mark: '✗',
      throttle: 'throttle 0.50',
      rate: 'panel 0.22',
      // Plain words in the row; the harness's sentence rides along as the tooltip
      // (the candidate's own rejection stays verbatim in the gate rows above it).
      why: 'too easy to be a fight',
      detail: '0.22 vs panel — outside the band 0.35–0.50 for round 2 (too easy)',
      ok: false,
    });
    // The step that passed is the one that ships, and is marked as such.
    expect(calibrationRow(measured[1] as CalibrationStepView)).toEqual({
      mark: '✓',
      throttle: 'throttle 0.71',
      rate: 'panel 0.44',
      why: 'in band — all four gates pass',
      detail: '',
      ok: true,
    });
  });

  it('does not invent a rate for a step that never reached Gate 3', () => {
    const row = calibrationRow({ step: 1, pressure: 0.5, ok: false, reason: 'the boss was motionless for 300 ticks' });
    expect(row.rate).toBe('panel not reached');
    expect(row.why).toBe('it stood still instead of fighting');
    expect(row.detail).toBe('the boss was motionless for 300 ticks');
  });
});

describe('the calibrated verdict', () => {
  it('is one plain sentence: the rate, the value, and what it cost', () => {
    expect(calibratedVerdictLine({ panel: 0.44, from: 1, to: 0.71, steps: 3 })).toBe(
      '0.44 vs panel after the Judge throttled the boss to 0.71 (3 steps)',
    );
    expect(calibratedVerdictLine({ panel: 0.44, from: 1, to: 0.71, steps: 1 })).toBe(
      '0.44 vs panel after the Judge throttled the boss to 0.71 (1 step)',
    );
  });

  it('follows the direction the knob actually moved', () => {
    // The knob moves both ways — a file that is too *easy* is pushed up — so
    // "throttled" would be a claim about a search that never happened.
    expect(calibratedVerdictLine({ panel: 0.52, from: 1, to: 2, steps: 2 })).toContain(
      'pushed the boss to 2.00',
    );
    expect(calibratedVerdictLine({ panel: 0.52, from: 1, to: 1, steps: 2 })).toContain(
      'settled the boss at 1.00',
    );
    expect(calibratedVerdictLine({ panel: 0.52, from: null, to: 0.5, steps: 2 })).toContain(
      'set the boss to 0.50',
    );
  });

  it('quotes the Mimic rate only when there is one', () => {
    expect(calibratedVerdictLine({ panel: 0.44, from: 1, to: 0.71, steps: 2, mimic: 0.62 })).toBe(
      '0.44 vs panel after the Judge throttled the boss to 0.71 (2 steps) · mimic 0.62',
    );
    // A calibration step reports no Mimic rate, and the Coder's own pass measured a
    // different file — so a calibrated approval quotes none rather than the wrong one.
    expect(calibratedVerdictLine({ panel: 0.44, from: 1, to: 0.71, steps: 2, mimic: null })).not.toContain('mimic');
  });

  it('still rules when Gate 3 reported no number', () => {
    expect(calibratedVerdictLine({ panel: null, from: 1, to: 0.71, steps: 2 })).toBe(
      'approved after the Judge throttled the boss to 0.71 (2 steps)',
    );
  });

  it('says the same thing in words, with the file by name', () => {
    // One line, unlike the uncalibrated approval's two: the strip above the stamp is
    // four lines the Trial panel did not have, and the footer already names the boss.
    expect(calibratedPlain('Warden II', 1, 0.71)).toBe('Warden II is fair once the Judge eased it off');
    expect(calibratedPlain('Warden II', 1, 2)).toBe('Warden II is fair once the Judge pushed it harder');
    expect(calibratedPlain(null, null, 0.71)).toBe('it is fair at the throttle the Judge measured');
  });
});

describe('the throttle, read out of the file on screen', () => {
  it('reads the value the Judge wrote into the file', () => {
    expect(readThrottle('// ---- calibrated by the Judge ----\nconst THROTTLE = 0.5;\n')).toBe(0.5);
    expect(readThrottle('const THROTTLE = 0.354;\n')).toBe(0.354);
  });

  it('refuses anything that is not the injected line', () => {
    // The block's own line is at column zero and is the only one. `calibrate.ts`
    // reads it exactly this narrowly, and the chain must not print a value the
    // search never set.
    expect(readThrottle('export const meta = {};\n')).toBe(null);
    expect(readThrottle('const THROTTLE = 0.5;\nconst THROTTLE = 0.7;\n')).toBe(null);
    expect(readThrottle('  const THROTTLE = 0.5;\n')).toBe(null);
    expect(readThrottle('// const THROTTLE = 0.5;\n')).toBe(null);
  });

  it('calls an unwrapped file 1.0, which is what the harness means by it', () => {
    // `THROTTLE_MAX` is 1.0 and the injected block short-circuits at `>= 1`, so a
    // chain starting at 1.00 describes the Coder's file rather than rounding up.
    expect(UNTHROTTLED).toBe(1);
    expect(throttleChain(UNTHROTTLED, [{ step: 1, pressure: 0.5, panel: 0.22, ok: false }])).toBe(
      'throttle 1.00 → 0.50',
    );
  });
});
