/**
 * Node-side replay of a recorded round — the other half of spec AC 3.
 *
 * The browser plays `{ seed, inputLog, source }` through QuickJS and reports
 * `hashState`. This does the identical thing in Node, with the same sandbox package,
 * the same WASM bytes and the same deterministic clock, so the two hashes are
 * comparable byte for byte. Used by the fixture generator and by the fixture's
 * regression test (`test/replay-fixture.test.ts`), which is what keeps the recorded
 * expectation honest when an engine constant changes.
 */
import { readFileSync } from 'node:fs';
import { replay, hashState, type InputLog, type GameState } from '@rematch/engine';
import { createSandbox } from '@rematch/sandbox';

import { deterministicClock } from '../src/game/clock.ts';

/** Absolute path of a bundled strategy source, resolved from this file. */
export function strategyPath(name: string): string {
  return new URL(`../src/strategies/${name}.js`, import.meta.url).pathname;
}

export function readStrategySource(name: string): string {
  return readFileSync(strategyPath(name), 'utf8');
}

export type NodeReplay = {
  final: GameState;
  hash: string;
  ticks: number;
  outcome: GameState['outcome'];
};

/**
 * Replay a log in Node exactly the way the browser does.
 *
 * Note the sandbox is created fresh per call: a `StrategyRunner` owns a QuickJS
 * runtime and a round's memory, and reusing one across replays would leak state
 * between them.
 */
export async function replayInNode(seed: number, log: InputLog, source: string): Promise<NodeReplay> {
  const sandbox = await createSandbox();
  const runner = sandbox.load(source, { now: deterministicClock() });
  try {
    const { final } = replay(seed, log, runner);
    return { final, hash: hashState(final), ticks: final.tick, outcome: final.outcome };
  } finally {
    runner.dispose();
  }
}

/**
 * Round every float in a log to 1e-4.
 *
 * The recorded aim vectors are the only non-integer inputs, and a 17-digit double in
 * the fixture JSON is both unreadable and pointlessly precise — the engine quantizes
 * to 1e-4 anyway. Rounding *before* the hash is computed is what makes the fixture and
 * its expectation consistent: the hash is always the hash of the log as written.
 */
export function quantizeLog(log: InputLog): InputLog {
  const r = (v: number): number => Math.round(v * 1e4) / 1e4;
  return log.map((input) => ({ ...input, aimX: r(input.aimX), aimY: r(input.aimY) }));
}
