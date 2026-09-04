/**
 * The gate runner — the deterministic half of the autonomous loop (spec §6.3).
 *
 * Gates run in order and stop at the first failure. That is not an optimisation,
 * it is the contract: the Coder agent gets **one** reason per attempt, so it
 * fixes one thing at a time and the interlude has one line to show. It also
 * means an expensive gate never runs on code a cheap gate has already rejected —
 * a strategy that mentions `Date` must not boot a QuickJS runtime (spec AC 8),
 * and one that throws on 12% of states must not burn 200 simulated matches.
 *
 * There is no LLM anywhere in this file, and there never will be.
 */
import { gate1Static, type Gate1Options } from './gates/gate1Static.ts';
import { gate2Fuzz, type Gate2Options } from './gates/gate2Fuzz.ts';
import { gate3Balance, type Gate3Options } from './gates/gate3Balance.ts';
import { gate4Perf, type Gate4Options } from './gates/gate4Perf.ts';
import { GATE_NUMBERS, type GateNumber, type GateResult } from './gates/types.ts';

export type RunGatesOptions = {
  /**
   * Which gates to run, in ascending order.
   *
   * Default: `[1, 2, 3, 4]` when `gate3.round` is set, `[1, 2]` otherwise. The
   * round is what makes the balance gates *meaningful* — Gate 3 asserts a
   * per-round fairness band and Gate 4 costs a couple of seconds of simulation —
   * so asking for a round is how a caller says "run the expensive gates too".
   * The rewrite loop always passes a round; a quick `pnpm harness file.js` does
   * not, and gets the two cheap gates.
   */
  gates?: readonly GateNumber[];
  gate1?: Gate1Options;
  gate2?: Gate2Options;
  gate3?: Gate3Options;
  gate4?: Gate4Options;
};

export type RunGatesResult = {
  /** True only if every requested gate passed. */
  approved: boolean;
  /** One entry per gate that ran, in order. */
  results: GateResult[];
  /** The gate that rejected, when one did. */
  stoppedAt?: GateNumber;
};

/** The cheap gates: static + fuzz. No simulation, no engine, milliseconds. */
export const DEFAULT_GATES: readonly GateNumber[] = [1, 2];
/** Every gate, in order. What the rewrite loop runs (spec §6.3). */
export const ALL_GATES: readonly GateNumber[] = [1, 2, 3, 4];

/** The gate list a call implies: see `RunGatesOptions.gates`. */
export function gatesFor(opts: RunGatesOptions): readonly GateNumber[] {
  if (opts.gates !== undefined) return opts.gates;
  return opts.gate3?.round === undefined ? DEFAULT_GATES : ALL_GATES;
}

function normalizeGates(requested: readonly GateNumber[]): GateNumber[] {
  const set = new Set(requested);
  return GATE_NUMBERS.filter((n) => set.has(n));
}

/**
 * Run the requested gates in order, stopping at the first rejection.
 *
 * Async because Gates 2, 3 and 4 bring up QuickJS runtimes (and Gate 3 a worker
 * pool). Gate 1 is synchronous and is simply awaited in place.
 */
export async function runGates(source: string, opts: RunGatesOptions = {}): Promise<RunGatesResult> {
  const gates = normalizeGates(gatesFor(opts));
  const results: GateResult[] = [];

  for (const gate of gates) {
    const result = await runOne(gate, source, opts);
    results.push(result);
    if (!result.ok) return { approved: false, results, stoppedAt: gate };
  }

  return { approved: true, results };
}

async function runOne(gate: GateNumber, source: string, opts: RunGatesOptions): Promise<GateResult> {
  switch (gate) {
    case 1:
      return gate1Static(source, opts.gate1 ?? {});
    case 2:
      return gate2Fuzz(source, opts.gate2 ?? {});
    case 3:
      return gate3Balance(source, opts.gate3 ?? {});
    case 4:
      return gate4Perf(source, opts.gate4 ?? {});
  }
}
