/**
 * The agent eval, as a function (spec §7):
 *
 *   "Given 10 canned replays, the loop reaches APPROVED within 4 attempts
 *    >= 80% of the time."
 *
 * The logic lives here rather than in `scripts/eval.ts` for one reason: the eval
 * is what produces AC 6's evidence, so it has to be *tested*. `scripts/eval.ts` is
 * a thin CLI over this — credential check, env parsing, printing — and
 * `test/eval.test.ts` runs the whole thing against mock providers with no network.
 *
 * The report is the artifact. It carries every event of every run: each attempt's
 * prompt size, token usage, per-gate result, the rejection sentence and the file
 * that answered it. Nothing in it is written by hand.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { DEFAULT_MATCHES, type BalanceRound } from '@rematch/harness';
import { CANNED_NAMES, loadCanned, type CannedName } from './canned.ts';
import type { RewriteEvent, RewriteResult } from './events.ts';
import { DEADLINE_MS, rewrite, type RewriteProviders } from './loop.ts';

/** Spec §7's threshold. Below this, `pnpm eval:agents` exits non-zero. */
export const PASS_RATE_TARGET = 0.8;
/** Round 2 is the first rewrite, and the one AC 7 is about. */
export const EVAL_ROUND: BalanceRound = 2;

export type EvalRun = {
  replay: CannedName;
  archetype?: string;
  approved: boolean;
  /** Harness attempts used. `<= maxAttempts`. */
  attempts: number;
  /** `1 static`, `3 balance`, … one per gate that rejected, in order. */
  gatesFailed: string[];
  strategyName?: string;
  failureReason?: string;
  ms: number;
  tokens: { input: number; output: number; cacheRead: number };
  /** Model calls, including Analyst retries and Coder static self-retries. */
  modelCalls: number;
  events: RewriteEvent[];
  result: RewriteResult;
};

export type EvalReport = {
  spec: string;
  generatedAt: string;
  round: BalanceRound;
  matches: number;
  models: { analyst: string; coder: string };
  target: number;
  passRate: number;
  approved: number;
  total: number;
  /** Runs approved after at least one rejection — AC 6's evidence. */
  rejectedThenApproved: CannedName[];
  /** …of which the rejection came from Gate 3, the balance gate AC 6 names. */
  gate3ThenApproved: CannedName[];
  runs: EvalRun[];
};

export type EvalOptions = {
  /** Providers for one run. Called per replay so usage is never shared. */
  makeProviders: (replay: CannedName) => RewriteProviders;
  names?: readonly CannedName[];
  matches?: number;
  round?: BalanceRound;
  deadlineMs?: number;
  maxAttempts?: number;
  /** Called as each run finishes, for the CLI's progress lines. */
  onRun?: (run: EvalRun) => void;
};

/** Parse `REMATCH_EVAL_ONLY=camper-a,kiter-b` into a canned-replay list. */
export function selectCanned(only: string | undefined): CannedName[] {
  if (only === undefined || only.trim() === '') return [...CANNED_NAMES];
  const wanted = new Set(only.split(',').map((s) => s.trim()));
  const picked = CANNED_NAMES.filter((n) => wanted.has(n));
  if (picked.length === 0) throw new Error(`no canned replay matched: ${only}`);
  return picked;
}

async function runOne(name: CannedName, opts: EvalOptions, matches: number, round: BalanceRound): Promise<EvalRun> {
  const canned = loadCanned(name);
  const events: RewriteEvent[] = [];
  const started = Date.now();

  const result = await rewrite(
    {
      summary: canned.summary,
      round,
      prevSource: canned.bossStrategy,
      providers: opts.makeProviders(name),
      harnessOpts: { gate3: { matches } },
      deadlineMs: opts.deadlineMs ?? DEADLINE_MS,
      ...(opts.maxAttempts === undefined ? {} : { maxAttempts: opts.maxAttempts }),
    },
    (event) => void events.push(event),
  );
  const ms = Date.now() - started;

  // Tokens come from two places: the Analyst's `analysis.done` event and each
  // attempt's Coder log. Summing both is the only way the number covers the whole
  // rewrite rather than half of it.
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let modelCalls = 0;
  for (const event of events) {
    if (event.type !== 'analysis.done') continue;
    input += event.usage.inputTokens;
    output += event.usage.outputTokens;
    cacheRead += event.usage.cacheReadTokens ?? 0;
    modelCalls += event.calls;
  }
  for (const attempt of result.attempts) {
    input += attempt.coder.usage.inputTokens;
    output += attempt.coder.usage.outputTokens;
    cacheRead += attempt.coder.usage.cacheReadTokens ?? 0;
    modelCalls += attempt.coder.calls;
  }

  const gatesFailed = result.attempts
    .flatMap((a) => a.gates.filter((g) => !g.ok))
    .map((g) => `${g.gate} ${g.name}`);

  return {
    replay: name,
    ...(result.analysis === undefined ? {} : { archetype: result.analysis.playerArchetype }),
    approved: result.approved,
    attempts: result.attempts.length,
    gatesFailed,
    ...(result.approved ? { strategyName: result.meta.name } : { failureReason: result.reason }),
    ms,
    tokens: { input, output, cacheRead },
    modelCalls,
    events,
    result,
  };
}

