/**
 * The interlude UI — spec §2.2, "this is the demo".
 *
 * A full-screen DOM overlay above the canvas with one panel per beat, each lighting
 * up as its events arrive. It renders `RewriteEvent`s and nothing else: it does not
 * know whether it is watching the mock or a live server, it never fetches, and it
 * holds no game state. That is what let the whole screen be built and demoed before
 * the server existed.
 *
 * Three rules the code is arranged around, all of them from the spec:
 *
 * 1. **Waiting is content.** Every beat shows partial output while it is still
 *    arriving — prose types, code streams a line at a time, gates land one by one,
 *    and the Gate 3 meter moves on *measured* progress: `trial.progress` carries
 *    the matches the harness has actually finished, so the bar is a readout, not an
 *    animation over a guessed duration. Spec §11's mitigation for LLM latency is
 *    exactly this, so a blank panel with a spinner would be the bug.
 * 2. **Nothing clears.** Above all the rejection log: "the player must be able to
 *    read every rejection. Rejections are the proof." An attempt-2 approval must not
 *    erase attempt 1's reason, so the log is append-only for the life of the screen.
 * 3. **There is always an ending.** `fallback` renders spec AC 5's banner verbatim
 *    and the FIGHT button still appears. A blank screen or a spinner that never
 *    resolves is the one outcome that is not allowed.
 *
 * DOM rather than canvas for everything except the three replay figures: this screen
 * is mostly text — a diff, a rejection reason, four observations — and text in the
 * DOM is crisp at any DPR, selectable by a judge who wants to copy a reason, and
 * visible to Playwright, which is how the e2e suite proves all four beats got real
 * content.
 */
import type { ReplaySummary } from '@rematch/engine';

import { AGENTS, JUDGE_APPROVE } from '../ui/cast.ts';
import { createPortrait, setPortraitDim } from '../ui/portrait.ts';

import './interlude.css';
import {
  castStatus,
  fallbackHeadline,
  INITIAL_CAST,
  plainVerdict,
  reduceCast,
  replayStatus,
  type AgentSlot,
  type CastState,
} from './castStatus.ts';
import {
  balanceRates,
  MAX_ATTEMPTS,
  type Analysis,
  type FailureReason,
  type GateName,
  type GateNumber,
  type GateResult,
  type RewriteEvent,
} from './events.ts';
import { drawDashRose, drawHeat, drawTimeline, replayCaption } from './replayViz.ts';
import type { SourceKind } from './source.ts';

/** The beats, in order. Also the phase machine. */
export const BEATS = ['replay', 'analysis', 'rewrite', 'trial'] as const;
export type Beat = (typeof BEATS)[number];
export type Phase = Beat | 'done';

/** Spec AC 5's outer bound: the safety-valve skip appears at 50 s, not before. */
export const SKIP_AFTER_MS = 50_000;
/** After `done`, the next round starts on its own this long later. */
export const AUTO_FIGHT_MS = 3000;

/**
 * What each source is called on screen.
 *
 * The three words are the demo's honesty contract, so they are short enough to read
 * at a glance from the back of a room: `LIVE` is happening now, `RECORDED RUN` is real
 * model output from a past run, `MOCK` is scripted. `recorded` is refined to
 * `RECORDED RUN · <model> · <date>` by `setProvenance` once the file's header has
 * loaded — this is the placeholder that shows during the fetch.
 */
export const KIND_LABEL: Readonly<Record<SourceKind, string>> = {
  mock: 'MOCK',
  sse: 'LIVE',
  recorded: 'RECORDED RUN',
};

const GATE_LABELS: Readonly<Record<GateNumber, string>> = {
  1: 'Gate 1 static',
  2: 'Gate 2 fuzz',
  3: 'Gate 3 balance',
  4: 'Gate 4 perf',
};

const BEAT_TITLES: Readonly<Record<Beat, { n: string; title: string }>> = {
  replay: { n: '01', title: 'Replay' },
  analysis: { n: '02', title: 'Analysis' },
  rewrite: { n: '03', title: 'Rewrite' },
  trial: { n: '04', title: 'Trial' },
};

/**
 * Whose beat each panel is.
 *
 * The Replay belongs to the **Analyst** rather than to nobody: the three pictures
 * in that panel are literally its input (see `replayViz.ts` — the player and the
 * agent look at the same heat grid at the same moment), so the panel is the Analyst
 * holding up what it is about to read. Its portrait is dimmed until it starts
 * talking, which is the one frame of the interlude where an agent is present but
 * not yet working.
 */
const BEAT_AGENT: Readonly<Record<Beat, AgentSlot>> = {
  replay: 'analyst',
  analysis: 'analyst',
  rewrite: 'coder',
  trial: 'judge',
};

/** Spec AC 5's wording, verbatim. The reason only chooses the second half. */
export function fallbackText(reason: FailureReason): string {
  const why =
    reason === 'max-attempts'
      ? 'it ran out of attempts'
      : reason === 'deadline'
        ? 'the coder timed out'
        : 'the coder failed';
  return `Using a pre-approved strategy — ${why}.`;
}

/** Everything Playwright and the debug surface can see. */
export type InterludeState = {
  phase: Phase;
  /** 1-based; 0 until the first `rewrite.delta`. */
  attempt: number;
  maxAttempts: number;
  kind: SourceKind;
  /** The footer badge's text: `MOCK`, `LIVE`, or `RECORDED RUN · <model> · <date>`. */
  provenance: string;
  /**
   * A caveat the source disclosed about itself, or `null`. Today only a recorded
   * run sets one, and only because the three committed runs predate Gate 3's
   * ACTIVE assertion — see `recorded.ts`'s `knownIssue`.
   */
  provenanceNote: string | null;
  gates: Array<{
    attempt: number;
    /** 0-based index of the candidate file this gate judged, when there was more than one. */
    candidate?: number;
    gate: GateNumber;
    name: GateName;
    ok: boolean;
    ms: number;
    reason?: string;
  }>;
  /**
   * Append-only. One entry per rejected candidate — spec §2.2: "the player must be
   * able to read every rejection". Three candidates that all miss the band produce
   * three entries, not one.
   */
  rejections: Array<{ attempt: number; candidate?: number; dial?: string; gate: GateNumber; reason: string }>;
  approved: boolean | null;
  fallback: { reason: FailureReason; message?: string } | null;
  done: boolean;
  /** Wall-clock since the interlude opened, milliseconds. */
  elapsedMs: number;
  /** `meta.name` of the approved strategy, once `done` carried one. */
  strategyName: string | null;
  /** Gate 3's simulation progress for the current attempt: matches done / total. */
  matchesDone: number;
  matchesTotal: number;
  /** Gate 3's panel win rate for the current attempt, when it reported one. */
  panelRate: number | null;
  mimicRate: number | null;
  analysis: Analysis | null;
  /** Characters of streamed analysis / code received. Cheap proof of streaming. */
  analysisChars: number;
  codeChars: number;
  events: number;
  /** Files this attempt is writing at once. 1 for a single-candidate run. */
  candidates: number;
  /** Which candidate's diff the Rewrite panel is showing. */
  selectedCandidate: number;
};

