/**
 * `pnpm --filter @rematch/web record:run` — turn a real eval run into a replayable
 * demo asset. **Reads a file on disk; makes no network call and needs no API key.**
 *
 * ```
 * node scripts/record-run.ts <eval-artifact.json> <replay> [<replay> …]
 * node scripts/record-run.ts ../../artifacts/agents/eval-2026-09-03T23-53-46-645Z.json \
 *   mimic-camper dodger-a kiter-a
 *
 * node scripts/record-run.ts --server --provider <p> --model <m> <name>=<artifact.json> …
 * node scripts/record-run.ts --server --provider claude-cli --model sonnet \
 *   silo-r2-calibrated=../../docs/evidence/local-live-2026-09-11-r2-throttle.json \
 *   cistern-r3-calibrated=../../docs/evidence/local-live-2026-09-11-r3-throttle.json
 * ```
 *
 * ## Two kinds of input
 *
 * An **eval artifact** (`pnpm eval:agents` → `artifacts/agents/eval-*.json`) is a
 * report of ten runs; a run inside it is named by its replay and carries its own
 * `events`, `ms` and `archetype`.
 *
 * A **server rewrite artifact** (`artifacts/server/rewrite-*.json`, and the copies
 * kept under `docs/evidence/`) is one real request end to end:
 * `{generatedAt, request, summary, events}`. It is what a live round on
 * `REMATCH_PROVIDER=claude-cli` leaves behind, so it is the only shape a run against
 * the developer's own Claude Code session can be recorded from — and the only shape
 * that contains the Judge's `calibrate.*` beat at all, because calibration did not
 * exist when the 2026-09-03 evals ran.
 *
 * The two modes differ in where the seven header fields come from and in how the
 * timeline is reconstructed (see *Timing*); everything after that — the stripping,
 * the credential grep, the index — is shared. `--server` names the provider and the
 * model on the command line because the artifact does not record them: the server
 * logs what it did, not what it was configured with.
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
 * Neither artifact has a per-event timestamp (see `timeline.ts`), so offsets are
 * reconstructed from the durations each one *does* measure and scaled onto the run's
 * real wall clock. `timing.method` in each file says so, and the badge on screen says
 * `RECORDED RUN`.
 *
 * A server artifact adds one beat the eval never had, and it is the one beat with no
 * measurement anywhere in the stream: a `calibrate.step` is a full four-gate re-run
 * and the event carries only its value and its rate. The spec's own figure for that
 * re-run is ~1 s (SPEC §6.3, delta 26), so every step is charged a flat
 * `CALIBRATE_STEP_MS` and `timing.assumed` counts how many offsets were bought that
 * way rather than measured. That is the only number in a recorded file that is an
 * assumption rather than a reading, which is exactly why it is counted separately
 * from `timing.pinned` instead of being folded into it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

/**
 * One `POST /api/rewrite`, as the server writes it to `artifacts/server/rewrite-*.json`.
 *
 * `events` is the whole ordered SSE stream — the same frames the browser received,
 * including the `calibrate.*` pair — and `summary` is the server's own log line for
 * the request. Structural, like `EvalRunShape`: the file is data, not an import.
 */
type ServerArtifactShape = {
  generatedAt?: string;
  request?: { round?: number };
  summary?: { at?: string; round?: number; ms?: number; attempts?: number };
  events: RewriteEvent[];
};

/**
 * What one step of the Judge's calibration search is charged, in milliseconds.
 *
 * SPEC §6.3 (delta 26): the search re-runs **all four gates** per value, "at most 6
 * steps, ~1 s each". The stream does not time a step — `calibrate.step` carries the
 * value and the rate it measured and nothing else — so this is the spec's figure,
 * not a reading, and `timing.assumed` says how many offsets rest on it.
 */
export const CALIBRATE_STEP_MS = 1000;

/** The header a recorded file carries, and the only metadata the badge reads. */
export type RecordedHeader = {
  /**
   * The vendor the run was made against — inferred from the model name for an eval
   * artifact, named on the command line for a server one (`--provider`), because the
   * server logs the run and not the configuration that produced it.
   */
  provider: string;
  /** The Coder's model — the one that wrote the code that shipped. */
  model: string;
  round: number;
  /** The Analyst's own verdict on the player, or `unknown` if it never returned. */
  archetype: string;
  /** The artifact's `generatedAt`, ISO. The badge shows its date half. */
  recordedAt: string;
  approved: boolean;
  /** Harness attempts the run took. */
  attempts: number;
};

export type RecordedRun = RecordedHeader & {
  timing: {
    method: string;
    totalMs: number;
    pinned: number;
    /** Offsets charged `CALIBRATE_STEP_MS` because nothing in the stream times them. */
    assumed?: number;
    events: number;
  };
  /** Offsets in milliseconds from the first event, one per entry of `events`. */
  at: number[];
  events: RewriteEvent[];
};

