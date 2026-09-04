/**
 * Events → "who is doing what, right now, in one line".
 *
 * The interlude already renders everything the loop produces. What it did not say
 * is *who*: a playtester watching a real run could read `✗ Gate 3 balance — 0.91 vs
 * panel` and still not know that a model wrote the file and a deterministic harness
 * threw it out. So each beat's panel gets a header — portrait, name, and one line of
 * status — and this module is the line.
 *
 * It is a **pure reducer** over `RewriteEvent`s (`reduceCast`) plus a **pure
 * formatter** over the state it accumulates (`castStatus`), for the same reason
 * `meterView` is pure: everything interesting about a status line is the mapping,
 * the mapping is where the bugs are, and `test/interlude-cast.test.ts` can then
 * assert the whole table in Node with no DOM at all.
 *
 * Three rules the strings follow:
 *
 * 1. **Present tense while it is happening, past tense when it is done.** "running
 *    200 fights…" becomes "✓ approved Warden II". The ellipsis is the only
 *    indication of "still going" and it is never on a finished line.
 * 2. **Plain language, with the number.** "found 6 patterns", not "analysis
 *    complete"; "running 200 fights…", not "simulating". The quantitative sentence
 *    the harness actually wrote is still shown verbatim underneath the stamp (spec
 *    §2.2: every rejection stays readable) — this line is the human reading of it.
 * 3. **The Judge never sounds like an opinion.** It rejects and it approves; it does
 *    not "think" or "feel". It is not a model, and the status line is one of the
 *    few places the product gets to say so.
 */
import { MAX_ATTEMPTS, type FailureReason, type GateNumber, type RewriteEvent } from './events.ts';

/** The three agents that take turns. The Replay beat belongs to the Analyst. */
export type AgentSlot = 'analyst' | 'coder' | 'judge';

/** The most recent verdict, as the Judge's stamp and status line need it. */
export type CastVerdict = {
  approved: boolean;
  /** `meta.name` of the file it judged, when the stream named one. */
  name: string | null;
  /** Plain words: `too easy`, `it stood still`. */
  plain: string;
  /** The harness's own sentence, verbatim. Never rewritten, never dropped. */
  raw: string | null;
};

export type CastState = {
  /** Who is acting. `null` before the first event and after the last. */
  active: AgentSlot | null;
  // ---- Analyst
  replaySeen: boolean;
  /** The Analyst has started talking: the portrait stops being dimmed. */
  analysisStarted: boolean;
  /** Observations counted, once `analysis.done` landed. */
  observations: number | null;
  archetype: string | null;
  // ---- Coder
  /** 1-based; 0 until the first `rewrite.delta`. */
  attempt: number;
  /** Files this attempt is writing at once. */
  candidates: number;
  /** How many of them are finished. */
  written: number;
  /** `meta.name` per candidate index, as each file finishes. */
  candidateNames: readonly (string | null)[];
  /** The newest name the Coder produced — the boss's name for the diff header. */
  bossName: string | null;
  // ---- Judge
  matchesDone: number;
  matchesTotal: number;
  /** Gate 3 is mid-simulation for some candidate. */
  simulating: boolean;
  verdict: CastVerdict | null;
  /** How many candidates have been rejected, over the whole interlude. */
  rejections: number;
  approvedName: string | null;
  fallback: FailureReason | null;
  done: boolean;
};

export const INITIAL_CAST: CastState = {
  active: null,
  replaySeen: false,
  analysisStarted: false,
  observations: null,
  archetype: null,
  attempt: 0,
  candidates: 1,
  written: 0,
  candidateNames: [],
  bossName: null,
  matchesDone: 0,
  matchesTotal: 0,
  simulating: false,
  verdict: null,
  rejections: 0,
  approvedName: null,
  fallback: null,
  done: false,
};

