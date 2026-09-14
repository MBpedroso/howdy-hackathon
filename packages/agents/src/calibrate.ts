/**
 * THE THROTTLE — the Judge aims the number, and owns the knob that moves it.
 *
 * The Coder writes a boss with the *shape* of a learned counter and the harness
 * decides whether it is fair. Measured on three live `claude-cli` runs (2026-09-11),
 * the shape was never the problem and the number always was: round 2 wants
 * 0.35–0.50 and six candidates measured 0.56 / 0.00 / 0.84 / 0.57 / 0.65; round 3
 * wants 0.50–0.65 and measured 0.86 / 0.78 / 0.07 / 0.90. Every one of those files
 * countered the player. None of them landed.
 *
 * A human tuning a fallback boss does not rewrite it — they change one cadence
 * constant, re-run Gate 3 and read the number. The header of
 * `packages/server/fallback/round2/metronome.js` is that loop written down:
 * "Minions really are the strongest lever: 700 measures 0.46, 1600 measures 0.36."
 * One Coder call is 20-37 s; one Gate 3 is ~1 s. So the loop belongs on the side of
 * the fence where a second is cheap.
 *
 * ## Why the knob is not the Coder's
 *
 * The first version of this module asked the model for one. `CODER_OUTPUT_RULES`
 * required a `const PRESSURE = 1.0;` wired so that higher was harder, monotonically,
 * and the harness bisected it. It failed live on the first try
 * (`artifacts/server/rewrite-2026-09-11T18-27-02-444Z.json`, round 2): the file
 * scaled its slam and charge odds and its lead by PRESSURE and left `burst`
 * (`count: 8` behind a 50 % roll) and the spawn cadence alone — so the two strongest
 * levers on the panel rate were outside the knob, and the knob measured **1.0 →
 * 0.86, 0.5 → 0.90, 0.25 → 0.84**. Attempt 2 was the same shape (0.56 / 0.59 /
 * 0.54). The non-monotone stop fired correctly both times and the run fell back.
 *
 * The lesson is not that the prompt needed to be firmer. It is that "monotone in
 * difficulty" is a *global* property of a strategy, the model cannot check it, and
 * nothing in the loop can check it either until it has spent three gate passes
 * finding out. So the knob is the harness's own now, and it is injected rather than
 * requested: `withThrottle` wraps the Coder's `decide` and forces a rest between its
 * attacks. That is monotone by construction — fewer attacks per second is strictly
 * less pressure — and it is the same lever a human reaches for first.
 *
 * ## What the throttle may and may not do
 *
 * It only ever makes a boss **weaker**, so the search is downward-only: a candidate
 * over the band is throttled until it lands, and one under the band is still the
 * Coder's problem (it is handed back with the rejection, exactly as before). It does
 * not touch what the boss *reads* — the adaptation the product exists to demonstrate
 * is untouched, the same slam goes to the same cell, it simply goes less often. And
 * it keeps the boss moving while it holds, because ACTIVE would otherwise reject what
 * the throttle just made legal.
 *
 * Two properties are load-bearing:
 *
 * 1. **No model, ever.** Everything here is arithmetic over numbers the sandbox
 *    measured, plus one fixed block of JavaScript. The Judge stays deterministic
 *    (spec §2.2), and a throttled boss ships only by passing the same four gates at
 *    the same thresholds as any other.
 *
 * 2. **The search is a pure function of the measured points.** `nextThrottle` reads
 *    nothing but its arguments — no clock, no randomness, no order of arrival — so
 *    the same panel rates always produce the same sequence of throttle values, and a
 *    run log can be re-derived from its own numbers. The only wall-clock input is
 *    `hasBudget`, which can end the search early but can never change where it was
 *    going.
 */
import type { GateResult } from '@rematch/harness';

/**
 * The legal range of the throttle.
 *
 * `1.0` is the Coder's file untouched — the block short-circuits and returns the raw
 * action, so a throttle of 1 is not a wrapper that happens to do nothing, it is one
 * that measurably cannot. `0.1` is a rest of 405 ticks (6.75 s) between attacks,
 * which is the point past which a boss stops reading as a boss; a file that is still
 * too hard there is too hard for a reason the throttle cannot reach, and the search
 * says so rather than turning it into furniture.
 */
export const THROTTLE_MIN = 0.1;
export const THROTTLE_MAX = 1.0;

