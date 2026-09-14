/**
 * The synthesized voice. Everything audible in the game is generated here with
 * Tone.js — spec §2.3's binding constraint on sound: "if added, generated with
 * Tone.js, never sampled assets." There is no audio *file* anywhere under this
 * package; every cue, and the session's music bed, is an oscillator, a noise source
 * or an envelope.
 *
 * Two shapes of sound share this one file and its one chain: **fifteen discrete
 * cues** (`buildVoices` — `sfx.ts`'s `SfxId`s, played once each via `trigger()`, a
 * `Voice` per id) and **one continuous bed** (`buildMusic` — the session's
 * background music, started once via `noteGesture`/`attemptAutoStart` and never
 * stopped, ducked under the interlude via `noteInterludeOpened`/
 * `noteInterludeClosed`, all four gated by the pure `musicState.ts`).
 *
 * ## The music never stops — it ducks
 *
 * Matt's brief, verbatim: *"o som do jogo não tá funcionando. Ele deve ser
 * constante, não deve parar em nenhum momento, somente diminuir no momento do
 * pensamento."* One bed for the whole session — intro, fight, round won, interlude,
 * next fight, game over — and the only thing that ever happens to it is a duck
 * while the agents are thinking. The previous design was the opposite (intro-only
 * music, stopped on `startRound` and latched off for the session), and that latch
 * is exactly what made the game silent from round 1 onward. It is gone, along with
 * the `stopIntroMusic()` call that drove it; nothing in this module can turn the
 * bed off any more. Mute still can — that is the player's own call, and it lives on
 * the master fader where it silences cues and music together.
 *
 * The duck is its own gain stage: the music voices feed a `musicBus`
 * (`MUSIC_BASE_DB`) that feeds the master, so `MUSIC_DUCK_DB` can pull the bed down
 * under the interlude without touching a single SFX cue — and the thinking texture,
 * which routes to the master like every other cue, stays at full level over the
 * ducked bed. That is the whole point of the second stage.
 *
 * ## Never off raw gameplay input — that is the actual rule, not "only a gesture"
 *
 * A browser will not *play* audio before the page has been interacted with (the
 * autoplay policy), so this module never touches `AudioContext` at import time or at
 * module load — `tone` itself is not imported until `init()` runs. Three kinds of
 * call site feed it, and the first two are deliberately outside live gameplay:
 *
 *  - **A one-time mount event.** `attemptAutoStart()`, called once by
 *    `ui/screens.ts` the moment the intro screen appears — see its own doc for why
 *    an *attempt* with no gesture at all is the honest reading of "start on load"
 *    against a policy that literally cannot promise it (Chrome's media-engagement
 *    heuristics let a returning visitor's page start audio with zero gesture; a
 *    first-time one still needs the fallback below).
 *  - **Deliberate click/keydown handlers**: a screen's primary button and a
 *    document-level fallback armed while an intro screen is showing (both
 *    `ui/screens.ts` — the same sites that call `noteGesture`), the interlude's
 *    FIGHT/skip buttons (`interlude/ui.ts`), and the mute toggle
 *    (`ui/audioToggle.ts`).
 *  - **`armGestureFallback()` — one page-level, one-shot listener**, armed by
 *    `app.ts`'s `boot()` and disarmed the instant music is playing. It exists for
 *    the player no menu-level site can reach: `?autostart=1`, or a remembered "skip
 *    intro" (`ui/intro.ts`), mounts no intro at all, and with the bed required to
 *    play for the whole session "the music never starts" is not an acceptable
 *    outcome for them.
 *
 *    This listener is the one that does **not** call `init()`. It records the
 *    gesture and nothing else, because it is the only one that can fire while a
 *    round is stepping, and building the chain inside a gameplay keypress's own task
 *    drops ticks for real (`e2e/controls.spec.ts` measures it — see
 *    `onGestureFallback` for the whole story). The build happens at the next moment
 *    that can afford a long task instead.
 *
 * That is also what keeps Tone off the determinism path for free:
 * `e2e/determinism.spec.ts` drives the sandbox entirely through `page.evaluate()`
 * calls into `window.__rematch`, `?autostart=1` skips the intro screen outright, and
 * `gen-inputlog.ts` and every other Node-side script never touch a DOM at all — so
 * neither `attemptAutoStart()` nor a real gesture ever happens in that path (a
 * synthetic `page.evaluate` call is not one, and `armGestureFallback`'s listener
 * fires on nothing else), and `tone` is never fetched, parsed or instantiated.
 * Nothing here had to special-case it.
 *
 * ## Failure is silent, always
 *
 * `init()` and `trigger()` never throw and never leave a rejected promise unhandled.
 * A missing `AudioContext` (Node, an unusual sandboxed frame), a `tone` chunk that
 * fails to fetch, a suspended context the browser refuses to resume — every one of
 * them degrades to "no sound this session" rather than a console error, because the
 * one thing worse than a silent boss fight is a boss fight that throws over one.
 * `e2e/boot.spec.ts` asserts zero console errors across the whole intro; this module
 * is written to that bar, not just to "works on my machine".
 *
 * ## The chain
 *
 * Every cue voice connects to one `Tone.Volume` (the master fader, and where mute
 * lives) feeding one `Tone.Limiter` feeding the destination — "everything through a
 * limiter so overlapping SFX can't clip" is a routing decision, made once, here,
 * rather than a discipline every call site has to remember. Per-cue loudness
 * (`sfx.ts`'s `GAIN`) is applied as a `Decibels` offset on the *voice* at trigger
 * time, not as a second gain stage, so the limiter always sees the same signal path.
 *
 * The music bed is the one exception, and only by one node: its two voices connect
 * to `musicBus` (its own `Tone.Volume`) which connects to that same master. The
 * extra stage exists so the duck has something to move that is not the master and
 * not a voice — see `buildMusic`.
 */
