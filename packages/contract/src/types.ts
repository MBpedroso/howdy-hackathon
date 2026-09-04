/**
 * The Boss Contract — types. Frozen from spec.md §4 (v0.1).
 *
 * This file is the ONLY interface the Coder agent is shown. It must stay free of
 * engine internals, DOM types, and anything Node-specific. Any change here is a
 * contract change and requires a CHANGELOG.md entry in this package (spec §7).
 */

/** The five primitives the boss can act with. `idle` is an action but not a primitive. */
export type PrimitiveName = 'move' | 'burst' | 'charge' | 'slam' | 'spawn';

/** Runtime-iterable companion to {@link PrimitiveName}. Order is stable and load-bearing
 *  (the engine uses it for cooldown records and the harness for fuzz coverage). */
export const PRIMITIVES = ['move', 'burst', 'charge', 'slam', 'spawn'] as const satisfies readonly PrimitiveName[];

/** Read-only, plain-data snapshot handed to `decide` once per tick. 60 ticks / second. */
export type BossView = {
  /** Ticks since the round started. 60 ticks / second. */
  tick: number;
  arena: { w: number; h: number };
  boss: {
    x: number;
    y: number;
    hp: number;
    facing: number;
    /** Ticks remaining per primitive; 0 = ready. */
    cooldowns: Record<PrimitiveName, number>;
  };
  player: {
    x: number;
    y: number;
    hp: number;
    vx: number;
    vy: number;
    isDashing: boolean;
    lastShotTick: number;
  };
  projectiles: Array<{ x: number; y: number; vx: number; vy: number; owner: 'boss' | 'player' }>;
  /** Rolling summaries, not raw logs. */
  history: {
    /** 8x8 grid of player dwell time, normalized to [0, 1]. Row-major, 64 entries. */
    playerPosHeat: number[];
    /** 8 bins of dash direction counts, bin 0 centred on +x, counter-clockwise. */
    playerDashDirs: number[];
    /** Shots the player fired while each primitive was active. */
    playerShotsDuring: Record<PrimitiveName, number>;
  };
};

/** The fixed action menu. Anything else is a contract violation. */
export type BossAction =
  | { type: 'move'; dx: number; dy: number }
  | { type: 'burst'; angle: number; count: 3 | 5 | 8 }
  | { type: 'charge'; angle: number }
  | { type: 'slam'; x: number; y: number }
  | { type: 'spawn'; x: number; y: number }
  | { type: 'idle' };

/** Every action `type` the validator accepts, including `idle`. */
export const ACTION_TYPES = ['move', 'burst', 'charge', 'slam', 'spawn', 'idle'] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

/** Legal values for `burst.count`. */
export const BURST_COUNTS = [3, 5, 8] as const;
export type BurstCount = (typeof BURST_COUNTS)[number];

/**
 * Strategy-private state, created by `init` and threaded through `decide`.
 * Opaque to the engine: it is only ever handed back to the same strategy, and is
 * capped at {@link CONSTANTS.limits.memoryBytes} when JSON-serialized.
 */
export type Memory = Record<string, unknown>;

/** Player-facing description of a strategy. `name` and `rationale` are rendered verbatim. */
export type StrategyMeta = {
  /** Shown to the player; <= CONSTANTS.limits.metaNameMaxChars characters. */
  name: string;
  /** One sentence, shown to the player. */
  rationale: string;
  version: number;
};

/** The shape of a loaded `strategy.js`. The only module shape agents may produce. */
export type StrategyModule = {
  meta: StrategyMeta;
  /** Called once per round. */
  init(): Memory;
  /** Called once per tick. Must be pure with respect to everything except `mem`. */
  decide(view: BossView, mem: Memory): BossAction;
};

/**
 * Shared numeric truth. The engine, the harness and the static check all read these
 * so there is exactly one place to change them.
 */
export const CONSTANTS = {
  /** Open decision in spec §12 resolved: square 800x800. */
  arena: { w: 800, h: 800 },
  ticksPerSecond: 60,
  /** Ticks of cooldown incurred by each primitive. `move` is free. */
  cooldowns: {
    move: 0,
    burst: 90,
    charge: 150,
    slam: 210,
    spawn: 300,
  } satisfies Record<PrimitiveName, number>,
  /** Telegraph windows, in ticks (spec §4.3). Informational for strategies. */
  telegraphs: {
    charge: 20,
    slam: 40,
  },
  limits: {
    /** `init()` result must serialize to at most this many bytes of JSON. */
    memoryBytes: 4 * 1024,
    /** Wall-clock budget for a single `decide` call. */
    decideBudgetMs: 2,
    /** QuickJS heap ceiling for the strategy sandbox. */
    sandboxMemoryBytes: 64 * 1024 * 1024,
    /** Maximum `strategy.js` source size accepted by the static check. */
    sourceBytes: 32 * 1024,
    /** `meta.name` length cap. */
    metaNameMaxChars: 40,
    /** Concurrent minions from `spawn`. Engine-enforced. */
    maxMinionsAlive: 2,
  },
} as const;
