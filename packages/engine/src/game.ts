/**
 * Round lifecycle: create, replay, hash, summarize.
 *
 * A round is fully described by `{ seed, inputLog, strategy }`. `replay` reconstructs it
 * exactly; `hashState` is the equality witness; `summarizeReplay` is the *only* thing the
 * Analyst agent is ever shown (spec §8: it never sees engine source or raw logs).
 */
import { CONSTANTS, type PrimitiveName, type StrategyMeta, type StrategyRunner } from '@rematch/contract';
import { ENGINE_CONSTANTS as E } from './constants.ts';
import { hashValue } from './hash.ts';
import { IDLE_INPUT, type InputLog, type PlayerInput } from './input.ts';
import { cloneState, createInitialState, type GameState, type Outcome, type TimelineEvent } from './state.ts';
import { normalizeHeat } from './view.ts';
import { step } from './step.ts';

/** Start a round. Calls `runner.init(seed)`; the strategy's memory lives in the runner. */
export function createGame(seed: number, runner: StrategyRunner): GameState {
  runner.init(seed);
  return createInitialState(seed, runner.meta);
}

export type ReplayOptions = {
  /** Keep a deep copy of every tick, including tick 0. Costly; off by default. */
  keepFrames?: boolean;
};

export type ReplayResult = {
  final: GameState;
  /** Present only when `keepFrames` was set. `frames[0]` is the initial state. */
  frames?: GameState[];
};

/**
 * Re-run a round from `{ seed, inputLog }`.
 *
 * Runs exactly `inputLog.length` ticks, stopping early once the outcome is decided.
 * To play a round out to the 3600-tick cap, pad the log with `IDLE_INPUT`.
 */
export function replay(
  seed: number,
  inputLog: InputLog,
  runner: StrategyRunner,
  options: ReplayOptions = {},
): ReplayResult {
  const state = createGame(seed, runner);
  const keepFrames = options.keepFrames === true;
  const frames: GameState[] = keepFrames ? [cloneState(state)] : [];

  for (let i = 0; i < inputLog.length; i += 1) {
    const input: PlayerInput = inputLog[i] ?? IDLE_INPUT;
    step(state, input, runner);
    if (keepFrames) frames.push(cloneState(state));
    if (state.outcome !== 'playing') break;
  }

  return keepFrames ? { final: state, frames } : { final: state };
}

/**
 * Stable hash of the whole simulation state. Same seed + same input log + same strategy
 * -> same hash, on any platform. Changing any engine rule changes this by design, which
 * is what the snapshot test in `determinism.test.ts` guards.
 */
export function hashState(state: GameState): string {
  return hashValue(state);
}

// ------------------------------------------------------------- replay summary

export type ReplaySummary = {
  seed: number;
  /** The strategy that drove the boss this round. */
  strategy: StrategyMeta;
  outcome: Outcome;
  durations: {
    ticks: number;
    seconds: number;
    /** Ticks until the player first damaged the boss, or null. */
    firstBossHitTick: number | null;
    /** Ticks until the player first took damage, or null. */
    firstPlayerHitTick: number | null;
  };
  player: {
    hpStart: number;
    hpEnd: number;
    dashes: number;
    shots: number;
    damageTaken: number;
  };
  boss: {
    hpStart: number;
    hpEnd: number;
    damageTaken: number;
    /** Applied actions per primitive. */
    primitives: Record<PrimitiveName, number>;
    minionsSpawned: number;
    damageToMinions: number;
  };
  history: {
    /** 8x8 row-major, normalized to sum 1. */
    playerPosHeat: number[];
    /** 8 raw dash counts, bin 0 centred on +x, counter-clockwise. */
    playerDashDirs: number[];
    playerShotsDuring: Record<PrimitiveName, number>;
  };
  contract: {
    violations: number;
    strategyKilled: boolean;
    /** Events the caps discarded (violation spam / event ceiling). */
    droppedEvents: number;
  };
  /** At most `ENGINE_CONSTANTS.limits.timelineMax` entries, in tick order. */
  timeline: TimelineEvent[];
  /** Total events recorded, before the timeline was trimmed. */
  timelineTotal: number;
};

