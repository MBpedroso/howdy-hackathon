/**
 * Diagnostic: what does the boss do when the *player* stands against a wall?
 *
 * Follow-up to `wall-hug.ts`, which found that neither shipped strategy hugs a wall
 * against the scripted panel — every bot in the panel keeps moving, so the boss keeps
 * moving with it. The playtest report ("travado na lateral esquerda, andando de um
 * lado pro outro") describes something the panel cannot produce: a player who stops.
 *
 * Both shipped bosses chase, so a player standing still on the left edge should pull
 * the boss to the left edge — where the arena clamp stops it and any strafe or
 * overshoot in the strategy turns into pacing on the spot. This asks whether that is
 * what happens, and whether the boss still *attacks* while it does.
 *
 * It prints, for a player pinned at a wall and one in the middle as the control:
 *
 *  - `wall%`  — fraction of ticks the boss spent within a radius of any wall
 *  - `dist`   — mean boss-to-player distance
 *  - `idle`   — longest run of visually motionless ticks (Gate 3 ACTIVE's clause)
 *  - `spanX`  — how much of the width the boss covered
 *  - the boss's actual x/y bounding box, which is the number that settles whether
 *    "stuck at the left wall" is about the strategy or about the renderer
 *
 *   node --experimental-strip-types scripts/corner-camp.ts
 */
import { readFileSync } from 'node:fs';
import { createGame, createRng, ENGINE_CONSTANTS as E, IDLE_INPUT, step, type Axis } from '@rematch/engine';
import { createSandbox, monotonicClock } from '@rematch/sandbox';
import { playerSeed } from '../src/index.ts';
import type { PlayerBot } from '../src/bots/types.ts';

const ROOT = new URL('../../../', import.meta.url).pathname;
const SEEDS = [1, 2, 3, 4, 5];
const NEAR = E.boss.radius + 6;

/**
 * A player that walks to one spot and stops there, never shooting. Not a fair
 * opponent and not meant to be — it is the input that isolates "where does the boss
 * end up when the player stops moving", which is what the playtest described.
 */
function statue(name: string, tx: number, ty: number): PlayerBot {
  return {
    name,
    reset(): void {},
    act(state): ReturnType<PlayerBot['act']> {
      const dx = tx - state.player.x;
      const dy = ty - state.player.y;
      const move: { x: Axis; y: Axis } = {
        x: Math.abs(dx) < 4 ? 0 : dx < 0 ? -1 : 1,
        y: Math.abs(dy) < 4 ? 0 : dy < 0 ? -1 : 1,
      };
      return { ...IDLE_INPUT, moveX: move.x, moveY: move.y };
    },
  };
}

const spots: PlayerBot[] = [
  statue('left-edge', E.boss.radius + 10, E.arena.h / 2),
  statue('left-corner', E.boss.radius + 10, E.boss.radius + 10),
  statue('centre', E.arena.w / 2, E.arena.h / 2),
];

const targets = [
  { name: 'round1 (Cornerbreaker)', path: 'packages/web/src/strategies/round1.js' },
  { name: 'hound (Hound)', path: 'packages/web/src/strategies/hound.js' },
  // What the *mock* interlude hands the player for rounds 2-5, which is what a local
  // session with no API server actually fights. See `web/src/interlude/mock.ts`.
  { name: 'round2-candidate (mock approval)', path: 'packages/harness/test/fixtures/round2-candidate.js' },
];

const sandbox = await createSandbox();

for (const target of targets) {
  const source = readFileSync(ROOT + target.path, 'utf8');
  console.log(`\n=== ${target.name} ===`);
  console.log('player spot   wall%   dist(px)  idle  spanX%');

  for (const bot of spots) {
    let ticks = 0;
    let wall = 0;
    let distSum = 0;
    let idle = 0;
    let worstIdle = 0;
    /** Ticks where the strategy asked to move, is against a wall, and went nowhere. */
    let pushing = 0;
    let worstPush = 0;
    let pushRun = 0;
    /** Charge ticks that displaced nothing: the charge ran into a wall. `decide` is
     *  not called for the whole 20-tick telegraph plus 30-tick dash, so these are
     *  ticks the strategy cannot take back. */
    let chargeStuck = 0;
    let chargeTicks = 0;
    let worstChargeStuck = 0;
    let chargeRun = 0;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (const seed of SEEDS) {
      const runner = sandbox.load(source, { now: monotonicClock() });
      try {
        bot.reset(seed);
        const state = createGame(seed, runner);
        const rng = createRng(playerSeed(seed));
        let prev = { x: state.boss.x, y: state.boss.y };
        for (let i = 0; i < E.round.maxTicks; i += 1) {
          step(state, bot.act(state, rng), runner);
          const b = state.boss;
          ticks += 1;
          if (b.x <= NEAR || b.x >= E.arena.w - NEAR || b.y <= NEAR || b.y >= E.arena.h - NEAR) wall += 1;
          distSum += Math.hypot(state.player.x - b.x, state.player.y - b.y);
          const moved = Math.hypot(b.x - prev.x, b.y - prev.y);
          const onWall = b.x <= E.boss.radius + 1 || b.x >= E.arena.w - E.boss.radius - 1
            || b.y <= E.boss.radius + 1 || b.y >= E.arena.h - E.boss.radius - 1;
          if (b.chargeTicksLeft > 0) {
            chargeTicks += 1;
            if (moved < 0.25) {
              chargeStuck += 1;
              chargeRun += 1;
              if (chargeRun > worstChargeStuck) worstChargeStuck = chargeRun;
            } else {
              chargeRun = 0;
            }
          } else {
            chargeRun = 0;
          }
          if (b.lastAction === 'move' && onWall && moved < 0.25) {
            pushing += 1;
            pushRun += 1;
            if (pushRun > worstPush) worstPush = pushRun;
          } else {
            pushRun = 0;
          }
          if (moved < 0.25) {
            idle += 1;
            if (idle > worstIdle) worstIdle = idle;
          } else {
            idle = 0;
          }
          prev = { x: b.x, y: b.y };
          if (b.x < minX) minX = b.x;
          if (b.x > maxX) maxX = b.x;
          if (b.y < minY) minY = b.y;
          if (b.y > maxY) maxY = b.y;
          if (state.outcome !== 'playing') break;
        }
      } finally {
        runner.dispose();
      }
    }

    const dist = distSum / ticks;
    console.log(
      `${bot.name.padEnd(13)}${`${(100 * wall / ticks).toFixed(1)}%`.padStart(6)}` +
        `${dist.toFixed(0).padStart(10)}  ${String(worstIdle).padStart(4)}` +
        `  ${`${(100 * (maxX - minX) / E.arena.w).toFixed(0)}%`.padStart(5)}` +
        `  push ${`${(100 * pushing / ticks).toFixed(1)}%`.padStart(6)}` +
        `  chargeWasted ${`${chargeTicks === 0 ? 0 : Math.round(100 * chargeStuck / chargeTicks)}%`.padStart(4)}` +
        ` (run ${String(worstChargeStuck).padStart(3)})` +
        `  x ${minX.toFixed(0)}..${maxX.toFixed(0)} y ${minY.toFixed(0)}..${maxY.toFixed(0)}`,
    );
  }
}
