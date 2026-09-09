/**
 * Parallelisation evidence, measured rather than asserted.
 *
 * The submission asks which workstreams ran in parallel and what that bought. The
 * *development* lanes are described in `docs/SYSTEM.md` §8 but their timeline is not
 * recoverable — the history was squashed one commit per milestone, so every lane
 * landed in the same minute. What is recoverable is the parallelism that is still
 * running in the product, and this measures it: the same 200-match Gate 3, on one
 * worker and on the pool.
 *
 *   pnpm --filter @rematch/harness evidence:parallel
 */
import { availableParallelism } from 'node:os';
import { readFileSync } from 'node:fs';
import { gate3Balance } from '../src/index.ts';

const ROOT = new URL('../../../', import.meta.url).pathname;
const source = readFileSync(`${ROOT}packages/web/src/strategies/round1.js`, 'utf8');
const MATCHES = 200;

console.log(`cores available: ${availableParallelism()}`);
console.log(`matches:         ${MATCHES} (one Gate 3 run)\n`);

const runs: { label: string; workers: number | undefined; ms: number }[] = [];
for (const workers of [1, undefined]) {
  // One warm run first: the WASM module is instantiated once per process and the
  // first sandbox load would otherwise be charged to whichever config went first.
  await gate3Balance(source, { round: 2, matches: 16, ...(workers === undefined ? {} : { workers }) });
  const t0 = performance.now();
  const r = await gate3Balance(source, { round: 2, matches: MATCHES, ...(workers === undefined ? {} : { workers }) });
  const ms = performance.now() - t0;
  runs.push({ label: workers === 1 ? 'inline (workers = 1)' : 'worker pool (default)', workers, ms });
  const d = r.detail as { workers?: number };
  console.log(`${(workers === 1 ? 'inline (workers = 1)' : 'worker pool (default)').padEnd(24)} ${ms.toFixed(0).padStart(6)} ms   workers=${d.workers ?? '?'}`);
}

const [serial, pool] = runs;
if (serial !== undefined && pool !== undefined) {
  console.log(`\nspeedup: ${(serial.ms / pool.ms).toFixed(2)}x`);
  console.log(`Gate 3 is the loop's only CPU-bound stage; at ${MATCHES} matches per candidate and`);
  console.log(`3 candidates per attempt, the serial cost would be ${((serial.ms * 3) / 1000).toFixed(1)} s per attempt`);
  console.log(`against ${((pool.ms * 3) / 1000).toFixed(1)} s — inside a 45 s interlude budget that also has to`);
  console.log('fit two model calls.');
}