/** Indices of `budget` items spread evenly across `[0, length)`. */
function evenIndices(length: number, budget: number): number[] {
  if (budget <= 0 || length === 0) return [];
  if (length <= budget) {
    const all: number[] = [];
    for (let i = 0; i < length; i += 1) all.push(i);
    return all;
  }
  const out: number[] = [];
  for (let k = 0; k < budget; k += 1) {
    const idx = Math.min(length - 1, Math.floor((k * length) / budget));
    if (out[out.length - 1] !== idx) out.push(idx);
  }
  return out;
}

/**
 * Trim the event log to `max` entries, preserving original order.
 *
 * `playerShot` events are the only high-frequency kind (~400 in a full match), so they
 * are the only ones downsampled: every dash, hit, boss primitive and violation survives
 * as long as the budget allows.
 */
export function buildTimeline(events: readonly TimelineEvent[], max: number): TimelineEvent[] {
  const notable: number[] = [];
  const shots: number[] = [];
  for (let i = 0; i < events.length; i += 1) {
    if (events[i]?.kind === 'playerShot') shots.push(i);
    else notable.push(i);
  }

  const keep = new Set<number>();
  if (notable.length > max) {
    for (const k of evenIndices(notable.length, max)) {
      const idx = notable[k];
      if (idx !== undefined) keep.add(idx);
    }
  } else {
    for (const idx of notable) keep.add(idx);
    for (const k of evenIndices(shots.length, max - notable.length)) {
      const idx = shots[k];
      if (idx !== undefined) keep.add(idx);
    }
  }

  const out: TimelineEvent[] = [];
  for (let i = 0; i < events.length; i += 1) {
    const ev = events[i];
    if (ev !== undefined && keep.has(i)) out.push(ev);
  }
  return out;
}

function firstEventTick(state: GameState, kind: TimelineEvent['kind']): number | null {
  for (const ev of state.events) {
    if (ev.kind === kind) return ev.tick;
  }
  return null;
}

/**
 * Compress a finished round into the object the Analyst agent reads. Accepts either the
 * final state or a `frames` array (the last frame is used).
 */
export function summarizeReplay(input: GameState | GameState[]): ReplaySummary {
  const state = Array.isArray(input) ? input[input.length - 1] : input;
  if (state === undefined) throw new Error('summarizeReplay: empty frames array');

  return {
    seed: state.seed,
    strategy: { ...state.strategy },
    outcome: state.outcome,
    durations: {
      ticks: state.tick,
      seconds: Math.round((state.tick / CONSTANTS.ticksPerSecond) * 100) / 100,
      firstBossHitTick: firstEventTick(state, 'bossHit'),
      firstPlayerHitTick: firstEventTick(state, 'playerHit'),
    },
    player: {
      hpStart: E.player.hp,
      hpEnd: state.player.hp,
      dashes: state.counts.dashes,
      shots: state.counts.shots,
      damageTaken: state.damageTaken,
    },
    boss: {
      hpStart: E.boss.hp,
      hpEnd: state.boss.hp,
      damageTaken: state.damageDealt,
      primitives: { ...state.counts.primitives },
      minionsSpawned: state.minionsSpawned,
      damageToMinions: state.damageToMinions,
    },
    history: {
      playerPosHeat: normalizeHeat(state.history.playerPosHeat),
      playerDashDirs: state.history.playerDashDirs.slice(),
      playerShotsDuring: { ...state.history.playerShotsDuring },
    },
    contract: {
      violations: state.violations,
      strategyKilled: state.strategyKilled,
      droppedEvents: state.droppedEvents,
    },
    timeline: buildTimeline(state.events, E.limits.timelineMax),
    timelineTotal: state.events.length,
  };
}
