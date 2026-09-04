/**
 * `buildBossView` — the only thing a strategy ever sees.
 *
 * Two hard rules:
 *  1. **No references leak.** Every array and object is freshly allocated, so a strategy
 *     that mutates its `view` (or holds it across ticks in `mem`) cannot touch the world.
 *  2. **Only contract fields.** Minions, telegraph internals, violation counts and the
 *     rng state are deliberately absent: they are not in `BossView`, so the boss cannot
 *     depend on them. Adding a field here is a contract change.
 */
import { PRIMITIVES, type BossView } from '@rematch/contract';
import type { GameState, History } from './state.ts';

/** Rounding step for normalized heat values. */
const HEAT_PRECISION = 1e6;

/**
 * Normalize the accumulated 8x8 dwell counts so the 64 cells **sum to 1**
 * (each value therefore also lies in [0, 1], as the contract documents).
 * Before the first tick every cell is 0 and the sum is 0 — an all-zero grid is
 * returned rather than dividing by zero. Values are rounded to 1e-6 for hash
 * stability; the sum can therefore differ from 1 by up to 64e-6.
 */
export function normalizeHeat(counts: readonly number[]): number[] {
  let total = 0;
  for (const c of counts) total += c > 0 ? c : 0;
  const out = new Array<number>(counts.length);
  for (let i = 0; i < counts.length; i += 1) {
    const c = counts[i] ?? 0;
    out[i] = total > 0 ? Math.round((c / total) * HEAT_PRECISION) / HEAT_PRECISION : 0;
  }
  return out;
}

function copyHistory(history: History): BossView['history'] {
  return {
    playerPosHeat: normalizeHeat(history.playerPosHeat),
    playerDashDirs: history.playerDashDirs.slice(),
    playerShotsDuring: {
      move: history.playerShotsDuring.move,
      burst: history.playerShotsDuring.burst,
      charge: history.playerShotsDuring.charge,
      slam: history.playerShotsDuring.slam,
      spawn: history.playerShotsDuring.spawn,
    },
  };
}

export function buildBossView(state: GameState): BossView {
  const { boss, player } = state;
  const projectiles: BossView['projectiles'] = new Array(state.projectiles.length);
  for (let i = 0; i < state.projectiles.length; i += 1) {
    const p = state.projectiles[i];
    if (p === undefined) continue;
    projectiles[i] = { x: p.x, y: p.y, vx: p.vx, vy: p.vy, owner: p.owner };
  }

  return {
    tick: state.tick,
    arena: { w: state.arena.w, h: state.arena.h },
    boss: {
      x: boss.x,
      y: boss.y,
      hp: boss.hp,
      facing: boss.facing,
      cooldowns: {
        move: boss.cooldowns.move,
        burst: boss.cooldowns.burst,
        charge: boss.cooldowns.charge,
        slam: boss.cooldowns.slam,
        spawn: boss.cooldowns.spawn,
      },
    },
    player: {
      x: player.x,
      y: player.y,
      hp: player.hp,
      vx: player.vx,
      vy: player.vy,
      isDashing: player.dashTicksLeft > 0,
      lastShotTick: player.lastShotTick,
    },
    projectiles,
    history: copyHistory(state.history),
  };
}

/** Names of the primitives whose cooldowns appear in a view, in contract order. */
export const VIEW_PRIMITIVES = PRIMITIVES;
