/**
 * What ADAPTED's relative route actually changes, on the strategies the model wrote.
 *
 * ## Why this exists
 *
 * `balanceConfig.ts`'s `ADAPTED_MARGIN` argues that the absolute 0.70 threshold and
 * FAIR contradict each other for a player who plays well, and adds a second way to
 * pass: beat the incumbent boss against the same Mimic by 0.10. That argument came
 * from one live run. Before it ships, two questions need numbers, and neither is one
 * the unit suite can answer:
 *
 *  1. **Does anything that passed before now fail?** It must not — the route is an
 *     `||` — and "must not by construction" is exactly the claim worth checking
 *     against real files rather than fixtures.
 *  2. **How much does it actually loosen?** A route that approves everything is not
 *     a gate. The answer depends entirely on how strong the incumbent is, so this
 *     prints the baseline it measured next to every verdict it changed.
 *
 * ## The incumbent problem, which is the interesting part
 *
 * The recorded eval ran every replay against the **null boss** — the canned
 * `bossStrategy` is `Statue`, which returns `idle` forever. Its rate against any
 * Mimic is ~0, so a baseline taken from the artifacts would be ~0.00 and
 * `base + 0.10` would approve almost anything. That is not the game: round 2's
 * incumbent is the hand-written round-1 boss, and from round 3 on it is a boss that
 * already passed this gate — so the bar rises by itself each round.
 *
 * So both baselines are measured and printed. The statue's is the floor of what the
 * relative route can be worth; the round-1 boss's is what round 2 will really use.
 *
 * Costs nothing — no model call, no network.
 *
 *   pnpm --filter @rematch/harness recheck:adapted [eval.json] [--write]
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReplaySummary } from '@rematch/engine';
import { ADAPTED_MARGIN, adapted, adaptedMinFor, bandFor, gate3Balance, measureMimicWinRate } from '../src/index.ts';

const ROOT = new URL('../../../', import.meta.url).pathname;

/** Matches per candidate. Half go to the Mimic, which is the half this is about. */
const MATCHES = 100;
const WORKERS = 4;

/** The incumbent round 2 really faces. */
const ROUND1 = join(ROOT, 'packages/web/src/strategies/round1.js');

type Candidate = { id: string; replay: string; name: string; wasApproved: boolean; source: string };

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

/** Same join as `recheck-active.ts`: `rewrite.done` has the source, `verdict` the outcome. */
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
  const seen = new Set<string>();
  return out.filter((c) => (seen.has(c.source) ? false : (seen.add(c.source), true)));
}

/** The canned replay a run used, by name. */
function canned(name: string): { summary: ReplaySummary; bossStrategy: string } {
  const path = join(ROOT, 'packages/agents/canned', `${name}.json`);
  return JSON.parse(readFileSync(path, 'utf8')) as { summary: ReplaySummary; bossStrategy: string };
}

const argv = process.argv.slice(2);
const evalPath = resolveEval(argv);
const candidates = extract(evalPath);
const round1Source = readFileSync(ROUND1, 'utf8');

console.log(`eval:       ${evalPath}`);
console.log(`candidates: ${candidates.length} unique sources`);
console.log(`ADAPTED:    absolute >= ${adaptedMinFor(2)}, or base + ${ADAPTED_MARGIN}\n`);

// ---------------------------------------------------------------- the baselines
const replays = [...new Set(candidates.map((c) => c.replay))].sort();
const bases = new Map<string, { statue: number; round1: number }>();
console.log('replay          statue  round1   → relative bar (round1)');
for (const replay of replays) {
  const { summary, bossStrategy } = canned(replay);
  const shared = { mimicSummary: summary, matches: MATCHES, workers: WORKERS };
  const statue = (await measureMimicWinRate(bossStrategy, shared)) ?? 0;
  const round1 = (await measureMimicWinRate(round1Source, shared)) ?? 0;
  bases.set(replay, { statue, round1 });
  console.log(
    `${replay.padEnd(14)}  ${statue.toFixed(2).padStart(6)}  ${round1.toFixed(2).padStart(6)}   → ${(round1 + ADAPTED_MARGIN).toFixed(2)}`,
  );
}

