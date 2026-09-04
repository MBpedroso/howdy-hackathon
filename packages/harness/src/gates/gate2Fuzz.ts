/**
 * Gate 2 — contract fuzz.
 *
 * Gate 1 proved the strategy does not *mention* anything forbidden. Gate 2 is
 * the first gate that actually runs it, and it asks three questions that Gate 1
 * cannot (they are halting problems or they depend on values):
 *
 *  1. Does `decide` survive every state the contract permits? Not every state
 *     *this* engine build produces — the whole `BossView` type. A generated
 *     strategy that indexes `history.playerPosHeat` without checking, or divides
 *     by a distance that is zero when the player stands on the boss, fails here
 *     rather than mid-fight in front of the player.
 *  2. Does it return something the validator accepts? A strategy is free to
 *     return `{angle: NaN}` — the engine will coerce the tick to `idle` and count
 *     a violation — but a strategy that does it on 3% of states is broken, and
 *     the *reason* has to say so numerically (spec §6.3).
 *  3. Does it respect cooldowns? Asking for a primitive that is still on
 *     cooldown is legal-but-wasted: the engine coerces it to `idle`. A strategy
 *     that does it on a fifth of all states has not read `view.boss.cooldowns`
 *     at all, which is the single most common failure mode for a first draft, and
 *     it produces a boss that visibly does nothing.
 *
 * Everything is seeded, so a rejection replays exactly: `(states, seed)` is all
 * the Coder agent (or a human) needs to reproduce it.
 */
import {
  CONSTANTS,
  validateAction,
  type BossView,
  type DecideResult,
  type PrimitiveName,
  type RunnerFailure,
  type StrategyRunner,
} from '@rematch/contract';
import { createSandbox, SandboxInitError, SandboxLoadError, type SandboxFactory, type SandboxOptions } from '@rematch/sandbox';

import { describeView, makeFuzzSequence, makeFuzzViews } from '../fuzzViews.ts';
import { gateFail, gateOk, type GateResult } from './types.ts';

export type Gate2Options = {
  /** How many states to fuzz. Default 500. */
  states?: number;
  /** Seed for the state generator. Default `0x5EEDFACE`. Same seed → same states. */
  seed?: number;
  /** Consecutive ticks to run on one runner, to shake out per-tick memory growth. Default 60. */
  sequenceTicks?: number;
  /** Invalid-action rate that fails the gate. Default 0.02 (2%). */
  invalidRateLimit?: number;
  /** On-cooldown-action rate that fails the gate. Default 0.20 (20%). */
  cooldownRateLimit?: number;
  /** Reuse an already-created sandbox (avoids re-instantiating nothing, but keeps DI honest). */
  sandbox?: SandboxFactory;
  /** Passed through to the sandbox — e.g. a fake `now` or a tighter budget. */
  sandboxOptions?: SandboxOptions;
  now?: () => number;
};

const DEFAULTS = {
  states: 500,
  seed: 0x5eedface,
  sequenceTicks: 60,
  invalidRateLimit: 0.02,
  cooldownRateLimit: 0.2,
};

/**
 * One `createSandbox()` per process — instantiating the WASM is the expensive
 * part, and every load after it is synchronous. The memo is dropped if creation
 * fails, so a transient failure does not poison every later gate run.
 */
let sharedSandbox: Promise<SandboxFactory> | undefined;
function getSandbox(): Promise<SandboxFactory> {
  sharedSandbox ??= createSandbox().catch((err: unknown) => {
    sharedSandbox = undefined;
    throw err;
  });
  return sharedSandbox;
}

type FailureKind = RunnerFailure['kind'];

type FailureBucket = {
  kind: FailureKind;
  count: number;
  /** The message / byte count of the first occurrence — what the reason quotes. */
  detailText: string;
  firstIndex: number;
  firstState: string;
};

type ReasonBucket = { count: number; example: string };

/**
 * Group validator reasons by shape, not by text: `slam.x out of arena bounds:
 * 812.3 not in [0, 800]` and `... 941.7 not in [0, 800]` are one bug, and a
 * reason that listed them separately would bury the count the Coder needs.
 */