import { readMuted, writeMuted } from './mute.ts';
import { initialMusicState, reduceMusicState, type MusicEvent, type MusicState } from './musicState.ts';
import { sfxForThinking, type SfxDescriptor, type SfxId } from './sfx.ts';
import {
  IDLE_THINKING_STATE,
  reduceThinking,
  THINKING_IDLE_MS,
  type ThinkingEvent,
  type ThinkingState,
} from './thinking.ts';

/** The dynamically-imported module's shape — never a static import (see header). */
type ToneModule = typeof import('tone');

/** What every voice needs to expose: play one shot at a given loudness. */
type Voice = { play(gainDb: number): void };

/** Headroom under the limiter's threshold, and the limiter's own threshold. */
const MASTER_DB = -6;
const LIMITER_THRESHOLD_DB = -3;

/** `gain` (0..1, from `sfx.ts`) → decibels, without needing a live `Tone` reference. */
function gainToDb(gain: number): number {
  return 20 * Math.log10(Math.max(0.0001, gain));
}

let muted = readMuted();
/** Set once `init()` has really built the chain; `null` means "not ready yet". */
let bus: { mute: boolean } | null = null;
let voices: Partial<Record<SfxId, Voice>> | null = null;
let building: Promise<void> | null = null;
let musicNodes: MusicNodes | null = null;
let musicState: MusicState = initialMusicState;
let thinkingState: ThinkingState = IDLE_THINKING_STATE;
/** The pulse interval and the idle-check timeout, while the texture is sounding. */
let thinkingPulseTimer: number | null = null;
let thinkingIdleTimer: number | null = null;
/** `armGestureFallback`'s one-shot page-level listener — see the header. */
let gestureFallbackArmed = false;
/** The loaded module, kept only so `contextRunning()` can read the context's state. */
let toneRef: ToneModule | null = null;

