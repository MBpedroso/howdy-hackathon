/**
 * Free validation for analysis item 3 (`docs/ANALYSIS-learning-signal-2026-09-09.md`,
 * §5 Q3): does calibrating the Mimic's `accuracy` to the summary it was built from
 * actually move the incumbent-vs-Mimic number, and in the honest direction?
 *
 * ## What it does
 *
 * Scans every committed `ReplaySummary` it can find —
 *
 *  - `packages/agents/canned/*.json` (`.summary`)
 *  - `packages/web/public/recorded/*.json` (the `replay` SSE event's `.summary`)
 *  - `docs/evidence/**​/*.json` (anything shaped like a `ReplaySummary`, recursively —
 *    none of the current evidence files embed one raw, so this is future-proofing,
 *    not padding: it costs nothing to check)
 *
 * and for each one prints:
 *
 *  1. the measured hit rate (`boss.damageTaken / player.shots`) and the accuracy it
 *     derives (`accuracyFromSummary`) next to the old fixed 0.72
 *  2. the incumbent's (`web/src/strategies/round1.js`) win rate against a Mimic of
 *     that summary, **before** (accuracy pinned to 0.72, the old behaviour) and
 *     **after** (accuracy derived, the new default) — via `measureMimicWinRate`'s
 *     own `accuracy` override, so "before" is not a different code path, just the
 *     old constant fed through it
 *
 * The number analysis item 3 exists to move is delta 23's: the incumbent beats a
 * Mimic of a flawless human run (zero damage taken) 0.710 of the time. The closest
 * committed replay to that description is `mimic-camper` (`Statue` rationale, "I do
 * nothing, so you can measure everything else against me", `player.damageTaken: 0`)
 * — its row is called out explicitly.
 *
 * Costs nothing: no model call, no network, deterministic seeds.
 *
 *   node --experimental-strip-types scripts/mimic-calibration.ts [--matches N]
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ReplaySummary } from '@rematch/engine';
import { accuracyFromSummary, measureMimicWinRate } from '../src/index.ts';

const ROOT = new URL('../../../', import.meta.url).pathname;
const OLD_FIXED_ACCURACY = 0.72;
const ROUND1 = join(ROOT, 'packages/web/src/strategies/round1.js');

const argv = process.argv.slice(2);
const matchesFlag = argv.indexOf('--matches');
const MATCHES = matchesFlag >= 0 ? Number(argv[matchesFlag + 1]) : 100;
const WORKERS = 4;

// ------------------------------------------------------------------ discovery

type Found = { path: string; label: string; summary: ReplaySummary };

/** Loose structural check — enough to tell a `ReplaySummary` from an arbitrary JSON blob. */
function looksLikeSummary(v: unknown): v is ReplaySummary {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  const player = o.player as Record<string, unknown> | undefined;
  const boss = o.boss as Record<string, unknown> | undefined;
  const durations = o.durations as Record<string, unknown> | undefined;
  return (
    typeof player?.shots === 'number' &&
    typeof boss?.damageTaken === 'number' &&
    typeof durations?.ticks === 'number'
  );
}