export async function runEval(opts: EvalOptions): Promise<EvalReport> {
  const names = opts.names ?? CANNED_NAMES;
  const matches = Math.max(8, Math.trunc(opts.matches ?? DEFAULT_MATCHES));
  const round = opts.round ?? EVAL_ROUND;

  const runs: EvalRun[] = [];
  for (const name of names) {
    // Sequentially, not in parallel: Gate 3 already saturates every core with
    // simulation workers, so two runs at once would make both slower and make the
    // wall-clock column meaningless.
    const run = await runOne(name, opts, matches, round);
    runs.push(run);
    opts.onRun?.(run);
  }

  const approved = runs.filter((r) => r.approved).length;
  const rejectedThenApproved = runs.filter((r) => r.approved && r.gatesFailed.length > 0);
  const probe = opts.makeProviders(names[0] ?? CANNED_NAMES[0]);

  return {
    spec: 'docs/SPEC.md §7 — agent eval; AC 6 — autonomous loop evidence',
    generatedAt: new Date().toISOString(),
    round,
    matches,
    models: { analyst: probe.analyst.model, coder: probe.coder.model },
    target: PASS_RATE_TARGET,
    passRate: runs.length === 0 ? 0 : approved / runs.length,
    approved,
    total: runs.length,
    rejectedThenApproved: rejectedThenApproved.map((r) => r.replay),
    gate3ThenApproved: rejectedThenApproved
      .filter((r) => r.gatesFailed.some((g) => g.startsWith('3')))
      .map((r) => r.replay),
    runs,
  };
}

/** The table `pnpm eval:agents` prints: one row per replay. */
export function formatEvalTable(report: EvalReport): string {
  const head = [
    'replay'.padEnd(13),
    'arch'.padEnd(7),
    'appr',
    'att',
    'gates rejected'.padEnd(22),
    'strategy / why'.padEnd(22),
    '   wall',
    '     in',
    '   out',
    'calls',
  ].join(' ');

  const rows = report.runs.map((r) =>
    [
      r.replay.padEnd(13),
      (r.archetype ?? '—').padEnd(7),
      (r.approved ? ' ✓  ' : ' ✗  ').padEnd(4),
      String(r.attempts).padStart(3),
      (r.gatesFailed.join(', ') || '—').padEnd(22).slice(0, 22),
      (r.strategyName ?? r.failureReason ?? '—').padEnd(22).slice(0, 22),
      `${(r.ms / 1000).toFixed(1)}s`.padStart(7),
      String(r.tokens.input).padStart(7),
      String(r.tokens.output).padStart(6),
      String(r.modelCalls).padStart(5),
    ].join(' '),
  );

  const pct = (report.passRate * 100).toFixed(0);
  return [
    head,
    ...rows,
    '',
    `pass rate ${report.approved}/${report.total} = ${pct}% (target >= ${(report.target * 100).toFixed(0)}%, spec §7)`,
    `AC 6 evidence: ${report.rejectedThenApproved.length} run(s) rejected then approved with no human input` +
      ` (${report.gate3ThenApproved.length} of them by Gate 3).`,
  ].join('\n');
}

/** Write the full report — every event of every run — and return the path. */
export function writeEvalArtifact(report: EvalReport, dir: string): string {
  mkdirSync(dir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, '-');
  const file = `${dir.replace(/\/?$/, '/')}eval-${stamp}.json`;
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  return file;
}
