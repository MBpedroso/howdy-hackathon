/**
 * Deterministic `BossView` generator for Gate 2.
 *
 * Two jobs, in this order:
 *
 *  1. **Corners first.** The states that break generated strategies are not
 *     random ones — they are the degenerate ones: tick 0 (nothing in `history`
 *     yet), every cooldown busy (the strategy has no legal primitive and must
 *     still return something), a heat map that is all zeros or all in one cell
 *     (division by a zero total, `indexOf` on an empty max), hp 0, the player
 *     exactly on top of the boss (`atan2(0,0)`, normalising a zero vector), 30
 *     projectiles. `CORNER_CASES` enumerates them, so every fuzz run starts by
 *     covering them regardless of seed or count.
 *  2. **Then spread.** The remaining states are drawn from the harness's own
 *     xorshift32 so a run is reproducible from `(count, seed)` alone: a Gate 2
 *     rejection can be replayed exactly, which is what makes the rejection
 *     evidence rather than an anecdote (spec §7).
 *
 * This generator is intentionally *not* the engine's simulation. Gate 2 asks
 * "does `decide` behave on any state the contract permits", not "on states this
 * engine build happens to produce" — the boss agent's code has to be total over
 * the type, and an engine change must not silently narrow the fuzz corpus.
 */
import { CONSTANTS, PRIMITIVES, type BossView, type PrimitiveName } from '@rematch/contract';

/** The harness's own PRNG. Same algorithm as the sandbox's `rand`, separate state. */
export function xorshift32(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9;
  const next = (): number => {
    let x = state;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    state = x;
    return x;
  };
  next();
  next();
  next();
  next();
  return () => next() / 4294967296;
}

const { w: ARENA_W, h: ARENA_H } = CONSTANTS.arena;
const MAX_TICK = 3600; // a 60 s round at 60 Hz

type Cooldowns = Record<PrimitiveName, number>;

const READY: Cooldowns = { move: 0, burst: 0, charge: 0, slam: 0, spawn: 0 };
const BUSY: Cooldowns = {
  move: 0,
  burst: CONSTANTS.cooldowns.burst,
  charge: CONSTANTS.cooldowns.charge,
  slam: CONSTANTS.cooldowns.slam,
  spawn: CONSTANTS.cooldowns.spawn,
};
const MIXED: Cooldowns = { move: 0, burst: 0, charge: 90, slam: 0, spawn: 210 };

const UNIFORM_HEAT = Array.from({ length: 64 }, () => 1 / 64);
const ZERO_HEAT = Array.from({ length: 64 }, () => 0);
const heatInCell = (cell: number): number[] => Array.from({ length: 64 }, (_, i) => (i === cell ? 1 : 0));

const CORNERS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [ARENA_W, 0],
  [0, ARENA_H],
  [ARENA_W, ARENA_H],
];

type Partial3 = {
  tick?: number;
  boss?: Partial<BossView['boss']>;
  player?: Partial<BossView['player']>;
  projectiles?: BossView['projectiles'];
  history?: Partial<BossView['history']>;
};

function view(overrides: Partial3 = {}): BossView {
  return {
    tick: overrides.tick ?? 600,
    arena: { w: ARENA_W, h: ARENA_H },
    boss: {
      x: ARENA_W / 2,
      y: ARENA_H / 2,
      hp: 100,
      facing: 0,
      cooldowns: { ...READY },
      ...overrides.boss,
    },
    player: {
      x: ARENA_W / 2,
      y: ARENA_H / 2,
      hp: 100,
      vx: 0,
      vy: 0,
      isDashing: false,
      lastShotTick: 0,
      ...overrides.player,
    },
    projectiles: overrides.projectiles ?? [],
    history: {
      playerPosHeat: UNIFORM_HEAT,
      playerDashDirs: [0, 0, 0, 0, 0, 0, 0, 0],
      playerShotsDuring: { move: 0, burst: 0, charge: 0, slam: 0, spawn: 0 },
      ...overrides.history,
    },
  };
}

function projectiles(count: number, owner: 'boss' | 'player' | 'both' = 'both'): BossView['projectiles'] {
  return Array.from({ length: count }, (_, i) => ({
    x: (i * 97) % ARENA_W,
    y: (i * 131) % ARENA_H,
    vx: i % 2 === 0 ? 6 : -6,
    vy: i % 3 === 0 ? -6 : 6,
    owner: owner === 'both' ? (i % 2 === 0 ? 'boss' : 'player') : owner,
  }));
}