export type RecordedIndexEntry = {
  /** `?run=<name>`, and the basename of the file. */
  name: string;
  /** Absent on entries recorded before the field existed; the run file always has it. */
  provider?: string;
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
  /** Basename of the artifact this entry was recorded from. */
  source?: string;
  /**
   * Carried through, never generated. The 2026-09-03 recordings disclose their idle
   * bosses here (see `recorded.ts`), and a merge must not quietly drop that.
   */
  knownIssue?: string;
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

/**
 * The stream as `buildTimeline` can pin it.
 *
 * `buildTimeline` lives in `timeline.ts` and knows the eval's four anchors; a
 * `calibrate.step` is a fifth it has never seen, and an unpinned step would be
 * interpolated into whatever span it fell in — in the round 3 run that is eight steps
 * smeared across two candidates' gate groups, so the strip would crawl or jump rather
 * than tick once per re-run.
 *
 * So the timeline is computed over a **shadow** array in which each step wears a
 * gate's clothes and is charged `CALIBRATE_STEP_MS`. Same length, same order, so the
 * offsets come back index-aligned with the real stream. Nothing here is ever written:
 * the recorded file carries the artifact's own events, and `timing.assumed` is how a
 * reader finds out that these particular offsets were charged rather than measured.
 */
export function pinnable(events: readonly RewriteEvent[]): RewriteEvent[] {
  return events.map((event) =>
    event.type === 'calibrate.step'
      ? {
          type: 'trial.gate',
          attempt: event.attempt,
          gate: { gate: 3, name: 'balance', ok: true, ms: CALIBRATE_STEP_MS },
        }
      : event,
  );
}

/** How many offsets in a stream are bought with `CALIBRATE_STEP_MS` rather than read. */
export function countAssumed(events: readonly RewriteEvent[]): number {
  return events.filter((event) => event.type === 'calibrate.step').length;
}

/**
 * Strip one server rewrite artifact down to a recorded file.
 *
 * Same contract as `toRecorded`, from the other input shape. `provider` and `model`
 * are arguments because the artifact does not record them — the server logs the run,
 * not its configuration — so the header's honesty here rests on the command line,
 * which is why the command that produced each file is in the log entry beside it.
 *
 * The `calibrate.step` / `calibrate.done` frames are kept, deliberately and against
 * the general rule that a recorded file is the smallest thing that replays: they are
 * the Judge doing arithmetic in public, which is the whole reason this run is worth
 * recording over an eval that never calibrated anything.
 */
export function toRecordedServer(
  artifact: ServerArtifactShape,
  vendor: { provider: string; model: string },
): RecordedRun {
  const events = artifact.events;
  const last = events.at(-1);
  if (last?.type !== 'done') throw new Error('artifact does not end in a `done` event');

  const result = last.result;
  const attempts = Array.isArray(result.attempts) ? result.attempts : [];
  // `summary.ms` is the server's own measurement of the request, which is the number
  // the replay is claiming when it says it lasts as long as the run did.
  const runMs = artifact.summary?.ms ?? 0;
  if (!(runMs > 0)) throw new Error('artifact records no summary.ms to scale the replay onto');

  const timeline = buildTimeline({ events: pinnable(events), runMs, attempts: attempts as [] });
  const assumed = countAssumed(events);

  // The Analyst's verdict on the player, from the stream if it got that far and from
  // the terminal result otherwise — the same field under both roofs.
  const analysed = events.find((event) => event.type === 'analysis.done');
  const archetype =
    (analysed?.type === 'analysis.done' ? analysed.analysis.playerArchetype : undefined) ??
    result.analysis?.playerArchetype ??
    'unknown';

  const round = artifact.request?.round ?? artifact.summary?.round;
  if (round === undefined) throw new Error('artifact records no round');
  const recordedAt = artifact.generatedAt ?? artifact.summary?.at;
  if (recordedAt === undefined) throw new Error('artifact records no generatedAt');

  const stripped = events.map((event): RewriteEvent => {
    if (event.type !== 'done') return event;
    return { ...event, result: { ...event.result, attempts: [] } };
  });

  return {
    provider: vendor.provider,
    model: vendor.model,
    round,
    archetype,
    recordedAt,
    approved: result.approved,
    attempts: attempts.length > 0 ? attempts.length : (artifact.summary?.attempts ?? 0),
    timing: {
      method:
        'reconstructed from the measured durations in the server artifact ' +
        "(analysis.done.ms, each candidate's coder.ms from the done result, each " +
        'trial.gate ms), with a flat 1 000 ms charged to every calibrate.step because ' +
        'the stream does not time one (SPEC §6.3 measures the four-gate re-run at ~1 s); ' +
        "scaled so the total equals summary.ms, the run's real wall clock. The " +
        'artifact records no per-event timestamp.',
      totalMs: Math.round(timeline.totalMs),
      // `buildTimeline` counts the shadow gates as pins; they are assumptions, so they
      // are subtracted out here rather than inflating the measured count.
      pinned: timeline.pinned - assumed,
      assumed,
      events: stripped.length,
    },
    at: timeline.at,
    events: stripped,
  };
}

/** `throttle 1.00 → 0.50, 1 step` — the Judge's search, for the index line. */
function calibrationOf(events: readonly RewriteEvent[]): string {
  const done = events.filter((event) => event.type === 'calibrate.done').find((event) => event.approved);
  if (done === undefined || done.type !== 'calibrate.done') return '';
  const steps = `${done.steps} calibration step${done.steps === 1 ? '' : 's'}`;
  return ` at the Judge's throttle ${done.pressure.toFixed(2)} after ${steps}`;
}

function entryOf(run: RecordedRun, name: string, strategy: string): RecordedIndexEntry {
  const rejections = countRejections(run.events);
  return {
    name,
    provider: run.provider,
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
      `approved on attempt ${run.attempts}${calibrationOf(run.events)} ` +
      `(${(run.timing.totalMs / 1000).toFixed(1)}s)`,
  };
}

/**
 * The index's opening paragraph, written from the entries rather than pinned to a
 * particular set of them.
 *
 * The KNOWN ISSUE sentence is the reason this is generated: it is true of the three
 * 2026-09-03 runs and false of everything recorded since the ACTIVE assertion
 * landed, so it names the runs it applies to and disappears when none of them do.
 * A blanket caveat over a run that does not have the fault would be its own small
 * lie, and this file's whole job is not telling those.
 */
function noteFor(entries: readonly RecordedIndexEntry[]): string {
  const first = entries[0];
  const caveated = entries.filter((entry) => entry.knownIssue !== undefined);
  const lead =
    'Recorded real runs, replayed by ?agent=recorded&run=<name>. Real model output and ' +
    "real harness verdicts; per-event timing is reconstructed (see each file's " +
    'timing.method). The first entry is the default';
  const who =
    first === undefined
      ? ''
      : first.provider === undefined
        ? first.model
        : `${first.provider} (${first.model})`;
  const dflt =
    first === undefined
      ? '.'
      : `: ${first.name}, a ${first.recordedAt.slice(0, 10)} ${who} run approved ` +
        "through the Judge's deterministic throttle calibration.";
  const issue =
    caveated.length === 0
      ? ''
      : ` KNOWN ISSUE — ${caveated.map((entry) => entry.name).join(', ')} only: those ` +
        "recordings predate Gate 3's ACTIVE assertion, so the strategies they approved " +
        'use `idle` as a resting state and the boss freezes for seconds at a time. Each ' +
        'carries its own measured worst run in `knownIssue`, the interlude footer shows ' +
        'it on screen, and these files are kept as-is rather than re-recorded from a ' +
        'model that never ran.';
  return `${lead}${dflt}${issue} Re-record with \`pnpm --filter @rematch/web record:run\`.`;
}

/**
 * Write `index.json`, keeping entries this invocation did not re-record.
 *
 * The recorder used to own the whole index because one eval produced every run in it.
 * A server artifact is one run, so recording two of them would otherwise delete the
 * three 2026-09-03 recordings — assets that cannot be regenerated, from a model this
 * project no longer pays for. New entries come first (the first is the default), and
 * a name recorded again replaces its old entry in place of appending beside it.
 */
function writeIndex(outDir: string, fresh: readonly RecordedIndexEntry[]): RecordedIndexEntry[] {
  const path = `${outDir}index.json`;
  let previous: RecordedIndexEntry[] = [];
  let previousSource: string | undefined;
  if (existsSync(path)) {
    const old = JSON.parse(readFileSync(path, 'utf8')) as { source?: string; runs?: RecordedIndexEntry[] };
    previousSource = old.source;
    previous = (old.runs ?? []).map((entry) => {
      const source = entry.source ?? previousSource;
      return source === undefined ? entry : { ...entry, source };
    });
  }

  const names = new Set(fresh.map((entry) => entry.name));
  const runs = [...fresh, ...previous.filter((entry) => !names.has(entry.name))];
  const sources = new Set(runs.map((entry) => entry.source));
  const only = sources.size === 1 ? [...sources][0] : undefined;

  const index = {
    note: noteFor(runs),
    // One shared provenance line while every run came from one artifact; per entry
    // once they do not, which is the moment a single `source` would start lying.
    ...(only === undefined ? {} : { source: only }),
    runs: only === undefined ? runs : runs.map(({ source: _source, ...rest }) => rest),
  };
  const indexJson = `${JSON.stringify(index, null, 2)}\n`;
  verify(indexJson, 'index.json');
  writeFileSync(path, indexJson);
  return runs;
}

const USAGE = [
  'usage:',
  '  node scripts/record-run.ts <eval-artifact.json> <replay> [<replay> …]',
  '  node scripts/record-run.ts --server --provider <p> --model <m> <name>=<artifact.json> …',
  '',
  'Reads an artifact from disk and writes public/recorded/<name>.json per run, merging',
  'public/recorded/index.json. No network, no API key.',
].join('\n');

/** One line per written file, in the shape the eval mode has always printed. */
function printRun(name: string, run: RecordedRun, bytes: number): void {
  const assumed = run.timing.assumed ?? 0;
  console.log(
    `  ${name.padEnd(22)} ${(bytes / 1024).toFixed(0).padStart(4)} kB  ` +
      `${run.events.length} events  ${(run.timing.totalMs / 1000).toFixed(1)}s  ` +
      `${run.timing.pinned} measured anchor(s)` +
      (assumed === 0 ? '' : `  ${assumed} assumed`),
  );
}

/** `--server`: one recorded file per `<name>=<artifact.json>` pair. */
function recordServerRuns(argv: readonly string[], outDir: string): RecordedIndexEntry[] {
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index === -1 ? undefined : argv[index + 1];
  };
  const provider = flag('--provider');
  const model = flag('--model');
  if (provider === undefined || model === undefined) {
    // Not defaulted: the artifact does not record either one, so a guess here would
    // put a wrong model name on the badge — the one string the mode exists to get right.
    throw new Error('--server needs --provider and --model; the artifact records neither');
  }
  const pairs = argv.filter((arg) => arg.includes('=') && !arg.startsWith('--'));
  if (pairs.length === 0) throw new Error('--server needs at least one <name>=<artifact.json>');

  const entries: RecordedIndexEntry[] = [];
  for (const pair of pairs) {
    const at = pair.indexOf('=');
    const name = pair.slice(0, at);
    const path = pair.slice(at + 1);
    const artifact = JSON.parse(readFileSync(path, 'utf8')) as ServerArtifactShape;
    if (!Array.isArray(artifact.events)) throw new Error(`${basename(path)} has no events array`);

    const recorded = toRecordedServer(artifact, { provider, model });
    // The same two refusals the eval mode makes, for the same reason: the recorded
    // mode exists to show the loop working, and a run that never approved has no
    // `result.source` for the next round to load.
    if (!recorded.approved) throw new Error(`"${name}" was not approved — it cannot drive a next round`);
    if (countRejections(recorded.events) === 0) {
      throw new Error(`"${name}" shows no harness rejection — it is not evidence of the loop`);
    }

    const json = `${JSON.stringify(recorded)}\n`;
    verify(json, `${name}.json`);
    writeFileSync(`${outDir}${name}.json`, json);

    const done = recorded.events.at(-1);
    const strategy = done?.type === 'done' && done.result.approved ? done.result.meta.name : 'unknown';
    entries.push({ ...entryOf(recorded, name, strategy), source: basename(path) });
    printRun(name, recorded, json.length);
  }
  return entries;
}

