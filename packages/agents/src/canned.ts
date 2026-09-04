/**
 * The canned replays the agent eval runs on (spec §7): "Given 10 canned replays,
 * the loop reaches APPROVED within 4 attempts >= 80% of the time."
 *
 * They are not hand-written JSON. Each one is a real match — a reference bot
 * playing as the *human* against a real strategy, through the real engine and the
 * real QuickJS sandbox — compressed with `summarizeReplay`, which is byte-for-byte
 * the object the live game will hand the Analyst. Regenerate with
 * `pnpm --filter @rematch/agents gen-canned`; the seeds are fixed, so the files
 * only change when the engine's rules change, and then they should.
 *
 * Ten of them, chosen to span the archetypes the Analyst has to tell apart *and*
 * the same archetype played twice at different skill (`-b` variants), because a
 * loop that only ever sees one camper is not evidence that it can read a camper.
 * Two are Mimic replays: a bot rebuilt from another canned summary, which is the
 * closest thing available to "a second human who plays like the first".
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ReplaySummary } from '@rematch/engine';

export const CANNED_NAMES = [
  'camper-a',
  'camper-b',
  'kiter-a',
  'kiter-b',
  'rusher-a',
  'rusher-b',
  'dodger-a',
  'dodger-b',
  'mimic-camper',
  'mimic-rusher',
] as const;
export type CannedName = (typeof CANNED_NAMES)[number];

export type CannedReplay = {
  name: CannedName;
  summary: ReplaySummary;
  /** The strategy the bot played against — the eval's `prevSource`. */
  bossStrategy: string;
};

const dir = new URL('../canned/', import.meta.url);

export function cannedPath(name: CannedName): string {
  return fileURLToPath(new URL(`${name}.json`, dir));
}

export function loadCanned(name: CannedName): CannedReplay {
  const raw = JSON.parse(readFileSync(new URL(`${name}.json`, dir), 'utf8')) as {
    summary: ReplaySummary;
    bossStrategy: string;
  };
  return { name, summary: raw.summary, bossStrategy: raw.bossStrategy };
}

export function loadAllCanned(): CannedReplay[] {
  return CANNED_NAMES.map(loadCanned);
}