/**
 * The rest, in ticks, that a throttle of 0.5 buys.
 *
 * `hold = (1/p - 1) x BASE`, so 1.0 → 0 ticks, 0.5 → 45, 0.25 → 135, 0.1 → 405:
 * strictly decreasing in `p`, unbounded as `p` falls, and zero exactly at 1. 45
 * ticks is three quarters of a second — half of `burst`'s own 90-tick cooldown —
 * chosen so that the first bracket step is a visible change to the boss rather than
 * a rounding error on it.
 */
export const THROTTLE_BASE_TICKS = 45;

/** The rest a throttle buys, in ticks. Exported because the fixture tests assert it. */
export function throttleHoldTicks(throttle: number): number {
  if (throttle >= 1) return 0;
  return Math.round((1 / throttle - 1) * THROTTLE_BASE_TICKS);
}

/**
 * How many times the search may re-measure one candidate.
 *
 * Each step is a full `runTrial` — ~1 s for Gate 3 at 200 matches, ~0.1 s for Gate 4
 * — so six steps cost about a fifth of one Coder call. Six is also more than the
 * geometry needs: 1.0 halves to the floor in four steps, and a bisection after that
 * resolves the interval to under the panel rate's own 0.03 noise floor
 * (`DIST_BUCKET` in `loop.ts`).
 */
export const CALIBRATION_MAX_STEPS = 6;

/**
 * Extra steps allowed after the first measurement that is FAIR but rejected anyway.
 *
 * A file at panel 0.44 that fails ADAPTED or ACTIVE has the rate right and something
 * else wrong, and no rest between its attacks fixes "the boss never read this
 * player" — that is the Coder's retry to make. Two more steps is enough to find out
 * whether a neighbouring throttle happens to satisfy both, and cheap enough that
 * failing to is not a wasted attempt: the fair file is kept as `fairButBlind` either
 * way.
 */
export const FAIR_EXTRA_STEPS = 2;

/**
 * How far the panel rate has to move *against* the throttle before it counts as a
 * wrong way.
 *
 * Each panel bot's rate is near-binary over its 25 matches, so the mean of four moves
 * in steps of roughly 0.25/8 ≈ 0.03 (`harnessRules` derives this, `DIST_BUCKET` uses
 * it). A move smaller than that is the measurement's own resolution and says nothing.
 */
export const MONOTONE_EPSILON = 0.03;

/**
 * Two wrong-way moves is a strategy the throttle cannot weaken; one is a measurement.
 *
 * This is kept from the PRESSURE version even though the harness now owns the knob,
 * because the *response* is still the strategy's: a boss whose damage comes from
 * standing somewhere rather than from firing at something can be throttled without
 * getting easier, and the search has to be able to notice that and stop.
 */
export const MONOTONE_VIOLATIONS = 2;

/** Below the 3-decimal quantum the throttle is written at, so two values are "the same". */
const THROTTLE_EPSILON = 0.0005;

/** Clamped into the legal range and quantized to the 3 decimals the file is written with. */
export function clampThrottle(value: number): number {
  if (!Number.isFinite(value)) return THROTTLE_MAX;
  const clamped = Math.min(THROTTLE_MAX, Math.max(THROTTLE_MIN, value));
  return Math.round(clamped * 1000) / 1000;
}

/** The literal the throttle is written as: `1.0`, `0.5`, `0.354`. */
export function formatThrottle(value: number): string {
  const v = clampThrottle(value);
  return Number.isInteger(v) ? v.toFixed(1) : String(v);
}

// ------------------------------------------------------- reading and injecting

/**
 * `const THROTTLE = 0.5;` — the one line of the injected block that ever changes.
 *
 * Everything else about the block is fixed text, which is what makes re-throttling an
 * already-throttled file a constant substitution rather than a second wrapping. The
 * rest is *derived* from it at module scope (`THROTTLE_HOLD`), so there is exactly one
 * number to keep in sync and no way to leave the file half-retuned.
 */
const THROTTLE_LINE = String.raw`^const THROTTLE = (-?(?:\d+(?:\.\d*)?|\.\d+));`;

/** `export function decide(` / `export function init(`, as the output rules require them. */
const EXPORTED_FN = (name: string): string => String.raw`^export[ \t]+function[ \t]+` + name + String.raw`[ \t]*\(`;