function buildVoices(T: ToneModule, master: InstanceType<ToneModule['Volume']>): Partial<Record<SfxId, Voice>> {
  const now = (): number => T.now();

  /**
   * A single note (or chord) through a `Tone.Synth`/`Tone.PolySynth`/`Tone.MembraneSynth`
   * -shaped instrument. `note`/`time` are typed loosely (`...args: any[]`) on purpose:
   * `Synth.triggerAttackRelease` takes one `Frequency` and `PolySynth`'s takes
   * `Frequency | Frequency[]`, and unifying those two real, narrower signatures behind
   * one helper is exactly what `any[]` is for — every call site below still passes a
   * concrete `string | string[]`, so nothing about the actual note lookup is untyped.
   */
  function stab(
    synth: { volume: { value: number }; triggerAttackRelease: (...args: any[]) => unknown },
    note: string | string[],
    duration: number,
  ): Voice {
    return {
      play(gainDb): void {
        synth.volume.value = gainDb;
        synth.triggerAttackRelease(note, duration, now());
      },
    };
  }

  /** A rising pitch sweep — the telegraph warnings, distinct for charge and slam. */
  function riser(synth: InstanceType<ToneModule['Synth']>, f0: number, f1: number, duration: number): Voice {
    return {
      play(gainDb): void {
        const t = now();
        synth.volume.value = gainDb;
        synth.frequency.cancelScheduledValues(t);
        synth.frequency.setValueAtTime(f0, t);
        synth.frequency.exponentialRampToValueAtTime(f1, t + duration);
        synth.triggerAttackRelease(f0, duration, t);
      },
    };
  }

  // ---- shots: the most frequent sound in the game, so the cheapest voices in it.
  const shotSynth = new T.Synth({
    oscillator: { type: 'triangle' },
    envelope: { attack: 0.001, decay: 0.03, sustain: 0, release: 0.02 },
  }).connect(master);
  const bossShotSynth = new T.Synth({
    oscillator: { type: 'triangle' },
    envelope: { attack: 0.001, decay: 0.06, sustain: 0, release: 0.04 },
  }).connect(master);

  // ---- dash: a filtered noise burst — the "whoosh".
  const dashFilter = new T.Filter({ type: 'bandpass', frequency: 1800, Q: 0.7 }).connect(master);
  const dashSynth = new T.NoiseSynth({
    noise: { type: 'white' },
    envelope: { attack: 0.004, decay: 0.16, sustain: 0, release: 0.04 },
  }).connect(dashFilter);

  // ---- hits: harsh for the player, soft for the boss — spec's own contrast.
  const playerHitSynth = new T.MetalSynth({
    envelope: { attack: 0.001, decay: 0.16, release: 0.05 },
    harmonicity: 3.1,
    modulationIndex: 16,
    resonance: 900,
    octaves: 1.2,
  }).connect(master);
  const bossHitSynth = new T.Synth({
    oscillator: { type: 'sine' },
    envelope: { attack: 0.001, decay: 0.09, sustain: 0, release: 0.05 },
  }).connect(master);

  // ---- telegraphs: charge is quick and sharp, slam is slower and lower — the same
  // distinction the visuals draw (a 20-tick lance vs a 40-tick ring, renderer.ts).
  const chargeWarnSynth = new T.Synth({
    oscillator: { type: 'sawtooth' },
    envelope: { attack: 0.02, decay: 0.05, sustain: 0.5, release: 0.05 },
  }).connect(master);
  const slamWarnSynth = new T.Synth({
    oscillator: { type: 'sine' },
    envelope: { attack: 0.05, decay: 0.05, sustain: 0.5, release: 0.08 },
  }).connect(master);
  const slamImpactSynth = new T.MembraneSynth({
    pitchDecay: 0.06,
    octaves: 4,
    envelope: { attack: 0.001, decay: 0.35, sustain: 0, release: 0.1 },
  }).connect(master);

  // ---- minions.
  const spawnSynth = new T.Synth({
    oscillator: { type: 'triangle' },
    envelope: { attack: 0.005, decay: 0.09, sustain: 0, release: 0.05 },
  }).connect(master);
  const downSynth = new T.Synth({
    oscillator: { type: 'triangle' },
    envelope: { attack: 0.005, decay: 0.12, sustain: 0, release: 0.06 },
  }).connect(master);

  // ---- the Judge's stamp: approved is bright, rejected is heavier — "the demo's beat".
  const approvedSynth = new T.PolySynth(T.Synth, {
    oscillator: { type: 'triangle' },
    envelope: { attack: 0.005, decay: 0.22, sustain: 0.1, release: 0.35 },
  }).connect(master);
  const rejectedSynth = new T.PolySynth(T.Synth, {
    oscillator: { type: 'square' },
    envelope: { attack: 0.005, decay: 0.4, sustain: 0.08, release: 0.45 },
  }).connect(master);

  // ---- round stingers.
  const winSynth = new T.PolySynth(T.Synth, {
    oscillator: { type: 'triangle' },
    envelope: { attack: 0.006, decay: 0.3, sustain: 0.15, release: 0.6 },
  }).connect(master);
  const loseSynth = new T.PolySynth(T.Synth, {
    oscillator: { type: 'sawtooth' },
    envelope: { attack: 0.01, decay: 0.35, sustain: 0.1, release: 0.7 },
  }).connect(master);

  // ---- the interlude's thinking texture. The one cue that used to be a
  // typewriter: a square-wave click per ~55 ms of stream, at C6-G6. Matt's call —
  // "algo que indique pensamento ao invés do typing" — is a different *instrument*,
  // not a different rhythm, so every parameter here is the inverse of that tick.
  // An `AMSynth` on a sine carrier with a triangle modulator for a slow shimmer
  // (a plain `Synth` reads as a note being played; the amplitude modulation is
  // what makes it read as a machine working); three octaves down, at C3-G3, under
  // everything else on screen rather than on top of it; a 0.15 s attack and 0.4 s
  // release so each pulse swells and decays instead of clicking; and one pulse
  // every `THINKING_PULSE_MS` (~0.8 s) rather than one per delta, wandering through
  // a minor triad in a fixed order — a *wander*, deliberately not random, for the
  // same reason the music loop is composed rather than generated: a texture that
  // draws a new hand every pulse reads as a malfunction, not as thought.
  const thinkingSynth = new T.AMSynth({
    harmonicity: 2,
    oscillator: { type: 'sine' },
    modulation: { type: 'triangle' },
    envelope: { attack: 0.15, decay: 0.2, sustain: 0.4, release: 0.4 },
    modulationEnvelope: { attack: 0.3, decay: 0.2, sustain: 0.4, release: 0.4 },
  }).connect(master);
  const THINKING_NOTES = ['C3', 'Eb3', 'G3'] as const;
  const THINKING_PULSE_S = 0.5;
  let thinkingStep = 0;

  return {
    shot: stab(shotSynth, 'C6', 0.05),
    bossShot: stab(bossShotSynth, 'A4', 0.08),
    dash: {
      play(gainDb): void {
        dashSynth.volume.value = gainDb;
        dashSynth.triggerAttackRelease(0.18, now());
      },
    },
    playerHit: {
      play(gainDb): void {
        playerHitSynth.volume.value = gainDb;
        playerHitSynth.triggerAttackRelease('C3', 0.15, now());
      },
    },
    bossHit: stab(bossHitSynth, 'E4', 0.09),
    telegraphCharge: riser(chargeWarnSynth, 220, 760, 0.3),
    telegraphSlam: riser(slamWarnSynth, 110, 330, 0.6),
    slamImpact: stab(slamImpactSynth, 'C1', 0.35),
    minionSpawn: stab(spawnSynth, 'E5', 0.08),
    minionDown: stab(downSynth, 'A3', 0.1),
    verdictApproved: stab(approvedSynth, ['C5', 'E5', 'G5'], 0.35),
    verdictRejected: stab(rejectedSynth, ['C4', 'Db4'], 0.4),
    roundWin: stab(winSynth, ['C4', 'E4', 'G4', 'C5'], 0.55),
    roundLose: stab(loseSynth, ['C3', 'F#3'], 0.6),
    thinkingPulse: {
      play(gainDb): void {
        const note = THINKING_NOTES[thinkingStep % THINKING_NOTES.length] ?? 'C3';
        thinkingStep += 1;
        thinkingSynth.volume.value = gainDb;
        thinkingSynth.triggerAttackRelease(note, THINKING_PULSE_S, now());
      },
    },
  };
}

