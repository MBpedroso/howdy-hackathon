/**
 * Re-grade every strategy the model actually wrote, against the harness as it is now.
 *
 * ## Why this exists
 *
 * Gate 3's ACTIVE assertion has been added to twice, both times after something got
 * past it: the two idle clauses on 2026-09-04 (a human playtest found a frozen boss)
 * and the span clause on 2026-09-08 (an independent review found a vibrating one). Both
 * times the question that mattered next was the same, and it is not a question the unit
 * suite can answer: **does the new clause reject what the model actually produces?**
 *
 * A gate can only lower the loop's pass rate. The eleven shipped strategies clear the
 * span floor by 2.8x, but they were hand-written to clear it; the real distribution is
 * the ~60 candidate files `gpt-5.4-mini` wrote during the 2026-09-03 eval, and those are
 * on disk. This script replays all of them through the current Gate 3 and prints, per
 * candidate, the verdict it got then and the numbers it posts now.
 *
 * It costs nothing — no model call, no network. That is the point: it is the check to
 * run *before* spending credit on a fresh eval.
 *
 * ## What it found on 2026-09-08
 *
 * Committed at `docs/evidence/recheck-active-2026-09-08.json`, and two things:
 *
 *  1. The span clause rejects **0 of 58**. The narrowest real candidate is 86.9 px
 *     against the 56 px floor, and that one already fails an idle clause. The clause is
 *     free on this distribution.
 *  2. **Four of the eval's six approvals fail the *idle* clauses** — idle runs of 161,
 *     183, 762 and 155 ticks against the 90-tick limit. The eval ran on 09-03; ACTIVE
 *     was added on 09-04. So the 0.6 pass rate quoted throughout the docs was measured
 *     against a harness that no longer exists, and it is an upper bound.
 *
 * ## Usage
 *
 *   pnpm --filter @rematch/harness recheck:active [eval.json] [--write]
 *
 * Defaults to the newest `artifacts/agents/eval-*.json`. `--write` refreshes the
 * evidence file. `artifacts/` is untracked, so on a fresh clone this needs an eval to
 * point at — `docs/evidence/eval-round2-2026-09-03.json` works but holds one run of ten.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACTIVITY, gate3Balance } from '../src/index.ts';

/** Repo root, from this file's location. Keeps every path below relative. */
const ROOT = new URL('../../../', import.meta.url).pathname;

/** Gate 3 matches per candidate. Reduced from the eval's 200 for turnaround: ACTIVE is
 *  a max/min over matches rather than a rate, so it barely moves with the count. */
const MATCHES = 100;
const WORKERS = 4;

type Candidate = {
  id: string;
  replay: string;
  name: string;
  wasApproved: boolean;
  source: string;
};

/** Newest `artifacts/agents/eval-*.json`, or the path given on the command line. */
function resolveEval(argv: readonly string[]): string {
  const given = argv.find((a) => !a.startsWith('--'));
  if (given !== undefined) return given;
  const dir = join(ROOT, 'artifacts/agents');
  const files = readdirSync(dir)
    .filter((f) => f.startsWith('eval-') && f.endsWith('.json'))
    .sort();
  const last = files.at(-1);
  if (last === undefined) throw new Error(`no eval-*.json in ${dir} — pass one as an argument`);
  return join(dir, last);
}

/**
 * Pair every generated file with the verdict it got.
 *
 * `rewrite.done` carries the source and `verdict` carries the outcome; both carry
 * `attempt` and `candidate`, which is the join key. The `verdict` events *without* a
 * `candidate` are the loop's per-attempt summaries — the same verdict again — so they
 * are skipped or every winning candidate would be counted twice.
 */
