/**
 * `Dodger` — reacts perfectly to telegraphs and shoots only when safe (spec §6.1:
 * "tests that the boss can still deal damage to a defensive player").
 *
 * "Perfectly" is a search, not a rule: nine candidate directions (the eight WASD
 * headings plus standing still) are scored by *predicting* where every boss
 * projectile will be, plus penalties for the slam circle and the charge line, and
 * the best one wins. That is what makes the Dodger the panel's upper bound — a boss
 * that still lands damage on it is landing damage on geometry, not on a mistake.
 *
 * The trade is real: it fires only while nothing is inbound and no tell is on
 * screen, so a boss that keeps *something* on the board holds it to a draw, and the
 * 60-second timeout counts as a boss win.
 */
import { ENGINE_CONSTANTS as E, type GameState, type PlayerInput, type Rng } from '@rematch/engine';
import {
  chargeTelegraph,
  clearanceIfMoving,
  distanceToChargeLine,
  dashReady,
  input,
  makeAimer,
  nearestIncoming,
  nearestMinion,
  slamTelegraph,
  unit,
} from './shared.ts';
import type { BotOptions, PlayerBot } from './types.ts';

/** Ticks of prediction. A boss shot crosses its own radius in ~10. */
const HORIZON = 26;
const CANDIDATES: ReadonlyArray<readonly [number, number]> = [
  [0, 0], [1, 0], [-1, 0], [0, 1], [0, -1],
  [0.7071, 0.7071], [0.7071, -0.7071], [-0.7071, 0.7071], [-0.7071, -0.7071],
];

export function dodger(opts: BotOptions = {}): PlayerBot {
  const aimer = makeAimer(opts.accuracy ?? 0.8);
  let ideal = 300;

  return {
    name: 'Dodger',

    reset(seed: number): void {
      aimer.reset();
      ideal = 260 + (seed % 4) * 30;
    },

    act(state: Readonly<GameState>, rng: Rng): PlayerInput {
      const p = state.player;
      const b = state.boss;
      const aim = aimer.aim(state, rng);
      const slam = slamTelegraph(state);
      const charge = chargeTelegraph(state);
      const incoming = nearestIncoming(state, HORIZON);
      const minion = nearestMinion(state);

      let bestX = 0;
      let bestY = 0;
      let bestScore = Number.NEGATIVE_INFINITY;
      for (const [cx, cy] of CANDIDATES) {
        const steps = Math.hypot(cx, cy) === 0 ? 0 : E.player.speed * HORIZON;
        const endX = p.x + cx * steps;
        const endY = p.y + cy * steps;

        // 1. Projectile clearance, capped: past ~60 px it stops mattering.
        let score = Math.min(60, clearanceIfMoving(state, cx, cy, HORIZON));
        // 2. Out of the slam circle, weighted by how soon it lands.
        if (slam !== null) {
          const d = Math.hypot(endX - slam.x, endY - slam.y);
          score += Math.min(80, d - E.slam.radius) * (slam.ticksLeft < 24 ? 2.5 : 1);
        }
        // 3. Off the charge line.
        if (charge !== null) score += Math.min(70, distanceToChargeLine(state, charge.angle)) * 0.8;
        // 4. Hold a shooting distance, and stay off the walls.
        score -= Math.abs(Math.hypot(endX - b.x, endY - b.y) - ideal) * 0.22;
        if (minion !== null) score += Math.min(70, Math.hypot(endX - (p.x + minion.dirX * minion.dist), endY - (p.y + minion.dirY * minion.dist))) * 0.15;
        score -= edgePenalty(state, endX, endY);
        if (score > bestScore) {
          bestScore = score;
          bestX = cx;
          bestY = cy;
        }
      }

      // The dash is spent only on a hit that walking cannot avoid: a slam about to
      // resolve on top of us, or a shot inside its own travel time.
      const inSlam = slam !== null && slam.ticksLeft < 10 && Math.hypot(p.x - slam.x, p.y - slam.y) < E.slam.radius;
      const dash = (inSlam || (incoming !== null && incoming.ticks < 5)) && dashReady(state);

      // Shoot only when nothing is on the board and nothing is being telegraphed.
      const safe = slam === null && charge === null && state.boss.chargeTicksLeft === 0 && incoming === null;
      const move = unit(bestX, bestY);
      return input(move, aim, dash, safe);
    },
  };
}

/** Soft wall penalty: a cornered player has nowhere to dodge to. */
function edgePenalty(state: Readonly<GameState>, x: number, y: number): number {
  const margin = 70;
  const dx = Math.min(x, state.arena.w - x);
  const dy = Math.min(y, state.arena.h - y);
  return Math.max(0, margin - dx) * 0.9 + Math.max(0, margin - dy) * 0.9;
}
