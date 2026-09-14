/**
 * The interlude's event vocabulary — a **copy** of `packages/agents/src/events.ts`.
 *
 * SOURCE OF TRUTH: `packages/agents/src/events.ts` (`RewriteEvent`, `RewriteResult`,
 * `AttemptLog`, `FailureReason`), plus `packages/harness/src/gates/types.ts`
 * (`GateResult`), `packages/agents/src/context/prompts.ts` (`Analysis`,
 * `PlayerArchetype`), `packages/agents/src/provider.ts` (`LLMUsage`) and
 * `packages/agents/src/calibrate.ts` (the PRESSURE knob `readPressure` reads).
 *
 * ## Why a copy and not an import
 *
 * `@rematch/agents` pulls in `@rematch/harness`, which pulls in the balance
 * simulator, `node:worker_threads` and the filesystem; `@rematch/server` pulls in
 * the Anthropic SDK and the API key handling. None of that may be reachable from a
 * browser bundle — spec §5.2 keeps the model server-side precisely so the key never
 * reaches the client, and an accidental type-only import that Vite decides to keep
 * would defeat it. The web client's dependency list stays `engine`, `contract`,
 * `sandbox` (see `packages/web/package.json`).
 *
 * These are structural types, so the copy is checked the moment the server sends a
 * real event: a field that drifts shows up as a rendering hole, and the SSE contract
 * documented in `source.ts` is the thing both sides are written against. Two types
 * *are* imported, because the browser already owns them: `ReplaySummary` (the client
 * produced it) and `StrategyMeta` (the client is about to run it).
 *
 * If you change `agents/src/events.ts`, change this file in the same commit.
 */
import type { StrategyMeta } from '@rematch/contract';
import type { ReplaySummary } from '@rematch/engine';

// ------------------------------------------------------- copied from `harness`

export type GateNumber = 1 | 2 | 3 | 4;
export type GateName = 'static' | 'fuzz' | 'balance' | 'perf';

export type GateOk = {
  gate: GateNumber;
  name: GateName;
  ok: true;
  /** Wall-clock the gate took, milliseconds. */
  ms: number;
  detail?: unknown;
};

export type GateFail = {
  gate: GateNumber;
  name: GateName;
  ok: false;
  ms: number;
  /** One sentence, quantitative. Shown to the player verbatim (spec §2.2). */
  reason: string;
  detail?: unknown;
};

export type GateResult = GateOk | GateFail;

/**
 * Spec §6.2's per-round fairness band (as amended by §13 delta 24), for the rejection
 * copy the UI renders.
 *
 * A copy rather than an import: `packages/web` does not depend on `@rematch/harness`.
 * `packages/harness/src/gates/balanceConfig.ts` is the source of truth.
 */
export const BAND: Readonly<Record<number, readonly [number, number]>> = {
  2: [0.35, 0.5],
  3: [0.5, 0.65],
  4: [0.6, 0.75],
  5: [0.65, 0.95],
};

/**
 * Spec §6.3: "Max 4 attempts. Then fallback pool."
 *
 * The client cannot render this as a *total*, and that is not pedantry — it was on
 * screen wrong. The server's ceiling is `REMATCH_MAX_ATTEMPTS`, which a player training
 * against the boss raises (see `.env.example`), and the interlude read `attempt 7 of 4`
 * for a whole round because this constant was baked into the label. The stream never
 * carries the server's limit, so the honest label is the attempt number alone; this
 * constant is kept only for the `max-attempts` copy, where the count *is* known after
 * the fact.
 */
export const MAX_ATTEMPTS = 4;

// -------------------------------------------------------- copied from `agents`

export const ARCHETYPES = ['camper', 'kiter', 'rusher', 'dodger', 'mixed'] as const;
export type PlayerArchetype = (typeof ARCHETYPES)[number];

export type Analysis = {
  observations: string[];
  playerArchetype: PlayerArchetype;
  counterPlan: string;
};

export type LLMUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
};

