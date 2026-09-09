/**
 * Diagnostic: would an ADAPTED (Mimic) tie-break ever have changed which candidate
 * shipped?
 *
 * `chooseCandidate` (`packages/agents/src/loop.ts`, ~line 652) picks among an
 * attempt's K rewrite candidates by distance to the round's band midpoint alone —
 * approved beats rejected, then nearest to `bandMid` wins. It never looks at the
 * Mimic (ADAPTED) win rate, even though every candidate has one. Open question Q4
 * in `docs/ANALYSIS-learning-signal-2026-09-09.md` asks: if ties within 0.03 of
 * band-mid distance broke on the higher Mimic rate instead, would any *historically
 * shipped* candidate have changed?
 *
 * This is pure replay of committed run artifacts — no model call, no sandbox, no
 * simulation. Every artifact's `done` event (or, for the batched evals, each run's
 * `.result`) already carries `RewriteResult.attempts[].candidates[]`
 * (`CandidateLog[]`): each candidate's `panel` rate, `approved` flag, and `gates`,
 * whose Gate 3 entry's `detail.mimic.winRate` is the number `chooseCandidate`
 * ignores. So the whole comparison is: for every attempt that had >= 2 *approved*
 * candidates (the only case where a tie-break could ever matter — an attempt with
 * 0 or 1 approved candidates has nothing to break a tie between), replay
 *
 *   (a) current rule  — min |panel - bandMid|, first-encountered on an exact tie
 *   (b) proposed rule — quantize |panel - bandMid| into floor(dist / 0.03) buckets,
 *                        lowest bucket wins, ties broken by max Mimic rate, and any
 *                        remaining tie falls back to (a) for determinism
 *
 * and count how often they disagree.
 *
 * Note on (b)'s operationalization: "quantize into 0.03 buckets" is a fixed grid
 * anchored at distance 0, not "any two candidates within 0.03 of *each other*". A
 * pair straddling a bucket boundary (0.029 vs 0.031) lands in different buckets
 * despite being 0.002 apart, and a pair at 0.01 and 0.089 lands in the *same*
 * bucket [0, 0.03) only if both round down together — this is the bucketing the
 * task specified, and it is reported as a caveat rather than smoothed over.
 *
 * `bandMid` comes from `BAND[round]` (`packages/harness/src/gates/balanceConfig.ts`),
 * keyed by each run's round (read from the `replay` event / `request.round`).
 *
 * Sources scanned: `artifacts/agents/eval-*.json` (10-run batched evals, 2026-09-03)
 * and `artifacts/server/rewrite-*.json` (individual live/server runs). Both are
 * untracked (`artifacts/` is gitignored) so this script does nothing on a fresh
 * clone with no local runs. `docs/evidence/eval-round2-2026-09-03.json` is
 * deliberately *not* scanned: its own header says it is a one-run excerpt of one of
 * the `artifacts/agents/eval-*.json` files, and including it would double-count
 * that run.
 *
 *   node --experimental-strip-types scripts/choice-audit.ts
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { BAND, type BalanceRound } from '../src/index.ts';

const ROOT = new URL('../../../', import.meta.url).pathname;
const TIE_BUCKET = 0.03;

// ------------------------------------------------------------- artifact shapes
// Minimal, read-only mirrors of the real types (`packages/agents/src/events.ts`,
// `packages/harness/src/gates/types.ts`) — just enough structure to read the
// fields this script needs out of already-parsed JSON.

type GateResultLike = { gate: number; detail?: unknown };
type CandidateLogLike = {
  candidate: number;
  dial?: string;
  approved: boolean;
  skipped?: true;
  panel?: number;
  gates: GateResultLike[];
  /** The candidate's actual source, used only to fingerprint runs for de-duplication. */
  source?: string;
};
type AttemptLogLike = {
  attempt: number;
  chosen?: number;
  candidates?: CandidateLogLike[];
};
type RewriteResultLike = {
  approved: boolean;
  attempts: AttemptLogLike[];
};

type Run = { label: string; round: number | undefined; result: RewriteResultLike | undefined };

