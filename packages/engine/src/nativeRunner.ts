/**
 * `nativeRunner` — a `StrategyRunner` that calls a strategy module in-process.
 *
 * **For tests, benchmarks and reference bots only.** It is not a sandbox: the module
 * runs with full host access. The shipping runner is QuickJS (`@rematch/sandbox`), which
 * is what the game and the harness use; this one exists so the engine's own tests can run
 * the reference strategies without pulling in WebAssembly.
 *
 * It matches the sandbox's *observable contract*, not its isolation:
 *  - `decide` never throws — a throwing strategy becomes `{ kind: 'throw' }`,
 *  - the 4 KB serialized memory cap is enforced (`{ kind: 'memory' }`),
 *  - a `decide` call over budget becomes `{ kind: 'timeout' }`.
 *
 * ## Determinism
 * Timing comes from an injectable `now()`. The default is a **monotonic counter**, not a
 * clock, advancing a fixed 1/128 ms per call — so `elapsedMs` is identical on every run
 * and on every machine, and tests never flake on a slow CI box. The step is a power of
 * two so the subtraction is exact in binary floating point: every `elapsedMs` is bit-for-
 * bit `0.0078125`, not `0.010000000000000002`. Pass `now: () => performance
 * .now()` to measure real time (that is what Gate 4 does), and `now` plus
 * `decideBudgetMs` to force a timeout on purpose.
 *
 * It does **not** inject the sandbox's seeded `rand()` global — that would mean writing to
 * `globalThis`, and the engine touches no globals. Strategies exercised through this
 * runner must not call `rand()`.
 */
import { CONSTANTS, type BossView, type DecideResult, type Memory, type RunnerFailure, type StrategyMeta, type StrategyModule, type StrategyRunner } from '@rematch/contract';

/** Fixed step of the default deterministic clock, in milliseconds. 1/128: a power of two,
 *  so accumulating it and subtracting is exact in binary floating point. */
export const DETERMINISTIC_TICK_MS = 1 / 128;

export type NativeRunnerOptions = {
  /** Millisecond source. Default: a deterministic monotonic counter (see above). */
  now?: () => number;
  /** Per-call budget. Default `CONSTANTS.limits.decideBudgetMs` (2 ms). */
  decideBudgetMs?: number;
  /** Serialized memory ceiling. Default `CONSTANTS.limits.memoryBytes` (4 KB). */
  memoryBytes?: number;
};

/** UTF-8 byte length, computed without `TextEncoder` so this stays host-free. */
export function utf8Length(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      // Surrogate pair -> one 4-byte code point.
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

function deterministicClock(): () => number {
  let t = 0;
  return () => {
    t += DETERMINISTIC_TICK_MS;
    return t;
  };
}

const FALLBACK_META: StrategyMeta = { name: 'unnamed', rationale: '', version: 0 };

function readMeta(module: StrategyModule): StrategyMeta {
  const m: unknown = module.meta;
  if (typeof m !== 'object' || m === null) return FALLBACK_META;
  const raw = m as Partial<StrategyMeta>;
  return {
    name: typeof raw.name === 'string' ? raw.name : FALLBACK_META.name,
    rationale: typeof raw.rationale === 'string' ? raw.rationale : FALLBACK_META.rationale,
    version: typeof raw.version === 'number' && Number.isFinite(raw.version) ? raw.version : FALLBACK_META.version,
  };
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return 'unprintable throw';
  }
}

export function nativeRunner(module: StrategyModule, options: NativeRunnerOptions = {}): StrategyRunner {
  const now = options.now ?? deterministicClock();
  const budgetMs = options.decideBudgetMs ?? CONSTANTS.limits.decideBudgetMs;
  const memoryCap = options.memoryBytes ?? CONSTANTS.limits.memoryBytes;
  const meta = readMeta(module);

  let mem: Memory = {};
  let bytes = 2; // "{}"
  let stuck: RunnerFailure | null = { kind: 'load', message: 'init() has not been called' };

  function measure(): number {
    try {
      return utf8Length(JSON.stringify(mem) ?? 'undefined');
    } catch {
      return -1;
    }
  }

  return {
    meta,

    init(_seed: number): void {
      stuck = null;
      mem = {};
      try {
        const created: unknown = module.init();
        if (typeof created !== 'object' || created === null || Array.isArray(created)) {
          stuck = { kind: 'load', message: 'init() must return a plain object' };
          return;
        }
        mem = created as Memory;
      } catch (err) {
        stuck = { kind: 'load', message: `init() threw: ${errMessage(err)}` };
        return;
      }
      bytes = measure();
      if (bytes < 0) {
        stuck = { kind: 'load', message: 'init() result is not JSON-serializable' };
      } else if (bytes > memoryCap) {
        stuck = { kind: 'memory', bytes };
      }
    },

    decide(view: BossView): DecideResult {
      if (stuck !== null) return { ok: false, failure: stuck, elapsedMs: 0 };

      const t0 = now();
      let action: unknown;
      try {
        action = module.decide(view, mem);
      } catch (err) {
        const elapsedMs = now() - t0;
        return { ok: false, failure: { kind: 'throw', message: errMessage(err) }, elapsedMs };
      }
      const elapsedMs = now() - t0;

      if (elapsedMs > budgetMs) {
        return { ok: false, failure: { kind: 'timeout', ms: elapsedMs }, elapsedMs };
      }

      bytes = measure();
      if (bytes < 0) {
        return { ok: false, failure: { kind: 'throw', message: 'memory is not JSON-serializable' }, elapsedMs };
      }
      if (bytes > memoryCap) {
        return { ok: false, failure: { kind: 'memory', bytes }, elapsedMs };
      }

      return { ok: true, action, elapsedMs };
    },

    memoryBytes(): number {
      return bytes;
    },

    dispose(): void {
      mem = {};
      bytes = 2;
      stuck = { kind: 'load', message: 'runner disposed' };
    },
  };
}