/**
 * The harness's sentence, in words a player can act on.
 *
 * This never *replaces* the sentence — spec §2.2 requires every rejection to stay
 * readable, so the original is rendered verbatim under the stamp in monospace. This
 * is the headline over it, and it exists because "0.91 vs panel — outside the band
 * 0.35–0.50 for round 2" tells a judge in the audience everything and a player
 * nothing.
 *
 * Order matters: a Gate 3 sentence lists the Mimic rate inline even when the thing
 * that failed was the band, so "too hard" and "too easy" are matched first.
 */
export function plainVerdict(reason: string | undefined, gate?: GateNumber): string {
  const text = (reason ?? '').toLowerCase();
  if (text.includes('too hard')) return 'too hard to be fair';
  if (text.includes('too easy')) return 'too easy to be a fight';
  if (text.includes("didn't adapt") || text.includes('did not adapt') || text.includes('adapted')) {
    return "it didn't counter you";
  }
  if (text.includes('motionless') || text.includes('idle')) return 'it stood still instead of fighting';
  if (gate === 1) return 'the file broke the boss contract';
  if (gate === 2) return 'it broke a rule under fuzzing';
  if (gate === 4) return 'too slow to run inside a frame';
  if (text.includes('mimic')) return "it didn't counter you";
  if (text.includes('band')) return 'outside the fairness band';
  return 'rejected by the harness';
}

/** The plain-words headline over spec AC 5's fallback banner. */
export function fallbackHeadline(reason: FailureReason): string {
  if (reason === 'deadline') return '⏱ the coder ran out of time';
  if (reason === 'max-attempts') return `✗ ${MAX_ATTEMPTS} attempts, none approved`;
  return '✗ the rewrite failed';
}

function nameOf(state: CastState, candidate: number | undefined): string | null {
  if (candidate === undefined) return state.bossName;
  return state.candidateNames[candidate] ?? state.bossName;
}

/**
 * Fold one event into the cast state.
 *
 * Immutable, so a test can keep every intermediate state and assert the *sequence*
 * of status lines rather than only the final one — the sequence is the thing the
 * player watches.
 */
export function reduceCast(state: CastState, event: RewriteEvent): CastState {
  switch (event.type) {
    case 'replay':
      return { ...state, replaySeen: true, active: 'analyst' };

    case 'analysis.delta':
      return { ...state, analysisStarted: true, active: 'analyst' };

    case 'analysis.done':
      return {
        ...state,
        analysisStarted: true,
        observations: event.analysis.observations.length,
        archetype: event.analysis.playerArchetype,
        // The Analyst is done; the Coder has the floor even before its first delta.
        active: 'coder',
      };

    case 'rewrite.delta': {
      const total = event.candidates ?? 1;
      const fresh = event.attempt !== state.attempt;
      return {
        ...state,
        active: 'coder',
        attempt: event.attempt,
        candidates: total,
        ...(fresh
          ? {
              written: 0,
              candidateNames: [],
              matchesDone: 0,
              matchesTotal: 0,
              simulating: false,
            }
          : {}),
      };
    }

    case 'rewrite.done': {
      const total = event.candidates ?? 1;
      const index = event.candidate ?? 0;
      const fresh = event.attempt !== state.attempt;
      const names = [...(fresh ? [] : state.candidateNames)];
      const name = event.meta?.name ?? null;
      names[index] = name;
      // Counted from the names, not incremented: the K files finish in whatever
      // order the model finishes them (candidate 2 can land before candidate 1 and
      // leave a hole), and a re-sent `rewrite.done` must not make "candidate 4 of
      // 3" appear on screen.
      let written = 0;
      for (let i = 0; i < names.length; i += 1) if (names[i] !== undefined) written += 1;
      return {
        ...state,
        active: 'coder',
        attempt: event.attempt,
        candidates: total,
        candidateNames: names,
        written: Math.min(total, written),
        bossName: name ?? state.bossName,
        ...(fresh ? { matchesDone: 0, matchesTotal: 0, simulating: false } : {}),
      };
    }

    case 'trial.gate':
      return { ...state, active: 'judge' };

    case 'trial.progress':
      return {
        ...state,
        active: 'judge',
        matchesDone: event.matchesDone,
        matchesTotal: event.matchesTotal,
        simulating: event.matchesDone < event.matchesTotal,
      };

    case 'verdict': {
      const name = nameOf(state, event.candidate);
      if (event.approved) {
        // A per-candidate verdict names the file it judged. The attempt-level one
        // that follows carries no `candidate`, so it must not rename the approval
        // after the fact — the newest file the Coder wrote is not necessarily the
        // one that passed (the loop keeps measuring the rest).
        const approved = event.candidate === undefined ? (state.approvedName ?? name) : (name ?? state.approvedName);
        return {
          ...state,
          active: 'judge',
          simulating: false,
          approvedName: approved,
          verdict: { approved: true, name: approved, plain: 'it is fair, and it countered you', raw: null },
        };
      }
      return {
        ...state,
        active: 'judge',
        simulating: false,
        rejections: state.rejections + 1,
        verdict: {
          approved: false,
          name,
          plain: plainVerdict(event.reason),
          raw: event.reason ?? null,
        },
      };
    }

    case 'fallback':
      return { ...state, active: 'judge', simulating: false, fallback: event.reason };

    case 'done': {
      if (event.result.approved) {
        return {
          ...state,
          active: null,
          done: true,
          simulating: false,
          approvedName: event.result.meta.name,
          bossName: event.result.meta.name,
        };
      }
      return {
        ...state,
        active: null,
        done: true,
        simulating: false,
        fallback: state.fallback ?? event.result.reason,
      };
    }

    default: {
      // Exhaustive: a new event type that nobody's status line reflects would leave
      // the three headers frozen mid-run, which is the exact bug this file fixes.
      const never: never = event;
      void never;
      return state;
    }
  }
}