function normalizeReason(reason: string): string {
  return reason.replace(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi, 'N');
}

/** `cooldown: burst (37 ticks)` → `burst`. Anything else → undefined. */
function cooldownPrimitive(reason: string): PrimitiveName | undefined {
  const match = /^cooldown: (move|burst|charge|slam|spawn) /.exec(reason);
  return match ? (match[1] as PrimitiveName) : undefined;
}

function bump(map: Map<string, ReasonBucket>, key: string, example: string): void {
  const existing = map.get(key);
  if (existing) existing.count += 1;
  else map.set(key, { count: 1, example });
}

function topEntries(map: Map<string, ReasonBucket>, n: number): ReasonBucket[] {
  return [...map.values()].sort((a, b) => b.count - a.count).slice(0, n);
}

/**
 * Merge the fuzz pass and the tick-sequence pass. Both count towards the rates,
 * so both have to count towards the buckets the reason names — otherwise the
 * numbers in one sentence would not add up (`134/560` while the named causes sum
 * to 500), which is exactly the kind of detail that makes a rejection look
 * unreliable to whoever is reading it.
 */
function mergeReasons(...maps: ReadonlyArray<Map<string, ReasonBucket>>): Map<string, ReasonBucket> {
  const out = new Map<string, ReasonBucket>();
  for (const map of maps) {
    for (const [key, bucket] of map) {
      const existing = out.get(key);
      if (existing) existing.count += bucket.count;
      else out.set(key, { ...bucket });
    }
  }
  return out;
}

function mergeCounts<K>(...maps: ReadonlyArray<Map<K, number>>): Map<K, number> {
  const out = new Map<K, number>();
  for (const map of maps) {
    for (const [key, count] of map) out.set(key, (out.get(key) ?? 0) + count);
  }
  return out;
}

function percent(part: number, whole: number): string {
  return `${((part / Math.max(1, whole)) * 100).toFixed(1)}%`;
}

function failureText(failure: RunnerFailure): string {
  switch (failure.kind) {
    case 'timeout':
      return `${failure.ms.toFixed(2)} ms`;
    case 'memory':
      return `${failure.bytes} bytes`;
    default:
      return failure.message;
  }
}

function failureReason(bucket: FailureBucket, states: number, others: FailureBucket[]): string {
  const where = `(first at state ${bucket.firstIndex + 1}: ${bucket.firstState})`;
  const also =
    others.length === 0
      ? ''
      : ` — also ${others.map((o) => `${o.count} ${o.kind}`).join(', ')}`;
  const head = ((): string => {
    switch (bucket.kind) {
      case 'timeout':
        return `decide() exceeded its ${CONSTANTS.limits.decideBudgetMs} ms budget on ${bucket.count}/${states} states (slowest seen: ${bucket.detailText})`;
      case 'memory':
        return `strategy memory grew past the ${CONSTANTS.limits.memoryBytes}-byte limit (${bucket.detailText}) on ${bucket.count}/${states} states`;
      case 'throw':
        return `decide() threw '${bucket.detailText}' on ${bucket.count}/${states} states`;
      case 'load':
        return `the strategy stopped being runnable ('${bucket.detailText}') on ${bucket.count}/${states} states`;
    }
  })();
  return `${head} ${where}${also}`;
}

/** Tally one `decide` result into the running counts. */
type Tally = {
  valid: number;
  invalid: number;
  onCooldown: number;
  failures: Map<FailureKind, FailureBucket>;
  reasons: Map<string, ReasonBucket>;
  cooldowns: Map<PrimitiveName, number>;
  elapsed: number[];
};

function newTally(): Tally {
  return {
    valid: 0,
    invalid: 0,
    onCooldown: 0,
    failures: new Map(),
    reasons: new Map(),
    cooldowns: new Map(),
    elapsed: [],
  };
}

