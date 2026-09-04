/**
 * The Gate 3 meter — the one number on screen that used to be a guess.
 *
 * It animated over a 4.2 s estimate and stopped at 85% so it could not claim to be
 * finished while the simulation ran; the closing `trial.progress` snapped it shut.
 * `simulate()` now reports batched progress, so the bar is a readout of matches the
 * harness has actually finished, and these tests pin the properties that make it
 * one: it starts empty, it never claims to be done early, it never overshoots, and
 * `done` means done.
 *
 * DOM-free on purpose (`vitest.config.ts` runs Node): the meter's whole behaviour is
 * this function, and the rendering around it is covered by the Playwright suite.
 */
import { describe, expect, it } from 'vitest';

import { meterView } from '../src/interlude/ui.ts';

describe('meterView', () => {
  it('reads out the fraction of matches that are really finished', () => {
    expect(meterView(0, 200)).toMatchObject({ fraction: 0, count: '0 / 200', done: false });
    expect(meterView(50, 200)).toMatchObject({ fraction: 0.25, count: '50 / 200', done: false });
    expect(meterView(130, 200).fraction).toBeCloseTo(0.65, 10);
  });

  it('labels the total while simulating, and stops naming it when it is over', () => {
    expect(meterView(0, 200).label).toBe('Gate 3 · simulating 200 matches');
    expect(meterView(190, 200).label).toBe('Gate 3 · simulating 200 matches');
    expect(meterView(200, 200).label).toBe('Gate 3 · simulated');
  });

  it('is only `done` at the total — no estimate can fill it early', () => {
    // The old meter's 85% cap existed because it did not know. This one does: at
    // 199 of 200 it is still simulating, and one match later it is not.
    expect(meterView(199, 200).done).toBe(false);
    expect(meterView(199, 200).fraction).toBeLessThan(1);
    expect(meterView(200, 200)).toMatchObject({ fraction: 1, done: true });
  });

  it('never overshoots, and never goes backwards past zero', () => {
    // A total that shrank between events (the gate's rounding) must not produce a
    // bar wider than the track.
    expect(meterView(220, 200)).toMatchObject({ fraction: 1, count: '200 / 200', done: true });
    expect(meterView(-5, 200)).toMatchObject({ fraction: 0, count: '0 / 200' });
  });

  it('survives a degenerate total rather than dividing by zero', () => {
    expect(meterView(0, 0)).toMatchObject({ fraction: 0, done: false });
    expect(Number.isFinite(meterView(0, 0).fraction)).toBe(true);
    expect(meterView(1, 0)).toMatchObject({ fraction: 1, done: true });
  });

  it('rises monotonically across a realistic batched series', () => {
    // What the loop actually emits for the spec's 200 matches: 0, then one event
    // per batch of 10.
    const series = [0, ...Array.from({ length: 20 }, (_, i) => (i + 1) * 10)];
    const views = series.map((done) => meterView(done, 200));

    let previous = -1;
    for (const view of views) {
      expect(view.fraction).toBeGreaterThan(previous);
      previous = view.fraction;
    }
    expect(views.at(-1)).toMatchObject({ fraction: 1, done: true, count: '200 / 200' });
    // Exactly one event in the series claims completion.
    expect(views.filter((v) => v.done)).toHaveLength(1);
  });
});
