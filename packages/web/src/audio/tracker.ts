/**
 * Sim events → SFX triggers, ingested the same way `render/effects.ts` turns them
 * into visuals: tail `state.events`, once per frame, and fire a cue for every one
 * that is new since the last call. Not a second reader of sim internals — it is
 * fed the same `GameState` the renderer already receives from `app.ts`'s `render()`,
 * and the same `state.events` log `effects.ts` and `habitHighlight.ts` already tail;
 * nothing here reaches past what those two already consume.
 *
 * A round's `events` array is truncated back to empty when a new round starts (see
 * `effects.ts`'s header), so a shrinking length is how a reset is detected here too,
 * for the same reason: re-deriving "did something new happen" from a diff of state
 * would be the wrong direction to read a log.
 *
 * The sink is injected rather than this module reaching for `engine.ts` itself —
 * that is what makes `test/audio-tracker.test.ts` able to assert "which cues fired,
 * in what order" against a synthetic `GameState` with no DOM, no `AudioContext` and
 * no Tone.js anywhere in the import graph.
 */
import type { GameState } from '@rematch/engine';

import { sfxForSimEvent, type SfxDescriptor } from './sfx.ts';

export type AudioTracker = {
  /** Ingest everything that happened since the last call. Call once per frame. */
  sync(state: GameState): void;
  /** Forget everything — call when a new round starts. */
  reset(): void;
};

export function createAudioTracker(sink: (descriptor: SfxDescriptor) => void): AudioTracker {
  let seen = 0;

  return {
    sync(state: GameState): void {
      if (state.events.length < seen) seen = 0;

      for (let i = seen; i < state.events.length; i += 1) {
        const ev = state.events[i];
        if (ev === undefined) continue;
        const descriptor = sfxForSimEvent(ev.kind);
        if (descriptor !== null) sink(descriptor);
      }
      seen = state.events.length;
    },

    reset(): void {
      seen = 0;
    },
  };
}
