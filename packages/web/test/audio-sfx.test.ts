/**
 * The event → SFX reducer (`audio/sfx.ts`) — the pure mapping the whole audio
 * feature rests on, and the only part of it worth testing outside a browser: DOM,
 * `AudioContext` and Tone.js itself are covered by the e2e suite instead (see
 * `e2e/boot.spec.ts`'s mute-toggle test), because none of that can mean anything
 * headless. What can be pinned in Node is the *mapping* — which `EventKind` makes
 * which sound, that a Judge verdict and a round outcome pick the right one of a
 * pair, and the one balance rule the brief asked for by name.
 */
import { describe, expect, it } from 'vitest';
import type { EventKind } from '@rematch/engine';

import { sfxForRoundOutcome, sfxForSimEvent, sfxForThinking, sfxForVerdict, sfxGain, type SfxId } from '../src/audio/sfx.ts';

/** Every `EventKind` the engine can push (`packages/engine/src/state.ts`). */
const ALL_EVENT_KINDS: readonly EventKind[] = [
  'playerDash',
  'playerShot',
  'playerHit',
  'bossHit',
  'bossBurst',
  'bossChargeStart',
  'bossChargeHit',
  'bossSlamStart',
  'bossSlamHit',
  'bossSlamMiss',
  'bossSpawn',
  'minionDown',
  'violation',
  'outcome',
];

describe('sfxForSimEvent', () => {
  it('maps the ten sounded events to their own cue', () => {
    const expected: Record<string, SfxId> = {
      playerShot: 'shot',
      bossBurst: 'bossShot',
      playerDash: 'dash',
      playerHit: 'playerHit',
      bossHit: 'bossHit',
      bossChargeStart: 'telegraphCharge',
      bossSlamStart: 'telegraphSlam',
      bossSlamHit: 'slamImpact',
      bossSpawn: 'minionSpawn',
      minionDown: 'minionDown',
    };
    for (const [kind, id] of Object.entries(expected)) {
      const descriptor = sfxForSimEvent(kind as EventKind);
      expect(descriptor, `${kind} should have a cue`).not.toBeNull();
      expect(descriptor?.id).toBe(id);
      expect(descriptor?.gain).toBe(sfxGain(id));
    }
  });

  it('is silent for the four kinds documented as silent, and covers every kind', () => {
    const silent: readonly EventKind[] = ['bossChargeHit', 'bossSlamMiss', 'violation', 'outcome'];
    for (const kind of silent) {
      expect(sfxForSimEvent(kind), `${kind} should stay silent`).toBeNull();
    }
    // Every `EventKind` is either mapped above or listed here — nothing falls through
    // the switch's exhaustive `never` check unnoticed by this test.
    const sounded = ALL_EVENT_KINDS.filter((k) => !silent.includes(k));
    expect(sounded.length + silent.length).toBe(ALL_EVENT_KINDS.length);
    for (const kind of sounded) expect(sfxForSimEvent(kind)).not.toBeNull();
  });

  it('gives a slam its two cues on the same tick, and a miss neither', () => {
    // `resolveSlam` (packages/engine/src/step.ts) pushes `playerHit` then
    // `bossSlamHit` on the same tick when it connects — both get a cue, and the
    // overlap is deliberate (the limiter in `engine.ts` is what keeps it in check).
    expect(sfxForSimEvent('playerHit')?.id).toBe('playerHit');
    expect(sfxForSimEvent('bossSlamHit')?.id).toBe('slamImpact');
    expect(sfxForSimEvent('bossSlamMiss')).toBeNull();
  });
});

describe('sfxForVerdict', () => {
  it('picks the approved cue for true and the rejected one for false', () => {
    expect(sfxForVerdict(true)).toEqual({ id: 'verdictApproved', gain: sfxGain('verdictApproved') });
    expect(sfxForVerdict(false)).toEqual({ id: 'verdictRejected', gain: sfxGain('verdictRejected') });
  });

  it('gives the rejection more weight than the approval — "the demo\'s beat"', () => {
    expect(sfxGain('verdictRejected')).toBeGreaterThan(sfxGain('verdictApproved'));
  });
});

describe('sfxForRoundOutcome', () => {
  it('picks win for true and lose for false', () => {
    expect(sfxForRoundOutcome(true)).toEqual({ id: 'roundWin', gain: sfxGain('roundWin') });
    expect(sfxForRoundOutcome(false)).toEqual({ id: 'roundLose', gain: sfxGain('roundLose') });
  });
});

describe('sfxForThinking', () => {
  it('is always the one thinking cue', () => {
    expect(sfxForThinking()).toEqual({ id: 'thinkingPulse', gain: sfxGain('thinkingPulse') });
  });
});

describe('the gain table', () => {
  const ALL_IDS: SfxId[] = [
    'shot',
    'bossShot',
    'dash',
    'playerHit',
    'bossHit',
    'telegraphCharge',
    'telegraphSlam',
    'slamImpact',
    'minionSpawn',
    'minionDown',
    'verdictApproved',
    'verdictRejected',
    'roundWin',
    'roundLose',
    'thinkingPulse',
  ];

  it('has a value for all fifteen cues, each a sane fraction', () => {
    for (const id of ALL_IDS) {
      const gain = sfxGain(id);
      expect(gain).toBeGreaterThan(0);
      expect(gain).toBeLessThanOrEqual(1);
    }
  });

  it('keeps the shot — it fires up to ~5/s — much quieter than the stingers', () => {
    expect(sfxGain('shot')).toBeLessThan(sfxGain('roundWin') / 4);
    expect(sfxGain('shot')).toBeLessThan(sfxGain('verdictApproved') / 4);
    expect(sfxGain('shot')).toBeLessThan(sfxGain('playerHit'));
  });

  it('keeps every per-tick cue quieter than every once-per-round stinger', () => {
    const frequent: SfxId[] = ['shot', 'bossShot', 'dash', 'bossHit', 'minionSpawn', 'minionDown', 'thinkingPulse'];
    const stingers: SfxId[] = ['roundWin', 'roundLose', 'verdictApproved', 'verdictRejected'];
    const loudestFrequent = Math.max(...frequent.map(sfxGain));
    const quietestStinger = Math.min(...stingers.map(sfxGain));
    expect(loudestFrequent).toBeLessThan(quietestStinger);
  });

  it('keeps the thinking pulse at least as quiet as the shot — texture, not a cue', () => {
    // It repeats for as long as a beat streams (both beats' worth of text at once
    // when the Coder writes K candidates), so it is the floor of the mix, not a
    // moment in it — the same bar the typewriter tick it replaced had to clear.
    expect(sfxGain('thinkingPulse')).toBeLessThanOrEqual(sfxGain('shot'));
  });
});