/**
 * What the music bed needs to expose: start it (idempotent — it is never stopped
 * again), and duck it. There is deliberately no `stop()`: nothing in this module
 * turns the bed off any more (see the header), and a method nobody can reach would
 * be an invitation to reach for it.
 */
type MusicNodes = { start(): void; setDucked(ducked: boolean): void };

/** Well under the quietest SFX (`sfx.ts`'s `GAIN.shot`, 0.05) — background, not a cue. */
const MUSIC_ARP_GAIN = 0.045;
const MUSIC_BASS_GAIN = 0.04;
const MUSIC_BPM = 132;

/**
 * The bed's own fader, in dB on `musicBus`.
 *
 * `MUSIC_BASE_DB` is a small trim rather than a mix decision: the loop was written
 * to carry an intro screen on its own, and it now also plays under a fight where
 * ten SFX voices are firing, so it sits 3 dB lower than it was composed at. The
 * composition itself is untouched.
 *
 * `MUSIC_DUCK_DB` is where it goes while the interlude is open — 11 dB under the
 * base, which is far enough that the thinking texture and the Judge's stamp own the
 * room, and not so far that the bed disappears (the brief asks for *diminuir*, not
 * for silence: the session's continuity is the point). `DUCK_RAMP_S` is long enough
 * to be heard as the room quieting down rather than as a cut.
 */
const MUSIC_BASE_DB = -3;
const MUSIC_DUCK_DB = -14;
const DUCK_RAMP_S = 0.6;

/**
 * The session's music bed — a short, generative-in-code chiptune vamp: an
 * arpeggiated triad over a two-bar bass ostinato (A minor → G major), built from
 * oscillators the same way every SFX voice is. "Generative" here means *composed
 * algorithmically*, not randomized — a fixed loop is the restrained reading of
 * "a short generative loop" the brief asked for, and it is the one piece of this
 * feature where a *predictable* result is the point: nobody wants the game's music
 * to draw a different hand each reload.
 *
 * Both voices connect to `musicBus`, not to the master directly. That one extra
 * `Tone.Volume` is the whole ducking mechanism: `setDucked` ramps *it*, so the bed
 * drops under the interlude while every SFX cue — including the thinking texture
 * that is the reason for the duck — keeps its own level on the master untouched.
 * Ducking the master instead would take the thinking sound down with the music,
 * which is precisely backwards.
 *
 * Scheduled on `Tone.Transport`/`Tone.Sequence` rather than as a manual `setInterval`
 * of one-shot triggers — Tone's own musical clock is what makes "start" one call,
 * and it runs independently of the SFX voices above (which schedule against raw
 * context time via `Tone.now()`, never the Transport), so starting the bed can never
 * perturb an SFX cue's timing or vice versa.
 */