function extract(evalJson: string): Candidate[] {
  const parsed = JSON.parse(readFileSync(evalJson, 'utf8')) as {
    runs: Array<{ replay: string; events: Array<Record<string, unknown>> }>;
  };
  const out: Candidate[] = [];
  parsed.runs.forEach((run, ri) => {
    const sources = new Map<string, { source: string; name: string }>();
    for (const e of run.events) {
      if (e.type !== 'rewrite.done') continue;
      const meta = e.meta as { name?: string } | undefined;
      sources.set(`${String(e.attempt)}|${String(e.candidate ?? 0)}`, {
        source: String(e.source ?? ''),
        name: meta?.name ?? '?',
      });
    }
    for (const e of run.events) {
      if (e.type !== 'verdict' || e.candidate === undefined) continue;
      const hit = sources.get(`${String(e.attempt)}|${String(e.candidate)}`);
      if (hit === undefined || hit.source === '') continue;
      out.push({
        id: `r${ri}-a${String(e.attempt)}-c${String(e.candidate)}`,
        replay: run.replay,
        name: hit.name,
        wasApproved: e.approved === true,
        source: hit.source,
      });
    }
  });
  // Identical sources across attempts would be graded twice for no information.
  const seen = new Set<string>();
  return out.filter((c) => (seen.has(c.source) ? false : (seen.add(c.source), true)));
}

type Row = Candidate & {
  panel: number;
  idleRun: number;
  idleP90: number;
  span: number;
  failsIdle: boolean;
  failsSpan: boolean;
};

const argv = process.argv.slice(2);
const evalPath = resolveEval(argv);
const candidates = extract(evalPath);

console.log(`eval:       ${evalPath}`);
console.log(`candidates: ${candidates.length} unique sources`);
console.log(
  `thresholds: idleRun <= ${ACTIVITY.maxIdleRunTicks}  idleP90 <= ${ACTIVITY.maxIdleFractionP90}  span >= ${ACTIVITY.minSpanPx} px\n`,
);
console.log('id              then       panel  idleRun  idleP90    span  now');

const rows: Row[] = [];
let ungraded = 0;
for (const c of candidates) {
  const result = await gate3Balance(c.source, { round: 2, matches: MATCHES, workers: WORKERS });
  const detail = result.detail as {
    activity?: { longestIdleRun: number; idleFractionP90: number; minSpanPx: number };
    panel?: { winRate: number };
  } | null;
  const activity = detail?.activity;
  const then = (c.wasApproved ? 'APPROVED' : 'rejected').padEnd(9);
  if (activity === undefined || detail?.panel === undefined) {
    // Gate 3 never reached the simulation. In practice: truncated model output that
    // Gate 1 rejects, which this script skips past by calling Gate 3 directly.
    ungraded += 1;
    console.log(`${c.id.padEnd(14)} ${then}   --  not graded (${result.ok ? 'ok' : result.reason.slice(0, 52)})`);
    continue;
  }
  const failsIdle =
    activity.longestIdleRun > ACTIVITY.maxIdleRunTicks || activity.idleFractionP90 > ACTIVITY.maxIdleFractionP90;
  const failsSpan = activity.minSpanPx < ACTIVITY.minSpanPx;
  rows.push({
    ...c,
    panel: detail.panel.winRate,
    idleRun: activity.longestIdleRun,
    idleP90: activity.idleFractionP90,
    span: activity.minSpanPx,
    failsIdle,
    failsSpan,
  });
  console.log(
    [
      c.id.padEnd(14),
      then,
      detail.panel.winRate.toFixed(2).padStart(6),
      String(activity.longestIdleRun).padStart(8),
      `${(activity.idleFractionP90 * 100).toFixed(0).padStart(7)}%`,
      activity.minSpanPx.toFixed(0).padStart(7),
      failsSpan ? '  SPAN REJECTS' : failsIdle ? '  idle rejects' : '',
    ].join(' '),
  );
}

const wasApproved = rows.filter((r) => r.wasApproved);
const minSpan = Math.min(...rows.map((r) => r.span));