function main(argv: readonly string[]): void {
  const outDir = fileURLToPath(new URL(`../public/${RECORDED_DIR}/`, import.meta.url));

  if (argv.includes('--server')) {
    mkdirSync(outDir, { recursive: true });
    const runs = writeIndex(outDir, recordServerRuns(argv, outDir));
    console.log(`\n${runs.length} run(s) in public/${RECORDED_DIR}/  (default: ${runs[0]?.name})`);
    return;
  }

  const [artifactPath, ...wanted] = argv;
  if (artifactPath === undefined || wanted.length === 0) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }

  const report = JSON.parse(readFileSync(artifactPath, 'utf8')) as EvalReportShape;
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

    entries.push({ ...entryOf(recorded, name, run.strategyName ?? 'unknown'), source: basename(artifactPath) });
    printRun(name, recorded, json.length);
  }

  const runs = writeIndex(outDir, entries);
  console.log(`\n${runs.length} run(s) in public/${RECORDED_DIR}/  (default: ${runs[0]?.name})`);
}

// Only when invoked as a script. `verify`, `countRejections`, `toRecorded` and
// `toRecordedServer` are imported directly by `test/recorded-source.test.ts` and
// `test/recorded-server.test.ts`, which must not trigger `main`.
if (process.argv[1] !== undefined && import.meta.url.endsWith(basename(process.argv[1]))) {
  main(process.argv.slice(2));
}
