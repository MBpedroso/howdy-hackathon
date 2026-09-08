import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ReplaySummary } from '@rematch/engine';

/** Known-good strategies live in `contract`; every consumer reuses them (spec §7). */
export const GOOD_FIXTURES = ['idle', 'chaser', 'orbiter', 'cornerbreaker'] as const;
export type GoodFixture = (typeof GOOD_FIXTURES)[number];

export function readGood(name: GoodFixture): string {
  return readFileSync(
    new URL(`../../contract/test/fixtures/strategies/good/${name}.js`, import.meta.url),
    'utf8',
  );
}

/**
 * The hand-written Round 2 boss. It lives in the harness rather than in
 * `contract`'s reference set because its whole purpose is to be *measured*: it is
 * the evidence that the Round 2 fairness band is reachable by a strategy that also
 * counters a camper (see `balance.test.ts`).
 */
export function readCandidate(): string {
  return readFileSync(new URL('./fixtures/round2-candidate.js', import.meta.url), 'utf8');
}

export function candidatePath(): string {
  return fileURLToPath(new URL('./fixtures/round2-candidate.js', import.meta.url));
}

/** Replay summaries of a bot beating the null boss — stand-ins for a human's round 1. */
export const SUMMARY_FIXTURES = ['camper', 'kiter', 'rusher', 'dodger'] as const;
export type SummaryFixture = (typeof SUMMARY_FIXTURES)[number];

export function readSummary(name: SummaryFixture): ReplaySummary {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/summaries/${name}-round1.json`, import.meta.url), 'utf8'),
  ) as ReplaySummary;
}

export function summaryPath(name: SummaryFixture): string {
  return fileURLToPath(new URL(`./fixtures/summaries/${name}-round1.json`, import.meta.url));
}

/** Harness-specific rejection corpus: one file per way a strategy can fail a gate. */
export const BAD_FIXTURES = [
  'nan-angle',
  'ignores-cooldowns',
  'throws-on-corner',
  'infinite-loop',
  'memory-hog',
  'returns-string',
  'slow-decide',
  'uses-date',
  'out-of-bounds',
  // Passes Gates 1, 2 and 4 and fails only Gate 3's span clause — the one entry
  // here that is not a *crash*, but a boss that plays honestly and goes nowhere.
  'jitter',
] as const;
export type BadFixture = (typeof BAD_FIXTURES)[number];

export function readBad(name: BadFixture): string {
  return readFileSync(new URL(`./fixtures/${name}.js`, import.meta.url), 'utf8');
}

export function goodFixturePath(name: GoodFixture): string {
  return fileURLToPath(new URL(`../../contract/test/fixtures/strategies/good/${name}.js`, import.meta.url));
}

export function badFixturePath(name: BadFixture): string {
  return fileURLToPath(new URL(`./fixtures/${name}.js`, import.meta.url));
}
