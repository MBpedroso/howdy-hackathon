/**
 * Event kind → SFX descriptor. Pure, and the whole reason it is worth its own file:
 * everything interesting about "what does this moment sound like" is the mapping,
 * the mapping is where a mismatched cue would hide, and `test/audio-sfx.test.ts`
 * asserts the whole table in Node with no DOM and no Tone.js at all — same shape as
 * `interlude/castStatus.ts`'s `reduceCast`, which is the reducer this one is modelled
 * on: a pure fold from a domain event to "what does the player see/hear right now".
 *
 * Three sources feed it, and each gets its own pure function rather than one giant
 * union, because they are read off three different places in the client:
 *
 *  - `sfxForSimEvent` — the engine's own `EventKind` (`@rematch/engine`), tailed off
 *    `GameState.events` the same way `render/effects.ts` tails it for visuals
 *    (`audio/tracker.ts` is effects.ts's sibling, not a second reader of sim
 *    internals — see its header).
 *  - `sfxForVerdict` — the interlude's Judge stamp (`interlude/ui.ts`'s `setVerdict`),
 *    approved or rejected.
 *  - `sfxForRoundOutcome` — the round's own ending, win or lose (`app.ts`).
 *  - `sfxForThinking` — the one cue with no engine event behind it at all: the
 *    interlude's thinking texture, pulsed on a slow clock for as long as
 *    `audio/thinking.ts`'s reducer says the agents are still working
 *    (`interlude/ui.ts` feeds it every `analysis.delta`/`rewrite.delta`).
 *
 * Restrained on purpose (spec §2.3: "Sound optional… never sampled assets," and the
 * brief this shipped against: "polish, not a soundtrack"). Fifteen cues, not forty:
 * a few `EventKind`s that already imply another one's sound stay silent here rather
 * than layering a second cue on the same tick — see the `default` branch below.
 */
import type { EventKind } from '@rematch/engine';

/** The fifteen sounds in the game. Every one of them is synthesized — see `engine.ts`. */
export type SfxId =
  | 'shot'
  | 'bossShot'
  | 'dash'
  | 'playerHit'
  | 'bossHit'
  | 'telegraphCharge'
  | 'telegraphSlam'
  | 'slamImpact'
  | 'minionSpawn'
  | 'minionDown'
  | 'verdictApproved'
  | 'verdictRejected'
  | 'roundWin'
  | 'roundLose'
  | 'thinkingPulse';

export type SfxDescriptor = { id: SfxId; gain: number };

/**
 * Relative gain per cue, 0..1, *before* the master volume and limiter (`engine.ts`).
 *
 * The one balance rule the brief asked for by name: "shots much quieter than
 * stingers" — `playerShot` fires up to ~5 times a second and must sit under
 * everything else, while a round win/lose or a Judge verdict is a single moment and
 * can afford to be heard from across the room. Asserted in
 * `test/audio-sfx.test.ts` rather than only eyeballed here.
 */
const GAIN: Readonly<Record<SfxId, number>> = {
  shot: 0.05,
  bossShot: 0.06,
  dash: 0.12,
  playerHit: 0.32,
  bossHit: 0.14,
  telegraphCharge: 0.16,
  telegraphSlam: 0.16,
  slamImpact: 0.3,
  minionSpawn: 0.12,
  minionDown: 0.14,
  verdictApproved: 0.4,
  verdictRejected: 0.45,
  roundWin: 0.55,
  roundLose: 0.55,
  // Quieter than the shot, deliberately: it repeats for as long as a beat streams
  // (both beats at once when the Coder writes K candidates) and it is texture under
  // the four panels, not a moment. Unchanged from the typewriter tick it replaced —
  // the waveform got slower and lower, not louder.
  thinkingPulse: 0.035,
};

export function sfxGain(id: SfxId): number {
  return GAIN[id];
}

/**
 * The engine's `EventKind` → what it sounds like, or `null` for "no cue of its own".
 *
 * Three kinds are deliberately silent here:
 *  - `bossChargeHit` and `bossSlamMiss` — the tick a charge connects also carries a
 *    `playerHit` (`packages/engine/src/step.ts`'s `damagePlayer` pushes it for every
 *    source of damage), so the harsh hit already sounds; a miss's silence *is* the
 *    tell that the slam whiffed, on top of the ring closing with nothing landing.
 *  - `violation` / `outcome` — bookkeeping and a duplicate of what `sfxForRoundOutcome`
 *    already renders from `app.ts`'s own read of `Round.state.outcome`; a strategy
 *    contract violation has no stake for the player watching, so it stays silent.
 *
 * A slam that *does* hit fires both `playerHit` and `bossSlamHit` on the same tick
 * (`resolveSlam` pushes the hit event right after `damagePlayer`'s), so the harsh
 * stab and the low impact land together on purpose — that overlap, and every other
 * one like it, is exactly what the limiter in `engine.ts` exists to keep in check.
 */
export function sfxForSimEvent(kind: EventKind): SfxDescriptor | null {
  switch (kind) {
    case 'playerShot':
      return { id: 'shot', gain: GAIN.shot };
    case 'bossBurst':
      return { id: 'bossShot', gain: GAIN.bossShot };
    case 'playerDash':
      return { id: 'dash', gain: GAIN.dash };
    case 'playerHit':
      return { id: 'playerHit', gain: GAIN.playerHit };
    case 'bossHit':
      return { id: 'bossHit', gain: GAIN.bossHit };
    case 'bossChargeStart':
      return { id: 'telegraphCharge', gain: GAIN.telegraphCharge };
    case 'bossSlamStart':
      return { id: 'telegraphSlam', gain: GAIN.telegraphSlam };
    case 'bossSlamHit':
      return { id: 'slamImpact', gain: GAIN.slamImpact };
    case 'bossSpawn':
      return { id: 'minionSpawn', gain: GAIN.minionSpawn };
    case 'minionDown':
      return { id: 'minionDown', gain: GAIN.minionDown };
    case 'bossChargeHit':
    case 'bossSlamMiss':
    case 'violation':
    case 'outcome':
      return null;
    default: {
      // Exhaustive: a new `EventKind` that nobody's SFX table reflects would leave a
      // moment silent by accident rather than by the documented decision above.
      const never: never = kind;
      void never;
      return null;
    }
  }
}

/**
 * The Judge's stamp. Rejected is heavier than approved on purpose — the brief calls
 * the rejection "the demo's beat", and `GAIN` gives it the bigger number for the
 * same reason `interlude/ui.ts` gives it the Judge's own accent colour rather than
 * treating it as a lesser, quieter approval.
 */
export function sfxForVerdict(approved: boolean): SfxDescriptor {
  return approved ? { id: 'verdictApproved', gain: GAIN.verdictApproved } : { id: 'verdictRejected', gain: GAIN.verdictRejected };
}

/** The round's own ending — spec §2.1's win/lose, read off `Round.state.outcome`. */
export function sfxForRoundOutcome(won: boolean): SfxDescriptor {
  return won ? { id: 'roundWin', gain: GAIN.roundWin } : { id: 'roundLose', gain: GAIN.roundLose };
}

/**
 * One pulse of the interlude's thinking texture. One descriptor, always the same —
 * the *whether* is `audio/thinking.ts`'s job (is a stream still arriving?) and the
 * *when* is `engine.ts`'s pulse clock (every `THINKING_PULSE_MS` while it is); by
 * the time this is called, the answer is already "yes, now".
 */
export function sfxForThinking(): SfxDescriptor {
  return { id: 'thinkingPulse', gain: GAIN.thinkingPulse };
}