function buildMusic(T: ToneModule, master: InstanceType<ToneModule['Volume']>): MusicNodes {
  const musicBus = new T.Volume(MUSIC_BASE_DB).connect(master);

  const arpSynth = new T.Synth({
    oscillator: { type: 'square' },
    envelope: { attack: 0.002, decay: 0.09, sustain: 0.04, release: 0.05 },
  }).connect(musicBus);
  arpSynth.volume.value = gainToDb(MUSIC_ARP_GAIN);

  const bassSynth = new T.Synth({
    oscillator: { type: 'triangle' },
    envelope: { attack: 0.01, decay: 0.15, sustain: 0.3, release: 0.25 },
  }).connect(musicBus);
  bassSynth.volume.value = gainToDb(MUSIC_BASS_GAIN);

  // Two bars of eighth notes, 8 steps each: A minor bar, then G major.
  const ARP: readonly string[] = ['A3', 'C4', 'E4', 'C4', 'G3', 'B3', 'D4', 'B3'];
  const BASS: readonly (string | null)[] = ['A2', null, null, null, 'G2', null, null, null];

  // Typed structurally (just the two methods used below) rather than as
  // `InstanceType<ToneModule['Sequence']>`: `Sequence` is generic over its event
  // value type, and pinning that generic through an indexed-access type only to
  // immediately discard it (nothing here reads a scheduled event back out) is
  // exactly what a narrower local interface is for.
  type StartableEvent = { start(offset: number): unknown };
  let started = false;

  return {
    start(): void {
      if (started) return; // already running, and it runs for the session — idempotent
      started = true;
      T.getTransport().bpm.value = MUSIC_BPM;
      const arpSeq: StartableEvent = new T.Sequence<string>(
        (time, note) => {
          arpSynth.triggerAttackRelease(note, '16n', time);
        },
        [...ARP],
        '8n',
      );
      arpSeq.start(0);
      const bassSeq: StartableEvent = new T.Sequence<string | null>(
        (time, note) => {
          if (note !== null) bassSynth.triggerAttackRelease(note, '2n', time);
        },
        [...BASS],
        '8n',
      );
      bassSeq.start(0);
      T.getTransport().start();
    },
    setDucked(ducked: boolean): void {
      // `rampTo` rather than a scheduled envelope: it is cancel-safe by
      // construction, so an interlude that opens and closes faster than one ramp
      // (a skip on the first frame) lands on the right level instead of fighting a
      // queued automation. Always ramps to an absolute target, never a relative
      // step, so no sequence of opens and closes can drift the bed's level.
      musicBus.volume.rampTo(ducked ? MUSIC_DUCK_DB : MUSIC_BASE_DB, DUCK_RAMP_S);
    },
  };
}

/**
 * How long `attemptResume` waits for the `AudioContext` to actually reach `running`
 * before giving up on it for this call. Bounded on purpose: a blocked autoplay
 * attempt does not reliably *reject* — some browsers just leave the promise pending
 * forever — and an unresolved `build()` would mean `init()` itself never resolves,
 * which would strand every caller awaiting it (the mute toggle, a screen's primary
 * button) as well as `attemptAutoStart()`. Generous enough that a real, allowed
 * resume (a returning visitor, or a genuine gesture) is never cut off early — this
 * is a ceiling on the *blocked* case, not a target latency for the allowed one.
 */
const AUTOPLAY_TIMEOUT_MS = 500;

/**
 * Ask the context to resume, and stop waiting either when it does or when the
 * timeout above elapses — never throws, never hangs. Whether it actually reached
 * `running` is `contextRunning()`'s question, not this function's: `build()` needs
 * to move on regardless, because the SFX/music graph can be constructed while the
 * context stays suspended (nodes schedule fine; they simply produce no sound until
 * something resumes the context later) — see `attemptAutoStart()`.
 */
async function attemptResume(T: ToneModule): Promise<void> {
  await Promise.race([
    T.start().catch(() => {}),
    new Promise<void>((resolve) => {
      setTimeout(resolve, AUTOPLAY_TIMEOUT_MS);
    }),
  ]);
}

/** Did the context actually end up audible? What `attemptAutoStart()` reports on. */
function contextRunning(): boolean {
  return toneRef !== null && toneRef.getContext().state === 'running';
}

/**
 * Ask a chain that is already built to actually make sound.
 *
 * The bug this fixes (human playtest, 2026-09-14: "is there a bug in the sound? I
 * can't hear anything"): the intro's mount-time `attemptAutoStart()` builds the whole
 * graph while the browser's autoplay policy still has the `AudioContext` suspended,
 * and `attemptResume` was the **only** place `Tone.start()` was ever called. Every
 * later gesture found `voices !== null`, returned early from `init()`, and the
 * context stayed suspended for the session — Transport running, voices scheduling,
 * nothing audible, SFX included. A resume is not the long task `build()` is (no fetch,
 * no graph), so it is safe from any gesture, a fight's keypress included.
 */
function resumeContext(): void {
  if (toneRef === null || contextRunning()) return;
  void toneRef.start().catch(() => {});
}