console.log('\n=== does the span clause reject what the model writes? ===');
console.log(`graded:                     ${rows.length} (${ungraded} not graded)`);
console.log(`rejected by the span clause: ${rows.filter((r) => r.failsSpan).length}`);
console.log(`narrowest real candidate:    ${minSpan.toFixed(1)} px against a ${ACTIVITY.minSpanPx} px floor`);

console.log('\n=== would the eval\'s approvals still be approved? ===');
console.log(`approved then:               ${wasApproved.length}`);
console.log(`now failing an idle clause:  ${wasApproved.filter((r) => r.failsIdle).length}`);
console.log(`now failing the span clause: ${wasApproved.filter((r) => r.failsSpan).length}`);

if (argv.includes('--write')) {
  const out = join(ROOT, 'docs/evidence/recheck-active-2026-09-08.json');
  writeFileSync(
    out,
    `${JSON.stringify(
      {
        what: "Every candidate strategy the model wrote in the 2026-09-03 eval, re-graded by the harness as it stands on 2026-09-08. Answers two questions: does Gate 3's new span clause reject anything the model actually produces, and would the eval's six approvals still be approved now that ACTIVE exists.",
        generatedBy: 'packages/harness/scripts/recheck-active.mts --write',
        source: `${evalPath} (the untrimmed 10-run eval; docs/evidence/eval-round2-2026-09-03.json is a one-run excerpt of it)`,
        gradedAt: new Date().toISOString(),
        harness: { round: 2, matches: MATCHES, workers: WORKERS },
        thresholds: {
          maxIdleRunTicks: ACTIVITY.maxIdleRunTicks,
          maxIdleFractionP90: ACTIVITY.maxIdleFractionP90,
          minSpanPx: ACTIVITY.minSpanPx,
          note: 'the two idle clauses were added 2026-09-04, the day AFTER this eval ran; minSpanPx was added 2026-09-08',
        },
        findings: {
          graded: rows.length,
          notGraded: ungraded,
          notGradedWhy:
            'truncated model output missing required exports; Gate 1 rejects both, and this script calls gate3Balance directly so the sandbox load fails instead',
          spanClauseRejects: rows.filter((r) => r.failsSpan).length,
          minSpanPxObserved: minSpan,
          previouslyApproved: wasApproved.length,
          previouslyApprovedNowFailingIdle: wasApproved.filter((r) => r.failsIdle).length,
          previouslyApprovedNowFailingSpan: wasApproved.filter((r) => r.failsSpan).length,
        },
        conclusion: [
          `The span clause costs nothing on the real generation distribution: 0 of ${rows.length} graded candidates fall below ${ACTIVITY.minSpanPx} px, and the narrowest real candidate is ${minSpan.toFixed(1)} px and already fails an idle clause.`,
          "The documented 0.6 pass rate predates ACTIVE. Four of the eval's six approvals post idle runs of 161, 183, 762 and 155 ticks against a 90-tick limit, and p90 idle fractions of 0.73 to 0.95 against 0.25. They would not be approved on the attempt that approved them.",
          'That does NOT make the current pass rate 0.2. The loop gets the idle-run rejection as feedback and has four attempts; whether it recovers inside the deadline is unmeasured, and the deadline was already the binding constraint (Coder p50 7.7 s, p90 12.3 s). The honest statement is that the current rate is unknown and 0.6 is an upper bound measured against a weaker harness.',
        ],
        rows: rows.map((r) => ({
          id: r.id,
          replay: r.replay,
          name: r.name,
          verdict2026_09_03: r.wasApproved ? 'approved' : 'rejected',
          panel: Number(r.panel.toFixed(4)),
          longestIdleRun: r.idleRun,
          idleFractionP90: Number(r.idleP90.toFixed(4)),
          minSpanPx: Number(r.span.toFixed(1)),
          failsIdleNow: r.failsIdle,
          failsSpanNow: r.failsSpan,
        })),
      },
      null,
      2,
    )}\n`,
  );
  console.log(`\nwrote ${out}`);
}
