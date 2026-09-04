/**
 * The balance simulator: N matches of one strategy against a set of bots, spread
 * across worker threads.
 *
 * ## Why workers
 * The sandbox costs 16–43 µs per `decide` depending on how much is in the
 * `BossView` (`pnpm --filter @rematch/sandbox bench`), so the 200 matches spec §6.2
 * asks for are 12–31 s of sandbox time alone on one thread — and the interlude's
 * whole budget is 45 s (spec AC 5). Each worker owns one sandbox and one loaded
 * strategy, and pays the ~100 ms load once for all of its matches.
 *
 * ## Why the result cannot depend on the worker count
 * Three rules, all tested (`test/sim.test.ts` compares 1 worker against 4):
 *  1. The job list is built up front from `(bots x seeds)` in a fixed order.
 *  2. A result is stored at its job's index, never appended on arrival.
 *  3. The reduction walks that array in order, so even the floating-point
 *     summation order is fixed.
 * Scheduling therefore affects only *when* a match runs, never the verdict.
 *
 * ## Why progress is batched
 * `onProgress` is the one thing here that *does* depend on scheduling: it reports
 * how many results have arrived, and results arrive in whatever order the pool
 * finishes them. That is deliberate and it is safe — the callback cannot reach
 * `out[]`, the reduction or the verdict, so `test/sim.test.ts`' worker-count
 * invariance still holds byte-for-byte and only the *cadence* of the callback
 * differs between 1 worker and 4.
 *
 * It fires in batches (`progressBatch`) rather than per match because the consumer
 * is an SSE frame on the other end of the interlude: 200 frames for a 4-second gate
 * is noise on the wire and a re-layout per match in the browser, while ~20 is a
 * meter that visibly moves. The final callback always lands on `(total, total)`,
 * so a UI can trust the last one to close the bar.
 */
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import type { SandboxFactory } from '@rematch/sandbox';
import { getSandbox, runMatchWith, type MatchResult } from './runMatch.ts';
import { botFromSpec, type BotSpec, type FromWorker, type ToWorker } from './protocol.ts';

export type SimulateOptions = {
  /** `strategy.js` source. Loaded once per worker. */
  source: string;
  /** Which opponents to play, in a fixed order. */
  bots: readonly BotSpec[];
  /** Match seeds. Every bot plays every seed, so `matches = bots x seeds`. */
  seeds: readonly number[];
  /** Threads to use. Default `availableParallelism() - 1`, min 1. 1 = inline. */
  workers?: number;
  /** Inline path only: reuse an existing sandbox instead of the process-wide one. */
  sandbox?: SandboxFactory;
  /**
   * Called as match results arrive, in batches of `progressBatch(total)`, and once
   * more at `(total, total)` when the last one lands. Never called with a `done`
   * that goes backwards. Purely observational: it cannot affect the result.
   */
  onProgress?: (done: number, total: number) => void;
};

export type BotRate = {
  name: string;
  matches: number;
  bossWins: number;
  /** `bossWins / matches` — the number spec §6.2's assertions are about. */
  winRate: number;
  avgTicks: number;
  avgBossHpLeft: number;
  avgPlayerHpLeft: number;
};

export type SimulateResult = {
  matches: number;
  bossWins: number;
  winRate: number;
  /** One entry per bot, in the order they were requested. */
  perBot: BotRate[];
  /** Contract violations summed over every match. */
  violations: number;
  /** Matches in which the sandbox killed the strategy (timeout / memory). */
  killed: number;
  /** Wall-clock time, milliseconds. Not part of the verdict. */
  ms: number;
  workers: number;
};

type Job = { index: number; bot: number; seed: number };

/** Threads to use: leave one core for the main thread, and never exceed the work. */
export function resolveWorkers(requested: number | undefined, jobs: number): number {
  const wanted = requested === undefined ? availableParallelism() - 1 : Math.trunc(requested);
  return Math.max(1, Math.min(wanted, Math.max(1, jobs)));
}

/** Never more than one callback per this many matches. */
export const PROGRESS_MAX_BATCH = 20;
/** ~20 callbacks per simulation, floor 1, cap `PROGRESS_MAX_BATCH`. */
export function progressBatch(total: number): number {
  return Math.max(1, Math.min(PROGRESS_MAX_BATCH, Math.ceil(total / 20)));
}

type Reporter = { tick(done: number): void; finish(): void };

/** Batches `onProgress`, and guarantees exactly one final `(total, total)` call. */
function reporter(total: number, onProgress?: (done: number, total: number) => void): Reporter {
  if (onProgress === undefined) return { tick: (): void => {}, finish: (): void => {} };
  const batch = progressBatch(total);
  let last = 0;
  return {
    tick(done: number): void {
      if (done - last < batch || done >= total) return;
      last = done;
      onProgress(done, total);
    },
    finish(): void {
      if (last >= total) return;
      last = total;
      onProgress(total, total);
    },
  };
}

function buildJobs(bots: number, seeds: readonly number[]): Job[] {
  const jobs: Job[] = [];
  for (let bot = 0; bot < bots; bot += 1) {
    for (const seed of seeds) jobs.push({ index: jobs.length, bot, seed });
  }
  return jobs;
}

