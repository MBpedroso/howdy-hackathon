/**
 * One number: how well the *incumbent* boss does against a Mimic of a real player.
 *
 * Throwaway-shaped but kept, because it is the measurement that decides whether
 * ADAPTED's relative route is worth anything (`balanceConfig.ts`, `ADAPTED_MARGIN`).
 * The canned replays in `packages/agents/canned` are bot-played and the round-1 boss
 * beats their Mimics 0.58–1.00, which makes `base + 0.10` *stricter* than the
 * absolute 0.70 and the relative route dead weight. A human replay is the case the
 * route was designed for, and the only way to know is to measure one.
 *
 *   node --experimental-strip-types scripts/live-base.ts <summary.json> [source.js]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReplaySummary } from '@rematch/engine';
import { ADAPTED_MARGIN, measureMimicWinRate } from '../src/index.ts';

const ROOT = new URL('../../../', import.meta.url).pathname;
const [summaryPath, sourcePath = join(ROOT, 'packages/web/src/strategies/round1.js')] = process.argv.slice(2);
if (summaryPath === undefined) throw new Error('usage: live-base.ts <summary.json> [source.js]');

const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as ReplaySummary;
const source = readFileSync(sourcePath, 'utf8');
const base = await measureMimicWinRate(source, { mimicSummary: summary, matches: 200, workers: 4 });

console.log(`incumbent:  ${sourcePath.replace(ROOT, '')}`);
console.log(`vs Mimic:   ${base === undefined ? 'could not measure' : base.toFixed(3)}`);
if (base !== undefined) console.log(`relative bar: ${(base + ADAPTED_MARGIN).toFixed(3)}`);