async function build(): Promise<void> {
  try {
    const T = await import('tone');
    toneRef = T;
    await attemptResume(T);
    const limiter = new T.Limiter(LIMITER_THRESHOLD_DB).toDestination();
    const master = new T.Volume(MASTER_DB).connect(limiter);
    master.mute = muted;
    bus = master;
    voices = buildVoices(T, master);
    musicNodes = buildMusic(T, master);
    // Whatever happened while the chain was still building, honour it now rather
    // than waiting for the *next* event to notice. Both halves of `musicState` are
    // live before `init()` resolves — `noteGesture` flips `playing` on the gesture
    // itself, and an interlude can open (or open *and* close) during a slow `tone`
    // fetch — so the freshly built graph is caught up here, in one place, off the
    // same state every impure entry point below reads.
    if (musicState.playing) musicNodes.start();
    if (musicState.ducked) musicNodes.setDucked(true);
  } catch {
    // `tone` failed to load, or the context could not be built. Audio stays off for
    // the session; nothing else about the game is allowed to notice.
    toneRef = null;
    bus = null;
    voices = null;
    musicNodes = null;
  }
}

/**
 * Build the audio chain, once. Safe to call from anywhere, any number of times —
 * later calls await the same build. A no-op outside a browser (no `window`), which
 * is what keeps `gen-inputlog.ts` and every Node-side script untouched.
 *
 * Every call site is either the one intro-mount attempt (`attemptAutoStart()`), a
 * deliberate menu-level gesture (a screen's primary button, the intro's own
 * fallback, the interlude's buttons, the mute toggle), or `noteInterludeOpened()`.
 * What is *not* a call site, deliberately: `armGestureFallback`'s page-level
 * listener, the only one that can fire while a round is stepping.
 *
 * That exclusion is the whole reason this doc exists. The ~80 KB `tone` chunk plus
 * every instrument graph it builds (fifteen voices, the bed's two, and the bus they
 * feed) is one long task, and `game/loop.ts`'s fixed-step accumulator has a small,
 * real catch-up budget (`MAX_CATCHUP_STEPS` — about 83 ms): building the chain on
 * the first WASD key of a round overruns it and drops ticks, which
 * `e2e/controls.spec.ts`'s `droppedTicks` assertion catches every time. So nothing
 * about a fight in progress calls `init()` — a gesture during a fight is *recorded*
 * (`onGestureFallback`) and the chain is built at the next moment that can afford
 * it.
 */
export async function init(): Promise<void> {
  if (voices !== null) {
    // Built already — but maybe under a blocked autoplay attempt. Every `init()`
    // caller is a gesture site, so this is the moment the browser lets it through.
    resumeContext();
    return;
  }
  if (typeof window === 'undefined') return;
  building ??= build();
  await building;
  // A failed attempt is allowed to retry on the *next* gesture rather than being
  // cached as a permanent no-op — a chunk fetch can fail once and succeed later.
  if (voices === null) building = null;
}

/**
 * Apply one `MusicEvent`, and move the actual audio graph if the pure step changed
 * anything. Shared by every impure caller below so "did this event just start the
 * bed / duck it / bring it back" is answered once, in one place, off the same
 * before/after comparison every time.
 *
 * The two transitions are independent on purpose: an `interludeOpened` that arrives
 * before music ever started still records the duck (so `build()` can apply it when
 * the graph appears), and a `gesture` during a ducked interlude starts the bed
 * *already* ducked rather than blasting the room mid-thought.
 */
function applyMusicEvent(event: MusicEvent): void {
  const prev = musicState;
  musicState = reduceMusicState(prev, event);
  if (!prev.playing && musicState.playing) {
    // Nothing more for the page-level fallback to do — see `armGestureFallback`.
    disarmGestureFallback();
    musicNodes?.start();
  }
  if (prev.ducked !== musicState.ducked) musicNodes?.setDucked(musicState.ducked);
}

/**
 * The mount-time attempt: try to start the chain and the loop with **no gesture at
 * all**, because that is the only way "music on the initial moments" can ever be
 * literally true — the autoplay policy is what stands between "attempt" and
 * "guarantee", not this code. Call once, from `ui/screens.ts`, the instant the intro
 * screen appears.
 *
 * `init()` builds the whole graph regardless of whether the context actually
 * resumes (see `attemptResume`'s doc) — what this function adds on top is reading
 * `contextRunning()` *after* that settles and reporting the honest outcome to
 * `musicState.ts`: `autoplaySucceeded` starts the bed for real, `autoplayFailed`
 * changes nothing and leaves the gesture listeners (`ui/screens.ts`'s intro
 * fallback and `armGestureFallback`'s page-level one-shot) as the way in. Either
 * way this never throws, never logs, and never blocks its caller — `screens.ts`
 * fires it and moves on.
 */
export function attemptAutoStart(): void {
  void init().then(() => {
    const succeeded = voices !== null && contextRunning();
    applyMusicEvent(succeeded ? { type: 'autoplaySucceeded' } : { type: 'autoplayFailed' });
  });
}

/**
 * A deliberate gesture happened — anywhere, on any screen. The one thing it can do
 * is start the music bed, and it does so the first time and never again: the pure
 * decision lives in `musicState.ts`'s `reduceMusicState`, this is its impure other
 * half. Flip the state immediately (so a second gesture on the same beat is a
 * correct no-op even before `init()` resolves) and kick off `init()`, starting the
 * bed once the chain is ready — now, if it already is.
 *
 * No `screen` argument any more. It used to take one because music was intro-only
 * and every other screen's gesture had to be filtered out; under "the bed plays for
 * the whole session" there is nothing left to filter, and a parameter every caller
 * passes and nobody reads is worse than no parameter at all.
 */
