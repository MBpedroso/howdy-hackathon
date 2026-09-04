import { readFileSync } from 'node:fs';
import type { ReplaySummary } from '@rematch/engine';
import { loadCanned, type CannedName } from '../src/canned.ts';

/** Known-good strategies live in `contract`; every consumer reuses them (spec §7). */
export function readGood(name: 'idle' | 'chaser' | 'orbiter' | 'cornerbreaker'): string {
  return readFileSync(
    new URL(`../../contract/test/fixtures/strategies/good/${name}.js`, import.meta.url),
    'utf8',
  );
}

/** The harness's rejection corpus and its hand-written Round 2 boss. */
export function readHarnessFixture(name: string): string {
  return readFileSync(new URL(`../../harness/test/fixtures/${name}.js`, import.meta.url), 'utf8');
}

export function cannedSummary(name: CannedName): ReplaySummary {
  return loadCanned(name).summary;
}

/** Wrap a strategy the way a model would reply. */
export function asCoderReply(source: string, preamble = ''): string {
  return `${preamble}\`\`\`js\n${source}\n\`\`\`\n`;
}

export function asAnalystReply(analysis: unknown): string {
  return JSON.stringify(analysis);
}
