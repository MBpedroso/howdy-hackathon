/**
 * `chooseCandidate` — analysis item 6 (`docs/ANALYSIS-learning-signal-2026-09-09.md`).
 *
 * Before this file's assertions existed, `chooseCandidate` was tested only through
 * `loop.test.ts`'s end-to-end runs, which never happened to produce two *approved*
 * candidates in the same attempt — so the tie-break the selection rule actually
 * needs (Mimic rate, once fairness is a wash) had no test at all. These four cases
 * are the ones the analysis names: approval beats everything, a near-tie goes to
 * the counter that measurably worked, a real difference in fairness still wins over
 * a bigger Mimic number, and a candidate with no Mimic reading never beats one that
 * has one.
 */
import { describe, expect, it } from 'vitest';
import { chooseCandidate, type CandidateLog } from '../src/index.ts';
import type { GateResult } from '@rematch/harness';

/** A passing Gate 3 result carrying the one field `balanceRates` reads for this file: `mimic`. */
function gate3(mimic?: number): GateResult {
  return {
    gate: 3,
    name: 'balance',
    ok: true,
    ms: 1,
    detail: {
      panel: { perBot: [{ name: 'Camper', winRate: 1 }] },
      ...(mimic === undefined ? {} : { mimic: { winRate: mimic } }),
    },
  };
}

/** A minimal `CandidateLog`, defaulted to "approved, measured, no Mimic reading". */
function log(over: Partial<CandidateLog> & { panel?: number; mimic?: number }): CandidateLog {
  const { mimic, ...rest } = over;
  return {
    candidate: 0,
    source: '',
    diff: '',
    coder: { calls: 1, promptChars: 0, usage: { inputTokens: 0, outputTokens: 0 }, ms: 0 },
    gates: [gate3(mimic)],
    approved: true,
    ...rest,
  };
}

const BAND_MID = 0.425; // round 2's band, (0.35 + 0.50) / 2

describe('chooseCandidate', () => {
  it('K=1: a single log is returned unchanged regardless of its fields', () => {
    const only = log({ panel: 0.91, approved: false, reason: 'too hard' });
    expect(chooseCandidate([only], BAND_MID)).toBe(only);
  });

  it('(a) approved beats rejected regardless of Mimic', () => {
    const rejected = log({ candidate: 0, panel: 0.43, mimic: 0.99, approved: false, reason: 'too hard' });
    const approved = log({ candidate: 1, panel: 0.20, mimic: 0.0, approved: true });
    expect(chooseCandidate([rejected, approved], BAND_MID)).toBe(approved);
    expect(chooseCandidate([approved, rejected], BAND_MID)).toBe(approved);
  });

  it('(b) two approved candidates in the same 0.03 bucket: the higher Mimic rate wins', () => {
    // |0.43 - 0.425| = 0.005 and |0.435 - 0.425| = 0.010 both round to bucket 0 —
    // measurement noise, per DIST_BUCKET's rationale — so Mimic breaks the tie.
    const low = log({ candidate: 0, panel: 0.43, mimic: 0.31, approved: true });
    const high = log({ candidate: 1, panel: 0.435, mimic: 0.88, approved: true });
    // Sanity: same bucket, different distance to bandMid, mimic disagrees with distance.
    expect(Math.round(Math.abs(0.43 - BAND_MID) / 0.03)).toBe(Math.round(Math.abs(0.435 - BAND_MID) / 0.03));
    expect(chooseCandidate([low, high], BAND_MID)).toBe(high);
    expect(chooseCandidate([high, low], BAND_MID)).toBe(high);
  });

  it('(c) two approved candidates in different buckets: the nearer band-mid wins even with lower Mimic', () => {
    const near = log({ candidate: 0, panel: 0.43, mimic: 0.10, approved: true });
    const far = log({ candidate: 1, panel: 0.60, mimic: 0.95, approved: true });
    expect(Math.round(Math.abs(0.43 - BAND_MID) / 0.03)).not.toBe(Math.round(Math.abs(0.60 - BAND_MID) / 0.03));
    expect(chooseCandidate([near, far], BAND_MID)).toBe(near);
    expect(chooseCandidate([far, near], BAND_MID)).toBe(near);
  });

  it('(d) an unmeasured Mimic ranks below any measured Mimic within the same bucket', () => {
    const noMimic = log({ candidate: 0, panel: 0.43, approved: true }); // gate3(undefined)
    const measured = log({ candidate: 1, panel: 0.435, mimic: 0.01, approved: true });
    expect(Math.round(Math.abs(0.43 - BAND_MID) / 0.03)).toBe(Math.round(Math.abs(0.435 - BAND_MID) / 0.03));
    expect(chooseCandidate([noMimic, measured], BAND_MID)).toBe(measured);
    expect(chooseCandidate([measured, noMimic], BAND_MID)).toBe(measured);
  });
});