export function noteGesture(): void {
  resumeContext();
  applyMusicEvent({ type: 'gesture' });
  startBedWhenReady();
}

/**
 * Build the chain and start the bed if the state says it should be playing and the
 * graph does not exist yet. Idempotent, and safe to call from anywhere that is
 * *allowed* to pay for `init()` — which is the whole distinction this function
 * exists to draw. See `onGestureFallback`.
 */
function startBedWhenReady(): void {
  if (!musicState.playing) return;
  if (musicNodes !== null) return; // already built, and `build()`/`applyMusicEvent` started it
  void init().then(() => {
    if (musicState.playing) musicNodes?.start();
  });
}

/**
 * The last-resort way in: one page-level, one-shot `pointerdown`/`keydown` listener,
 * armed by `app.ts`'s `boot()` and removed the instant music is playing (from
 * `applyMusicEvent`, so *any* route to playing disarms it — the intro's own button,
 * a successful autoplay, or this listener itself).
 *
 * It exists for the player the menu-level gesture sites cannot reach: `?autostart=1`
 * never mounts an intro, and a browser that blocked the mount-time autoplay attempt
 * leaves a player who clicked nothing on the intro with no other arming path. Under
 * the old intro-only design those players simply got no music, which was tolerable
 * when music was a menu flourish and is not when it is the session's bed.
 *
 * Idempotent, silent outside a browser, and deliberately *not* re-armable after it
 * fires: see the header for the frame-budget cost of building the chain off a
 * gameplay keypress, which this may pay at most once per session.
 */
export function armGestureFallback(): void {
  if (typeof document === 'undefined') return;
  if (gestureFallbackArmed || musicState.playing) return;
  gestureFallbackArmed = true;
  document.addEventListener('pointerdown', onGestureFallback);
  document.addEventListener('keydown', onGestureFallback);
}

/**
 * The page-level fallback's handler, and the one place in this module that records a
 * gesture **without** building the chain.
 *
 * This is the frame-budget lesson, paid for twice. `init()` costs one long task —
 * the `tone` chunk's parse plus fifteen instrument graphs — and `game/loop.ts` caps
 * catch-up at `MAX_CATCHUP_STEPS` (5, i.e. ~83 ms), so building the chain inside the
 * task that handled a WASD keypress drops ticks in a live round;
 * `e2e/controls.spec.ts`'s `droppedTicks` assertion fails on it, which is exactly
 * how this was caught rather than shipped. The old design avoided the problem by
 * refusing gameplay input as a gesture at all — and that is what left a
 * "skip intro" player with no music for the session.
 *
 * So the two halves are separated: this records the player's consent immediately
 * (the pure state flips to `playing`, and it is *permanent*), and the graph is built
 * at the next moment that can afford a long task — `noteInterludeOpened()`, where
 * the simulation has stopped, or any menu-level gesture site, all of which call
 * `init()` themselves. The audible consequence, stated plainly: a player who skipped
 * the intro and clicks nothing but the arena hears the bed from the first interlude
 * on rather than from their first click. That is the right trade against a visible
 * stutter in a fight, and it is the only case it applies to — an intro the player
 * actually sees starts the music there, before any round exists.
 */
function onGestureFallback(): void {
  // Disarm first: a listener that removes itself before doing any work cannot fire
  // twice, and `applyMusicEvent` reaches back into `disarmGestureFallback` anyway.
  disarmGestureFallback();
  // Cheap, and the one thing a mid-fight gesture *may* do to the graph: a suspended
  // context resumed here costs no frame; a build would (see the doc above).
  resumeContext();
  applyMusicEvent({ type: 'gesture' });
}

function disarmGestureFallback(): void {
  if (!gestureFallbackArmed) return;
  gestureFallbackArmed = false;
  document.removeEventListener('pointerdown', onGestureFallback);
  document.removeEventListener('keydown', onGestureFallback);
}

/**
 * The interlude took the screen (`interlude/ui.ts`, at mount). Ducks the bed —
 * `MUSIC_DUCK_DB` over `DUCK_RAMP_S` — and nothing else: the bed keeps playing, and
 * the thinking texture that is the reason for the duck routes to the master, so it
 * sounds *over* the ducked music rather than with it.
 *
 * Never calls `init()`: an interlude opening is not a gesture, and loading `tone`
 * off it would put the chain on the determinism path (`?autostart=1` + `?agent=mock`
 * reaches an interlude with no gesture anywhere). If the graph appears later,
 * `build()` applies the duck it finds in `musicState`.
 */
