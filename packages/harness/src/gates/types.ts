/**
 * The four gates' shared result shape (spec §6.3).
 *
 * The whole design rests on one property: `reason` is fed **verbatim** to the
 * Coder agent as the next attempt's only feedback, and shown verbatim to the
 * player during the interlude. So it is a single sentence, quantitative wherever
 * a number exists, and it names the fix rather than the symptom:
 *
 *   ✗ "returned an invalid action on 3.0% of states (15/500); the most common
 *      problem was burst.angle must be a finite number, got NaN (12x)"
 *   ✗ "decide() threw 'heat is not defined' on 12/500 states (first: tick 371,
 *      player dashing, 4 projectiles)"
 *   ✗ "0.91 win rate vs the panel — too hard; band for round 3 is 0.45-0.60"
 *
 * `detail` carries the machine-readable counts behind the sentence: logged,
 * streamed to the interlude, and asserted on in tests. Nothing reads `reason` to
 * make a decision — that is what `gate` and `ok` are for.
 */

export type GateNumber = 1 | 2 | 3 | 4;
export type GateName = 'static' | 'fuzz' | 'balance' | 'perf';

export type GateOk = {
  gate: GateNumber;
  name: GateName;
  ok: true;
  /** Wall-clock time the gate took, milliseconds. */
  ms: number;
  detail?: unknown;
};

export type GateFail = {
  gate: GateNumber;
  name: GateName;
  ok: false;
  ms: number;
  /** One human- and LLM-readable sentence. Fed back to the Coder agent verbatim. */
  reason: string;
  detail?: unknown;
};

export type GateResult = GateOk | GateFail;

/** Gate number → name. The pairing is fixed by the spec; keep them in one place. */
export const GATE_NAMES = {
  1: 'static',
  2: 'fuzz',
  3: 'balance',
  4: 'perf',
} as const satisfies Record<GateNumber, GateName>;

export const GATE_NUMBERS = [1, 2, 3, 4] as const;

/**
 * Build a result. `detail` is omitted rather than set to `undefined` so the shape
 * matches `exactOptionalPropertyTypes` and serializes cleanly over SSE.
 */
export function gateOk(gate: GateNumber, ms: number, detail?: unknown): GateOk {
  return { gate, name: GATE_NAMES[gate], ok: true, ms, ...(detail === undefined ? {} : { detail }) };
}

export function gateFail(gate: GateNumber, ms: number, reason: string, detail?: unknown): GateFail {
  return {
    gate,
    name: GATE_NAMES[gate],
    ok: false,
    ms,
    reason,
    ...(detail === undefined ? {} : { detail }),
  };
}

/** `✓ Gate 1 static 3ms` / `✗ Gate 2 fuzz — reason`. Used by the CLI and the logs. */
export function formatGateResult(result: GateResult): string {
  const head = `Gate ${result.gate} ${result.name}`;
  return result.ok
    ? `✓ ${head} ${Math.round(result.ms)}ms`
    : `✗ ${head} — ${result.reason}`;
}
