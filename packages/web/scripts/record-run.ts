/**
 * `pnpm --filter @rematch/web record:run` — turn a real eval run into a replayable
 * demo asset. **Reads a file on disk; makes no network call and needs no API key.**
 *
 * ```
 * node scripts/record-run.ts <eval-artifact.json> <replay> [<replay> …]
 * node scripts/record-run.ts ../../artifacts/agents/eval-2026-09-03T23-53-46-645Z.json \
 *   mimic-camper dodger-a kiter-a
 * ```
 *
 * Writes `public/recorded/<replay>.json` per run plus `public/recorded/index.json`, and
 * `recordedSource` (`src/interlude/recorded.ts`) replays them through the same
 * `onEvent` the live SSE source uses. The point is a demo video that shows the *real*
 * model's real rejections and real approval with **zero API spend** — the eval that
 * produced the artifact was paid for once, in September, and never has to run again.
 *
 * ## What is kept, and what is dropped
 *
 * Kept: the event stream verbatim, in order — every `analysis.delta`, every
 * `rewrite.delta`, every gate result, every rejection sentence, and a terminal `done`
 * whose `result.source` is the approved strategy. That source really loads through
 * QuickJS in the next round, which is what makes the recorded mode more than a video.
 *
 * Dropped, deliberately:
 *
 *  - **`done.result.attempts`.** Up to twelve full `strategy.js` files plus their
 *    diffs — ~80 KB of the ~650 KB — every byte of which already appears in the
 *    stream's own `rewrite.done` events. Nothing in the client reads
 *    `result.attempts` (`ui.ts` reads `approved`, `meta`, `reason`, `message`;
 *    `index.ts` reads `source`). Emptied rather than removed so the frame still
 *    satisfies `RewriteResult`, and `header.attempts` records the real count.
 *  - Everything else about the eval: the other nine runs, the report's aggregates, the
 *    file's `spec`/`target` bookkeeping. A recorded file is one run's stream and a
 *    seven-field header, nothing more.
 *
 * Never present in the first place: prompts and credentials. The events carry
 * `promptChars` (a count) and `analysis.done.raw` (the model's own *reply*), never a
 * prompt and never a key — `verify()` below re-checks that on the bytes about to be
 * written rather than trusting this paragraph.
 *
 * ## Timing
 *
 * The artifact has no per-event timestamp (see `timeline.ts`), so offsets are
 * reconstructed from the durations it *does* measure and scaled onto the run's real
 * wall clock. `timing.method` in each file says so, and the badge on screen says
 * `RECORDED RUN`.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { RewriteEvent } from '../src/interlude/events.ts';
import { buildTimeline } from './timeline.ts';

/** The `public/` subdirectory the browser fetches from. */
export const RECORDED_DIR = 'recorded';

/** Shapes read out of an eval artifact. Structural: the file is data, not an import. */
type EvalRunShape = {
  replay: string;
  archetype?: string;
  approved: boolean;
  attempts: number;
  strategyName?: string;
  ms: number;
  events: RewriteEvent[];
  result: { approved: boolean; attempts?: unknown[] };
};

type EvalReportShape = {
  generatedAt: string;
  round: number;
  candidates?: number;
  models: { analyst: string; coder: string };
  runs: EvalRunShape[];
};

/** The header a recorded file carries, and the only metadata the badge reads. */
export type RecordedHeader = {
  /** The vendor the run was made against. Inferred from the model name. */
  provider: string;
  /** The Coder's model — the one that wrote the code that shipped. */
  model: string;
  round: number;
  /** The Analyst's own verdict on the player, or `unknown` if it never returned. */
  archetype: string;
  /** The eval's `generatedAt`, ISO. The badge shows its date half. */
  recordedAt: string;
  approved: boolean;
  /** Harness attempts the run took. */
  attempts: number;
};

export type RecordedRun = RecordedHeader & {
  timing: { method: string; totalMs: number; pinned: number; events: number };
  /** Offsets in milliseconds from the first event, one per entry of `events`. */
  at: number[];
  events: RewriteEvent[];
};

export type RecordedIndexEntry = {
  /** `?run=<name>`, and the basename of the file. */
  name: string;
  model: string;
  recordedAt: string;
  round: number;
  archetype: string;
  approved: boolean;
  attempts: number;
  /** `meta.name` of the strategy that was approved. */
  strategy: string;
  /** Candidate files the harness rejected, across every attempt. */
  rejections: number;
  totalMs: number;
  /** One line for a human choosing a run to show. */
  label: string;
};

/** OpenAI's models are the `gpt-*` ones; everything else here is Anthropic's. */
function vendorOf(model: string): string {
  return model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3') ? 'openai' : 'anthropic';
}

/** Rejected candidate files — one per failing `trial.gate`, which is what a viewer counts. */
export function countRejections(events: readonly RewriteEvent[]): number {
  return events.filter((event) => event.type === 'trial.gate' && !event.gate.ok).length;
}

/**
 * Refuse to write anything that looks like a credential.
 *
 * A grep over the finished bytes rather than a promise about the pipeline: the whole
 * value of this asset is that it can be published, and "I checked the code path" is
 * not the same claim as "I checked the file".
 */
