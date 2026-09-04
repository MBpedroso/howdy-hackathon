/**
 * Reconstruct a per-event timeline for a recorded eval run.
 *
 * ## Why this file has to exist at all
 *
 * `pnpm eval:agents` writes every event of every run to
 * `artifacts/agents/eval-<ts>.json`, and those event logs are the raw material for the
 * recorded demo mode. But the eval **does not record a timestamp per event**:
 * `runOne` in `packages/agents/src/eval.ts` collects the stream with
 * `(event) => void events.push(event)` and nothing more, so the artifact holds the
 * events in order and no clock. (Checked against the artifacts, not assumed: the union
 * of every key on every event of every run contains no time field.)
 *
 * A replay therefore has to derive its own cadence. Inventing one would make the
 * recorded mode a second mock, which is the one thing it must not be — so the cadence
 * is derived from the durations the artifact *does* measure:
 *
 * | Anchor | Measured field |
 * |---|---|
 * | the Analyst's whole beat | `analysis.done.ms` |
 * | each candidate file's Coder call | `result.attempts[a].candidates[c].coder.ms` |
 * | every gate, individually | `trial.gate.gate.ms` |
 * | the run as a whole | `EvalRun.ms` |
 *
 * Those become **pins**: events whose offset is a real measurement. Everything between
 * two pins — the `analysis.delta` chunks, the `rewrite.delta` chunks, the
 * `trial.progress` batches — is spread linearly between them. So the shape of the
 * playback is measured (the Analyst really took ~3 s, Gate 3 really took ~0.9 s per
 * candidate, the Coder really took ~7 s) while the spacing *within* one phase is
 * interpolated, because that is the part the artifact does not know.
 *
 * Finally every offset is scaled so the last one lands exactly on `EvalRun.ms`. The
 * recorded interlude therefore takes precisely as long as the real run took, which is
 * the number the demo actually claims.
 *
 * This is stated on screen (`RECORDED RUN · <model> · <date>`), in the recorded JSON
 * (`timing.method`), and in `packages/web/README.md`. A viewer who wants to know how
 * honest the timing is should not have to read this file to find out — but if they do,
 * this is the answer.
 */
import type { RewriteEvent } from '../src/interlude/events.ts';

/** Just enough of `AttemptLog` to read the Coder's measured cost per candidate. */
type CoderCost = { ms?: number };
type AttemptShape = {
  coder?: CoderCost;
  candidates?: Array<{ candidate?: number; coder?: CoderCost }>;
};

export type TimelineInput = {
  events: readonly RewriteEvent[];
  /** `EvalRun.ms` — the run's real wall clock. The timeline is scaled onto it. */
  runMs: number;
  /** `EvalRun.result.attempts`, for the per-candidate Coder durations. */
  attempts?: readonly AttemptShape[];
};

export type Timeline = {
  /** One offset per event, milliseconds from the first event. Monotonic. */
  at: number[];
  /** How many offsets came from a measurement rather than interpolation. */
  pinned: number;
  /** `at.at(-1)` — equal to `runMs` for a non-empty run. */
  totalMs: number;
};

/** `coder.ms` for one candidate of one attempt, when the log recorded it. */
function coderMs(attempt: AttemptShape | undefined, candidate: number | undefined): number | undefined {
  if (attempt === undefined) return undefined;
  if (candidate === undefined) return attempt.coder?.ms;
  const found = attempt.candidates?.find((c) => c.candidate === candidate);
  return found?.coder?.ms ?? attempt.coder?.ms;
}

/**
 * Offsets for every event, in stream order.
 *
 * The walk maintains a cursor in milliseconds and pins an event whenever the artifact
 * says how long the thing that just finished took. Unpinned events are filled in
 * afterwards by linear interpolation between their bracketing pins, so a phase with
 * 6 000 streamed deltas and one measured duration plays out over that duration.
 */
export function buildTimeline(input: TimelineInput): Timeline {
  const { events, runMs } = input;
  const attempts = input.attempts ?? [];
  const at = new Array<number>(events.length).fill(Number.NaN);

  let cursor = 0;
  /** Cursor value when the current attempt's Coder started streaming. */
  const coderBase = new Map<number, number>();

  const pin = (index: number, value: number): void => {
    // Monotonic by construction: a pin never moves the cursor backwards, because a
    // duration is time that has already been spent.
    cursor = Math.max(cursor, value);
    at[index] = cursor;
  };

  events.forEach((event, index) => {
    switch (event.type) {
      case 'replay':
        pin(index, 0);
        break;

      case 'analysis.done':
        // The Analyst's whole beat, measured end to end.
        pin(index, cursor + Math.max(0, event.ms));
        break;

      case 'rewrite.delta':
        // The first Coder byte of an attempt marks where its measured span starts.
        if (!coderBase.has(event.attempt)) coderBase.set(event.attempt, cursor);
        break;

      case 'rewrite.done': {
        if (!coderBase.has(event.attempt)) coderBase.set(event.attempt, cursor);
        const base = coderBase.get(event.attempt) ?? cursor;
        const ms = coderMs(attempts[event.attempt - 1], event.candidate);
        // Candidates stream concurrently and finish in their own order, so each
        // `rewrite.done` is pinned at its own candidate's measured Coder time from the
        // attempt's shared start. With no per-candidate figure the cursor stands.
        pin(index, ms === undefined ? cursor : base + Math.max(0, ms));
        break;
      }

      case 'trial.gate':
        // Candidates are gated one after another — Gate 3 owns the worker pool — so
        // gate durations accumulate rather than overlap.
        pin(index, cursor + Math.max(0, event.gate.ms));
        break;

      case 'done':
        pin(index, Math.max(cursor, runMs));
        break;

      // `analysis.delta`, `trial.progress`, `verdict` and `fallback` carry no duration
      // of their own; they are interpolated into the span they belong to. For
      // `trial.progress` that span ends at its gate's pin, which is exactly right: the
      // meter then advances across the gate's real duration.
      default:
        break;
    }
  });

  // A stream with no pin at all (a truncated log) still has to produce something
  // monotonic, so fall back to spreading it evenly across the run.
  const pinned = at.filter((value) => !Number.isNaN(value)).length;
  if (pinned === 0) {
    const span = Math.max(0, runMs);
    return {
      at: at.map((_, i) => (at.length <= 1 ? 0 : (span * i) / (at.length - 1))),
      pinned: 0,
      totalMs: span,
    };
  }

  // Anchor both ends so the interpolation below always has a bracket.
  if (Number.isNaN(at[0] as number)) at[0] = 0;
  const lastIndex = at.length - 1;
  if (Number.isNaN(at[lastIndex] as number)) {
    at[lastIndex] = Math.max(cursor, runMs);
  }

  // Fill the gaps: every unpinned run of events is spread evenly between the pins on
  // either side of it.
  let left = 0;
  for (let i = 1; i < at.length; i += 1) {
    if (Number.isNaN(at[i] as number)) continue;
    const from = at[left] as number;
    const to = at[i] as number;
    const steps = i - left;
    for (let k = 1; k < steps; k += 1) {
      at[left + k] = from + ((to - from) * k) / steps;
    }
    left = i;
  }

  // Scale so the recorded playback lasts exactly as long as the real run did.
  const reconstructed = at[lastIndex] as number;
  const scale = reconstructed > 0 && runMs > 0 ? runMs / reconstructed : 1;
  const scaled = at.map((value) => Math.round(value * scale * 1000) / 1000);

  return { at: scaled, pinned, totalMs: scaled[lastIndex] ?? 0 };
}