/**
 * States that must be covered on every run, seed or no seed. Named so a Gate 2
 * `detail` can say *which* corner broke.
 */
export const CORNER_CASES: ReadonlyArray<{ label: string; view: BossView }> = [
  { label: 'tick 0, empty history', view: view({ tick: 0, history: { playerPosHeat: ZERO_HEAT } }) },
  { label: 'last tick of the round', view: view({ tick: MAX_TICK }) },
  { label: 'all cooldowns busy', view: view({ boss: { cooldowns: { ...BUSY } } }) },
  { label: 'all cooldowns ready', view: view({ boss: { cooldowns: { ...READY } } }) },
  { label: 'mixed cooldowns', view: view({ boss: { cooldowns: { ...MIXED } } }) },
  { label: 'one cooldown at 1 tick', view: view({ boss: { cooldowns: { ...READY, burst: 1 } } }) },
  ...CORNERS.map(([x, y], i) => ({
    label: `player in corner ${i}`,
    view: view({ player: { x, y }, history: { playerPosHeat: heatInCell(i === 0 ? 0 : i === 1 ? 7 : i === 2 ? 56 : 63) } }),
  })),
  ...CORNERS.map(([x, y], i) => ({ label: `boss in corner ${i}`, view: view({ boss: { x, y } }) })),
  { label: 'player on the boss (zero distance)', view: view({ boss: { x: 300, y: 300 }, player: { x: 300, y: 300 } }) },
  { label: 'player on an edge, dashing', view: view({ player: { x: 0, y: ARENA_H / 2, isDashing: true, vx: -9, vy: 0 } }) },
  { label: 'player dashing at full speed', view: view({ player: { isDashing: true, vx: 9, vy: -9 } }) },
  { label: 'player hp 0', view: view({ player: { hp: 0 } }) },
  { label: 'player hp 1', view: view({ player: { hp: 1 } }) },
  { label: 'boss hp 1', view: view({ boss: { hp: 1 } }) },
  { label: 'boss hp 0', view: view({ boss: { hp: 0 } }) },
  { label: 'no projectiles', view: view({ projectiles: [] }) },
  { label: '30 projectiles', view: view({ projectiles: projectiles(30) }) },
  { label: '30 boss projectiles', view: view({ projectiles: projectiles(30, 'boss') }) },
  { label: 'uniform heat map', view: view({ history: { playerPosHeat: UNIFORM_HEAT } }) },
  { label: 'zero heat map', view: view({ history: { playerPosHeat: ZERO_HEAT } }) },
  { label: 'heat all in one cell', view: view({ history: { playerPosHeat: heatInCell(27) } }) },
  { label: 'heat all in the last cell', view: view({ history: { playerPosHeat: heatInCell(63) } }) },
  {
    label: 'dash bins all one direction',
    view: view({ history: { playerDashDirs: [17, 0, 0, 0, 0, 0, 0, 0] } }),
  },
  {
    label: 'dash bins empty',
    view: view({ history: { playerDashDirs: [0, 0, 0, 0, 0, 0, 0, 0] } }),
  },
  {
    label: 'shots only during slam',
    view: view({ history: { playerShotsDuring: { move: 0, burst: 0, charge: 0, slam: 41, spawn: 0 } } }),
  },
  { label: 'player never shot', view: view({ player: { lastShotTick: -1 } }) },
  { label: 'facing at -PI', view: view({ boss: { facing: -Math.PI } }) },
];

/** A description of a generated state, for the "first failure was…" half of a reason. */
export function describeView(v: BossView): string {
  const parts = [`tick ${v.tick}`];
  if (v.player.isDashing) parts.push('player dashing');
  parts.push(`${v.projectiles.length} projectile${v.projectiles.length === 1 ? '' : 's'}`);
  const busy = PRIMITIVES.filter((p) => v.boss.cooldowns[p] > 0);
  if (busy.length === PRIMITIVES.length - 1) parts.push('every primitive on cooldown');
  else if (busy.length > 0) parts.push(`${busy.join('/')} on cooldown`);
  else parts.push('all cooldowns ready');
  if (v.player.hp <= 1) parts.push(`player hp ${v.player.hp}`);
  if (v.boss.hp <= 1) parts.push(`boss hp ${v.boss.hp}`);
  return parts.join(', ');
}

/**
 * `count` diverse views, deterministic in `(count, seed)`. The corner cases come
 * first (truncated if `count` is smaller than the corner list), then random
 * states drawn from the same generator.
 */
