import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Known-good strategies live in `contract`; every consumer reuses them (spec §7). */
export const GOOD_FIXTURES = ['idle', 'chaser', 'orbiter', 'cornerbreaker'] as const;
export type GoodFixture = (typeof GOOD_FIXTURES)[number];

export function readGood(name: GoodFixture): string {
  return readFileSync(
    new URL(`../../contract/test/fixtures/strategies/good/${name}.js`, import.meta.url),
    'utf8',
  );
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