/** Why the loop gave up. `error` also covers an aborted provider stream. */
export type FailureReason = 'max-attempts' | 'deadline' | 'error';

/** One of the K files an attempt wrote, with what the gates said about it. */
export type CandidateLog = {
  candidate: number;
  dial?: string;
  source: string;
  diff: string;
  name?: string;
  coder: {
    calls: number;
    promptChars: number;
    usage: LLMUsage;
    ms: number;
    selfRetry?: string;
    staticInvalid?: true;
  };
  gates: GateResult[];
  approved: boolean;
  reason?: string;
  panel?: number;
  skipped?: true;
  /**
   * The `const PRESSURE` this candidate's file ended up declaring — equal to
   * `calibration.to`. Absent for a file without the knob.
   */
  pressure?: number;
  /**
   * What the Judge's own search did to this candidate (`packages/agents/src/calibrate.ts`).
   *
   * `from` is the PRESSURE the Coder wrote, `to` the one the candidate ended at, and
   * `steps` how many extra full gate passes that cost.
   */
  calibration?: { steps: number; from: number; to: number };
};

export type AttemptLog = {
  attempt: number;
  /** The chosen candidate's file; `coder` is the whole attempt's cost. */
  source: string;
  diff: string;
  coder: {
    calls: number;
    promptChars: number;
    usage: LLMUsage;
    ms: number;
    selfRetry?: string;
    staticInvalid?: true;
  };
  gates: GateResult[];
  approved: boolean;
  reason?: string;
  ms: number;
  /** Present when the attempt wrote more than one file. */
  candidates?: CandidateLog[];
  chosen?: number;
};

export type RewriteResult =
  | {
      approved: true;
      source: string;
      meta: StrategyMeta;
      attempts: AttemptLog[];
      analysis: Analysis;
    }
  | {
      approved: false;
      attempts: AttemptLog[];
      reason: FailureReason;
      message?: string;
      analysis?: Analysis;
    };

