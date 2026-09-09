/**
 * Re-grade a live run's candidates through the harness as it is now.
 *
 * `recheck-adapted.ts` answers the same question for the 2026-09-03 eval, whose
 * replays were played by *bots*. This one takes a `POST /api/rewrite` artifact —
 * a real human's round — because that is the population the ADAPTED change was
 * made for, and it is the only one where the Mimic imitates a person.
 *
 *   node --experimental-strip-types scripts/regrade-live.ts artifacts/server/rewrite-*.json
 */
import { readFileSync } from 'node:fs';
import type { ReplaySummary } from '@rematch/engine';
import { bandFor, gate3Balance, measureMimicWinRate } from '../src/index.ts';

const MATCHES = 100;
const WORKERS = 4;
const ROOT = new URL('../../../', import.meta.url).pathname;

const [path] = process.argv.slice(2);
if (path === undefined) throw new Error('usage: regrade-live.ts <rewrite-*.json>');

const art = JSON.parse(readFileSync(path, 'utf8')) as {
  request: { round: number; prevMeta?: { name?: string } };
  events: Array<Record<string, unknown>>;
};

const replay = art.events.find((e) => e.type === 'replay') as { summary: ReplaySummary } | undefined;
if (replay === undefined) throw new Error('no replay event: cannot rebuild the Mimic');

/** Every candidate file the run produced, in the order it produced them. */
const sources = art.events
  .filter((e) => e.type === 'rewrite.done')
  .map((e, i) => ({
    id: `a${String(e.attempt ?? '?')}c${String(e.candidate ?? 0)}`,
    order: i,
    source: String(e.source ?? ''),
    name: (e.meta as { name?: string } | undefined)?.name ?? '?',
  }))
  .filter((c) => c.source !== '');

const round = art.request.round as 2 | 3 | 4 | 5;
const [lo, hi] = bandFor(round);
const summary = replay.summary;

const base = await measureMimicWinRate(readFileSync(`${ROOT}packages/web/src/strategies/round1.js`, 'utf8'), {
  mimicSummary: summary,
  matches: MATCHES,
  workers: WORKERS,
});

console.log(`artifact:  ${path}`);
console.log(`round:     ${round}  band ${lo.toFixed(2)}–${hi.toFixed(2)}  incumbent "${art.request.prevMeta?.name ?? '?'}"`);
console.log(`candidates: ${sources.length}`);
console.log(`round-1 boss vs this Mimic: ${base === undefined ? '—' : base.toFixed(3)}\n`);
console.log('id       name                 panel  mimic  verdict');

let approved = 0;
let firstApproved: string | undefined;
for (const c of sources) {
  const r = await gate3Balance(c.source, {
    round,
    matches: MATCHES,
    workers: WORKERS,
    mimicSummary: summary,
    ...(base === undefined ? {} : { adaptedBase: base }),
  });
  const d = r.detail as { panel?: { winRate: number }; mimic?: { winRate: number } };
  if (r.ok) {
    approved += 1;
    firstApproved ??= c.id;
  }
  console.log(
    `${c.id.padEnd(8)} ${c.name.slice(0, 20).padEnd(20)} ${(d.panel?.winRate ?? NaN).toFixed(2)}   ` +
      `${(d.mimic?.winRate ?? NaN).toFixed(2)}   ${r.ok ? 'APPROVED' : `rejected: ${(r as { reason: string }).reason.slice(0, 70)}`}`,
  );
}

console.log(`\napproved: ${approved} of ${sources.length}`);
console.log(`first approved candidate: ${firstApproved ?? 'none'}`);