/** Gate 3's `detail.mimic.winRate`, when the gate measured one. */
function mimicOf(candidate: CandidateLogLike): number | undefined {
  const g3 = candidate.gates.find((g) => g.gate === 3);
  const detail = g3?.detail;
  if (typeof detail !== 'object' || detail === null) return undefined;
  const mimic = (detail as Record<string, unknown>)['mimic'];
  if (typeof mimic !== 'object' || mimic === null) return undefined;
  const rate = (mimic as Record<string, unknown>)['winRate'];
  return typeof rate === 'number' ? rate : undefined;
}

// --------------------------------------------------------------- file loading

function listArtifacts(): { path: string; kind: 'eval' | 'server' }[] {
  const out: { path: string; kind: 'eval' | 'server' }[] = [];
  const evalDir = join(ROOT, 'artifacts/agents');
  const serverDir = join(ROOT, 'artifacts/server');
  try {
    for (const f of readdirSync(evalDir)) {
      if (f.startsWith('eval-') && f.endsWith('.json')) out.push({ path: join(evalDir, f), kind: 'eval' });
    }
  } catch {
    // artifacts/agents doesn't exist on a fresh clone; nothing to scan there.
  }
  try {
    for (const f of readdirSync(serverDir)) {
      if (f.startsWith('rewrite-') && f.endsWith('.json')) out.push({ path: join(serverDir, f), kind: 'server' });
    }
  } catch {
    // same, for artifacts/server.
  }
  return out;
}

type LoadOutcome = { runs: Run[]; skipped: { label: string; why: string }[] };

/** Every run in one artifact file, plus a note for every run that had nothing usable. */
function loadFile(path: string, kind: 'eval' | 'server'): LoadOutcome {
  const base = path.split('/').pop() ?? path;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return { runs: [], skipped: [{ label: base, why: `JSON.parse failed: ${(err as Error).message}` }] };
  }

  if (kind === 'eval') {
    const doc = parsed as { round?: number; runs?: Array<{ replay?: string | number; result?: unknown }> };
    if (!Array.isArray(doc.runs)) return { runs: [], skipped: [{ label: base, why: 'no `runs` array' }] };
    const runs: Run[] = [];
    const skipped: { label: string; why: string }[] = [];
    doc.runs.forEach((r, i) => {
      const label = `${base}#run${i}(replay=${String(r.replay ?? '?')})`;
      if (r.result === undefined || r.result === null) {
        skipped.push({ label, why: 'run has no `result` (crashed or truncated before it finished)' });
        return;
      }
      runs.push({ label, round: doc.round, result: r.result as RewriteResultLike });
    });
    return { runs, skipped };
  }

  // 'server': one rewrite() call per file, its outcome in the `done` event.
  const doc = parsed as { request?: { round?: number }; events?: Array<{ type: string; result?: unknown }> };
  if (!Array.isArray(doc.events)) return { runs: [], skipped: [{ label: base, why: 'no `events` array' }] };
  const done = doc.events.find((e) => e.type === 'done');
  if (done === undefined) {
    return { runs: [], skipped: [{ label: base, why: 'no `done` event (run never finished — deadline/abort/crash)' }] };
  }
  return {
    runs: [{ label: base, round: doc.request?.round, result: done.result as RewriteResultLike }],
    skipped: [],
  };
}

// ------------------------------------------------------------------- ranking

/** (a) today's rule, restricted to the approved subset — see header. */
function pickCurrent(cands: CandidateLogLike[], bandMid: number): CandidateLogLike {
  let best = cands[0] as CandidateLogLike;
  let bestDist = Math.abs((best.panel ?? Number.POSITIVE_INFINITY) - bandMid);
  for (const c of cands.slice(1)) {
    const dist = Math.abs((c.panel ?? Number.POSITIVE_INFINITY) - bandMid);
    if (dist < bestDist) {
      best = c;
      bestDist = dist;
    }
  }
  return best;
}

/** (b) proposed rule: bucket the distance, then max Mimic within the lowest bucket. */
function pickProposed(cands: CandidateLogLike[], bandMid: number): CandidateLogLike {
  const withMeta = cands.map((c) => {
    const dist = Math.abs((c.panel ?? Number.POSITIVE_INFINITY) - bandMid);
    return { c, dist, bucket: Math.floor((dist + 1e-9) / TIE_BUCKET), mimic: mimicOf(c) };
  });
  let best = withMeta[0]!;
  for (const cand of withMeta.slice(1)) {
    if (
      cand.bucket < best.bucket ||
      (cand.bucket === best.bucket &&
        (cand.mimic ?? -Infinity) > (best.mimic ?? -Infinity)) ||
      // same bucket, same (or both-undefined) Mimic rate: fall back to (a)'s raw
      // distance so the rule stays fully deterministic.
      (cand.bucket === best.bucket && (cand.mimic ?? -Infinity) === (best.mimic ?? -Infinity) && cand.dist < best.dist)
    ) {
      best = cand;
    }
  }
  return best.c;
}