/** Walk an arbitrary JSON value looking for objects shaped like a `ReplaySummary`. */
function findSummaries(v: unknown, path: string, out: Found[], seen: Set<string>): void {
  if (looksLikeSummary(v)) {
    const key = `${(v as ReplaySummary).seed}|${(v as ReplaySummary).durations.ticks}|${(v as ReplaySummary).player.shots}|${(v as ReplaySummary).boss.damageTaken}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ path, label: path, summary: v as ReplaySummary });
    }
    return; // a ReplaySummary's own nested objects are not further summaries
  }
  if (Array.isArray(v)) {
    for (const item of v) findSummaries(item, path, out, seen);
    return;
  }
  if (typeof v === 'object' && v !== null) {
    for (const value of Object.values(v)) findSummaries(value, path, out, seen);
  }
}

function jsonFilesUnder(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir, { recursive: true }) as string[];
  } catch {
    return out;
  }
  for (const e of entries) if (e.endsWith('.json')) out.push(join(dir, e));
  return out;
}

function discover(): Found[] {
  const seen = new Set<string>();
  const found: Found[] = [];
  const dirs = [
    join(ROOT, 'packages/agents/canned'),
    join(ROOT, 'packages/web/public/recorded'),
    join(ROOT, 'docs/evidence'),
  ];
  for (const dir of dirs) {
    for (const file of jsonFilesUnder(dir)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        continue;
      }
      const before = found.length;
      findSummaries(parsed, file.replace(ROOT, ''), found, seen);
      // Label each summary found in a multi-summary file (e.g. the recorded SSE
      // logs, which repeat the summary across several `interlude.state` events)
      // with just the file — `findSummaries`'s de-dup key already collapses exact
      // repeats, so `before` is only informative, not required for correctness.
      void before;
    }
  }
  return found;
}

// -------------------------------------------------------------------- measure

const round1Source = readFileSync(ROUND1, 'utf8');
const summaries = discover();

if (summaries.length === 0) {
  console.log('no ReplaySummary-shaped JSON found under packages/agents/canned, packages/web/public/recorded or docs/evidence');
  process.exit(0);
}

console.log(`incumbent:  ${ROUND1.replace(ROOT, '')}`);
console.log(`summaries:  ${summaries.length}, ${MATCHES} matches each, x2 (before/after)\n`);

type Row = {
  label: string;
  name: string;
  hitRate: number;
  oldAccuracy: number;
  newAccuracy: number;
  before: number | undefined;
  after: number | undefined;
};

const rows: Row[] = [];
for (const { label, summary } of summaries) {
  const shots = summary.player.shots;
  const hitRate = shots > 0 ? summary.boss.damageTaken / shots : Number.NaN;
  const newAccuracy = accuracyFromSummary(summary);
  const shared = { mimicSummary: summary, matches: MATCHES, workers: WORKERS };
  const before = await measureMimicWinRate(round1Source, { ...shared, accuracy: OLD_FIXED_ACCURACY });
  const after = await measureMimicWinRate(round1Source, shared); // no override -> accuracyFromSummary
  rows.push({
    label,
    name: summary.strategy?.name ?? '?',
    hitRate,
    oldAccuracy: OLD_FIXED_ACCURACY,
    newAccuracy,
    before,
    after,
  });
}

const fmt = (n: number | undefined): string => (n === undefined ? '  n/a' : n.toFixed(3));
console.log(
  'summary'.padEnd(58) +
    'hitRate  accOld  accNew   before   after   Δ',
);
for (const r of rows) {
  const delta = r.before !== undefined && r.after !== undefined ? (r.after - r.before).toFixed(3) : 'n/a';
  console.log(
    r.label.padEnd(58) +
      `${Number.isNaN(r.hitRate) ? ' n/a ' : r.hitRate.toFixed(3).padStart(6)}` +
      `  ${r.oldAccuracy.toFixed(2).padStart(5)}` +
      `  ${r.newAccuracy.toFixed(3).padStart(6)}` +
      `  ${fmt(r.before).padStart(7)}` +
      `  ${fmt(r.after).padStart(6)}` +
      `  ${delta.padStart(6)}`,
  );
}

// --------------------------------------------------------------- the headline

const flawless = rows.find((r) => r.label.includes('mimic-camper'));
console.log('\n=== delta 23\'s number, before and after ===');
console.log(
  'ADAPTED_MARGIN\'s comment: "the incumbent … scores 0.710 against a Mimic of the very run the human had just won" (a flawless, zero-damage round).',
);
if (flawless === undefined) {
  console.log('no committed summary matched "mimic-camper" — see the table above for the closest zero-damage rows.');
} else {
  console.log(
    `closest committed analogue: ${flawless.label} ("${flawless.name}", hit rate ${flawless.hitRate.toFixed(3)})`,
  );
  console.log(`  before (accuracy pinned to 0.72): ${fmt(flawless.before)}`);
  console.log(`  after  (accuracy ${flawless.newAccuracy.toFixed(3)}, derived):  ${fmt(flawless.after)}`);
  if (flawless.before !== undefined && flawless.after !== undefined) {
    console.log(
      flawless.after < flawless.before
        ? `  -> dropped by ${(flawless.before - flawless.after).toFixed(3)}, toward something less inflated.`
        : `  -> did NOT drop (moved by ${(flawless.after - flawless.before).toFixed(3)}) — the calibration did not shrink this number for this summary.`,
    );
  }
}

const withBoth = rows.filter((r) => r.before !== undefined && r.after !== undefined) as Array<
  Row & { before: number; after: number }
>;
const meanBefore = withBoth.reduce((s, r) => s + r.before, 0) / Math.max(1, withBoth.length);
const meanAfter = withBoth.reduce((s, r) => s + r.after, 0) / Math.max(1, withBoth.length);
console.log(`\nmean incumbent-vs-Mimic win rate across ${withBoth.length} summaries: ${meanBefore.toFixed(3)} -> ${meanAfter.toFixed(3)}`);
