/**
 * `Kiter` — holds max effective range and circles (spec §6.1: "tests that the boss
 * isn't helpless against distance").
 *
 * Range is chosen against the engine's own numbers, not by feel: a boss projectile
 * travels 5.5 px/tick, so at 340 px the bot has ~60 ticks to read an incoming burst,
 * and the boss (2.6 px/tick) cannot close that gap on foot faster than the bot can
 * back away (3.6 px/tick). `charge` is the only primitive that beats this — which is
 * exactly the lesson the boss agent is supposed to learn.
 */
import { ENGINE_CONSTANTS as E, type GameState, type PlayerInput, type Rng } from '@rematch/engine';
import { chargeTelegraph, dashReady, input, makeAimer, nearestIncoming, pushOffWalls, slamTelegraph, unit } from './shared.ts';
import type { BotOptions, PlayerBot } from './types.ts';

const RANGE = 340;
/** Ticks between orbit-direction flips, so a strategy cannot settle into a lead. */
const FLIP_PERIOD = 240;

export function kiter(opts: BotOptions = {}): PlayerBot {
  const aimer = makeAimer(opts.accuracy ?? 0.7);
  let spin = 1;
  let ticks = 0;

  return {
    name: 'Kiter',

    reset(seed: number): void {
      aimer.reset();
      ticks = 0;
      spin = seed % 2 === 0 ? 1 : -1;
    },

    act(state: Readonly<GameState>, rng: Rng): PlayerInput {
      ticks += 1;
      if (ticks % FLIP_PERIOD === 0) spin = -spin;

      const p = state.player;
      const b = state.boss;
      const away = unit(p.x - b.x, p.y - b.y);
      const dist = Math.hypot(p.x - b.x, p.y - b.y);
      const aim = aimer.aim(state, rng);

      // Base: hold the ring — radial correction plus a tangential orbit.
      const charge = chargeTelegraph(state);
      const radial = dist > RANGE + 20 ? -1 : dist < RANGE - 20 ? 1 : 0;
      let mx = -away.y * spin + away.x * radial;
      let my = away.x * spin + away.y * radial;
      let dash = false;

      // A slam is 40 ticks of warning over a 110 px circle, and at 3.6 px/tick a
      // kiter can walk out of it. It *biases* the orbit rather than replacing it:
      // running blindly away from the circle walks into a wall, and a cornered
      // kiter is not kiting any more — that mistake alone turned this bot from 96%
      // against `cornerbreaker` into 0%.
      const slam = slamTelegraph(state);
      if (slam !== null) {
        const d = Math.hypot(p.x - slam.x, p.y - slam.y);
        if (d < E.slam.radius + 40) {
          const out = unit(p.x - slam.x, p.y - slam.y);
          mx += out.x * 1.8;
          my += out.y * 1.8;
          dash = d < E.slam.radius * 0.7 && slam.ticksLeft < 10 && dashReady(state);
        }
      }

      // A charge is the counter to kiting, so it is the one thing always worth a
      // dash: perpendicular to the charge line, on the last few telegraph ticks.
      if (charge !== null) {
        const perp = { x: -Math.sin(charge.angle) * spin, y: Math.cos(charge.angle) * spin };
        return input(pushOffWalls(state, perp.x, perp.y, 60), aim, charge.ticksLeft < 6 && dashReady(state), true);
      }

      // Sidestep a burst that is actually on a collision course, and spend the
      // dash on the ones too close to walk out of. At 5.5 px/tick a boss shot
      // outruns the player's 3.6, so distance alone does not save a kiter — the
      // 10 invulnerable ticks of a dash do.
      const incoming = nearestIncoming(state, 40);
      if (incoming !== null && incoming.ticks < 20) {
        mx = -incoming.dirY * spin;
        my = incoming.dirX * spin;
        dash = incoming.ticks < 7 && dashReady(state);
      }

      const move = pushOffWalls(state, mx, my, E.player.radius + 70);
      return input(move, aim, dash, true);
    },
  };
}
