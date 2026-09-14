/**
 * The music bed's playing/ducked decision (`audio/musicState.ts`) — DOM-free,
 * Tone-free. `engine.ts`'s `attemptAutoStart`/`noteGesture`/`noteInterludeOpened`/
 * `noteInterludeClosed` are thin, untestable-without-a-browser wrappers around this
 * reducer; everything about *when* the bed should be playing and *when* it should
 * step back is pinned here instead.
 *
 * What these assertions are worth guarding, in one sentence: the previous version of
 * this file pinned the opposite product decision — music on the intro only, stopped
 * on the first `fightStarted` and latched off for the session — and it was green the
 * whole time the game was silent from round 1 onward. So the invariant with teeth is
 * now the one at the bottom: across a whole session, through a blocked autoplay, a
 * fight, an interlude and the next fight, `playing` never goes back to false.
 */
import { describe, expect, it } from 'vitest';

import { initialMusicState, reduceMusicState, type MusicState } from '../src/audio/musicState.ts';

describe('reduceMusicState', () => {
  it('starts stopped and unducked', () => {
    expect(initialMusicState).toEqual({ playing: false, ducked: false });
  });

  describe('the mount-time autoplay attempt', () => {
    it('autoplaySucceeded turns the bed on from the initial state', () => {
      expect(reduceMusicState(initialMusicState, { type: 'autoplaySucceeded' })).toEqual({
        playing: true,
        ducked: false,
      });
    });

    it('autoplayFailed changes nothing — the gesture fallback is the way in instead', () => {
      const next = reduceMusicState(initialMusicState, { type: 'autoplayFailed' });
      expect(next).toBe(initialMusicState);
    });

    it('autoplaySucceeded is a same-reference no-op once already playing', () => {
      const playing: MusicState = { playing: true, ducked: false };
      expect(reduceMusicState(playing, { type: 'autoplaySucceeded' })).toBe(playing);
    });

    it('autoplayFailed after the bed is already playing is a no-op too', () => {
      const playing: MusicState = { playing: true, ducked: false };
      expect(reduceMusicState(playing, { type: 'autoplayFailed' })).toBe(playing);
    });
  });

  describe('a gesture — on any screen, at any point in the session', () => {
    it('turns the bed on', () => {
      expect(reduceMusicState(initialMusicState, { type: 'gesture' })).toEqual({
        playing: true,
        ducked: false,
      });
    });

    it('a second gesture is a same-reference no-op', () => {
      const playing: MusicState = { playing: true, ducked: false };
      expect(reduceMusicState(playing, { type: 'gesture' })).toBe(playing);
    });

    it('during the interlude starts the bed already ducked — it never blasts mid-thought', () => {
      const ducked: MusicState = { playing: false, ducked: true };
      expect(reduceMusicState(ducked, { type: 'gesture' })).toEqual({ playing: true, ducked: true });
    });
  });

  describe('the interlude ducks the bed rather than stopping it', () => {
    it('interludeOpened ducks, and leaves playing alone', () => {
      const playing: MusicState = { playing: true, ducked: false };
      expect(reduceMusicState(playing, { type: 'interludeOpened' })).toEqual({ playing: true, ducked: true });
    });

    it('interludeClosed unducks, and leaves playing alone', () => {
      const ducked: MusicState = { playing: true, ducked: true };
      expect(reduceMusicState(ducked, { type: 'interludeClosed' })).toEqual({ playing: true, ducked: false });
    });

    it('is idempotent in both directions — a same-reference no-op each time', () => {
      const ducked: MusicState = { playing: true, ducked: true };
      expect(reduceMusicState(ducked, { type: 'interludeOpened' })).toBe(ducked);
      const open: MusicState = { playing: true, ducked: false };
      expect(reduceMusicState(open, { type: 'interludeClosed' })).toBe(open);
    });

    it('records a duck that arrives before the bed ever started, so a late build can apply it', () => {
      // `engine.ts`'s `build()` reads `ducked` when the graph finally exists: an
      // interlude can open during a slow `tone` fetch.
      expect(reduceMusicState(initialMusicState, { type: 'interludeOpened' })).toEqual({
        playing: false,
        ducked: true,
      });
    });

    it('closing always restores, even with no open it can remember', () => {
      // The invariant that matters more than symmetry: a stuck duck is a quiet game.
      const ducked: MusicState = { playing: true, ducked: true };
      expect(reduceMusicState(ducked, { type: 'interludeClosed' }).ducked).toBe(false);
      expect(reduceMusicState({ playing: false, ducked: true }, { type: 'interludeClosed' })).toEqual({
        playing: false,
        ducked: false,
      });
    });
  });

  it('nothing in the reducer can ever turn the bed off again', () => {
    const playing: MusicState = { playing: true, ducked: false };
    const events = [
      { type: 'gesture' },
      { type: 'autoplaySucceeded' },
      { type: 'autoplayFailed' },
      { type: 'interludeOpened' },
      { type: 'interludeClosed' },
    ] as const;
    for (const event of events) {
      expect(reduceMusicState(playing, event).playing, `${event.type} must not stop the bed`).toBe(true);
    }
  });

  it('a whole session: autoplay blocked, a gesture in the fight, an interlude, the next fight', () => {
    // The sequence Matt described: "constante, não deve parar em nenhum momento,
    // somente diminuir no momento do pensamento."
    let state = initialMusicState;

    // The browser refuses the gestureless attempt on the intro (or there is no intro
    // at all — `?autostart=1`).
    state = reduceMusicState(state, { type: 'autoplayFailed' });
    expect(state.playing).toBe(false);

    // The first deliberate gesture anywhere — here a keypress during round 1, which
    // the old reducer would have ignored forever.
    state = reduceMusicState(state, { type: 'gesture' });
    expect(state).toEqual({ playing: true, ducked: false });

    // Round 1 is won; the agents take the screen. The bed ducks, it does not stop.
    state = reduceMusicState(state, { type: 'interludeOpened' });
    expect(state).toEqual({ playing: true, ducked: true });

    // FIGHT: the interlude tears down and round 2 begins at full level.
    state = reduceMusicState(state, { type: 'interludeClosed' });
    expect(state).toEqual({ playing: true, ducked: false });

    // Round 2's own gameplay gestures change nothing at all.
    state = reduceMusicState(state, { type: 'gesture' });
    expect(state).toEqual({ playing: true, ducked: false });

    // A second interlude, and a second fight after it.
    state = reduceMusicState(state, { type: 'interludeOpened' });
    state = reduceMusicState(state, { type: 'interludeClosed' });
    expect(state).toEqual({ playing: true, ducked: false });
  });

  it('a whole session where autoplay succeeds outright: no gesture is ever needed', () => {
    let state = reduceMusicState(initialMusicState, { type: 'autoplaySucceeded' });
    expect(state.playing).toBe(true);
    state = reduceMusicState(state, { type: 'interludeOpened' });
    state = reduceMusicState(state, { type: 'interludeClosed' });
    expect(state).toEqual({ playing: true, ducked: false });
  });
});
