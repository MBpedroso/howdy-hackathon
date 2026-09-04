/**
 * The interlude's event vocabulary — a **copy** of `packages/agents/src/events.ts`.
 *
 * SOURCE OF TRUTH: `packages/agents/src/events.ts` (`RewriteEvent`, `RewriteResult`,
 * `AttemptLog`, `FailureReason`), plus `packages/harness/src/gates/types.ts`
 * (`GateResult`), `packages/agents/src/context/prompts.ts` (`Analysis`,
 * `PlayerArchetype`) and `packages/agents/src/provider.ts` (`LLMUsage`).
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

/** Spec §6.2's per-round fairness band, for the rejection copy the UI renders. */
export const BAND: Readonly<Record<number, readonly [number, number]>> = {
  2: [0.35, 0.5],
  3: [0.45, 0.6],
  4: [0.5, 0.65],
  5: [0.55, 0.7],
};

/** Spec §6.3: "Max 4 attempts. Then fallback pool." Drives `attempt 2 / 4`. */
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

export type AttemptLog = {
  attempt: number;
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
      calls: number;
      promptChars: number;
      usage: LLMUsage;
      ms: number;
    }
  /** Beat 3, streaming. `attempt` is 1-based. */
  | { type: 'rewrite.delta'; attempt: number; delta: string }
  | { type: 'rewrite.done'; attempt: number; source: string; diff: string }
  /** Beat 4. One event per gate, as it finishes; stops at the first failure. */
  | { type: 'trial.gate'; attempt: number; gate: GateResult }
  /** Gate 3's simulation, coarse: fires at `matchesDone: 0` and again at the total. */
  | { type: 'trial.progress'; attempt: number; matchesDone: number; matchesTotal: number; gate: GateName }
  | { type: 'verdict'; attempt: number; approved: boolean; reason?: string }
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
