/**
 * Whether the background music should be playing, and whether it should be ducked —
 * a pure reducer over the facts that decide both, so `engine.ts`'s impure
 * `attemptAutoStart`/`noteGesture`/`noteInterludeOpened`/`noteInterludeClosed` are
 * thin wrappers around a decision this module makes on its own, and
 * `test/audio-music.test.ts` can assert it without Tone.js or a DOM anywhere in the
 * import graph.
 *
 * Matt's brief, third pass and the one this shape exists for, verbatim: *"o som do
 * jogo não tá funcionando. Ele deve ser constante, não deve parar em nenhum
 * momento, somente diminuir no momento do pensamento."* The music is **one
 * continuous bed for the whole session** — intro, fight, round won, interlude, the
 * next fight, game over — and the only thing that ever happens to it is a *duck*
 * while the agents are thinking.
 *
 * That replaces the previous, wrong model outright. There used to be a
 * `fightStarted` event that stopped the loop and latched an `introOver` flag which
 * made every later gesture a permanent no-op: intro music, by design. Under the new
 * decision that latch was the bug — it is what made the game silent from the first
 * round onward — so both it and the event are gone. Nothing in this reducer can
 * turn music off again.
 *
 * Five events, two bits of state:
 *
 *  - `gesture` — a deliberate click/keydown happened, on **any** screen and at any
 *    point in the session (`ui/screens.ts`'s primary buttons and intro fallback,
 *    the interlude's own buttons, and `engine.ts`'s page-level one-shot fallback
 *    for the `?autostart=1` player who never saw an intro at all). Turns music
 *    **on**. No screen name is carried any more, because no screen is special:
 *    "the music is already playing by then" is the only reason a later gesture is a
 *    no-op.
 *  - `autoplaySucceeded` / `autoplayFailed` — the mount-time attempt
 *    (`ui/screens.ts` calls `attemptAutoStart()` the moment the intro appears)
 *    resolved one way or the other. Success turns music **on**, exactly like a
 *    gesture would; failure changes nothing — it exists as its own event, rather
 *    than being silently dropped, so "the attempt happened and here is what it
 *    decided" is a real, testable fact rather than an inferred absence, and the
 *    gesture fallback is the way in instead.
 *  - `interludeOpened` / `interludeClosed` — the agents' thinking screen took the
 *    screen, or let go of it (`interlude/ui.ts`'s mount and its one `dispose()`,
 *    which every exit path runs through). The *only* thing they touch is `ducked`;
 *    a ducked bed is still a playing bed, which is why these two are not expressed
 *    as a stop/start.
 *
 * Not modelled here at all: mute. Music shares the master `Volume`→`Limiter` chain
 * every SFX cue does (`engine.ts`), so muting silences both without either one
 * needing to know the other exists — and mute is the one thing that *can* silence
 * the bed, which is the player's own choice rather than a state transition.
 */

export type MusicState = {
  /** Has the bed been started? Once true, nothing here ever makes it false again. */
  playing: boolean;
  /** Is the interlude on screen, i.e. should the bed sit under the thinking sound? */
  ducked: boolean;
};

export const initialMusicState: MusicState = { playing: false, ducked: false };

export type MusicEvent =
  | { type: 'gesture' }
  | { type: 'autoplaySucceeded' }
  | { type: 'autoplayFailed' }
  | { type: 'interludeOpened' }
  | { type: 'interludeClosed' };

export function reduceMusicState(state: MusicState, event: MusicEvent): MusicState {
  switch (event.type) {
    case 'gesture':
    case 'autoplaySucceeded':
      // Both say the same thing — "audio is allowed now" — and both are idempotent:
      // a second gesture, or a late autoplay resolution arriving after one, returns
      // the same reference so `engine.ts`'s before/after comparison sees no
      // transition and does not re-start the loop.
      if (state.playing) return state;
      return { ...state, playing: true };
    case 'autoplayFailed':
      // The attempt was blocked (or `tone` never loaded at all). Nothing changes —
      // the gesture fallback is what turns it on instead. A distinct branch rather
      // than falling into `default` so the decision is named.
      return state;
    case 'interludeOpened':
      if (state.ducked) return state;
      return { ...state, ducked: true };
    case 'interludeClosed':
      // Always restores, whether or not the bed was ever started: a duck that
      // outlived its interlude would be a permanently quiet game, so "closing
      // always unducks" is the invariant, not "closing undoes the open it can
      // remember".
      if (!state.ducked) return state;
      return { ...state, ducked: false };
    default: {
      // Exhaustive: a sixth event type would otherwise leave the bed's on/off or
      // ducked decision silently unreachable from whatever new call site sent it.
      const never: never = event;
      void never;
      return state;
    }
  }
}