export function verify(json: string, name: string): void {
  const patterns: Array<[RegExp, string]> = [
    [/sk-[A-Za-z0-9_-]{8,}/, 'an sk- API key'],
    [/\bBearer\s+[A-Za-z0-9._-]{12,}/, 'a bearer token'],
    [/\b(OPENAI|ANTHROPIC)_(API_KEY|AUTH_TOKEN)\b/, 'a credential variable name'],
    [/"(system|messages|prompt)"\s*:/, 'a raw prompt field'],
  ];
  for (const [pattern, what] of patterns) {
    const hit = pattern.exec(json);
    if (hit !== null) {
      throw new Error(`refusing to write ${name}: it contains ${what} (${hit[0].slice(0, 12)}…)`);
    }
  }
}

/** Strip one run down to a recorded file. Pure, so the shape is testable. */
export function toRecorded(report: EvalReportShape, run: EvalRunShape): RecordedRun {
  const model = report.models.coder;
  const timeline = buildTimeline({
    events: run.events,
    runMs: run.ms,
    ...(Array.isArray(run.result.attempts) ? { attempts: run.result.attempts as [] } : {}),
  });

  // The terminal `done` loses `result.attempts` and nothing else — see the header.
  const events = run.events.map((event): RewriteEvent => {
    if (event.type !== 'done') return event;
    return { ...event, result: { ...event.result, attempts: [] } };
  });

  return {
    provider: vendorOf(model),
    model,
    round: report.round,
    archetype: run.archetype ?? 'unknown',
    recordedAt: report.generatedAt,
    approved: run.approved,
    attempts: run.attempts,
    timing: {
      method:
        'reconstructed from the measured durations in the eval artifact ' +
        '(analysis.done.ms, candidate coder.ms, trial.gate ms), scaled so the total ' +
        "equals the run's real wall clock; the artifact records no per-event timestamp",
      totalMs: Math.round(timeline.totalMs),
      pinned: timeline.pinned,
      events: events.length,
    },
    at: timeline.at,
    events,
  };
}

function entryOf(run: RecordedRun, name: string, strategy: string): RecordedIndexEntry {
  const rejections = countRejections(run.events);
  return {
    name,
    model: run.model,
    recordedAt: run.recordedAt,
    round: run.round,
    archetype: run.archetype,
    approved: run.approved,
    attempts: run.attempts,
    strategy,
    rejections,
    totalMs: run.timing.totalMs,
    label:
      `${name} — ${rejections} candidate(s) rejected by the harness, then "${strategy}" ` +
      `approved on attempt ${run.attempts} (${(run.timing.totalMs / 1000).toFixed(1)}s)`,
  };
}

function main(argv: readonly string[]): void {
  const [artifactPath, ...wanted] = argv;
  if (artifactPath === undefined || wanted.length === 0) {
    console.error(
      [
        'usage: node scripts/record-run.ts <eval-artifact.json> <replay> [<replay> …]',
        '',
        'Reads an eval artifact from disk and writes public/recorded/<replay>.json for',
        'each named run, plus public/recorded/index.json. No network, no API key.',
      ].join('\n'),
    );
    process.exitCode = 2;
    return;
  }

  const report = JSON.parse(readFileSync(artifactPath, 'utf8')) as EvalReportShape;
  const outDir = fileURLToPath(new URL(`../public/${RECORDED_DIR}/`, import.meta.url));
  mkdirSync(outDir, { recursive: true });

  const entries: RecordedIndexEntry[] = [];
  for (const name of wanted) {
    const run = report.runs.find((candidate) => candidate.replay === name);
    if (run === undefined) {
      throw new Error(`no run named "${name}" in ${basename(artifactPath)}`);
    }
    // The recorded mode exists to show the loop working. A run that never approved has
    // no `result.source`, so the next round could not load anything from it.
    if (!run.approved) throw new Error(`run "${name}" was not approved — it cannot drive a next round`);
    if (countRejections(run.events) === 0) {
      throw new Error(`run "${name}" shows no harness rejection — it is not evidence of the loop`);
    }

    const recorded = toRecorded(report, run);
    const json = `${JSON.stringify(recorded)}\n`;
    verify(json, `${name}.json`);
    writeFileSync(`${outDir}${name}.json`, json);

    entries.push(entryOf(recorded, name, run.strategyName ?? 'unknown'));
    console.log(
      `  ${name.padEnd(14)} ${(json.length / 1024).toFixed(0).padStart(4)} kB  ` +
        `${recorded.events.length} events  ${(recorded.timing.totalMs / 1000).toFixed(1)}s  ` +
        `${recorded.timing.pinned} measured anchor(s)`,
    );
  }

  const index = {
    note:
      'Recorded real eval runs, replayed by ?agent=recorded&run=<name>. Real model ' +
      'output and real harness verdicts; per-event timing is reconstructed (see each ' +
      "file's timing.method). The first entry is the default.",
    source: basename(artifactPath),
    runs: entries,
  };
  const indexJson = `${JSON.stringify(index, null, 2)}\n`;
  verify(indexJson, 'index.json');
  writeFileSync(`${outDir}index.json`, indexJson);
  console.log(`\n${entries.length} run(s) → public/${RECORDED_DIR}/  (default: ${entries[0]?.name})`);
}

// Only when invoked as a script. `verify`, `countRejections` and `toRecorded` are
// imported directly by `test/recorded-source.test.ts`, which must not trigger `main`.
if (process.argv[1] !== undefined && import.meta.url.endsWith(basename(process.argv[1]))) {
  main(process.argv.slice(2));
}
