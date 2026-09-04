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

/**
 * Wrap an `Analysis` the way the Analyst is asked to reply: the prose sentences
 * first — that is what streams to the player (spec §2.2) — then the fenced JSON
 * block the Coder is handed.
 *
 * Tests that pass a bare `JSON.stringify(analysis)` are still valid input and are
 * kept where the point is the parser's tolerance; this is the shape the *prompt*
 * asks for, so it is what the loop-level tests use.
 */
export function asAnalystReply(analysis: {
  observations: readonly string[];
  playerArchetype: string;
  counterPlan: string;
}): string {
  return `${analysis.observations.join(' ')}\n\n\`\`\`json\n${JSON.stringify(analysis, null, 2)}\n\`\`\`\n`;
}