function countMatches(source: string, pattern: string): number {
  const re = new RegExp(pattern, 'gm');
  let count = 0;
  while (re.exec(source) !== null) count += 1;
  return count;
}

/**
 * The throttle a file is already carrying, or `undefined` if it is not throttled.
 *
 * Reads the injected block and nothing else: a `const THROTTLE` the *Coder* happened
 * to write would have to be at column zero and be the only one in the file to be
 * mistaken for the Judge's, and it would then simply be retuned — which is the
 * behaviour wanted anyway.
 */
export function readThrottle(source: string): number | undefined {
  const re = new RegExp(THROTTLE_LINE, 'gm');
  const first = re.exec(source);
  if (first === null) return undefined;
  if (re.exec(source) !== null) return undefined;
  const value = Number(first[1]);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Can this file be throttled at all?
 *
 * It needs exactly one exported `init` and one exported `decide`, written as function
 * declarations — which is what `CODER_OUTPUT_RULES` asks for and what every file in
 * the fallback pool does. Anything else (an arrow assigned to a `const`, two
 * declarations, a file Gate 1 is about to reject) is left alone: the candidate is
 * judged exactly as it was before the throttle existed.
 */
export function canThrottle(source: string): boolean {
  if (readThrottle(source) !== undefined) return true;
  return countMatches(source, EXPORTED_FN('init')) === 1 && countMatches(source, EXPORTED_FN('decide')) === 1;
}

/**
 * The Coder's file, wrapped so that `throttle < 1` forces a rest between its attacks.
 *
 * `undefined` when the file cannot be wrapped (see `canThrottle`). Idempotent: handed
 * an already-throttled source it replaces the one constant, so a six-step search
 * produces six files that differ by one number rather than six nested wrappers.
 *
 * The wrapper is deliberately boring — one branch, no allocation beyond the returned
 * object, no new reads of the view — because it runs inside `decide`'s 2 ms budget and
 * Gate 4 measures the p99 of the *whole* file.
 */
export function withThrottle(source: string, throttle: number): string | undefined {
  const literal = formatThrottle(throttle);
  if (readThrottle(source) !== undefined) {
    return source.replace(new RegExp(THROTTLE_LINE, 'gm'), `const THROTTLE = ${literal};`);
  }
  if (!canThrottle(source)) return undefined;
  const renamed = source
    .replace(new RegExp(EXPORTED_FN('init'), 'm'), 'function __initRaw(')
    .replace(new RegExp(EXPORTED_FN('decide'), 'm'), 'function __decideRaw(');
  return `${renamed.trimEnd()}\n${throttleBlock(literal)}`;
}

/**
 * The block, verbatim. The only thing that varies between two throttled files is
 * `literal`.
 *
 * Everything in here was checked against the contract rather than assumed:
 * `view.tick`, `view.arena.w/h` and `view.boss.x/y` are the real field names
 * (`contract/src/types.ts`); `move` accepts any magnitude and is normalized by the
 * validator, and a zero vector canonicalizes to `idle` rather than to a violation
 * (`contract/src/validate.ts`) — which is why the boxed-in case walks towards the
 * centre rather than returning a zero vector; `isFinite` and `Math.sqrt` are allowed
 * (only `Math.random` is deleted in the sandbox, and `FORBIDDEN_IDENTIFIERS` lists
 * neither); `__initRaw`, `__decideRaw` and `__judgeRest` are not exported, so the
 * module still exports
 * exactly `meta`, `init`, `decide`; and `mem` is the strategy's own object, held
 * inside the runner and mutable across ticks (`sandbox/src/prelude.ts`), so
 * `mem.__judge` persists — guarded anyway, because a raw `init` that returned
 * something odd must cost the candidate a legible gate rejection rather than a throw.
 */
function throttleBlock(literal: string): string {
  return `
// ---- calibrated by the Judge (deterministic; not written by the Coder) ----
// THROTTLE < 1 forces a rest after every attack so the same read of the player
// lands less often. Measured through Gate 3 and bisected until the round's band.
// Nothing above this line changed except the two renames on init/decide.
const THROTTLE = ${literal};
const THROTTLE_BASE_TICKS = ${THROTTLE_BASE_TICKS};
const THROTTLE_HOLD = THROTTLE >= 1 ? 0 : Math.round((1 / THROTTLE - 1) * THROTTLE_BASE_TICKS);

export function init() {
  const raw = __initRaw();
  const mem = raw !== null && typeof raw === 'object' ? raw : {};
  mem.__judge = { holdUntil: 0 };
  return mem;
}

export function decide(view, mem) {
  const action = __decideRaw(view, mem);
  if (THROTTLE >= 1) return action;
  const type = action === null || typeof action !== 'object' ? '' : action.type;
  if (type !== 'burst' && type !== 'slam' && type !== 'charge' && type !== 'spawn') return action;

  let judge = mem === null || typeof mem !== 'object' ? null : mem.__judge;
  if (judge === null || typeof judge !== 'object') {
    judge = { holdUntil: 0 };
    if (mem !== null && typeof mem === 'object') mem.__judge = judge;
  }
  const tick = typeof view.tick === 'number' && isFinite(view.tick) ? view.tick : 0;
  if (tick >= judge.holdUntil) {
    judge.holdUntil = tick + THROTTLE_HOLD;
    return action;
  }
  // Held. Keep moving, or ACTIVE rejects what the throttle just made fair.
  return __judgeRest(view, tick);
}

/**
 * The resting pattern: a fixed square, straight legs, no read of the player.
 *
 * Straight and not a curve, on purpose. Every reference bot leads its shots off the
 * boss's last-tick velocity, so a curve is unhittable by construction and pushes the
 * panel rate *up* — the throttle would then be subtracting attacks and adding
 * survivability, which is exactly the non-monotonicity it exists to avoid. Measured:
 * an orbiting rest took the round 2 fallback from 0.46 to 0.53 at throttle 0.5; this
 * one takes it down.
 */
function __judgeRest(view, tick) {
  const arena = view.arena;
  const hasArena = arena !== null && typeof arena === 'object';
  const aw = hasArena && isFinite(arena.w) && arena.w > 0 ? arena.w : 800;
  const ah = hasArena && isFinite(arena.h) && arena.h > 0 ? arena.h : 800;
  const bx = isFinite(view.boss.x) ? view.boss.x : aw / 2;
  const by = isFinite(view.boss.y) ? view.boss.y : ah / 2;
  const leg = Math.floor(tick / 34) % 4;
  let dx = leg === 0 ? 1 : leg === 2 ? -1 : 0;
  let dy = leg === 1 ? 1 : leg === 3 ? -1 : 0;
  // A move that clamps against the arena edge displaces nothing, which ACTIVE counts
  // as standing still. Turn round before walking into it.
  if (__judgeBlocked(bx + dx * 40, by + dy * 40, aw, ah)) {
    dx = -dx;
    dy = -dy;
  }
  if (__judgeBlocked(bx + dx * 40, by + dy * 40, aw, ah)) {
    const cx = aw / 2 - bx;
    const cy = ah / 2 - by;
    if (Math.sqrt(cx * cx + cy * cy) > 1) return { type: 'move', dx: cx, dy: cy };
    return { type: 'move', dx: 1, dy: 0 };
  }
  return { type: 'move', dx: dx, dy: dy };
}

function __judgeBlocked(x, y, aw, ah) {
  return x < 34 || x > aw - 34 || y < 34 || y > ah - 34;
}
`;
}

// ------------------------------------------------------------------ the search

/** One measured file: the throttle it was measured at, and what the panel said. */
export type ThrottlePoint = {
  /** 1.0 for the Coder's own file. */
  throttle: number;
  /** Gate 3's panel mean. */
  panel: number;
  /** The FULL trial passed here — every gate, at the same thresholds. */
  ok?: boolean;
};

/** Why the search stopped. Every one of these is a reason to hand the file back. */
export type CalibrationStop =
  /** A step passed every gate. The only outcome that ships a throttled file. */
  | 'passed'
  /** The file was not over the band: the throttle only ever makes a boss weaker. */
  | 'not-too-hard'
  /** The panel moved against the throttle twice: this boss does not get easier. */
  | 'non-monotone'
  /** `CALIBRATION_MAX_STEPS` spent. */
  | 'max-steps'
  /** FAIR was reached and `FAIR_EXTRA_STEPS` more did not fix the other assertion. */
  | 'fair-exhausted'
  /** The next value is one already measured, or the `0.1` floor. */
  | 'exhausted'
  /** A step never reached Gate 3, so it produced no number to search on. */
  | 'unmeasured'
  /** The run deadline no longer leaves room for another gate pass. */
  | 'deadline'
  /** Nothing has been measured yet; there is nothing to search from. */
  | 'no-points';

export type CalibrationMove =
  | { kind: 'step'; throttle: number; mode: 'bracket' | 'bisect' }
  | { kind: 'stop'; reason: CalibrationStop };

/**
 * Where to measure next — bracket down, then bisect, in log2 space.
 *
 * Downward only, because that is the only direction the throttle has. The first step
 * is ×0.5 and each one after it halves again until a measurement comes back *under*
 * the band or the `0.1` floor is reached; from there the next point is the
 * *geometric* mean of the too-easy and too-hard bounds, which is the midpoint of the
 * interval in octaves rather than in rate.
 *
 * A FAIR measurement that was rejected anyway is not a bound in the usual sense — its
 * rate is right and something else is wrong — so it becomes the new ceiling and the
 * search keeps descending, which is the "same direction bias" the fair-but-blind case
 * wants expressed as geometry rather than as a special case.
 *
 * Pure: the arguments are the whole input. Same points, same band, same answer.
 */
export function nextThrottle(
  points: readonly ThrottlePoint[],
  band: readonly [number, number],
): CalibrationMove {
  if (points.length === 0) return { kind: 'stop', reason: 'no-points' };
  if (points.some((p) => p.ok === true)) return { kind: 'stop', reason: 'passed' };
  const lo = band[0];
  const hi = band[1];

  // The throttle subtracts pressure and cannot add any, so a file that is not over
  // the band is not a file it can help. Too easy goes back to the Coder.
  const first = points[0] as ThrottlePoint;
  if (first.panel <= hi) return { kind: 'stop', reason: 'not-too-hard' };

  // Less throttle should never mean a *harder* boss. Two measurements that say
  // otherwise describe a boss whose pressure does not come from its attacks, and no
  // amount of resting between them will bring it into the band.
  let wrongWay = 0;
  for (let i = 1; i < points.length; i += 1) {
    const previous = points[i - 1] as ThrottlePoint;
    const current = points[i] as ThrottlePoint;
    const dThrottle = current.throttle - previous.throttle;
    const dPanel = current.panel - previous.panel;
    if (dThrottle === 0) continue;
    if (Math.abs(dPanel) <= MONOTONE_EPSILON) continue;
    if (Math.sign(dThrottle) !== Math.sign(dPanel)) wrongWay += 1;
  }
  if (wrongWay >= MONOTONE_VIOLATIONS) return { kind: 'stop', reason: 'non-monotone' };

  // `points[0]` is the Coder's own file, which was not a calibration step.
  if (points.length - 1 >= CALIBRATION_MAX_STEPS) return { kind: 'stop', reason: 'max-steps' };

  const firstFair = points.findIndex((p) => p.panel >= lo && p.panel <= hi);
  if (firstFair >= 0 && points.length - 1 - firstFair >= FAIR_EXTRA_STEPS) {
    return { kind: 'stop', reason: 'fair-exhausted' };
  }

  /** The highest throttle known too easy, and the lowest known too hard. */
  let easy: number | undefined;
  let hard: number | undefined;
  for (const point of points) {
    if (point.panel < lo) easy = easy === undefined ? point.throttle : Math.max(easy, point.throttle);
    // Too hard, or FAIR and rejected for something else: either way a ceiling, since
    // the search only ever descends.
    else hard = hard === undefined ? point.throttle : Math.min(hard, point.throttle);
  }

  let raw: number;
  let mode: 'bracket' | 'bisect';
  if (easy !== undefined && hard !== undefined) {
    // A too-easy throttle at or above a too-hard one is the inverted case of the same
    // failure the wrong-way counter catches: the response is not usable.
    if (easy >= hard) return { kind: 'stop', reason: 'non-monotone' };
    raw = Math.sqrt(easy * hard);
    mode = 'bisect';
  } else if (hard !== undefined) {
    raw = hard * 0.5;
    mode = 'bracket';
  } else {
    // Unreachable: `first.panel > hi` put a ceiling in the set above.
    return { kind: 'stop', reason: 'exhausted' };
  }

  const throttle = clampThrottle(raw);
  // Clamped onto a point already measured: the floor is reached and the interval is
  // narrower than the number the file is written with.
  if (points.some((p) => Math.abs(p.throttle - throttle) < THROTTLE_EPSILON)) {
    return { kind: 'stop', reason: 'exhausted' };
  }
  return { kind: 'step', throttle, mode };
}

// ------------------------------------------------------------------ the driver

/** What one gate pass over a throttled file produced. */
export type CalibrationMeasurement = {
  /** Every gate that ran, in order — the same four, at the same thresholds. */
  gates: GateResult[];
  /** All four gates passed. */
  ok: boolean;
  /** The rejecting gate's `reason`, verbatim. */
  reason?: string;
  /** Gate 3's panel mean, when it measured one. */
  panel?: number;
  /** Gate 3's Mimic rate, when it measured one. */
  mimic?: number;
};

export type CalibrationStepLog = CalibrationMeasurement & {
  /** 1-based. */
  step: number;
  /** The throttle this step measured. Carried on the events as `pressure`. */
  throttle: number;
  /** The Coder's file, wrapped. Nothing but the one constant differs between steps. */
  source: string;
};

export type CalibrationRun = {
  /** Always 1.0 — the Coder's file, unthrottled, as the loop already measured it. */
  from: number;
  /** The throttle the candidate ended at: the approved step's, or the last one tried. */
  to: number;
  steps: CalibrationStepLog[];
  stop: CalibrationStop;
  /** The step that passed every gate, if one did. This is the file that ships. */
  approved?: CalibrationStepLog;
};

export type CalibrateInput = {
  /** The Coder's file, exactly as it was judged. */
  source: string;
  /** The round's fairness band, read out of Gate 3's own `detail`. */
  band: readonly [number, number];
  /** What the Coder's file measured against the panel. Must be above the band. */
  panel: number;
  /** One full gate pass over a throttled file. */
  measure: (source: string, throttle: number, step: number) => Promise<CalibrationMeasurement>;
  /** Is there wall clock left for another gate pass? The only clock in here. */
  hasBudget: () => boolean;
  /** Called as each step lands, so the loop can emit it while the search runs. */
  onStep?: (step: CalibrationStepLog) => void;
};

/**
 * Bracket down, then bisect, until a step passes every gate or the search runs out.
 *
 * `undefined` — and nothing emitted at all — when the file cannot be wrapped. That is
 * not a failure: it is the pre-throttle loop, unchanged.
 */
export async function calibrate(input: CalibrateInput): Promise<CalibrationRun | undefined> {
  if (!canThrottle(input.source)) return undefined;

  const from = THROTTLE_MAX;
  const points: ThrottlePoint[] = [{ throttle: from, panel: input.panel }];
  const steps: CalibrationStepLog[] = [];
  let stop: CalibrationStop = 'exhausted';
  let approved: CalibrationStepLog | undefined;

  for (;;) {
    const move = nextThrottle(points, input.band);
    if (move.kind === 'stop') {
      stop = move.reason;
      break;
    }
    // Checked here rather than inside the search, so the search stays a pure
    // function of the numbers and the clock can only ever cut it short.
    if (!input.hasBudget()) {
      stop = 'deadline';
      break;
    }

    const source = withThrottle(input.source, move.throttle);
    if (source === undefined) {
      // `canThrottle` said yes; this cannot happen. Treated as un-calibratable
      // rather than thrown, because a rewrite must never die on this path.
      stop = 'unmeasured';
      break;
    }

    const step = steps.length + 1;
    const measured = await input.measure(source, move.throttle, step);
    const log: CalibrationStepLog = { ...measured, step, throttle: move.throttle, source };
    steps.push(log);
    input.onStep?.(log);

    if (measured.ok) {
      approved = log;
      stop = 'passed';
      break;
    }
    if (measured.panel === undefined) {
      // The step never reached Gate 3 (the sandbox, Gate 1 or Gate 2 stopped it), so
      // there is no number to bisect on and the next step would be a guess.
      stop = 'unmeasured';
      break;
    }
    points.push({ throttle: move.throttle, panel: measured.panel, ok: measured.ok });
  }

  const last = steps.at(-1);
  return {
    from,
    to: approved?.throttle ?? last?.throttle ?? from,
    steps,
    stop,
    ...(approved === undefined ? {} : { approved }),
  };
}