// ---------------------------------------------------------------------- main

type Diff = {
  file: string;
  attempt: number;
  round: number;
  bandMid: number;
  candidates: { candidate: number; dial?: string; panel: number; mimic: number | undefined; dist: number }[];
  chosenCurrent: number;
  chosenProposed: number;
};

const artifacts = listArtifacts();
console.log(`artifacts found: ${artifacts.length} (${artifacts.filter((a) => a.kind === 'eval').length} eval, ${artifacts.filter((a) => a.kind === 'server').length} server)\n`);

let filesParsed = 0;
const fileSkips: { label: string; why: string }[] = [];
const runSkips: { label: string; why: string }[] = [];

let multiCandidateAttempts = 0; // attempts with K >= 2 recorded candidates
const approvedCountHisto = new Map<number, number>(); // # approved candidates -> # attempts
let attemptsGE2Approved = 0;
let roundlessSkipped = 0; // attempts with >=2 approved but an unrecognized round

const allApprovedMimics: number[] = []; // every approved candidate's Mimic rate, corpus-wide
const diffs: Diff[] = [];
let chooseCandidateMismatch = 0; // sanity check: (a) restricted to approved should equal the recorded `chosen`

const seenRunHashes = new Set<string>();
let duplicateRunsSkipped = 0;

for (const { path, kind } of artifacts) {
  const { runs, skipped } = loadFile(path, kind);
  if (skipped.length > 0 && runs.length === 0) {
    fileSkips.push(...skipped);
    continue;
  }
  filesParsed += 1;
  runSkips.push(...skipped);

  for (const run of runs) {
    if (run.result === undefined) continue;
    // Fingerprint on the actual generated source of every candidate, not just
    // shape (attempt count / chosen index) — two unrelated 1-attempt/1-candidate
    // runs would otherwise collide on shape alone and be wrongly treated as the
    // same run. Guards against the same run being present in two files (e.g. a
    // batched eval and a hand-excerpted copy of one of its runs).
    const sourcesConcat = run.result.attempts
      .flatMap((a) => a.candidates ?? [])
      .map((c) => c.source ?? '')
      .join(' ');
    const sig = createHash('sha1').update(`${run.round ?? '?'} ${sourcesConcat}`).digest('hex');
    if (sourcesConcat !== '' && seenRunHashes.has(sig)) {
      duplicateRunsSkipped += 1;
      continue;
    }
    seenRunHashes.add(sig);

    for (const attempt of run.result.attempts) {
      const cands = attempt.candidates;
      if (cands === undefined || cands.length < 2) continue; // K = 1: nothing to choose between
      multiCandidateAttempts += 1;

      const approved = cands.filter((c) => c.approved === true);
      approvedCountHisto.set(approved.length, (approvedCountHisto.get(approved.length) ?? 0) + 1);
      for (const c of approved) {
        const m = mimicOf(c);
        if (m !== undefined) allApprovedMimics.push(m);
      }

      if (approved.length < 2) continue;
      attemptsGE2Approved += 1;

      const round = run.round;
      const band = round !== undefined ? BAND[round as BalanceRound] : undefined;
      if (band === undefined) {
        roundlessSkipped += 1;
        continue;
      }
      const bandMid = (band[0] + band[1]) / 2;

      const current = pickCurrent(approved, bandMid);
      const proposed = pickProposed(approved, bandMid);

      if (attempt.chosen !== undefined) {
        const recordedChosen = cands.find((c) => c.candidate === attempt.chosen);
        if (recordedChosen?.approved === true && recordedChosen.candidate !== current.candidate) {
          chooseCandidateMismatch += 1;
        }
      }

      if (current.candidate !== proposed.candidate) {
        diffs.push({
          file: run.label,
          attempt: attempt.attempt,
          round: round as number,
          bandMid,
          candidates: approved.map((c) => ({
            candidate: c.candidate,
            dial: c.dial ?? `candidate ${c.candidate + 1}`,
            panel: c.panel ?? Number.NaN,
            mimic: mimicOf(c),
            dist: Math.abs((c.panel ?? Number.POSITIVE_INFINITY) - bandMid),
          })),
          chosenCurrent: current.candidate,
          chosenProposed: proposed.candidate,
        });
      }
    }
  }
}