/** The three lines, as they should read right now. */
export function castStatus(state: CastState): Record<AgentSlot, string> {
  return { analyst: analystStatus(state), coder: coderStatus(state), judge: judgeStatus(state) };
}

/**
 * The Replay panel's line.
 *
 * That panel is the Analyst's too — the three figures in it are its input — but
 * repeating "found 4 patterns · you play like a dodger" on both of the Analyst's
 * panels says the same thing twice on one screen. So the Replay panel carries the
 * agent's live status only while it is still reading, and then becomes a caption
 * for the evidence: this is the tape, and the reading of it is next door.
 */
export function replayStatus(state: CastState): string {
  return state.observations === null ? analystStatus(state) : 'this is the tape it read';
}

function analystStatus(state: CastState): string {
  if (state.observations !== null) {
    const n = state.observations;
    const found = `found ${n} pattern${n === 1 ? '' : 's'}`;
    return state.archetype === null ? found : `${found} · you play like a ${state.archetype}`;
  }
  if (state.analysisStarted) return 'writing down your habits…';
  return 'watching your replay…';
}

function coderStatus(state: CastState): string {
  if (state.attempt === 0) return 'waiting for the analysis…';
  const prefix = state.attempt > 1 ? `attempt ${state.attempt} of ${MAX_ATTEMPTS} · ` : '';
  const total = state.candidates;
  if (state.written >= total) {
    return `${prefix}${total} ${total === 1 ? 'strategy' : 'strategies'} written`;
  }
  if (total <= 1) return `${prefix}writing a new strategy…`;
  return `${prefix}writing candidate ${Math.min(total, state.written + 1)} of ${total}…`;
}

function judgeStatus(state: CastState): string {
  if (state.fallback !== null) {
    return `${fallbackHeadline(state.fallback)} — shipping a pre-approved strategy`;
  }
  if (state.approvedName !== null) return `✓ approved ${state.approvedName}`;
  if (state.simulating) {
    const total = state.matchesTotal > 0 ? state.matchesTotal : 200;
    return `running ${total} simulated fights…`;
  }
  const verdict = state.verdict;
  if (verdict !== null && !verdict.approved) {
    return `✗ rejected ${verdict.name ?? 'that one'} — ${verdict.plain}`;
  }
  if (verdict !== null) return `✓ approved ${verdict.name ?? 'it'}`;
  if (state.written > 0) return 'checking the file…';
  return 'waiting for a strategy…';
}
