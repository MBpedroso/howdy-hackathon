/**
 * `Rusher` — closes to point-blank and dashes *through* telegraphed attacks (spec
 * §6.1: "tests that the boss isn't trivially beaten by aggression").
 *
 * The dash is 10 ticks of invulnerability (`ENGINE_CONSTANTS.player.dashTicks`) on a
 * 45-tick cooldown, and boss shots pass harmlessly through an invulnerable player, so
 * a telegraph is not a warning to this bot — it is an invitation. That makes the
 * Rusher the panel's answer to a boss that wins by telegraph spam: every tell it
 * shows is 10 ticks the Rusher spends inside its guard, firing at contact range.
 */
import { ENGINE_CONSTANTS as E, type GameState, type PlayerInput, type Rng } from '@rematch/engine';
import { chargeTelegraph, dashReady, input, makeAimer, nearestIncoming, slamTelegraph, unit } from './shared.ts';
import type { BotOptions, PlayerBot } from './types.ts';

/**
 * Contact range. Just outside the ring a `burst` of 8 spawns on (the boss radius
 * plus a projectile radius), so the Rusher is inside the *cone* bursts and hugging
 * the ring bursts rather than standing in the middle of them — close enough that
 * every shot lands, far enough that it is not eating the whole ring every 90 ticks.
 */
const KNIFE_RANGE = E.boss.radius + E.player.radius + 55;

export function rusher(opts: BotOptions = {}): PlayerBot {
  const aimer = makeAimer(opts.accuracy ?? 0.7);
  let spin = 1;

  return {
    name: 'Rusher',

    reset(seed: number): void {
      aimer.reset();
      spin = seed % 2 === 0 ? 1 : -1;
    },

    act(state: Readonly<GameState>, rng: Rng): PlayerInput {
      const p = state.player;
      const b = state.boss;
      const toBoss = unit(b.x - p.x, b.y - p.y);
      const dist = Math.hypot(b.x - p.x, b.y - p.y);
      const aim = aimer.aim(state, rng);

      // Dash THROUGH whatever is being telegraphed: straight at the boss for a
      // charge (it is about to come to us anyway), straight across the slam
      // circle for a slam. Both are timed to the last few telegraph ticks so the
      // 10 invulnerable ticks overlap the hit.
      const ready = dashReady(state);
      const charge = chargeTelegraph(state);
      if (charge !== null && charge.ticksLeft < 8 && ready) {
        return input(toBoss, aim, true, true);
      }
      const slam = slamTelegraph(state);
      if (slam !== null && slam.ticksLeft < 8 && ready && Math.hypot(p.x - slam.x, p.y - slam.y) < E.slam.radius) {
        return input(toBoss, aim, true, true);
      }
      // A burst at contact range is unavoidable on foot, so dash into it.
      const incoming = nearestIncoming(state, 10);
      if (incoming !== null && ready) {
        return input(toBoss, aim, true, true);
      }

      // Otherwise close the gap, then strafe at knife range rather than grinding
      // into the boss's hitbox (where the walk clamp would leave us motionless).
      if (dist > KNIFE_RANGE) return input(toBoss, aim, false, true);
      const tangent = { x: -toBoss.y * spin, y: toBoss.x * spin };
      return input(tangent, aim, false, true);
    },
  };
}
