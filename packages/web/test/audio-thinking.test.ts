/**
 * The interlude's thinking texture — when it sounds (`audio/thinking.ts`). DOM-free,
 * Tone-free, timer-free: `now` is a fabricated number on every event, which is what
 * lets the idle boundary itself be pinned exactly rather than approximated with a
 * real `setTimeout` and a flaky assertion window (the same discipline the typewriter
 * throttle's own tests used before this replaced them).
 *
 * The one behaviour worth naming up front, because it is the whole difference from
 * the tick this replaced: a *span*, not an event. The old reducer answered "may I
 * click now?" per delta; this one answers "is the machine still working?", which
 * means the interesting cases are the gaps inside a stream (it must stay on) and the
 * silence after one (it must go off, and stay off once the screen is gone).
 */
import { describe, expect, it } from 'vitest';

import {
  IDLE_THINKING_STATE,
  reduceThinking,
  THINKING_IDLE_MS,
  type ThinkingState,
} from '../src/audio/thinking.ts';

describe('reduceThinking', () => {
  it('starts inactive, with no activity ever recorded', () => {
    expect(IDLE_THINKING_STATE).toEqual({ active: false, lastActivityAt: -Infinity });
  });

  it('activates on the first real delta', () => {
    const next = reduceThinking(IDLE_THINKING_STATE, { type: 'activity', deltaLength: 12, now: 1000 });
    expect(next).toEqual({ active: true, lastActivityAt: 1000 });
  });

  it('ignores an empty or malformed delta, and leaves the state untouched', () => {
    for (const deltaLength of [0, -3, Number.NaN]) {
      expect(
        reduceThinking(IDLE_THINKING_STATE, { type: 'activity', deltaLength, now: 1000 }),
        `a delta of ${String(deltaLength)} is not thinking`,
      ).toBe(IDLE_THINKING_STATE);
    }
    // And it must not extend a span that is otherwise about to end: an empty delta
    // arriving at 900 leaves `lastActivityAt` at 500, so the idle check still fires.
    const active: ThinkingState = { active: true, lastActivityAt: 500 };
    const after = reduceThinking(active, { type: 'activity', deltaLength: 0, now: 900 });
    expect(after).toBe(active);
    expect(reduceThinking(after, { type: 'idleCheck', now: 500 + THINKING_IDLE_MS }).active).toBe(false);
  });

  it('stays active while deltas keep arriving, and tracks the latest one', () => {
    let state = IDLE_THINKING_STATE;
    for (let i = 0; i < 10; i += 1) {
      // Chunks arriving well inside the idle window, the way one stream does.
      state = reduceThinking(state, { type: 'activity', deltaLength: 40, now: i * 120 });
      expect(state.active).toBe(true);
    }
    expect(state.lastActivityAt).toBe(9 * 120);
  });

  it('rides out a gap inside a stream that is shorter than the idle window', () => {
    let state = reduceThinking(IDLE_THINKING_STATE, { type: 'activity', deltaLength: 40, now: 0 });
    // The idle timer fires mid-stream, a hair before the window is up.
    state = reduceThinking(state, { type: 'idleCheck', now: THINKING_IDLE_MS - 1 });
    expect(state.active).toBe(true);
    // ...and the next chunk arrives, so the span simply continues.
    state = reduceThinking(state, { type: 'activity', deltaLength: 40, now: THINKING_IDLE_MS });
    expect(state).toEqual({ active: true, lastActivityAt: THINKING_IDLE_MS });
  });

  it('deactivates once the idle window has fully elapsed', () => {
    const active = reduceThinking(IDLE_THINKING_STATE, { type: 'activity', deltaLength: 7, now: 2000 });
    const next = reduceThinking(active, { type: 'idleCheck', now: 2000 + THINKING_IDLE_MS });
    expect(next.active).toBe(false);
    // The record of when the stream stopped survives — the next delta overwrites it.
    expect(next.lastActivityAt).toBe(2000);
  });

  it('an idleCheck on an already-quiet state is a same-reference no-op', () => {
    const quiet: ThinkingState = { active: false, lastActivityAt: 2000 };
    expect(reduceThinking(quiet, { type: 'idleCheck', now: 99_999 })).toBe(quiet);
  });

  it('respects a custom idle window', () => {
    const active = reduceThinking(IDLE_THINKING_STATE, { type: 'activity', deltaLength: 5, now: 0 });
    expect(reduceThinking(active, { type: 'idleCheck', now: 199 }, 200).active).toBe(true);
    expect(reduceThinking(active, { type: 'idleCheck', now: 200 }, 200).active).toBe(false);
  });

  it('closing the interlude forces it off, mid-stream and without waiting', () => {
    // The case this exists for: FIGHT clicked (or the deadline hit) while the Coder
    // is still streaming. A texture that kept humming would be heard over round 2.
    const active = reduceThinking(IDLE_THINKING_STATE, { type: 'activity', deltaLength: 40, now: 5000 });
    expect(active.active).toBe(true);
    const closed = reduceThinking(active, { type: 'closed' });
    expect(closed.active).toBe(false);
  });

  it('closing an already-quiet state is a same-reference no-op', () => {
    expect(reduceThinking(IDLE_THINKING_STATE, { type: 'closed' })).toBe(IDLE_THINKING_STATE);
  });

  it('a whole beat: prose streams with gaps, goes quiet, then the screen closes', () => {
    let state = IDLE_THINKING_STATE;
    // Analysis streams in four bursts, none of them a full idle window apart.
    for (const t of [0, 300, 640, 900]) {
      state = reduceThinking(state, { type: 'activity', deltaLength: 32, now: t });
      state = reduceThinking(state, { type: 'idleCheck', now: t + THINKING_IDLE_MS - 50 });
      expect(state.active).toBe(true);
    }
    // The beat ends: nothing arrives, and the next check finds real silence.
    state = reduceThinking(state, { type: 'idleCheck', now: 900 + THINKING_IDLE_MS });
    expect(state.active).toBe(false);
    // The Coder's beat starts a new span on the same state.
    state = reduceThinking(state, { type: 'activity', deltaLength: 80, now: 2000 });
    expect(state).toEqual({ active: true, lastActivityAt: 2000 });
    // FIGHT.
    expect(reduceThinking(state, { type: 'closed' }).active).toBe(false);
  });
});