export function makeFuzzViews(count: number, seed: number): BossView[] {
  const out: BossView[] = [];
  for (const corner of CORNER_CASES) {
    if (out.length >= count) return out;
    out.push(corner.view);
  }

  const rand = xorshift32(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.min(xs.length - 1, Math.floor(rand() * xs.length))]!;
  const range = (lo: number, hi: number): number => lo + rand() * (hi - lo);

  while (out.length < count) {
    const cooldowns: Cooldowns = pick([
      { ...READY },
      { ...BUSY },
      { ...MIXED },
      {
        move: 0,
        burst: Math.floor(range(0, CONSTANTS.cooldowns.burst)),
        charge: Math.floor(range(0, CONSTANTS.cooldowns.charge)),
        slam: Math.floor(range(0, CONSTANTS.cooldowns.slam)),
        spawn: Math.floor(range(0, CONSTANTS.cooldowns.spawn)),
      },
    ]);

    const heat = pick([
      UNIFORM_HEAT,
      ZERO_HEAT,
      heatInCell(Math.floor(range(0, 64))),
      Array.from({ length: 64 }, () => rand()),
    ]);

    out.push(
      view({
        tick: Math.floor(range(0, MAX_TICK + 1)),
        boss: {
          x: range(0, ARENA_W),
          y: range(0, ARENA_H),
          hp: pick([0, 1, 50, 100, Math.floor(range(1, 100))]),
          facing: range(-Math.PI, Math.PI),
          cooldowns,
        },
        player: {
          x: pick([0, ARENA_W, range(0, ARENA_W), range(0, ARENA_W)]),
          y: pick([0, ARENA_H, range(0, ARENA_H), range(0, ARENA_H)]),
          hp: pick([0, 1, 100, Math.floor(range(1, 100))]),
          vx: range(-9, 9),
          vy: range(-9, 9),
          isDashing: rand() < 0.3,
          lastShotTick: pick([-1, 0, Math.floor(range(0, MAX_TICK))]),
        },
        projectiles: projectiles(Math.floor(range(0, 31))),
        history: {
          playerPosHeat: heat,
          playerDashDirs: Array.from({ length: 8 }, () => Math.floor(range(0, 20))),
          playerShotsDuring: {
            move: Math.floor(range(0, 30)),
            burst: Math.floor(range(0, 30)),
            charge: Math.floor(range(0, 30)),
            slam: Math.floor(range(0, 30)),
            spawn: Math.floor(range(0, 30)),
          },
        },
      }),
    );
  }
  return out;
}

/**
 * A plausible *consecutive* tick sequence: cooldowns tick down and fire, the
 * player walks a circle, projectiles come and go. `makeFuzzViews` deliberately
 * jumps around, which cannot catch a strategy whose memory grows once per tick —
 * that only shows up when `decide` is called 60 times in a row on the same
 * runner, which is what Gate 2 uses this for.
 */
export function makeFuzzSequence(ticks: number, seed: number): BossView[] {
  const rand = xorshift32(seed ^ 0x51ce);
  const cooldowns: Cooldowns = { ...READY };
  const out: BossView[] = [];
  for (let tick = 0; tick < ticks; tick++) {
    for (const primitive of PRIMITIVES) {
      if (cooldowns[primitive] > 0) cooldowns[primitive] -= 1;
      else if (rand() < 0.02) cooldowns[primitive] = CONSTANTS.cooldowns[primitive];
    }
    const angle = (tick / 60) * Math.PI;
    out.push(
      view({
        tick,
        boss: { x: ARENA_W / 2, y: ARENA_H / 2, hp: 100 - tick / 100, facing: angle, cooldowns: { ...cooldowns } },
        player: {
          x: ARENA_W / 2 + Math.cos(angle) * 250,
          y: ARENA_H / 2 + Math.sin(angle) * 250,
          hp: 100 - tick / 200,
          vx: -Math.sin(angle) * 4,
          vy: Math.cos(angle) * 4,
          isDashing: tick % 47 === 0,
          lastShotTick: Math.max(0, tick - (tick % 13)),
        },
        projectiles: projectiles(tick % 17),
        history: {
          playerPosHeat: Array.from({ length: 64 }, (_, i) => ((i * 7 + tick) % 13) / 13),
          playerDashDirs: Array.from({ length: 8 }, (_, i) => Math.floor(tick / 60) + i),
          playerShotsDuring: {
            move: tick % 5,
            burst: tick % 7,
            charge: tick % 3,
            slam: tick % 11,
            spawn: 0,
          },
        },
      }),
    );
  }
  return out;
}
