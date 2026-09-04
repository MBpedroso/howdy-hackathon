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
   * Which gates to run, in ascending order. Default `[1, 2]` — Gates 3 and 4 are
   * stubs until the engine and the reference bots land, and defaulting to all
   * four would mean every strategy is "rejected: not implemented".
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

export const DEFAULT_GATES: readonly GateNumber[] = [1, 2];

function normalizeGates(requested: readonly GateNumber[] | undefined): GateNumber[] {
  const set = new Set(requested ?? DEFAULT_GATES);
  return GATE_NUMBERS.filter((n) => set.has(n));
}

/**
 * Run the requested gates in order, stopping at the first rejection.
 *
 * Async because Gate 2 has to bring up a QuickJS runtime. Gates 1, 3 and 4 are
 * synchronous and are simply awaited in place.
 */
export async function runGates(source: string, opts: RunGatesOptions = {}): Promise<RunGatesResult> {
  const gates = normalizeGates(opts.gates);
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
