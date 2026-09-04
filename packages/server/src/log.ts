/**
 * The evidence trail (spec AC 6): "At least one *recorded* real run in `docs/` shows
 * a strategy rejected by Gate 3 and then approved on a subsequent attempt with no
 * human input."
 *
 * That sentence is why this file exists, and it is why the server writes two things
 * per rewrite rather than one:
 *
 *  - **One JSON line to stdout.** Round, attempts, approved, wall clock, tokens.
 *    Greppable, cheap, and the thing a deploy's log viewer shows. It is a line of
 *    JSON rather than prose because the only interesting queries over it are
 *    numeric ("which runs took more than one attempt").
 *  - **The full event log to `artifacts/server/rewrite-<timestamp>.json`.** Every
 *    frame the client was sent, in order, including every rejection sentence and
 *    every generated `strategy.js`. `artifacts/` is gitignored, so the file is raw
 *    material: a run worth keeping gets copied into `docs/` by hand, which is the
 *    right way round — the evidence is chosen deliberately, not accumulated.
 *
 * The artifact is written **after** the stream ends, never during it. A synchronous
 * multi-hundred-kilobyte write in the middle of an interlude would stall the event
 * loop inside the 45 s budget, and the whole point of the log is to record a run
 * that met it.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AttemptLog } from '@rematch/agents';
import type { ServerRewriteEvent } from './events.ts';
import type { RewriteRequestBody } from './request.ts';

/** Repo-root `artifacts/server/`. Gitignored; see the header. */
export const ARTIFACT_DIR = fileURLToPath(new URL('../../../artifacts/server/', import.meta.url));

export const ARTIFACT_DIR_ENV = 'REMATCH_ARTIFACT_DIR';

/** One line of stdout per request. Every field is a number, a string or a boolean. */
export type RequestLogLine = {
  at: string;
  route: string;
  status: number;
  round: number | null;
  /** Harness attempts, not model calls. */
  attempts: number;
  approved: boolean | null;
  /** Wall clock for the whole request, ms. */
  ms: number;
  tokens: { input: number; output: number; cacheRead: number };
  /** Gate that rejected each attempt, in order: `['static', 'balance']`. */
  rejectedBy: string[];
  /** `'max-attempts' | 'deadline' | 'error'` when the loop did not approve. */
  reason?: string;
  /** The pool strategy that shipped instead, when one did. */
  fallback?: string;
  /** Frames sent. A stream that ends early shows up here first. */
  events: number;
  /** Where the full event log went, when it was written. */
  artifact?: string;
};

function usageOf(attempts: readonly AttemptLog[]): { input: number; output: number; cacheRead: number } {
  return attempts.reduce(
    (total, attempt) => ({
      input: total.input + attempt.coder.usage.inputTokens,
      output: total.output + attempt.coder.usage.outputTokens,
      cacheRead: total.cacheRead + (attempt.coder.usage.cacheReadTokens ?? 0),
    }),
    { input: 0, output: 0, cacheRead: 0 },
  );
}

/**
 * Reduce a finished stream to the log line.
 *
 * Derived from the events rather than returned by `handleRewrite`, which is what
 * keeps that function's signature `(body, emit, signal) => Promise<void>` — the
 * events are the only output it has, so anything a log wants must be in them, and
 * checking that here is a standing test that they are.
 */
export function summarizeRun(
  events: readonly ServerRewriteEvent[],
  meta: { route: string; status: number; ms: number; round?: number },
): RequestLogLine {
  const done = events.find((e) => e.type === 'done');
  const analysisDone = events.find((e) => e.type === 'analysis.done');
  const result = done?.result;
  const attempts = result?.attempts ?? [];
  const tokens = usageOf(attempts);
  if (analysisDone !== undefined) {
    tokens.input += analysisDone.usage.inputTokens;
    tokens.output += analysisDone.usage.outputTokens;
    tokens.cacheRead += analysisDone.usage.cacheReadTokens ?? 0;
  }

  const rejectedBy = attempts
    .filter((a) => !a.approved)
    .map((a) => a.gates.find((g) => !g.ok)?.name ?? 'unknown');

  return {
    at: new Date().toISOString(),
    route: meta.route,
    status: meta.status,
    round: meta.round ?? null,
    attempts: attempts.length,
    approved: result === undefined ? null : result.approved,
    ms: Math.round(meta.ms),
    tokens,
    rejectedBy,
    ...(result === undefined || result.approved ? {} : { reason: result.reason }),
    ...(result === undefined || result.approved ? {} : { fallback: result.fallback.name }),
    events: events.length,
  };
}

/** Append one line of JSON. `console.log` on purpose: stdout is the log transport. */
export function logLine(line: RequestLogLine, write: (text: string) => void = (t) => console.log(t)): void {
  write(JSON.stringify(line));
}

export type RewriteArtifact = {
  generatedAt: string;
  request: { round: number; seed: number; prevMeta: RewriteRequestBody['prevMeta'] };
  summary: RequestLogLine;
  /** Every frame the client was sent, in order. */
  events: readonly ServerRewriteEvent[];
};

/**
 * Write the full event log and return its path, or `undefined` if it could not be
 * written.
 *
 * A failure here is swallowed on purpose: the artifact is evidence *about* a run
 * that already succeeded, and a read-only filesystem (every serverless platform,
 * including the one spec §5.2 names) must not turn a good interlude into a 500. The
 * reason is reported to `onError` so it is visible in the log rather than silent.
 */
export function writeRewriteArtifact(
  artifact: RewriteArtifact,
  dir: string = ARTIFACT_DIR,
  onError?: (err: Error) => void,
): string | undefined {
  try {
    mkdirSync(dir, { recursive: true });
    const stamp = artifact.generatedAt.replace(/[:.]/g, '-');
    const file = `${dir.replace(/\/?$/, '/')}rewrite-${stamp}.json`;
    writeFileSync(file, `${JSON.stringify(artifact, null, 2)}\n`);
    return file;
  } catch (err) {
    onError?.(err instanceof Error ? err : new Error(String(err)));
    return undefined;
  }
}

/** Where artifacts go: `REMATCH_ARTIFACT_DIR`, else repo-root `artifacts/server/`. */
export function resolveArtifactDir(env: Record<string, string | undefined> = process.env): string {
  const configured = env[ARTIFACT_DIR_ENV];
  return configured === undefined || configured.trim() === '' ? ARTIFACT_DIR : configured;
}
