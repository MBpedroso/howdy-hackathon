/**
 * `Camper` — the passive player. Holds a corner and only shoots inside the boss's
 * cooldown windows (spec §6.1: "tests that the boss can flush a passive player").
 *
 * The corner is the point: a boss that only ever aims at the player's *current*
 * position beats a Kiter and loses to this, because a camper is never where the
 * pressure is — they are behind it. `history.playerPosHeat` exists so a strategy
 * can find the corner and put a slam in it; `cornerbreaker.js` is the reference
 * answer, and this bot is what proves the answer works.
 */
import { ENGINE_CONSTANTS as E, type GameState, type PlayerInput, type Rng } from '@rematch/engine';
import { bossIsCommitted, dashReady, input, makeAimer, nearestIncoming, pushOffWalls, slamTelegraph, unit } from './shared.ts';
import type { BotOptions, PlayerBot } from './types.ts';

/** How far inside the corner the bot parks; enough room to dash out of a slam. */
const INSET = 70;

export function camper(opts: BotOptions = {}): PlayerBot {
  const aimer = makeAimer(opts.accuracy ?? 0.72);
  let cornerX = INSET;
  let cornerY = E.arena.h - INSET;

  return {
    name: 'Camper',

    reset(seed: number): void {
      aimer.reset();
      // The player spawns at the bottom of the arena, so the two bottom corners
      // are the nearest ones; the seed picks between them. Every seed therefore
      // produces a *different* hot cell, which is what stops a strategy from
      // passing Gate 3 by hard-coding one corner.
      cornerX = (seed >>> 1) % 2 === 0 ? INSET : E.arena.w - INSET;
      cornerY = (seed >>> 2) % 4 === 0 ? INSET : E.arena.h - INSET;
    },

    act(state: Readonly<GameState>, rng: Rng): PlayerInput {
      const p = state.player;
      const aim = aimer.aim(state, rng);

      // The one thing a camper reacts to on foot: a slam landing on the corner.
      const slam = slamTelegraph(state);
      if (slam !== null) {
        const away = unit(p.x - slam.x, p.y - slam.y);
        const d = Math.hypot(p.x - slam.x, p.y - slam.y);
        if (d < E.slam.radius + 60) {
          const dash = d < E.slam.radius && slam.ticksLeft < 12 && dashReady(state);
          return input(pushOffWalls(state, away.x, away.y, 40), aim, dash, false);
        }
      }

      // A shot it cannot walk out of: spend the dash sideways through it. Even a
      // passive player does this — without it the corner is a death sentence to
      // any strategy that can put projectiles in it, and the bot would stop
      // measuring anything.
      const incoming = nearestIncoming(state, 30);
      if (incoming !== null && incoming.ticks < 9 && dashReady(state)) {
        return input({ x: -incoming.dirY, y: incoming.dirX }, aim, true, false);
      }

      // Otherwise: sit in the corner, and only shoot in the windows where the boss
      // has nothing on the board — no tell, no charge in flight, nothing inbound.
      const home = unit(cornerX - p.x, cornerY - p.y);
      const settled = Math.hypot(cornerX - p.x, cornerY - p.y) < 12;
      const window = !bossIsCommitted(state) && incoming === null;

      return input(settled ? { x: 0, y: 0 } : home, aim, false, window);
    },
  };
}