function record(tally: Tally, index: number, view: BossView, result: DecideResult): void {
  tally.elapsed.push(result.elapsedMs);

  if (!result.ok) {
    const kind = result.failure.kind;
    const text = failureText(result.failure);
    const existing = tally.failures.get(kind);
    if (existing) {
      existing.count += 1;
      // For a timeout, keep the worst observation; for the rest the first is the
      // representative one.
      if (kind === 'timeout' && result.failure.kind === 'timeout') {
        const worst = Number.parseFloat(existing.detailText);
        if (result.failure.ms > worst) existing.detailText = text;
      }
    } else {
      tally.failures.set(kind, {
        kind,
        count: 1,
        detailText: text,
        firstIndex: index,
        firstState: describeView(view),
      });
    }
    return;
  }

  const validation = validateAction(result.action, view);
  if (validation.ok) {
    tally.valid += 1;
    return;
  }

  const primitive = cooldownPrimitive(validation.reason);
  if (primitive !== undefined) {
    tally.onCooldown += 1;
    tally.cooldowns.set(primitive, (tally.cooldowns.get(primitive) ?? 0) + 1);
    return;
  }

  tally.invalid += 1;
  bump(tally.reasons, normalizeReason(validation.reason), validation.reason);
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
}

export async function gate2Fuzz(source: string, opts: Gate2Options = {}): Promise<GateResult> {
  const now = opts.now ?? (() => performance.now());
  const states = Math.max(1, Math.trunc(opts.states ?? DEFAULTS.states));
  const seed = opts.seed ?? DEFAULTS.seed;
  const sequenceTicks = Math.max(0, Math.trunc(opts.sequenceTicks ?? DEFAULTS.sequenceTicks));
  const invalidRateLimit = opts.invalidRateLimit ?? DEFAULTS.invalidRateLimit;
  const cooldownRateLimit = opts.cooldownRateLimit ?? DEFAULTS.cooldownRateLimit;

  const started = now();
  const sandbox = opts.sandbox ?? (await getSandbox());
  const elapsed = (): number => now() - started;

  let runner: StrategyRunner;
  try {
    runner = sandbox.load(source, opts.sandboxOptions ?? {});
  } catch (err) {
    // Gate 1 already passed, so this is a *runtime* load problem: a module body
    // that throws, `meta` that is only malformed once evaluated, top-level await.
    const failure = err instanceof SandboxLoadError ? err.failure : undefined;
    return gateFail(2, elapsed(), `the strategy could not be loaded: ${(err as Error).message}`, {
      seed,
      states: 0,
      ...(failure === undefined ? {} : { failure }),
    });
  }

  try {
    try {
      runner.init(seed);
    } catch (err) {
      const failure = err instanceof SandboxInitError ? err.failure : undefined;
      return gateFail(2, elapsed(), `init() failed: ${(err as Error).message}`, {
        seed,
        states: 0,
        ...(failure === undefined ? {} : { failure }),
      });
    }

    const views = makeFuzzViews(states, seed);
    const tally = newTally();
    for (let i = 0; i < views.length; i++) {
      const view = views[i]!;
      record(tally, i, view, runner.decide(view));
    }

    // A second pass over *consecutive* ticks. `makeFuzzViews` jumps around, which
    // cannot catch memory that grows once per tick; 60 ticks in a row can.
    const sequenceTally = newTally();
    let sequenceMemoryBytes = runner.memoryBytes();
    if (sequenceTicks > 0) {
      try {
        runner.init(seed ^ 0x1);
        const sequence = makeFuzzSequence(sequenceTicks, seed);
        for (let i = 0; i < sequence.length; i++) {
          const view = sequence[i]!;
          record(sequenceTally, i, view, runner.decide(view));
        }
        sequenceMemoryBytes = runner.memoryBytes();
      } catch (err) {
        return gateFail(2, elapsed(), `re-init before the tick sequence failed: ${(err as Error).message}`, { seed });
      }
    }

    const allReasons = mergeReasons(tally.reasons, sequenceTally.reasons);
    const allCooldowns = mergeCounts(tally.cooldowns, sequenceTally.cooldowns);
    const sortedElapsed = [...tally.elapsed, ...sequenceTally.elapsed].sort((a, b) => a - b);
    const totalStates = views.length + sequenceTally.elapsed.length;
    // Every field here is a pure function of (source, seed, states) except
    // `elapsedMs`, which is wall clock — the one thing a caller must not compare
    // between runs when checking that a verdict reproduces.
    const detail = {
      seed,
      states: views.length,
      sequence: {
        ticks: sequenceTally.elapsed.length,
        failures: [...sequenceTally.failures.values()].reduce((n, b) => n + b.count, 0),
        memoryBytes: sequenceMemoryBytes,
      },
      valid: tally.valid + sequenceTally.valid,
      invalid: tally.invalid + sequenceTally.invalid,
      onCooldown: tally.onCooldown + sequenceTally.onCooldown,
      failures: Object.fromEntries([...tally.failures, ...sequenceTally.failures].map(([k, b]) => [k, b.count])),
      byReason: Object.fromEntries([...allReasons.values()].map((b) => [b.example, b.count])),
      byPrimitive: Object.fromEntries(allCooldowns),
      // Gate 4 (perf) will reuse exactly this: `DecideResult.elapsedMs` from the
      // sandbox, as a p99 against CONSTANTS.limits.decideBudgetMs. Gate 2 only
      // records it — a slow-but-under-budget strategy passes here by design.
      elapsedMs: {
        samples: sortedElapsed.length,
        p50: quantile(sortedElapsed, 0.5),
        p99: quantile(sortedElapsed, 0.99),
        max: sortedElapsed[sortedElapsed.length - 1] ?? 0,
      },
    };

    // 1. Any runner failure at all is a rejection: a boss that throws on 1 state
    //    in 500 throws six times a match.
    const allFailures = [...tally.failures.values(), ...sequenceTally.failures.values()];
    if (allFailures.length > 0) {
      const merged = new Map<FailureKind, FailureBucket>();
      for (const bucket of allFailures) {
        const existing = merged.get(bucket.kind);
        if (existing) existing.count += bucket.count;
        else merged.set(bucket.kind, { ...bucket });
      }
      const ranked = [...merged.values()].sort((a, b) => b.count - a.count);
      const worst = ranked[0]!;
      return gateFail(2, elapsed(), failureReason(worst, totalStates, ranked.slice(1)), detail);
    }

    // 2. Invalid actions, grouped so the reason names the actual bug.
    const invalid = tally.invalid + sequenceTally.invalid;
    const invalidRate = invalid / totalStates;
    if (invalidRate > invalidRateLimit) {
      const top = topEntries(allReasons, 2);
      const worst = top[0];
      const second = top[1];
      const reason =
        `returned an invalid action on ${percent(invalid, totalStates)} of states (${invalid}/${totalStates}, limit ${percent(invalidRateLimit, 1)}); ` +
        `most common: ${worst?.example ?? 'unknown'} (${worst?.count ?? invalid} states)` +
        (second ? `, then ${second.example} (${second.count} states)` : '');
      return gateFail(2, elapsed(), reason, detail);
    }

    // 3. Cooldown discipline. Legal, but a boss that idles a fifth of the time
    //    looks broken to the player, so it is a rejection with a specific fix.
    const onCooldown = tally.onCooldown + sequenceTally.onCooldown;
    const cooldownRate = onCooldown / totalStates;
    if (cooldownRate > cooldownRateLimit) {
      const ranked = [...allCooldowns.entries()].sort((a, b) => b[1] - a[1]);
      const named = ranked
        .slice(0, 2)
        .map(([primitive, count]) => `${primitive} (${count} states)`)
        .join(', ');
      const reason =
        `asked for a primitive that was still on cooldown on ${percent(onCooldown, totalStates)} of states ` +
        `(${onCooldown}/${totalStates}, limit ${percent(cooldownRateLimit, 1)}): ${named} — ` +
        `check view.boss.cooldowns[name] === 0 before returning that action`;
      return gateFail(2, elapsed(), reason, detail);
    }

    return gateOk(2, elapsed(), detail);
  } finally {
    runner.dispose();
  }
}