// ---------------------------------------------------------------- the verdicts
type Row = {
  id: string;
  replay: string;
  name: string;
  panel: number;
  mimic: number;
  base: number;
  absoluteOk: boolean;
  relativeOk: boolean;
  fairOk: boolean;
  /** Rejected by ADAPTED and nothing else — the population this change is for. */
  adaptedOnly: boolean;
};

console.log('\nid              replay          panel  mimic   base  absolute  relative  fair');
const rows: Row[] = [];
let ungraded = 0;
for (const c of candidates) {
  const { summary } = canned(c.replay);
  const base = bases.get(c.replay)?.round1 ?? 0;
  const result = await gate3Balance(c.source, {
    round: 2,
    matches: MATCHES,
    workers: WORKERS,
    mimicSummary: summary,
    adaptedBase: base,
  });
  const detail = result.detail as {
    panel?: { winRate: number };
    mimic?: { winRate: number };
  };
  if (detail.panel === undefined || detail.mimic === undefined) {
    ungraded += 1;
    continue;
  }
  const panel = detail.panel.winRate;
  const mimic = detail.mimic.winRate;
  const [lo, hi] = bandFor(2);
  const fairOk = panel >= lo && panel <= hi;
  const absoluteOk = adapted(mimic);
  const relativeOk = adapted(mimic, base);
  const row: Row = {
    id: c.id,
    replay: c.replay,
    name: c.name,
    panel,
    mimic,
    base,
    absoluteOk,
    relativeOk,
    fairOk,
    adaptedOnly: fairOk && !absoluteOk,
  };
  rows.push(row);
  console.log(
    `${c.id.padEnd(14)}  ${c.replay.padEnd(14)}  ${panel.toFixed(2)}   ${mimic.toFixed(2)}   ${base.toFixed(2)}` +
      `      ${absoluteOk ? ' ok' : ' no'}       ${relativeOk ? ' ok' : ' no'}    ${fairOk ? ' ok' : ' no'}`,
  );
}

// ------------------------------------------------------------------- the answer
const regressed = rows.filter((r) => r.absoluteOk && !r.relativeOk);
const unlocked = rows.filter((r) => r.adaptedOnly && r.relativeOk);
const stillRejected = rows.filter((r) => r.adaptedOnly && !r.relativeOk);

console.log(`\ngraded:            ${rows.length}${ungraded > 0 ? ` (${ungraded} could not be graded)` : ''}`);
console.log(`passed absolute:   ${rows.filter((r) => r.absoluteOk).length}`);
console.log(`in band (FAIR):    ${rows.filter((r) => r.fairOk).length}`);
console.log(`rejected by ADAPTED alone: ${rows.filter((r) => r.adaptedOnly).length}`);
console.log(`  → now approved by the relative route: ${unlocked.length}`);
console.log(`  → still rejected:                     ${stillRejected.length}`);
console.log(`REGRESSIONS (passed before, fail now):  ${regressed.length}   <- must be 0`);

if (argv.includes('--write')) {
  const out = join(ROOT, `docs/evidence/recheck-adapted-${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(
    out,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        eval: evalPath,
        matches: MATCHES,
        thresholds: { adaptedMin: adaptedMinFor(2), adaptedMargin: ADAPTED_MARGIN, fair: bandFor(2) },
        baselines: Object.fromEntries(bases),
        summary: {
          graded: rows.length,
          passedAbsolute: rows.filter((r) => r.absoluteOk).length,
          inBand: rows.filter((r) => r.fairOk).length,
          adaptedOnly: rows.filter((r) => r.adaptedOnly).length,
          unlocked: unlocked.length,
          stillRejected: stillRejected.length,
          regressions: regressed.length,
        },
        rows,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`\nwrote ${out}`);
}