// -------------------------------------------------------------------- report

console.log(`files parsed:        ${filesParsed}`);
console.log(`files skipped:       ${fileSkips.length}`);
for (const s of fileSkips) console.log(`  - ${s.label}: ${s.why}`);
if (runSkips.length > 0) {
  console.log(`runs skipped:        ${runSkips.length} (within otherwise-parsed files)`);
  for (const s of runSkips.slice(0, 20)) console.log(`  - ${s.label}: ${s.why}`);
  if (runSkips.length > 20) console.log(`  ... and ${runSkips.length - 20} more`);
}
if (duplicateRunsSkipped > 0) console.log(`duplicate runs skipped (identical candidate sources): ${duplicateRunsSkipped}`);
console.log();

console.log('=== base rates ===');
console.log(`attempts with >= 2 recorded candidates (K >= 2): ${multiCandidateAttempts}`);
console.log('  distribution by # approved candidates in the attempt:');
for (const n of [...approvedCountHisto.keys()].sort((a, b) => a - b)) {
  console.log(`    ${n} approved: ${approvedCountHisto.get(n)} attempts`);
}
console.log(`attempts with >= 2 APPROVED candidates (tie-break could ever matter): ${attemptsGE2Approved}`);
if (roundlessSkipped > 0) console.log(`  of which skipped for an unrecognized round: ${roundlessSkipped}`);
console.log(`sanity check — current-rule pick vs the artifact's recorded \`chosen\`: ${chooseCandidateMismatch} mismatches (expect 0)`);
console.log();

if (allApprovedMimics.length > 0) {
  const sorted = [...allApprovedMimics].sort((a, b) => a - b);
  const median = sorted.length % 2 === 1
    ? sorted[(sorted.length - 1) / 2]!
    : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;
  console.log(`Mimic rate among ALL approved candidates (n=${sorted.length}): min ${sorted[0]!.toFixed(2)}  median ${median.toFixed(2)}  max ${sorted[sorted.length - 1]!.toFixed(2)}`);
} else {
  console.log('Mimic rate among approved candidates: no data (no approved candidate carried a measured Mimic rate)');
}
console.log();

console.log(`=== choice differs between current and proposed rule: ${diffs.length} attempt(s) ===`);
for (const d of diffs) {
  console.log(`\n${d.file}  attempt ${d.attempt}  round ${d.round}  bandMid ${d.bandMid.toFixed(3)}`);
  for (const c of d.candidates) {
    const mark = c.candidate === d.chosenCurrent ? 'CURRENT' : c.candidate === d.chosenProposed ? 'PROPOSED' : '';
    console.log(
      `  candidate ${c.candidate}${c.dial ? ` (${c.dial})` : ''}: panel ${c.panel.toFixed(3)}  dist ${c.dist.toFixed(3)}  mimic ${c.mimic === undefined ? 'n/a' : c.mimic.toFixed(3)}  ${mark}`,
    );
  }
}

console.log('\n=== verdict ===');
if (attemptsGE2Approved === 0) {
  console.log('No attempt in the scanned corpus ever had 2+ approved candidates — approvals never came in pairs, so');
  console.log('the tie-break has no attempt to act on. The corpus cannot say whether it would ever bind; it says only');
  console.log('that it would never have fired historically because its precondition never occurred.');
} else if (diffs.length === 0) {
  console.log(`${attemptsGE2Approved} attempt(s) had 2+ approved candidates, and the proposed tie-break never changed the pick.`);
  console.log('Either the panel-distance gaps between approved candidates were never within the same 0.03 bucket, or');
  console.log('the candidate the current rule already prefers also happens to carry the higher Mimic rate.');
} else {
  console.log(`${diffs.length} of ${attemptsGE2Approved} qualifying attempt(s) would have shipped a different candidate under the proposed rule.`);
  console.log('See the pairs above for the exact panel/Mimic numbers.');
}