export type RewriteEvent =
  /** Beat 1. The round the player just won, as the Analyst will read it. */
  | { type: 'replay'; summary: ReplaySummary; round: number }
  /** Beat 2, streaming. */
  | { type: 'analysis.delta'; delta: string }
  | {
      type: 'analysis.done';
      analysis: Analysis;
      /**
       * The Analyst's reply in full, including the JSON block that was withheld
       * from the stream. The panel streams prose; this is here for the run log.
       */
      raw?: string;
      calls: number;
      promptChars: number;
      usage: LLMUsage;
      ms: number;
    }
  /**
   * Beat 3, streaming. `attempt` is 1-based.
   *
   * ## Candidates
   *
   * An attempt writes K files at once (`REMATCH_CANDIDATES`, default 3), aimed at
   * the low edge, the middle and the high edge of the round's band. Every event
   * belonging to one of those files carries `candidate` (0-based) and `candidates`
   * (K) — `rewrite.delta`, `rewrite.done`, `trial.gate`, `trial.progress` and the
   * per-candidate `verdict`.
   *
   * Both fields are **absent when K is 1**, and absent on the one attempt-level
   * `verdict` that follows the per-candidate ones, so a renderer that ignores
   * `candidate` still sees exactly one verdict per attempt.
   */
  | { type: 'rewrite.delta'; attempt: number; delta: string; candidate?: number; candidates?: number }
  /** `meta` is the file's own, parsed from its source by the loop. */
  | {
      type: 'rewrite.done';
      attempt: number;
      source: string;
      diff: string;
      meta?: StrategyMeta;
      candidate?: number;
      candidates?: number;
      /** `conservative` / `balanced` / `aggressive` — the aim point this file took. */
      dial?: string;
    }
  /** Beat 4. One event per gate, as it finishes; stops at the first failure. */
  | { type: 'trial.gate'; attempt: number; gate: GateResult; candidate?: number; candidates?: number }
  /**
   * Gate 3's simulation, as it happens: `matchesDone: 0` first, then one event per
   * batch of finished matches, then `matchesDone === matchesTotal`. Real measured
   * progress — the meter needs no duration estimate.
   */
  | {
      type: 'trial.progress';
      attempt: number;
      matchesDone: number;
      matchesTotal: number;
      gate: GateName;
      candidate?: number;
      candidates?: number;
    }
  /** One per candidate, then one for the attempt with `candidate` absent. */
  | {
      type: 'verdict';
      attempt: number;
      approved: boolean;
      reason?: string;
      candidate?: number;
      candidates?: number;
      /** Gate 3's panel mean for this candidate, when it measured one. */
      panel?: number;
    }
  /**
   * Beat 4, still — one per re-measurement of a candidate's file at a different
   * `const PRESSURE` (`packages/agents/src/calibrate.ts`).
   *
   * The Coder writes the shape of the counter; the Judge aims the number. When a
   * candidate fails Gate 3 on FAIR alone and its file declares the knob, the loop
   * brackets and bisects PRESSURE in log2 space and re-runs the *whole* trial at
   * each value — so every one of these is a real four-gate verdict at ~1 s, not a
   * shortcut, and nothing about it is a model.
   *
   * `step` is 1-based and `pressure` is the value measured. `panel` is Gate 3's
   * panel mean at that value, absent if the step never reached Gate 3. `ok` is the
   * full trial's verdict; `reason` carries the rejecting gate's sentence when it is
   * false.
   *
   * No `trial.gate` or `trial.progress` events are emitted for a calibration step:
   * the candidate's gate list and its progress meter are about the file the Coder
   * wrote. That is why the interlude renders these as their own strip under that
   * candidate's gate rows (see `ui.ts`) rather than as more gate rows.
   */
  | {
      type: 'calibrate.step';
      attempt: number;
      candidate?: number;
      candidates?: number;
      step: number;
      pressure: number;
      panel?: number;
      ok: boolean;
      reason?: string;
    }
  /**
   * One per calibrated candidate, after its last step.
   *
   * `steps` is how many extra gate passes the search spent, `pressure` the value the
   * candidate ended at, and `approved` whether one of the steps passed every gate. A
   * candidate whose file has no knob emits neither this nor any `calibrate.step`.
   */
  | {
      type: 'calibrate.done';
      attempt: number;
      candidate?: number;
      candidates?: number;
      steps: number;
      pressure: number;
      approved: boolean;
    }
  /** Attempts or the deadline are exhausted; a pre-approved strategy ships. */
  | { type: 'fallback'; reason: FailureReason; message?: string }
  | { type: 'done'; result: RewriteResult };

export type RewriteEventType = RewriteEvent['type'];

/** Every `type` the union carries, so a frame from the wire can be checked cheaply. */
export const EVENT_TYPES: readonly RewriteEventType[] = [
  'replay',
  'analysis.delta',
  'analysis.done',
  'rewrite.delta',
  'rewrite.done',
  'trial.gate',
  'trial.progress',
  'verdict',
  // Dropping a frame whose `type` is not in this list is how a newer server talking
  // to an older client stays quiet (see `isRewriteEvent`) — which also means a type
  // missing from here is *invisible*, not a type error. The calibration strip did
  // not exist on screen until these two lines did.
  'calibrate.step',
  'calibrate.done',
  'fallback',
  'done',
];

/**
 * Is this parsed JSON one of our events?
 *
 * The check is deliberately shallow — `type` is a known string, nothing more. A
 * malformed *payload* should render as a hole in one panel, not throw away the whole
 * stream; a frame with an unknown `type` is a newer server talking to an older client
 * and is dropped silently.
 */
