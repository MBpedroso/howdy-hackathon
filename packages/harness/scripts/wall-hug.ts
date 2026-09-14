/**
 * Diagnostic: does the boss hug a wall instead of fighting in the arena?
 *
 * A playtest on 2026-09-09 reported the boss "andando de um lado pro outro mas
 * travado na lateral esquerda". Gate 3's ACTIVE assertion cannot see that. It asks
 * whether the boss *moved* (idle runs) and how far it *ranged* (`spanPx`), and a boss
 * pacing 200 px up and down the left edge answers both questions well while never
 * coming near the player. Pathologies of *where* are invisible to it.
 *
 * So this measures position rather than motion, per bot and per seed:
 *
 *  - `wall`  — fraction of ticks with the boss within one boss-radius of any wall.
 *  - `left`  — fraction of ticks spent in the leftmost 15% of the arena.
 *  - `dist`  — mean boss-to-player distance, in px and as a fraction of the arena
 *              diagonal. The number that says "it never engaged".
 *  - `spanX` — how much of the arena's width the boss's bounding box covered.
 *
 * No model call, no network: it replays the shipped strategies through the same
 * QuickJS sandbox Gate 3 uses.
 *
 *   node --experimental-strip-types scripts/wall-hug.ts
 */
import { readFileSync } from 'node:fs';
import { createGame, createRng, ENGINE_CONSTANTS as E, step } from '@rematch/engine';
import { createSandbox, monotonicClock } from '@rematch/sandbox';
import { BOT_KINDS, makeBot, playerSeed } from '../src/index.ts';

const ROOT = new URL('../../../', import.meta.url).pathname;
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
/** Within this of a wall counts as "against it": the boss cannot get closer. */
const NEAR = E.boss.radius + 6;
const DIAG = Math.hypot(E.arena.w, E.arena.h);

const targets: { name: string; path: string }[] = [
  { name: 'round1 (Cornerbreaker)', path: 'packages/web/src/strategies/round1.js' },
  { name: 'hound (Hound)', path: 'packages/web/src/strategies/hound.js' },
];

const sandbox = await createSandbox();

for (const target of targets) {
  const source = readFileSync(ROOT + target.path, 'utf8');
  console.log(`\n=== ${target.name} ===`);
  console.log('bot      wall%  left%   dist(px)  dist/diag  spanX%');

  for (const kind of BOT_KINDS) {
    let wall = 0;
    let left = 0;
    let ticks = 0;
    let distSum = 0;
    let minX = Infinity;
    let maxX = -Infinity;

    for (const seed of SEEDS) {
      const runner = sandbox.load(source, { now: monotonicClock() });
      try {
        const bot = makeBot(kind);
        bot.reset(seed);
        const state = createGame(seed, runner);
        const rng = createRng(playerSeed(seed));
        for (let i = 0; i < E.round.maxTicks; i += 1) {
          step(state, bot.act(state, rng), runner);
          const b = state.boss;
          ticks += 1;
          if (b.x <= NEAR || b.x >= E.arena.w - NEAR || b.y <= NEAR || b.y >= E.arena.h - NEAR) wall += 1;
          if (b.x <= E.arena.w * 0.15) left += 1;
          distSum += Math.hypot(state.player.x - b.x, state.player.y - b.y);
          if (b.x < minX) minX = b.x;
          if (b.x > maxX) maxX = b.x;
          if (state.outcome !== 'playing') break;
        }
      } finally {
        runner.dispose();
      }
    }

    const pct = (n: number): string => `${(100 * n / ticks).toFixed(1)}%`.padStart(6);
    const dist = distSum / ticks;
    console.log(
      `${kind.padEnd(8)} ${pct(wall)} ${pct(left)} ${dist.toFixed(0).padStart(9)}` +
        `  ${(dist / DIAG).toFixed(3).padStart(9)}  ${(100 * (maxX - minX) / E.arena.w).toFixed(0).padStart(5)}%`,
    );
  }
}
