/**
 * `pnpm --filter @rematch/engine bench`
 *
 * Two numbers the harness depends on:
 *  1. **ticks/sec** for a full 3600-tick match against the `chaser` reference strategy,
 *     with the boss and player made unkillable so every subsystem (projectiles, minions,
 *     bursts, telegraphs, charges) stays busy for the whole round. This is the worst case.
 *  2. **Balance sanity**: outcomes of real matches for each good fixture over 12 seeds,
 *     played by the scripted mid-range bot in `test/helpers.ts`.
 *
 * Gate 3 runs 200 matches per assertion (spec §6.2), so 3600 ticks x 200 = 720k ticks
 * must fit comfortably inside the interlude's 45 s budget.
 */
import { CONSTANTS, type StrategyModule } from '@rematch/contract';
import { createGame, summarizeReplay } from '../src/game.ts';
import { step } from '../src/step.ts';
import { nativeRunner } from '../src/nativeRunner.ts';
import { createRng } from '../src/prng.ts';
import { ENGINE_CONSTANTS as E } from '../src/constants.ts';
import { scriptedInput, playMatch } from '../test/helpers.ts';
import { GOOD_FIXTURES, loadGoodStrategy } from '../test/fixtures.ts';

const HUGE_HP = 1e9;

function throughput(module: StrategyModule, seed: number, ticks: number): number {
  const runner = nativeRunner(module);
  const state = createGame(seed, runner);
  state.boss.hp = HUGE_HP;
  state.player.hp = HUGE_HP;
  const rng = createRng(seed * 31 + 7);

  const t0 = performance.now();
  for (let i = 0; i < ticks; i += 1) {
    step(state, scriptedInput(state, rng), runner);
  }
  const ms = performance.now() - t0;
  return (ticks / ms) * 1000;
}

async function main(): Promise<void> {
  const chaser = await loadGoodStrategy('chaser');
  const ticks = E.round.maxTicks;

  // Warm up so the JIT is not being benchmarked.
  throughput(chaser, 99, ticks);

  const runs = [1, 2, 3, 4, 5].map((seed) => throughput(chaser, seed, ticks));
  const best = Math.max(...runs);
  const mean = runs.reduce((a, b) => a + b, 0) / runs.length;

  console.log('=== @rematch/engine bench ===');
  console.log(`match length      : ${ticks} ticks (${ticks / CONSTANTS.ticksPerSecond}s)`);
  console.log(`ticks/sec (mean)  : ${Math.round(mean).toLocaleString('en-US')}`);
  console.log(`ticks/sec (best)  : ${Math.round(best).toLocaleString('en-US')}`);
  console.log(`ms per 3600-tick match: ${((ticks / mean) * 1000).toFixed(2)}`);
  console.log(`200-match Gate 3 sim  : ${(((ticks * 200) / mean) * 1000 / 1000).toFixed(2)}s (single-threaded, worst case)`);

  console.log('\n=== balance sanity (scripted mid-range bot, 12 seeds) ===');
  console.log('strategy        bossWins  playerWins  timeouts  avg s  avg bossHp  violations');
  for (const name of GOOD_FIXTURES) {
    const module = await loadGoodStrategy(name);
    let bossWins = 0;
    let playerWins = 0;
    let timeouts = 0;
    let totalTicks = 0;
    let bossHp = 0;
    let violations = 0;
    for (let seed = 1; seed <= 12; seed += 1) {
      const { final } = playMatch(seed, nativeRunner(module), seed * 31 + 7);
      if (final.outcome === 'playerWon') playerWins += 1;
      else if (final.outcome === 'bossWon') bossWins += 1;
      else timeouts += 1;
      totalTicks += final.tick;
      bossHp += final.boss.hp;
      violations += summarizeReplay(final).contract.violations;
    }
    const secs = totalTicks / 12 / CONSTANTS.ticksPerSecond;
    console.log(
      `${name.padEnd(15)} ${String(bossWins).padStart(8)} ${String(playerWins).padStart(11)} ${String(timeouts).padStart(9)} ${secs.toFixed(1).padStart(6)} ${(bossHp / 12).toFixed(1).padStart(11)} ${String(violations).padStart(11)}`,
    );
  }
}

await main();
