/**
 * The audio tracker (`audio/tracker.ts`) — `render/effects.ts`'s sibling for sound
 * rather than pixels. Fed a fabricated `GameState` with nothing but an `events` log
 * (the only field `sync` reads), so this is DOM-free and Tone-free: the sink is a
 * plain array push, and the assertions are about *which* cues fire, in what order,
 * across a sync call and a round reset — never about how they sound.
 */
import { describe, expect, it } from 'vitest';
import type { EventKind, GameState, TimelineEvent } from '@rematch/engine';

import { createAudioTracker } from '../src/audio/tracker.ts';
import type { SfxId } from '../src/audio/sfx.ts';

function ev(kind: EventKind, tick = 0): TimelineEvent {
  return { kind, tick };
}

function stateWith(events: TimelineEvent[]): GameState {
  return { events } as unknown as GameState;
}

describe('createAudioTracker', () => {
  it('fires nothing on a state with no events', () => {
    const fired: SfxId[] = [];
    const tracker = createAudioTracker((d) => fired.push(d.id));
    tracker.sync(stateWith([]));
    expect(fired).toEqual([]);
  });

  it('fires one cue per new event, in order, and never re-fires an already-seen one', () => {
    const fired: SfxId[] = [];
    const tracker = createAudioTracker((d) => fired.push(d.id));

    tracker.sync(stateWith([ev('playerShot'), ev('playerDash')]));
    expect(fired).toEqual(['shot', 'dash']);

    // The log grew by two more; only the new pair fires, not the whole log again.
    tracker.sync(stateWith([ev('playerShot'), ev('playerDash'), ev('bossHit'), ev('minionDown')]));
    expect(fired).toEqual(['shot', 'dash', 'bossHit', 'minionDown']);
  });

  it('skips a silent `EventKind` without breaking the ones after it', () => {
    const fired: SfxId[] = [];
    const tracker = createAudioTracker((d) => fired.push(d.id));
    tracker.sync(stateWith([ev('violation'), ev('bossSpawn'), ev('outcome')]));
    expect(fired).toEqual(['minionSpawn']);
  });

  it('fires both cues a slam-hit tick carries', () => {
    const fired: SfxId[] = [];
    const tracker = createAudioTracker((d) => fired.push(d.id));
    // `resolveSlam` pushes `playerHit` then `bossSlamHit` on the same tick.
    tracker.sync(stateWith([ev('playerHit'), ev('bossSlamHit')]));
    expect(fired).toEqual(['playerHit', 'slamImpact']);
  });

  it('detects a new round the way `effects.ts` does — a shrinking `events` length — and replays from the top', () => {
    const fired: SfxId[] = [];
    const tracker = createAudioTracker((d) => fired.push(d.id));
    tracker.sync(stateWith([ev('playerShot'), ev('playerShot'), ev('playerShot')]));
    expect(fired).toEqual(['shot', 'shot', 'shot']);

    // A new round starts: the log is shorter than what was already seen.
    tracker.sync(stateWith([ev('playerDash')]));
    expect(fired).toEqual(['shot', 'shot', 'shot', 'dash']);
  });

  it('reset() forgets everything, same as a round boundary', () => {
    const fired: SfxId[] = [];
    const tracker = createAudioTracker((d) => fired.push(d.id));
    tracker.sync(stateWith([ev('playerShot')]));
    tracker.reset();
    // The same single-event log again looks brand new after a reset.
    tracker.sync(stateWith([ev('playerShot')]));
    expect(fired).toEqual(['shot', 'shot']);
  });
});