export function noteInterludeOpened(): void {
  applyMusicEvent({ type: 'interludeOpened' });
  // The one *deferred* build site: if a gesture has already been recorded but the
  // chain was never paid for (`onGestureFallback` — a player who only ever clicked
  // inside a fight), this is the moment to pay. The round is over, no simulation is
  // stepping, and the screen that just mounted is a thinking screen with no frame
  // budget to blow. A no-op when the graph already exists or no gesture has
  // happened, so `?autostart=1` + `?agent=mock` still reaches an interlude with
  // `tone` never fetched.
  startBedWhenReady();
}

/**
 * The interlude is gone (`interlude/ui.ts`'s `dispose()` — the single teardown every
 * exit path runs through: the FIGHT button, the skip button, Enter/Space/Escape, the
 * deadline, and `interlude/index.ts`'s programmatic `goToNextRound`).
 *
 * Restores the bed and kills the thinking texture, in that order and
 * unconditionally. "Unconditionally" is the load-bearing word: a duck that outlived
 * its interlude would leave the rest of the session quiet, and a processing texture
 * that outlived it would hum over a live fight. Neither is allowed to depend on the
 * screen having closed the way it expected to.
 */
export function noteInterludeClosed(): void {
  applyMusicEvent({ type: 'interludeClosed' });
  clearThinkingIdleTimer();
  applyThinkingEvent({ type: 'closed' });
}

/**
 * How long after the reducer's own `THINKING_IDLE_MS` boundary the idle check is
 * scheduled. A timer that fired at exactly the boundary could land a millisecond
 * early on a coarse clock and decide "still thinking", leaving the texture running
 * with nothing to re-check it; the slack makes every scheduled check decisive.
 */
const THINKING_IDLE_SLACK_MS = 30;

/** How often the texture pulses while it is active — see `buildVoices`. */
const THINKING_PULSE_MS = 800;

/** The clock the thinking reducer is fed. `performance.now()` where it exists. */
function thinkingNow(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

/**
 * Apply one `ThinkingEvent`, and start/stop the pulse clock if the pure step changed
 * whether the texture should be sounding. Same shape as `applyMusicEvent`, and the
 * same reason: one before/after comparison, in one place.
 */
function applyThinkingEvent(event: ThinkingEvent): void {
  const prev = thinkingState;
  thinkingState = reduceThinking(prev, event);
  if (!prev.active && thinkingState.active) startThinkingPulse();
  else if (prev.active && !thinkingState.active) stopThinkingPulse();
}

function startThinkingPulse(): void {
  if (typeof window === 'undefined' || thinkingPulseTimer !== null) return;
  // Sound immediately, then on the clock: the first pulse has to land with the
  // first characters, not `THINKING_PULSE_MS` after them.
  trigger(sfxForThinking());
  thinkingPulseTimer = window.setInterval(() => {
    trigger(sfxForThinking());
  }, THINKING_PULSE_MS);
}

function stopThinkingPulse(): void {
  if (thinkingPulseTimer === null) return;
  if (typeof window !== 'undefined') window.clearInterval(thinkingPulseTimer);
  thinkingPulseTimer = null;
}

function clearThinkingIdleTimer(): void {
  if (thinkingIdleTimer === null) return;
  if (typeof window !== 'undefined') window.clearTimeout(thinkingIdleTimer);
  thinkingIdleTimer = null;
}

/**
 * A streamed chunk arrived in the interlude (`interlude/ui.ts`'s `analysis.delta`
 * and `rewrite.delta` handlers, the only two callers). Keeps the thinking texture
 * sounding for as long as the stream keeps arriving and lets it go quiet
 * `THINKING_IDLE_MS` after the last chunk — the decision itself is
 * `audio/thinking.ts`'s; this is the timer half.
 *
 * A *rescheduled timeout* rather than a polling interval: the check only has to
 * exist once per quiet period, and rescheduling it on every delta means a fluent
 * stream never runs a check at all.
 */
export function noteThinking(deltaLength: number): void {
  applyThinkingEvent({ type: 'activity', deltaLength, now: thinkingNow() });
  if (!thinkingState.active) return;
  if (typeof window === 'undefined') return;
  clearThinkingIdleTimer();
  thinkingIdleTimer = window.setTimeout(() => {
    thinkingIdleTimer = null;
    applyThinkingEvent({ type: 'idleCheck', now: thinkingNow() });
  }, THINKING_IDLE_MS + THINKING_IDLE_SLACK_MS);
}

/** Play one cue. A silent no-op before `init()` has finished, or if it never will. */
export function trigger(descriptor: SfxDescriptor): void {
  if (voices === null) return;
  const voice = voices[descriptor.id];
  if (voice === undefined) return;
  try {
    voice.play(gainToDb(descriptor.gain));
  } catch {
    // A scheduling call rejected by a torn-down context must not cost a frame.
  }
}

export function setMuted(value: boolean): void {
  muted = value;
  writeMuted(value);
  if (bus !== null) bus.mute = value;
}

export function isMuted(): boolean {
  return muted;
}
