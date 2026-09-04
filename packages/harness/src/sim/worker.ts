/**
 * A simulation worker: one QuickJS sandbox, one loaded strategy, many matches.
 *
 * The expensive things are done exactly once per worker — instantiating the WASM
 * module and loading the strategy — and every match after that is one
 * `runner.init(seed)` plus up to 3600 ticks. Reusing the runner is safe *because*
 * `init` is what resets the strategy's memory (see `StrategyRunner`), and it is
 * what makes the parallel simulator worth having: the load is ~100 ms and a match
 * is ~30 ms, so a fresh sandbox per match would spend most of its time loading.
 *
 * Messages are handled through a serialized promise chain, so a `job` that arrives
 * while `init` is still awaiting the WASM module waits its turn instead of racing.
 *
 * Runs under Node's native TypeScript stripping (Node >= 23.6, or
 * `--experimental-strip-types`), like the harness CLI — there is no build step.
 */
import { isMainThread, parentPort } from 'node:worker_threads';
import type { StrategyRunner } from '@rematch/contract';
import { createSandbox, monotonicClock } from '@rematch/sandbox';
import type { PlayerBot } from '../bots/index.ts';
import { runMatchWith } from './runMatch.ts';
import { botFromSpec, type FromWorker, type ToWorker } from './protocol.ts';

if (isMainThread || parentPort === null) {
  throw new Error('sim/worker.ts must be run as a worker thread');
}
const port = parentPort;

let runner: StrategyRunner | null = null;
let bots: PlayerBot[] = [];
/** Serializes message handling: `init` is async, `job` must not overtake it. */
let queue: Promise<void> = Promise.resolve();

function send(message: FromWorker): void {
  port.postMessage(message);
}

async function handle(message: ToWorker): Promise<void> {
  switch (message.type) {
    case 'init': {
      const started = performance.now();
      const sandbox = await createSandbox();
      // The monotonic clock, not `performance.now`: a simulated match must produce
      // the same result on every machine and in every worker (spec §6.2, "fixed
      // seed set -> identical results"). With wall clock, one GC pause inside one
      // `decide` is a `timeout`, which the engine records as a violation and an
      // idle tick — and the match diverges from the same match run anywhere else.
      // Measured before this change: 2 phantom violations per 60 matches for a
      // strategy that commits none, and 0.43 / 0.45 vs the panel on back-to-back
      // runs of the same source. The budget still bounds the strategy, in interrupt
      // polls rather than in milliseconds; Gate 4 is where real time is judged.
      runner = sandbox.load(message.source, { now: monotonicClock() });
      bots = message.specs.map(botFromSpec);
      send({ type: 'ready', loadMs: performance.now() - started });
      return;
    }
    case 'job': {
      const bot = bots[message.bot];
      if (runner === null || bot === undefined) {
        send({ type: 'error', message: 'worker received a job before init', index: message.index });
        return;
      }
      send({ type: 'done', index: message.index, result: runMatchWith(runner, bot, message.seed) });
      return;
    }
    case 'stop': {
      dispose();
      port.close();
      return;
    }
  }
}

function dispose(): void {
  runner?.dispose();
  runner = null;
}

port.on('message', (message: ToWorker) => {
  queue = queue.then(
    () =>
      handle(message).catch((err: unknown) => {
        send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      }),
  );
});