export function isRewriteEvent(value: unknown): value is RewriteEvent {
  if (typeof value !== 'object' || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' && (EVENT_TYPES as readonly string[]).includes(type);
}

/** `✓ Gate 1 static 3ms` / `✗ Gate 2 fuzz — reason`. Mirrors `formatGateResult`. */
export function formatGate(result: GateResult): string {
  const head = `Gate ${result.gate} ${result.name}`;
  return result.ok ? `✓ ${head} ${Math.round(result.ms)}ms` : `✗ ${head} — ${result.reason}`;
}

/** One entry of the server's fallback pool, as it arrives on a non-approved `done`. */
export type FallbackPick = { name: string; source: string };

/**
 * The pre-approved strategy the *server* picked, when the loop did not approve one.
 *
 * `RewriteResult` is the agents loop's type and the loop has no fallback pool, so
 * `@rematch/server` widens the terminal `done` with `result.fallback` —
 * `pickFallback(round, seed)` from `packages/server/fallback/`, ≥ 2 per round, all
 * four gates passed at that round's band. It is attached to the frame the client is
 * already receiving so that spec AC 5's fallback needs no second request at exactly
 * the moment something has already gone wrong.
 *
 * Read structurally rather than typed, because the field belongs to the server's
 * union and the browser must not import it (see this file's header). Absent — the
 * mock, an older server, a client-side deadline — and the caller uses its own last
 * resort instead.
 */
export function serverFallbackPick(result: RewriteResult): FallbackPick | null {
  if (result.approved) return null;
  const pick = (result as { fallback?: unknown }).fallback;
  if (typeof pick !== 'object' || pick === null) return null;
  const name = (pick as { name?: unknown }).name;
  const source = (pick as { source?: unknown }).source;
  if (typeof name !== 'string' || typeof source !== 'string' || source.trim() === '') return null;
  return { name, source };
}

/** Gate 3's `detail.panel.winRate` / `detail.mimic.winRate`, when they are there. */
export function balanceRates(result: GateResult): { panel?: number; mimic?: number } {
  const detail = result.detail;
  if (typeof detail !== 'object' || detail === null) return {};
  const read = (key: 'panel' | 'mimic'): number | undefined => {
    const node = (detail as Record<string, unknown>)[key];
    if (typeof node !== 'object' || node === null) return undefined;
    const rate = (node as { winRate?: unknown }).winRate;
    return typeof rate === 'number' ? rate : undefined;
  };
  const panel = read('panel');
  const mimic = read('mimic');
  return { ...(panel === undefined ? {} : { panel }), ...(mimic === undefined ? {} : { mimic }) };
}

/**
 * `const THROTTLE = 0.5;` at column zero — the value, or `null`.
 *
 * A **copy** of `readThrottle` in `packages/agents/src/calibrate.ts`, for the same
 * reason the event union is one: the browser must not import the agents package. The
 * regex is deliberately identical, including the "exactly one match at column zero"
 * rule — that line belongs to the block the Judge injects (`// ---- calibrated by the
 * Judge …`), and anything looser would read a constant the search never touched.
 *
 * The interlude needs this for two things, both of them ends of the throttle chain
 * (`throttle 1.00 → 0.50 → 0.71`): the value the file on screen already carries, and
 * the value the *shipped* file ended at. The stream carries every value the Judge
 * measured but neither of those, and both are sitting in sources the interlude
 * already holds. Reading them out is exact; inferring them would not be.
 */
const THROTTLE_LINE = String.raw`^const THROTTLE = (-?(?:\d+(?:\.\d*)?|\.\d+));`;

/**
 * The throttle of a file that declares none: `1.0` is the Coder's file untouched.
 *
 * Not a UI convention — `calibrate.ts` defines `THROTTLE_MAX = 1.0` as exactly this,
 * and its injected block short-circuits at `>= 1`. So a chain that starts at 1.00 is
 * describing the file the Coder wrote, not rounding up to a tidy number.
 */
export const UNTHROTTLED = 1;

export function readThrottle(source: string): number | null {
  const re = new RegExp(THROTTLE_LINE, 'gm');
  const first = re.exec(source);
  if (first === null) return null;
  if (re.exec(source) !== null) return null;
  const value = Number(first[1]);
  return Number.isFinite(value) ? value : null;
}
