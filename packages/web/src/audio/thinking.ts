/**
 * The interlude's *thinking* sound — when it is on, and when it goes quiet. A pure
 * reducer over the streamed text the Analyst and Coder panels already render
 * (`interlude/ui.ts`'s `analysis.delta` and `rewrite.delta` handlers, the only two
 * places this is fed from), the same shape `audio/sfx.ts` and `audio/musicState.ts`
 * have and for the same reason: everything about *whether* it should be sounding is
 * assertable in Node with no DOM, no `AudioContext` and no Tone.js
 * (`test/audio-thinking.test.ts`).
 *
 * ## Why this replaced a per-character typewriter tick
 *
 * Matt's brief, verbatim: *"o barulho de typing vamos mudar pra algo que indique
 * pensamento ao invés do typing."* The old `audio/typing.ts` was a throttle that
 * fired one short square-wave click per ~55 ms of stream — accurate to the letters
 * appearing on screen, and exactly the wrong idea about what the screen *is*. The
 * four panels are three agents reasoning about the player's replay; the sound over
 * them should read as a machine thinking, not as a secretary typing.
 *
 * That changes the shape of the state, not just the waveform. A click is a decision
 * per delta ("tick, or don't"); a thinking texture is a decision about a *span*
 * ("something is being worked out right now"), so this reducer holds a sustained
 * `active` bit instead of a throttle gate, and the interesting edge moved from "how
 * often may it fire" to "how long after the last delta does it stay on":
 *
 *  - **On, at the first real character.** No warm-up, no fade-in delay — the panel
 *    and the sound start together.
 *  - **Still on across the gaps *inside* a stream.** An LLM stream arrives in bursts
 *    with dead air between them; a texture that dropped out in every gap would
 *    stutter where the old click merely paused. `THINKING_IDLE_MS` is the span of
 *    silence that has to pass before "thinking" becomes "done thinking" — long
 *    enough to ride out the gap between two chunks, short enough that the sound is
 *    gone before the Judge's stamp lands on a finished beat.
 *  - **Off the moment the screen is.** `closed` forces it off unconditionally
 *    (`interlude/ui.ts`'s `dispose()`, which every exit path runs through), because
 *    a processing texture still humming over a live fight would be the worst of the
 *    two possible bugs here.
 *
 * `now` is a parameter on every event rather than read in here, so the idle boundary
 * is pinned exactly in the tests with fabricated timestamps and no real timers —
 * and so the one impure half (`engine.ts`'s rescheduled idle timeout and the pulse
 * interval that plays the notes) has nothing to decide on its own.
 *
 * Never during the Trial beat, for free: `trial.progress` and `verdict` are event
 * types this module has never heard of, so it cannot sound over the Gate 3 meter or
 * the Judge's ruling — because nothing routes them here, not because of a runtime
 * check.
 */

export type ThinkingState = {
  /** Should the processing texture be sounding right now? */
  active: boolean;
  /** When the last real delta arrived, on the caller's clock. */
  lastActivityAt: number;
};

/** Before any delta has ever arrived, and what a closed interlude goes back to. */
export const IDLE_THINKING_STATE: ThinkingState = { active: false, lastActivityAt: -Infinity };

/**
 * How long the texture keeps sounding after the last streamed character. Sits above
 * the gap between two chunks of one LLM stream (which is tens to a few hundred ms
 * in practice, mock and live alike) and well under the time it takes a beat to
 * finish, so the sound covers a stream's own stalls without outliving the stream.
 */
export const THINKING_IDLE_MS = 700;

export type ThinkingEvent =
  /** A streamed chunk arrived with `deltaLength` characters in it. */
  | { type: 'activity'; deltaLength: number; now: number }
  /** The idle timer fired — is the stream still going, or has it gone quiet? */
  | { type: 'idleCheck'; now: number }
  /** The interlude is gone. Silence, unconditionally. */
  | { type: 'closed' };

export function reduceThinking(
  state: ThinkingState,
  event: ThinkingEvent,
  idleMs: number = THINKING_IDLE_MS,
): ThinkingState {
  switch (event.type) {
    case 'activity':
      // `!(x > 0)` rather than `x <= 0` so a malformed `NaN` length is ignored too:
      // an empty or broken delta is not "thinking", and it must not extend a span
      // that is otherwise about to end.
      if (!(event.deltaLength > 0)) return state;
      if (state.active && state.lastActivityAt === event.now) return state;
      return { active: true, lastActivityAt: event.now };
    case 'idleCheck':
      if (!state.active) return state;
      if (event.now - state.lastActivityAt < idleMs) return state;
      // Keep `lastActivityAt`: it is the record of when the stream really stopped,
      // and the next `activity` overwrites it anyway.
      return { active: false, lastActivityAt: state.lastActivityAt };
    case 'closed':
      if (!state.active) return state;
      return { active: false, lastActivityAt: state.lastActivityAt };
    default: {
      // Exhaustive: a fourth event type would otherwise leave the texture's on/off
      // decision silently unreachable from whatever new call site sent it.
      const never: never = event;
      void never;
      return state;
    }
  }
}