export async function simulate(opts: SimulateOptions): Promise<SimulateResult> {
  const started = performance.now();
  const jobs = buildJobs(opts.bots.length, opts.seeds);
  const workers = resolveWorkers(opts.workers, jobs.length);
  if (jobs.length === 0) {
    return { matches: 0, bossWins: 0, winRate: 0, perBot: [], violations: 0, killed: 0, ms: 0, workers };
  }

  const progress = reporter(jobs.length, opts.onProgress);
  const results =
    workers === 1
      ? await runInline(opts, jobs, progress)
      : await runInWorkers(opts, jobs, workers, progress);
  // Only once every result is in: a consumer must be able to read the closing
  // callback as "the matches are done", not as "the last batch is done".
  progress.finish();

  return reduce(opts, jobs, results, performance.now() - started, workers);
}

/** One sandbox, one thread, jobs in order. The reference implementation. */
async function runInline(
  opts: SimulateOptions,
  jobs: readonly Job[],
  progress: Reporter,
): Promise<MatchResult[]> {
  const sandbox = opts.sandbox ?? (await getSandbox());
  const bots = opts.bots.map(botFromSpec);
  const runner = sandbox.load(opts.source);
  try {
    const out: MatchResult[] = new Array<MatchResult>(jobs.length);
    let done = 0;
    for (const job of jobs) {
      const bot = bots[job.bot];
      if (bot === undefined) throw new Error(`no bot at index ${job.bot}`);
      out[job.index] = runMatchWith(runner, bot, job.seed);
      done += 1;
      progress.tick(done);
    }
    return out;
  } finally {
    runner.dispose();
  }
}

/**
 * A pool of `workers` threads, each owning one sandbox. Jobs are handed out one at
 * a time and a worker gets the next one as soon as it reports back, so a slow match
 * (a strategy that survives all 3600 ticks) cannot stall a whole pre-assigned
 * block. Results land at their job index, so scheduling does not reach the verdict.
 */
async function runInWorkers(
  opts: SimulateOptions,
  jobs: readonly Job[],
  workers: number,
  progress: Reporter,
): Promise<MatchResult[]> {
  const specs = [...opts.bots];
  const out = new Array<MatchResult | undefined>(jobs.length);
  const pool: Worker[] = [];
  let next = 0;
  let done = 0;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };

    const dispatch = (worker: Worker): void => {
      if (next >= jobs.length) {
        worker.postMessage({ type: 'stop' } satisfies ToWorker);
        return;
      }
      const job = jobs[next];
      next += 1;
      if (job === undefined) return;
      worker.postMessage({ type: 'job', index: job.index, bot: job.bot, seed: job.seed } satisfies ToWorker);
    };

    for (let i = 0; i < workers; i += 1) {
      const worker = new Worker(new URL('./worker.ts', import.meta.url));
      pool.push(worker);
      worker.on('message', (message: FromWorker) => {
        switch (message.type) {
          case 'ready':
            dispatch(worker);
            return;
          case 'done':
            out[message.index] = message.result;
            done += 1;
            // Reported from the arrival order, which is the only thing in this
            // file that depends on the schedule — and it reaches nothing but the
            // caller's meter.
            progress.tick(done);
            if (done === jobs.length) finish();
            else dispatch(worker);
            return;
          case 'error':
            finish(new Error(`simulation worker failed: ${message.message}`));
            return;
        }
      });
      worker.on('error', (err: Error) => finish(err));
      worker.on('exit', (code: number) => {
        // A worker that exits before the work is done means results are missing.
        if (code !== 0 && done < jobs.length) finish(new Error(`simulation worker exited with code ${code}`));
      });
      worker.postMessage({ type: 'init', source: opts.source, specs } satisfies ToWorker);
    }
  }).finally(() => {
    for (const worker of pool) void worker.terminate();
  });

  const complete: MatchResult[] = [];
  for (let i = 0; i < out.length; i += 1) {
    const result = out[i];
    if (result === undefined) throw new Error(`simulation lost the result for match ${i}`);
    complete.push(result);
  }
  return complete;
}

/** Fixed-order reduction: the same numbers on any machine, at any worker count. */
function reduce(
  opts: SimulateOptions,
  jobs: readonly Job[],
  results: readonly MatchResult[],
  ms: number,
  workers: number,
): SimulateResult {
  const acc = opts.bots.map((spec) => ({
    name: botFromSpec(spec).name,
    matches: 0,
    bossWins: 0,
    ticks: 0,
    bossHp: 0,
    playerHp: 0,
  }));
  let bossWins = 0;
  let violations = 0;
  let killed = 0;

  for (let i = 0; i < jobs.length; i += 1) {
    const job = jobs[i]!;
    const result = results[i]!;
    const bucket = acc[job.bot]!;
    bucket.matches += 1;
    bucket.ticks += result.ticks;
    bucket.bossHp += result.bossHpLeft;
    bucket.playerHp += result.playerHpLeft;
    if (result.bossWon) {
      bucket.bossWins += 1;
      bossWins += 1;
    }
    violations += result.violations;
    if (result.strategyKilled) killed += 1;
  }

  const perBot: BotRate[] = acc.map((b) => ({
    name: b.name,
    matches: b.matches,
    bossWins: b.bossWins,
    winRate: b.matches === 0 ? 0 : b.bossWins / b.matches,
    avgTicks: b.matches === 0 ? 0 : b.ticks / b.matches,
    avgBossHpLeft: b.matches === 0 ? 0 : b.bossHp / b.matches,
    avgPlayerHpLeft: b.matches === 0 ? 0 : b.playerHp / b.matches,
  }));

  return {
    matches: jobs.length,
    bossWins,
    winRate: jobs.length === 0 ? 0 : bossWins / jobs.length,
    perBot,
    violations,
    killed,
    ms,
    workers,
  };
}