export type InterludeUiOptions = {
  /** Where the overlay is appended. Normally `document.body`. */
  host: HTMLElement;
  /** The round just won. The header reads `Round N → N+1`. */
  round: number;
  kind: SourceKind;
  /** Footer badge text. Defaults to `KIND_LABEL[kind]`; `recorded` refines it later. */
  provenance?: string;
  /** Start the next round. Called by FIGHT, by the auto-continue, and by Enter. */
  onFight: () => void;
  /** The 50 s safety valve. Ships a bundled strategy (see `app.ts`). */
  onSkip: () => void;
  /** 0 disables the auto-continue (the e2e suite does, so it can assert first). */
  autoFightMs?: number;
  /** Injectable for tests. */
  now?: () => number;
};

export type InterludeUi = {
  handle(event: RewriteEvent): void;
  /** The client-side 45 s deadline fired; there was no `fallback` event to render. */
  showFallback(reason: FailureReason, message?: string): void;
  /** Reveal FIGHT and start the auto-continue. Idempotent. */
  finish(): void;
  setKind(kind: SourceKind, why?: string): void;
  /**
   * Replace the footer badge's text. `recorded` calls this once its header lands.
   *
   * `note` is a caveat about the source itself — a recorded run that predates a gate,
   * for instance — and it is rendered as its own line beside the badge *and* as the
   * badge's tooltip. The badge stays a chip you can read from the back of a room; the
   * note is the sentence that keeps it honest on video.
   */
  setProvenance(text: string, note?: string): void;
  state(): InterludeState;
  dispose(): void;
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * The Gate 3 meter, as a value.
 *
 * Pure so it can be tested without a DOM (`test/interlude-meter.test.ts`), and
 * because everything interesting about the meter is arithmetic: it shows the
 * fraction of matches the harness has actually finished, and it reaches 100% when —
 * and only when — the last one lands.
 *
 * The old version animated over a 4.2 s estimate and capped itself at 85% so it
 * could not claim to be finished while the simulation ran. That cap was an apology
 * for not knowing; `simulate()` now reports batched progress, so the honest bar is
 * the measured one and there is nothing left to estimate.
 */
export type MeterView = {
  /** 0-1. `width` on the fill element. */
  fraction: number;
  /** `Gate 3 · simulating 200 matches` / `Gate 3 · simulated`. */
  label: string;
  /** `130 / 200`. */
  count: string;
  /** Every match is in; the bar turns the player colour. */
  done: boolean;
};

export function meterView(matchesDone: number, matchesTotal: number): MeterView {
  const total = Math.max(1, Math.round(matchesTotal));
  const done = Math.max(0, Math.min(total, Math.round(matchesDone)));
  const complete = done >= total;
  return {
    fraction: done / total,
    label: complete ? 'Gate 3 · simulated' : `Gate 3 · simulating ${total} matches`,
    count: `${done} / ${total}`,
    done: complete,
  };
}

export function createInterludeUi(options: InterludeUiOptions): InterludeUi {
  const now = options.now ?? ((): number => performance.now());
  const startedAt = now();
  const autoFightMs = options.autoFightMs ?? AUTO_FIGHT_MS;

  const state: InterludeState = {
    phase: 'replay',
    attempt: 0,
    maxAttempts: MAX_ATTEMPTS,
    kind: options.kind,
    provenance: options.provenance ?? KIND_LABEL[options.kind],
    provenanceNote: null,
    gates: [],
    rejections: [],
    approved: null,
    fallback: null,
    done: false,
    elapsedMs: 0,
    strategyName: null,
    matchesDone: 0,
    matchesTotal: 0,
    panelRate: null,
    mimicRate: null,
    analysis: null,
    analysisChars: 0,
    codeChars: 0,
    events: 0,
    candidates: 1,
    selectedCandidate: 0,
  };

  // ------------------------------------------------------------------ header
  const root = el('div');
  root.id = 'interlude';
  root.dataset.testid = 'il-root';
  root.dataset.phase = state.phase;

  const head = el('header', 'il-head');
  head.append(el('div', 'il-title', 'The boss is rewriting itself'));
  const rounds = el('div', 'il-rounds');
  rounds.dataset.testid = 'il-rounds';
  rounds.append(document.createTextNode('Round '), el('b', undefined, String(options.round)), document.createTextNode(' → '), el('b', undefined, String(options.round + 1)));
  head.append(rounds);

  const chips = el('div', 'il-beats');
  const chipFor = new Map<Beat, HTMLElement>();
  for (const beat of BEATS) {
    const chip = el('div', 'il-chip', `${BEAT_TITLES[beat].n} ${BEAT_TITLES[beat].title}`);
    chip.dataset.state = 'idle';
    chipFor.set(beat, chip);
    chips.append(chip);
  }
  head.append(chips);

  const clock = el('div', 'il-clock', '0.0s');
  clock.dataset.testid = 'il-clock';
  const kindBadge = el('div', 'il-kind', KIND_LABEL[options.kind]);
  kindBadge.dataset.testid = 'il-kind';
  kindBadge.dataset.kind = options.kind;
  head.append(clock, kindBadge);
  root.append(head);

  // -------------------------------------------------------------------- grid
  const grid = el('main', 'il-grid');
  const panelFor = new Map<Beat, HTMLElement>();
  const bodyFor = new Map<Beat, HTMLElement>();
  const noteFor = new Map<Beat, HTMLElement>();
  /** The status line under each panel's agent name. Written by `paintCast`. */
  const statusFor = new Map<Beat, HTMLElement>();
  /** Each panel's portrait, so the Analyst's can stop being dimmed. */
  const portraitFor = new Map<Beat, HTMLElement>();

  for (const beat of BEATS) {
    const agent = AGENTS[BEAT_AGENT[beat]];
    const panel = el('section', 'il-panel');
    panel.dataset.beat = beat;
    panel.dataset.agent = agent.id;
    panel.dataset.state = beat === 'replay' ? 'active' : 'idle';
    panel.dataset.testid = `il-beat-${beat}`;
    // Every accent on this panel — border, glow, name, bullets — comes from here,
    // so "who is acting" is one custom property and not four rules.
    panel.style.setProperty('--accent', agent.accent);

    const panelHead = el('div', 'il-panel-head');
    // Dimmed to start with: the Analyst is holding the replay, not reading it yet.
    const portrait = createPortrait(agent.id, { size: 48, dim: beat === 'replay' });
    portraitFor.set(beat, portrait);

    const who = el('div', 'il-who');
    const whoTop = el('div', 'il-who-top');
    const agentName = el('span', 'il-agent', agent.name.toUpperCase());
    agentName.dataset.testid = `il-agent-${beat}`;
    whoTop.append(agentName, el('span', 'n', BEAT_TITLES[beat].n), el('h2', undefined, BEAT_TITLES[beat].title));
    const status = el('div', 'il-agent-status');
    status.dataset.testid = `il-status-${beat}`;
    statusFor.set(beat, status);
    who.append(whoTop, status);

    const note = el('span', 'note');
    note.dataset.testid = `il-note-${beat}`;
    noteFor.set(beat, note);
    panelHead.append(portrait, who, note);

    const body = el('div', 'il-body');
    body.dataset.testid = `il-body-${beat}`;
    bodyFor.set(beat, body);

    panel.append(panelHead, body);
    panelFor.set(beat, panel);
    grid.append(panel);
  }
  root.append(grid);

  // ------------------------------------------------------- beat 1: the replay
  const replayBody = bodyFor.get('replay') as HTMLElement;
  const figs = el('div', 'il-replay-figs');
  const heatCanvas = el('canvas');
  heatCanvas.id = 'il-heat';
  heatCanvas.width = 168;
  heatCanvas.height = 168;
  const heatFig = el('figure', 'il-fig');
  heatFig.append(heatCanvas, el('figcaption', undefined, 'Where you lived · 8×8'));
  const roseCanvas = el('canvas');
  roseCanvas.id = 'il-rose';
  roseCanvas.width = 120;
  roseCanvas.height = 120;
  const roseFig = el('figure', 'il-fig');
  roseFig.append(roseCanvas, el('figcaption', undefined, 'Dash directions'));
  figs.append(heatFig, roseFig);

  const stripCanvas = el('canvas');
  stripCanvas.id = 'il-strip';
  stripCanvas.width = 600;
  stripCanvas.height = 46;
  const stripWrap = el('div', 'il-strip-wrap');
  const legend = el('div', 'il-legend');
  legend.append(
    el('span', 'mine', 'your shots + dashes'),
    el('span', 'theirs', 'boss primitives'),
    el('span', 'hits', 'hits taken / dealt'),
  );
  stripWrap.append(stripCanvas, legend);

  const replayCap = el('div', 'il-caption', 'Waiting for the replay…');
  replayCap.dataset.testid = 'il-replay-caption';
  replayBody.append(figs, stripWrap, replayCap);

  // ----------------------------------------------------- beat 2: the analysis
  //
  // The Analyst's output is the only thing on this screen that is *speech* — it is
  // sentences, typed a character at a time, about you — so it is rendered as a
  // speech bubble tailed at the portrait above it rather than as another pane of
  // output. The typewriter is unchanged; only the frame around it is new.
  const analysisBody = bodyFor.get('analysis') as HTMLElement;
  const bubble = el('div', 'il-bubble');
  bubble.dataset.testid = 'il-bubble';
  const stream = el('pre', 'il-stream');
  stream.dataset.testid = 'il-analysis-stream';
  stream.dataset.streaming = 'false';
  stream.textContent = '';
  const structured = el('div', 'il-structured');
  structured.dataset.testid = 'il-analysis-structured';
  structured.hidden = true;
  bubble.append(stream, structured);
  analysisBody.append(bubble);

  // ------------------------------------------------------ beat 3: the rewrite
  const rewriteBody = bodyFor.get('rewrite') as HTMLElement;
  // The tab strip: one tab per candidate file the attempt is writing, with the
  // harness's mark on it as each verdict lands. Hidden for a single-candidate run,
  // so nothing about the pre-candidate screen changes.
  const candStrip = el('div', 'il-cands');
  candStrip.dataset.testid = 'il-cands';
  candStrip.hidden = true;
  // The diff's own byline: the Coder, small, and the name the boss will fight under.
  // A unified diff is anonymous, and the name is the thing that makes the beat read
  // as a character changing rather than as a file changing.
  const diffHead = el('div', 'il-diff-head');
  diffHead.dataset.testid = 'il-diff-head';
  diffHead.hidden = true;
  const diffHeadName = el('b', 'il-strategy-name');
  const diffHeadNote = el('span', 'dim');
  diffHead.append(
    createPortrait('coder', { size: 22 }),
    el('span', 'says', 'the boss is now'),
    diffHeadName,
    diffHeadNote,
  );
  const code = el('pre', 'il-code');
  code.dataset.testid = 'il-code';
  const diff = el('pre', 'il-diff');
  diff.dataset.testid = 'il-diff';
  diff.hidden = true;
  rewriteBody.append(candStrip, diffHead, code, diff);

  // -------------------------------------------------------- beat 4: the trial
  const trialBody = bodyFor.get('trial') as HTMLElement;
  const gateList = el('div', 'il-gates');
  gateList.dataset.testid = 'il-gates';

  const meterWrap = el('div', 'il-meter-wrap');
  meterWrap.hidden = true;
  const meterLabel = el('div', 'il-meter-label');
  const meterLeft = el('span', undefined, 'Gate 3 · simulating');
  const meterRight = el('span', undefined, '0 / 200');
  meterLabel.append(meterLeft, meterRight);
  const meter = el('div', 'il-meter');
  meter.dataset.testid = 'il-meter';
  const meterFill = el('i');
  meter.append(meterFill);
  meterWrap.append(meterLabel, meter);

  // The verdict, as a stamp the Judge puts on a file: its portrait, the mark, the
  // reason in plain words, and — smaller, in monospace, never dropped — the
  // harness's own quantitative sentence. Spec §2.2: every rejection stays readable,
  // and "readable" now means readable by a player *and* checkable by a judge.
  const verdict = el('div', 'il-verdict');
  verdict.dataset.testid = 'il-verdict';
  const verdictPortrait = createPortrait('judge', { size: 48, dim: true });
  const stamp = el('div', 'il-stamp');
  const stampMark = el('b', 'il-stamp-mark');
  const stampPlain = el('span', 'il-stamp-plain');
  const stampRaw = el('code', 'il-stamp-raw');
  stampRaw.dataset.testid = 'il-stamp-raw';
  stamp.append(stampMark, stampPlain, stampRaw);
  verdict.append(verdictPortrait, stamp);
  const rejections = el('ul', 'il-rejections');
  rejections.dataset.testid = 'il-rejections';
  trialBody.append(gateList, meterWrap, verdict, rejections);

  // ------------------------------------------------------------------ footer
  const foot = el('footer', 'il-foot');
  // Spec AC 5's fallback is also a Judge verdict — "nothing was approved, so here is
  // something that already was" — so it wears the same stamp as a rejection rather
  // than being an anonymous amber strip.
  const banner = el('div', 'il-banner');
  banner.dataset.testid = 'il-banner';
  banner.hidden = true;
  const bannerHead = el('b', 'il-banner-head');
  const bannerText = el('span', 'il-banner-text');
  const bannerBody = el('div');
  bannerBody.append(bannerHead, bannerText);
  banner.append(createPortrait('judge', { size: 36 }), bannerBody);
  const status = el('div', 'il-status');
  status.dataset.testid = 'il-status';
  status.append(document.createTextNode('The analyst is reading the replay. The coder writes; the harness decides.'));
  const actions = el('div', 'il-actions');
  const skip = el('button', 'il-skip', 'skip');
  skip.type = 'button';
  skip.dataset.testid = 'il-skip';
  skip.hidden = true;
  const fight = el('button', 'il-fight');
  fight.type = 'button';
  fight.dataset.testid = 'il-fight';
  fight.hidden = true;
  const fightLabel = el('span', undefined, 'FIGHT');
  const fightCount = el('span', 'count');
  fight.append(fightLabel, fightCount);
  actions.append(skip, fight);
  // The provenance badge lives in the footer rather than the header because the
  // recorded label is a whole sentence (`RECORDED RUN . <model> . <date>`) and the
  // header's badge slot is a 9px chip. In a demo video the footer is also where the
  // eye already is, next to FIGHT.
  const provenance = el('div', 'il-provenance', state.provenance);
  provenance.dataset.testid = 'il-provenance';
  provenance.dataset.kind = options.kind;
  // Hidden until a source discloses something. Only `recorded` ever does today.
  const provenanceNote = el('div', 'il-provenance-note');
  provenanceNote.dataset.testid = 'il-provenance-note';
  provenanceNote.hidden = true;
  const provenanceBox = el('div', 'il-provenance-box');
  provenanceBox.append(provenance, provenanceNote);
  foot.append(banner, status, provenanceBox, actions);
  root.append(foot);

  options.host.append(root);

  // ------------------------------------------------------------------- timers
  let disposed = false;
  let autoFightAt: number | null = null;

  const skipTimer = window.setTimeout(() => {
    if (!state.done) skip.hidden = false;
  }, SKIP_AFTER_MS);

  function setPhase(phase: Phase): void {
    state.phase = phase;
    root.dataset.phase = phase;
    // `BEATS.indexOf('done')` is -1, so the final phase is handled explicitly
    // rather than by the index comparison: at `done`, every beat is done.
    const allDone = phase === 'done';
    for (const beat of BEATS) {
      const chip = chipFor.get(beat);
      const panel = panelFor.get(beat);
      const active = beat === phase;
      const done = allDone || BEATS.indexOf(beat) < BEATS.indexOf(phase as Beat);
      if (chip !== undefined) chip.dataset.state = active ? 'active' : done ? 'done' : 'idle';
      if (panel !== undefined) {
        // A panel that already has content never goes back to `idle`: the Trial
        // panel is written to while the Rewrite panel is streaming the next attempt.
        const hasContent = panel.dataset.touched === '1';
        panel.dataset.state = active ? 'active' : done || hasContent ? 'done' : 'idle';
      }
    }
  }

  function touch(beat: Beat): void {
    const panel = panelFor.get(beat);
    if (panel !== undefined) panel.dataset.touched = '1';
  }

  /** Advance the phase only forward: events for an earlier beat still arrive. */
  function advance(beat: Beat): void {
    touch(beat);
    if (state.phase === 'done') return;
    const current = BEATS.indexOf(state.phase as Beat);
    if (BEATS.indexOf(beat) >= current) setPhase(beat);
  }

  function setNote(beat: Beat, text: string): void {
    const note = noteFor.get(beat);
    if (note !== undefined) note.textContent = text;
  }

  // -------------------------------------------------------------- the cast
  /**
   * Who is doing what, accumulated from the same events the panels render.
   *
   * Kept as its own value rather than derived from `state` because it is a
   * *different* reading of the stream — `state` is what happened (every gate, every
   * rejection, the counters a test asserts), and this is who is speaking right now.
   * The reducer and the strings are pure and live in `castStatus.ts`.
   */
  // `active: 'analyst'` rather than `null`: the screen opens on the Replay beat,
  // which is the Analyst's, so the first frame already says whose turn it is.
  let cast: CastState = { ...INITIAL_CAST, active: 'analyst' };

  /** Repaint the three status lines, the glow, and the Analyst's dimmed portrait. */
  function paintCast(): void {
    const lines = castStatus(cast);
    for (const beat of BEATS) {
      const slot = BEAT_AGENT[beat];
      const node = statusFor.get(beat);
      // The Analyst owns two panels, and the same sentence twice on one screen is
      // noise: the Replay panel's line becomes a caption once the reading exists.
      if (node !== undefined) node.textContent = beat === 'replay' ? replayStatus(cast) : lines[slot];
      const panel = panelFor.get(beat);
      // The acting agent's panel glows in its own accent; everything else is quiet.
      // `data-acting` rather than reusing `data-state`, because the two answer
      // different questions: `state` is "has this beat had its turn", `acting` is
      // "is this agent working *now*", and during a retry the Coder is working
      // while the Trial panel is still the one holding content.
      if (panel !== undefined) {
        if (cast.active === slot && !cast.done) panel.dataset.acting = '1';
        else delete panel.dataset.acting;
      }
    }
    const replayPortrait = portraitFor.get('replay');
    if (replayPortrait !== undefined) setPortraitDim(replayPortrait, !cast.analysisStarted);
    // The Judge's own portrait on the stamp lights up once it has something to say.
    const working = cast.simulating || cast.written > 0;
    setPortraitDim(verdictPortrait, cast.verdict === null && cast.fallback === null && !working);
    // Before the first verdict the stamp is a status, not a ruling — and it must not
    // still say "nothing has been submitted" while Gate 3 is visibly running. Once
    // any verdict exists this stops touching it: the ruling stays until it is
    // replaced by the next one, including the `↻ rewriting…` line a retry sets.
    if (cast.verdict === null && cast.fallback === null) {
      if (!working) setVerdict('working', 'WAITING', 'nothing has been submitted to the harness yet');
      else if (cast.simulating) {
        setVerdict('working', '↻ TESTING', `simulating ${cast.matchesTotal} matches — no verdict yet`);
      } else setVerdict('working', '↻ TESTING', 'the harness is running the gates');
    }
  }

  // ------------------------------------------------------------- the clock
  function tickClock(): void {
    if (disposed) return;
    const elapsed = now() - startedAt;
    state.elapsedMs = elapsed;
    clock.textContent = `${(elapsed / 1000).toFixed(1)}s`;
    // 45 s is the AC 5 budget. Past it the number itself is the warning.
    clock.classList.toggle('over', elapsed > 45_000);

    if (autoFightAt !== null) {
      const left = Math.max(0, autoFightAt - elapsed);
      fightCount.textContent = ` ${Math.ceil(left / 1000)}`;
      if (left <= 0) {
        autoFightAt = null;
        fightCount.textContent = '';
        options.onFight();
        return;
      }
    }

    frame = requestAnimationFrame(tickClock);
  }
  let frame = requestAnimationFrame(tickClock);

  // ------------------------------------------------------------- candidates
  /**
   * One tab per file the attempt is writing.
   *
   * An attempt writes K strategies at once — aimed at the low edge, the middle and
   * the high edge of the round's fairness band — and the harness keeps whichever it
   * likes best. That is the interesting part of the beat, so the panel shows all of
   * them: the strip is the search, and the pane below it is whichever one the
   * player is looking at.
   *
   * The text of an unselected candidate is kept as a string rather than as DOM. A
   * candidate streams ~4 KB and only one is on screen, so three hidden `<pre>`s
   * would be three times the nodes for nothing; switching tabs re-renders from the
   * string, which is one paint.
   */
  type CandidateView = {
    index: number;
    label: string;
    dial: string | null;
    /** Streamed source so far. */
    code: string;
    /** The unified diff, once `rewrite.done` landed. */
    diff: string | null;
    status: 'writing' | 'testing' | 'ok' | 'fail';
    tab: HTMLButtonElement;
  };

  /**
   * The candidate tabs, indexed by candidate number — and **sparse on purpose**.
   *
   * The K files stream concurrently and the model finishes them in whatever order it
   * likes, so candidate 2 can arrive before candidate 1 and leave a hole at index 1.
   * The type says `| undefined` so every read has to admit that: a `for…of` over a
   * sparse array yields `undefined` for the holes, and iterating this one without a
   * guard is exactly how the recorded-run e2e first failed ("Cannot read properties
   * of undefined (reading 'tab')"). The mock never caught it because a hand-written
   * script finishes its candidates in order.
   */
  let views: Array<CandidateView | undefined> = [];
  /** The player clicked a tab; stop following the newest one until the next attempt. */
  let pinned = false;
  /**
   * The candidate that passed, once one has.
   *
   * The loop keeps measuring the remaining candidates after one is approved (it
   * ships whichever lands closest to the middle of the band), so without this the
   * pane and the win rate on the verdict line would both drift onto a *rejected*
   * file after the approval — the last thing the player should be left looking at.
   */
  let locked: { candidate: number; panel: number | null; mimic: number | null } | null = null;
  /** One gate-row container per candidate, so the Trial panel reads as K columns of proof. */
  const groups = new Map<number, HTMLElement>();

  const MARKS: Readonly<Record<CandidateView['status'], string>> = {
    writing: '…',
    testing: '·',
    ok: '✓',
    fail: '✗',
  };

  function paintTab(view: CandidateView): void {
    view.tab.replaceChildren(
      el('span', 'mark', MARKS[view.status]),
      el('span', 'name', view.label),
    );
    view.tab.dataset.status = view.status;
    view.tab.dataset.selected = view.index === state.selectedCandidate ? 'true' : 'false';
  }

  function showCandidate(index: number): void {
    state.selectedCandidate = index;
    const view = views[index];
    for (const other of views) {
      if (other !== undefined) paintTab(other);
    }
    if (view === undefined) return;
    setDiffHead(view);
    if (view.diff !== null) {
      renderDiff(view.diff === '' ? '(no change from the previous strategy)' : view.diff);
    } else {
      diff.hidden = true;
      code.hidden = false;
      code.textContent = view.code;
      code.scrollTop = code.scrollHeight;
    }
  }

  function candidateView(index: number, total: number): CandidateView {
    const existing = views[index];
    if (existing !== undefined) return existing;
    const tab = el('button', 'il-cand');
    tab.type = 'button';
    tab.dataset.testid = `il-cand-${index}`;
    const view: CandidateView = {
      index,
      label: total > 1 ? `candidate ${index + 1}` : 'strategy',
      dial: null,
      code: '',
      diff: null,
      status: 'writing',
      tab,
    };
    tab.addEventListener('click', () => {
      pinned = true;
      showCandidate(index);
    });
    views[index] = view;
    // Insert in index order: the tabs are the low/middle/high aim points and their
    // order is the thing that makes the strip readable, but the files arrive in
    // whatever order the model finishes them.
    const after = views.slice(index + 1).find((v): v is CandidateView => v !== undefined);
    if (after === undefined) candStrip.append(tab);
    else candStrip.insertBefore(tab, after.tab);
    candStrip.hidden = total <= 1;
    paintTab(view);
    return view;
  }

  /** A new attempt: a fresh strip, a fresh pane, nothing pinned. */
  function resetCandidates(attempt: number, total: number): void {
    state.attempt = attempt;
    state.candidates = total;
    state.selectedCandidate = 0;
    state.matchesDone = 0;
    state.matchesTotal = 0;
    state.panelRate = null;
    state.mimicRate = null;
    state.codeChars = 0;
    pinned = false;
    locked = null;
    views = [];
    candStrip.replaceChildren();
    candStrip.hidden = total <= 1;
    gateList.replaceChildren();
    groups.clear();
    code.replaceChildren();
    code.hidden = false;
    diff.hidden = true;
    diffHead.hidden = true;
  }

  function setCandidateStatus(index: number, status: CandidateView['status']): void {
    const view = views[index];
    if (view === undefined) return;
    view.status = status;
    paintTab(view);
  }

  // -------------------------------------------------------------- rendering
  function renderStructuredAnalysis(analysis: Analysis): void {
    structured.replaceChildren();
    const list = el('ul', 'il-obs');
    for (const observation of analysis.observations) list.append(el('li', undefined, observation));
    const tagRow = el('div');
    tagRow.append(el('span', 'il-tag', `archetype · ${analysis.playerArchetype}`));
    const plan = el('p', 'il-plan');
    plan.append(el('span', 'lbl', 'counter-plan'), document.createTextNode(analysis.counterPlan));
    structured.append(tagRow, list, plan);
    structured.hidden = false;
    // The streamed prose stays in the DOM, scrolled away: the structured reading is
    // the conclusion, but the sentences the player watched being typed are what
    // makes it credible. Collapsing it to a fixed strip keeps both. (The Analyst's
    // JSON block was never streamed — see `analysisGate`; it is on
    // `analysis.done.raw` for the run log.)
    stream.dataset.streaming = 'false';
    stream.style.flex = '0 0 46px';
  }

  function renderDiff(text: string): void {
    diff.replaceChildren();
    for (const line of text.split('\n')) {
      let cls = '';
      if (line.startsWith('+++') || line.startsWith('---')) cls = 'file';
      else if (line.startsWith('@@')) cls = 'hunk';
      else if (line.startsWith('+')) cls = 'add';
      else if (line.startsWith('-')) cls = 'del';
      const span = el('span', cls === '' ? undefined : cls, `${line}\n`);
      diff.append(span);
    }
    diff.hidden = false;
    code.hidden = true;
  }

  /**
   * The gate rows for one candidate.
   *
   * Grouped rather than appended flat: with three candidates the panel would
   * otherwise be twelve unlabelled rows, and which file a `✗ Gate 3` belongs to is
   * the whole content of the beat.
   */
  function gateGroup(candidate: number | undefined): HTMLElement {
    const key = candidate ?? -1;
    const existing = groups.get(key);
    if (existing !== undefined) return existing;
    const group = el('div', 'il-gate-group');
    group.dataset.candidate = String(key);
    group.dataset.testid = key < 0 ? 'il-gate-group' : `il-gate-group-${key}`;
    if (key >= 0) {
      group.append(el('div', 'il-gate-group-head', views[key]?.label ?? `candidate ${key + 1}`));
    }
    groups.set(key, group);
    gateList.append(group);
    return group;
  }

  /** One row per gate. A pending Gate 3 row is replaced when its result lands. */
  function addGateRow(gate: GateResult, candidate?: number): void {
    const group = gateGroup(candidate);
    const existing = group.querySelector<HTMLElement>(`[data-gate="${gate.gate}"][data-pending="1"]`);
    const row = existing ?? el('div', 'il-gate');
    row.replaceChildren();
    row.className = 'il-gate';
    row.dataset.gate = String(gate.gate);
    delete row.dataset.pending;
    row.dataset.ok = gate.ok ? 'true' : 'false';
    row.append(el('span', 'mark', gate.ok ? '✓' : '✗'), el('span', 'name', GATE_LABELS[gate.gate]));
    if (gate.ok) {
      row.append(el('span', 'ms', `${Math.round(gate.ms)}ms`));
      const rates = balanceRates(gate);
      if (rates.panel !== undefined) {
        row.append(el('span', 'ms', `panel ${(rates.panel * 100).toFixed(0)}%${rates.mimic === undefined ? '' : ` · mimic ${(rates.mimic * 100).toFixed(0)}%`}`));
      }
    } else {
      row.append(el('span', 'why', `REJECTED — ${gate.reason}`));
    }
    if (existing === null) group.append(row);
    // Follow the newest gate. The list is short but it scrolls (a Gate 3 reason is
    // four wrapped lines), and the row worth seeing is always the last one — the
    // earlier attempts' rejections are preserved in the log below regardless.
    gateList.scrollTop = gateList.scrollHeight;
  }

  function addPendingGateRow(gate: GateNumber, label: string, candidate?: number): void {
    const row = el('div', 'il-gate');
    row.dataset.gate = String(gate);
    row.dataset.pending = '1';
    row.dataset.ok = 'pending';
    row.append(el('span', 'mark', '·'), el('span', 'name', GATE_LABELS[gate]), el('span', 'ms', label));
    gateGroup(candidate).append(row);
    gateList.scrollTop = gateList.scrollHeight;
  }

  /**
   * The stamp.
   *
   * `mark` is the verdict itself (`✓ APPROVED — 45%`), `plain` is what that means
   * in words, and `raw` is the harness's sentence verbatim in monospace. All three
   * slots are always in the DOM and are emptied rather than removed, so nothing
   * about the panel's height jumps between a rejection and an approval.
   */
  function setVerdict(
    kind: 'rejected' | 'approved' | 'working',
    mark: string,
    plain?: string,
    raw?: string,
  ): void {
    verdict.dataset.kind = kind;
    stampMark.textContent = mark;
    stampPlain.textContent = plain ?? '';
    stampRaw.textContent = raw ?? '';
    stampRaw.hidden = raw === undefined || raw === '';
    // Green for an approval, the Judge's red for a rejection — one agent, two
    // verdicts (see `JUDGE_APPROVE`), rather than two differently-coloured chromes.
    verdict.style.setProperty('--accent', kind === 'approved' ? JUDGE_APPROVE : AGENTS.judge.accent);
  }

  /** The diff's byline: the Coder, and the name the boss will fight under. */
  function setDiffHead(view: CandidateView | undefined): void {
    const name = view?.label ?? null;
    if (view === undefined || name === null || view.diff === null) {
      diffHead.hidden = true;
      return;
    }
    diffHeadName.textContent = name;
    diffHeadNote.textContent =
      state.candidates > 1
        ? ` · attempt ${state.attempt} · ${view.dial ?? `candidate ${view.index + 1}`}`
        : ` · attempt ${state.attempt}`;
    diffHead.hidden = false;
  }

  function drawReplay(summary: ReplaySummary): void {
    drawHeat(heatCanvas, summary.history.playerPosHeat);
    drawDashRose(roseCanvas, summary.history.playerDashDirs);
    drawTimeline(stripCanvas, summary);
    replayCap.textContent = replayCaption(summary);
  }

  // -------------------------------------------------------------- the handler
  function handle(event: RewriteEvent): void {
    if (disposed) return;
    state.events += 1;

    switch (event.type) {
      case 'replay': {
        drawReplay(event.summary);
        setNote('replay', `seed ${event.summary.seed} · ${event.summary.timelineTotal} events`);
        advance('replay');
        // The Analyst is next and takes a couple of seconds to say anything; say
        // what is happening rather than showing an empty pane.
        stream.dataset.streaming = 'true';
        setPhase('analysis');
        touch('replay');
        break;
      }

      case 'analysis.delta': {
        advance('analysis');
        state.analysisChars += event.delta.length;
        stream.dataset.streaming = 'true';
        stream.append(document.createTextNode(event.delta));
        // Autoscroll only while the player has not scrolled up themselves.
        stream.scrollTop = stream.scrollHeight;
        setNote('analysis', `${state.analysisChars} chars`);
        break;
      }

      case 'analysis.done': {
        advance('analysis');
        state.analysis = event.analysis;
        renderStructuredAnalysis(event.analysis);
        setNote('analysis', `${(event.ms / 1000).toFixed(1)}s · ${event.usage.outputTokens} tok · ${event.calls} call${event.calls === 1 ? '' : 's'}`);
        status.replaceChildren(
          document.createTextNode('Read as a '),
          el('b', undefined, event.analysis.playerArchetype),
          document.createTextNode('. The coder is writing a counter; the harness has final say.'),
        );
        break;
      }

      case 'rewrite.delta': {
        advance('rewrite');
        const total = event.candidates ?? 1;
        const index = event.candidate ?? 0;
        if (event.attempt !== state.attempt) {
          // A new attempt: fresh strip, fresh pane, and the verdict line becomes
          // the "it is fixing itself" moment the rejection set up.
          resetCandidates(event.attempt, total);
          if (state.rejections.length > 0) {
            setVerdict(
              'working',
              '↻ rewriting…',
              total > 1
                ? `attempt ${event.attempt} — ${total} files at once, with the rejections as their only feedback`
                : `attempt ${event.attempt}, with the rejection as its only feedback`,
            );
          }
        }
        const view = candidateView(index, total);
        view.code += event.delta;
        state.codeChars += event.delta.length;
        // The K files stream at once, so "follow the newest delta" would flicker
        // between three tabs sixty times a second. The pane stays on the first file
        // to arrive while they are all being written, and moves to whichever one is
        // under the harness once the Trial beat starts (see `trial.gate`).
        if (!pinned && locked === null && views[state.selectedCandidate] === undefined) showCandidate(index);
        if (state.selectedCandidate === index && view.diff === null) {
          code.hidden = false;
          diff.hidden = true;
          code.append(document.createTextNode(event.delta));
          code.scrollTop = code.scrollHeight;
        }
        setNote(
          'rewrite',
          total > 1
            ? `attempt ${state.attempt} · ${total} candidates · ${state.codeChars} chars`
            : `attempt ${state.attempt} · ${state.codeChars} chars`,
        );
        break;
      }

      case 'rewrite.done': {
        advance('rewrite');
        const total = event.candidates ?? 1;
        const index = event.candidate ?? 0;
        if (event.attempt !== state.attempt) resetCandidates(event.attempt, total);
        state.attempt = event.attempt;
        // The file's own `meta`, parsed from its source by the loop — not guessed
        // from the text here, and not the sandbox's (this attempt may never load).
        const name = event.meta?.name ?? null;
        const view = candidateView(index, total);
        view.diff = event.diff;
        view.status = 'testing';
        if (event.dial !== undefined) view.dial = event.dial;
        view.label = name ?? event.dial ?? view.label;
        paintTab(view);
        // Re-render only if this is the file on screen: the diff replaces the code.
        if (state.selectedCandidate === index) showCandidate(index);
        const note = noteFor.get('rewrite');
        if (note !== undefined) {
          note.replaceChildren();
          if (name !== null) note.append(el('span', 'il-strategy-name', name), document.createTextNode(' · '));
          note.append(
            document.createTextNode(
              total > 1
                ? `attempt ${event.attempt} · candidate ${index + 1} of ${total} · ${event.source.length} bytes`
                : `attempt ${event.attempt} · ${event.source.length} bytes`,
            ),
          );
        }
        setPhase('trial');
        break;
      }

      case 'trial.gate': {
        advance('trial');
        // Whatever the harness is judging is what the diff should be showing.
        if (!pinned && locked === null && event.candidate !== undefined && event.candidate !== state.selectedCandidate) {
          showCandidate(event.candidate);
        }
        addGateRow(event.gate, event.candidate);
        state.gates.push({
          attempt: event.attempt,
          ...(event.candidate === undefined ? {} : { candidate: event.candidate }),
          gate: event.gate.gate,
          name: event.gate.name,
          ok: event.gate.ok,
          ms: event.gate.ms,
          ...(event.gate.ok ? {} : { reason: event.gate.reason }),
        });
        if (event.gate.gate === 3) {
          const rates = balanceRates(event.gate);
          if (rates.panel !== undefined) state.panelRate = rates.panel;
          if (rates.mimic !== undefined) state.mimicRate = rates.mimic;
        }
        break;
      }

      case 'trial.progress': {
        advance('trial');
        meterWrap.hidden = false;
        // Measured, not animated: every frame of this bar is a number of matches
        // the harness has really finished (`simulate()`'s batched `onProgress`).
        const view = meterView(event.matchesDone, event.matchesTotal);
        state.matchesDone = event.matchesDone;
        state.matchesTotal = event.matchesTotal;
        meterFill.style.width = `${(view.fraction * 100).toFixed(1)}%`;
        meterLeft.textContent = view.label;
        meterRight.textContent = view.count;
        meter.classList.toggle('done', view.done);
        // The first event of an attempt is the one that puts the row on screen.
        if (event.matchesDone <= 0) addPendingGateRow(3, 'simulating…', event.candidate);
        // The meter belongs to whichever candidate is being simulated; show that
        // one, so the diff on screen is the file the bar is measuring.
        if (!pinned && locked === null && event.candidate !== undefined && event.candidate !== state.selectedCandidate) {
          showCandidate(event.candidate);
        }
        break;
      }

      case 'verdict': {
        advance('trial');
        // Per-candidate verdicts carry `candidate`; the attempt's own verdict does
        // not. Both are rendered, and neither is dropped — the attempt-level one is
        // what a K-unaware stream sends, and the per-candidate ones are the search.
        const perCandidate = event.candidate !== undefined;
        if (perCandidate) {
          setCandidateStatus(event.candidate as number, event.approved ? 'ok' : 'fail');
          if (event.approved) {
            // The approved file is the one that ships, so it is the one the panel is
            // left on and its rates are the ones the verdict line quotes — even
            // though the harness goes on to measure the candidates after it.
            locked = { candidate: event.candidate as number, panel: state.panelRate, mimic: state.mimicRate };
            if (!pinned) showCandidate(event.candidate as number);
          }
        } else state.approved = event.approved;

        if (event.approved) {
          if (!perCandidate) {
            if (locked !== null) {
              state.panelRate = locked.panel;
              state.mimicRate = locked.mimic;
            }
            const pct = state.panelRate === null ? null : `${Math.round(state.panelRate * 100)}%`;
            const name = views[locked?.candidate ?? state.selectedCandidate]?.label;
            setVerdict(
              'approved',
              pct === null ? '✓ APPROVED' : `✓ APPROVED — ${pct}`,
              name === undefined
                ? 'it is fair, and it countered you — this is what you fight next'
                : `${name} is fair, and it countered you — this is what you fight next`,
              state.panelRate === null
                ? undefined
                : `${pct} vs the reference panel${state.mimicRate === null ? '' : ` · ${Math.round(state.mimicRate * 100)}% vs a bot built from your own replay`}`,
            );
          }
          break;
        }

        const reason = event.reason ?? 'no reason given';
        // An attempt-level rejection that already logged its candidates' reasons
        // would double every entry; the candidates' rejections are the specific
        // ones, so the summary yields to them.
        const alreadyLogged =
          !perCandidate && state.rejections.some((r) => r.attempt === event.attempt && r.candidate !== undefined);
        if (!alreadyLogged) {
          const failing = state.gates
            .filter((g) => g.attempt === event.attempt && !g.ok && g.candidate === event.candidate)
            .at(-1);
          const gateNumber = failing?.gate ?? 3;
          const dial = perCandidate ? (views[event.candidate as number]?.dial ?? null) : null;
          state.rejections.push({
            attempt: event.attempt,
            ...(event.candidate === undefined ? {} : { candidate: event.candidate }),
            ...(dial === null ? {} : { dial }),
            gate: gateNumber,
            reason,
          });
          const who = perCandidate
            ? `attempt ${event.attempt} · ${dial ?? `candidate ${(event.candidate as number) + 1}`} · rejected by ${GATE_LABELS[gateNumber]}`
            : `attempt ${event.attempt} · rejected by ${GATE_LABELS[gateNumber]}`;
          const item = el('li');
          item.append(el('b', undefined, who), document.createTextNode(reason));
          rejections.append(item);
          rejections.scrollTop = rejections.scrollHeight;
        }
        if (!perCandidate) {
          const failing = state.gates.filter((g) => g.attempt === event.attempt && !g.ok).at(-1);
          setVerdict('rejected', '✗ REJECTED', plainVerdict(reason, failing?.gate), reason);
          status.replaceChildren(
            document.createTextNode('The harness rejected it. The reason goes straight back to the coder — '),
            el('b', undefined, 'no human in the loop'),
            document.createTextNode('.'),
          );
        }
        break;
      }

      case 'fallback': {
        showFallback(event.reason, event.message);
        break;
      }

      case 'done': {
        state.done = true;
        if (event.result.approved) {
          state.strategyName = event.result.meta.name;
          state.approved = true;
          // The hand-off, and the last thing on screen before the fight: the thing
          // that was just written, by name, saying in its own words what it intends
          // to do to you. `rationale` is the strategy file's own `meta`, so this is
          // the boss talking and not the interlude summarising.
          const boss = el('div', 'il-boss');
          boss.dataset.testid = 'il-boss';
          boss.append(
            createPortrait('boss', { size: 34 }),
            el('b', 'il-boss-name', event.result.meta.name),
            el('span', 'says', 'says:'),
            el('i', 'il-boss-line', `“${event.result.meta.rationale}”`),
          );
          status.replaceChildren(
            el('span', 'il-next', `Round ${options.round + 1}`),
            boss,
          );
          status.hidden = false;
        } else if (state.fallback === null) {
          showFallback(event.result.reason, event.result.message);
        }
        setPhase('done');
        finish();
        break;
      }

      default: {
        // Exhaustive: an unhandled event would be a silent hole on screen.
        const never: never = event;
        void never;
        break;
      }
    }
  }

  function showFallback(reason: FailureReason, message?: string): void {
    state.fallback = { reason, ...(message === undefined ? {} : { message }) };
    // Plain words on top, spec AC 5's sentence verbatim underneath. The wording of
    // the second line is the spec's and is not paraphrased — it is the promise the
    // product makes about never leaving the player on a spinner.
    bannerHead.textContent = fallbackHeadline(reason);
    bannerText.replaceChildren(document.createTextNode(fallbackText(reason)));
    if (message !== undefined && message !== '') {
      bannerText.append(el('small', undefined, ` (${message})`));
    }
    banner.hidden = false;
    status.hidden = true;
    cast = { ...cast, fallback: reason, active: 'judge' };
    paintCast();
    if (state.approved === null) setVerdict('rejected', '✗ NO APPROVAL', fallbackHeadline(reason), fallbackText(reason));
  }

  function finish(): void {
    if (disposed) return;
    state.done = true;
    // Nothing is acting any more: every glow goes out, so the eye lands on FIGHT.
    cast = { ...cast, done: true, active: null };
    paintCast();
    setPhase('done');
    skip.hidden = true;
    fight.hidden = false;
    queueMicrotask(() => fight.focus());
    if (autoFightMs > 0 && autoFightAt === null) {
      autoFightAt = (now() - startedAt) + autoFightMs;
    }
  }

  // Enter / Space / Escape continue — but only once there is something to continue
  // to. Spec §2.2: the interlude is the product, so there is no early exit; the
  // 50 s `skip` button is the safety valve and appears on its own.
  function onKey(ev: KeyboardEvent): void {
    if (!state.done) return;
    if (ev.code !== 'Enter' && ev.code !== 'NumpadEnter' && ev.code !== 'Space' && ev.code !== 'Escape') return;
    ev.preventDefault();
    options.onFight();
  }
  window.addEventListener('keydown', onKey);

  fight.addEventListener('click', () => {
    autoFightAt = null;
    options.onFight();
  });
  skip.addEventListener('click', () => {
    options.onSkip();
  });

  const onResize = (): void => {
    // The three figures are the only thing here that is not text, so they are the
    // only thing that needs redrawing on a resize.
    if (state.analysis !== null || replayCap.textContent !== '') {
      const summary = lastSummary;
      if (summary !== null) drawReplay(summary);
    }
  };
  let lastSummary: ReplaySummary | null = null;
  window.addEventListener('resize', onResize);

  // The three status lines have to say something before the first event arrives:
  // "watching your replay…" is true from the moment the screen opens.
  paintCast();
  setVerdict('working', 'WAITING', 'nothing has been submitted to the harness yet');

  return {
    handle(event: RewriteEvent): void {
      if (disposed) return;
      if (event.type === 'replay') lastSummary = event.summary;
      // The cast is folded first so the panels can be painted against the same
      // event they are rendering, and repainted after, because `handle` itself
      // moves the phase and the Judge's stamp.
      cast = reduceCast(cast, event);
      handle(event);
      paintCast();
    },
    showFallback,
    finish,
    setKind(kind: SourceKind, why?: string): void {
      state.kind = kind;
      kindBadge.textContent = KIND_LABEL[kind];
      kindBadge.dataset.kind = kind;
      // The footer follows the header unless something more specific has been set:
      // a mid-run switch to the mock must not leave `LIVE` standing in the footer.
      state.provenance = KIND_LABEL[kind];
      provenance.textContent = state.provenance;
      provenance.dataset.kind = kind;
      if (why !== undefined) {
        kindBadge.title = why;
        provenance.title = why;
      }
    },

    setProvenance(text: string, note?: string): void {
      state.provenance = text;
      provenance.textContent = text;
      const disclosure = note?.trim() ?? '';
      state.provenanceNote = disclosure === '' ? null : disclosure;
      provenanceNote.textContent = disclosure;
      provenanceNote.hidden = disclosure === '';
      // Also the badge's tooltip: the footer line is small on a 1080p capture, and a
      // reviewer hovering the badge is exactly the person asking "is this real?".
      if (disclosure !== '') provenance.title = disclosure;
    },
    state(): InterludeState {
      return { ...state, gates: [...state.gates], rejections: [...state.rejections] };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(frame);
      window.clearTimeout(skipTimer);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      root.remove();
    },
  };
}
