/**
 * The reference bot panel (spec §6.1). Three properties matter, and each one is a
 * load-bearing assumption of Gate 3's verdict:
 *
 *  1. **Determinism.** Same seed → same input sequence, byte for byte. Without it a
 *     rejection cannot be replayed and stops being evidence (spec §7).
 *  2. **Read-only.** A bot is handed the whole `GameState` because it stands in for
 *     a human who can see the screen. If it *wrote* to that state it would be
 *     cheating, and the sim would stop describing the game.
 *  3. **The Mimic is actually a mimic.** A camper's replay and a rusher's replay
 *     have to produce visibly different players, or ADAPTED measures nothing.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { hashValue, summarizeReplay, type GameState, type PlayerInput } from '@rematch/engine';
import { createSandbox, type SandboxFactory } from '@rematch/sandbox';
import type { StrategyRunner } from '@rematch/contract';
import {
  BOT_KINDS,
  PANEL,
  accuracyFromSummary,
  camper,
  dodger,
  kiter,
  makeBot,
  makeMimic,
  rusher,
  type PlayerBot,
} from '../src/bots/index.ts';
import { playMatchState, playerSeed, runMatchWith, summarizeMatch } from '../src/sim/runMatch.ts';
import { readGood } from './helpers.ts';

let sandbox: SandboxFactory;
let idle: StrategyRunner;
let chaser: StrategyRunner;

beforeAll(async () => {
  sandbox = await createSandbox();
  idle = sandbox.load(readGood('idle'));
  chaser = sandbox.load(readGood('chaser'));
  return () => {
    idle.dispose();
    chaser.dispose();
  };
});

/** The inputs a bot produces over one match, as a hashable list. */
function inputTrace(runner: StrategyRunner, bot: PlayerBot, seed: number, ticks = 400): PlayerInput[] {
  const trace: PlayerInput[] = [];
  const state = playMatchStateWithTrace(runner, bot, seed, ticks, trace);
  expect(state.tick).toBeGreaterThan(0);
  return trace;
}

/** `playMatchState`, but recording what the bot asked for each tick. */
function playMatchStateWithTrace(
  runner: StrategyRunner,
  bot: PlayerBot,
  seed: number,
  ticks: number,
  trace: PlayerInput[],
): GameState {
  const spy: PlayerBot = {
    name: bot.name,
    reset: (s) => bot.reset(s),
    act(state, rng) {
      const input = bot.act(state, rng);
      if (trace.length < ticks) trace.push(input);
      return input;
    },
  };
  return playMatchState(runner, spy, seed);
}

describe('the panel', () => {
  it('is the four scripted bots, in a fixed order', () => {
    expect(PANEL.map((b) => b.name)).toEqual(['Camper', 'Kiter', 'Rusher', 'Dodger']);
    expect(BOT_KINDS.length).toBe(PANEL.length);
  });

  it.each(BOT_KINDS)('%s is deterministic: same seed, same inputs', (kind) => {
    const a = inputTrace(chaser, makeBot(kind), 7);
    const b = inputTrace(chaser, makeBot(kind), 7);
    expect(hashValue(b)).toBe(hashValue(a));
    // And one instance replayed twice must not carry state over from the first match.
    const reused = makeBot(kind);
    expect(hashValue(inputTrace(chaser, reused, 7))).toBe(hashValue(a));
    expect(hashValue(inputTrace(chaser, reused, 7))).toBe(hashValue(a));
  });

  it.each(BOT_KINDS)('%s produces different play on a different seed', (kind) => {
    const a = inputTrace(chaser, makeBot(kind), 7);
    const b = inputTrace(chaser, makeBot(kind), 8);
    expect(hashValue(b)).not.toBe(hashValue(a));
  });

  it.each(BOT_KINDS)('%s never mutates the state it is shown', (kind) => {
    const bot = makeBot(kind);
    bot.reset(3);
    const state = playMatchState(idle, makeBot(kind), 3);
    const before = hashValue(state);
    // Hand it the same state 200 times; nothing it does may change the world.
    const rng = { next: () => 0.5, int: (n: number) => Math.floor(n / 2), state: () => 1 };
    for (let i = 0; i < 200; i += 1) bot.act(state, rng);
    expect(hashValue(state)).toBe(before);
  });

  it.each(BOT_KINDS)('%s beats the null boss on every seed', (kind) => {
    // `idle.js` is the calibration baseline: a bot that cannot beat a boss which
    // does nothing cannot measure anything (see the fixture's own comment).
    for (const seed of [1, 2, 3, 4, 5]) {
      const result = runMatchWith(idle, makeBot(kind), seed);
      expect(result.bossWon, `${kind} seed ${seed} (${result.outcome}, ${result.ticks} ticks)`).toBe(false);
    }
  });

  it('spans a range of skill: the Dodger survives what the Camper does not', () => {
    const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
    const rate = (bot: PlayerBot): number =>
      seeds.filter((s) => runMatchWith(chaser, bot, s).bossWon).length / seeds.length;
    // A panel whose members all score the same measures one thing, not four.
    expect(rate(camper())).toBeGreaterThan(rate(dodger()));
  });

  it('accuracy is a per-bot parameter that changes the outcome', () => {
    const seeds = [1, 2, 3, 4, 5, 6];
    const damage = (accuracy: number): number => {
      let total = 0;
      for (const seed of seeds) total += playMatchState(idle, kiter({ accuracy }), seed).damageDealt;
      return total / seeds.length;
    };
    // A blind bot needs many more shots to grind the boss down, so at a fixed
    // number of ticks it has dealt less damage.
    expect(damage(0.95)).toBeGreaterThan(0);
    const wild = kiter({ accuracy: 0 });
    const sharp = kiter({ accuracy: 1 });
    const shotsFor = (bot: PlayerBot): number => {
      let shots = 0;
      for (const seed of seeds) shots += playMatchState(idle, bot, seed).counts.shots;
      return shots;
    };
    expect(shotsFor(wild)).toBeGreaterThan(shotsFor(sharp));
  });
});

describe('the Mimic', () => {
  it('is built from a ReplaySummary and nothing else', () => {
    const summary = summarizeMatch(idle, camper(), 11);
    const mimic = makeMimic(summary);
    expect(mimic.name).toBe('Mimic');
    // Same summary, same seed, same play.
    expect(hashValue(inputTrace(chaser, makeMimic(summary), 5))).toBe(
      hashValue(inputTrace(chaser, makeMimic(summary), 5)),
    );
  });

  it('plays visibly differently for a camper replay than for a rusher replay', () => {
    const camperSummary = summarizeMatch(idle, camper(), 11);
    const rusherSummary = summarizeMatch(idle, rusher(), 11);

    const camperTrace = inputTrace(chaser, makeMimic(camperSummary), 5);
    const rusherTrace = inputTrace(chaser, makeMimic(rusherSummary), 5);
    expect(hashValue(rusherTrace)).not.toBe(hashValue(camperTrace));

    // Not just "different bytes": the two stand in different places. The camper's
    // heat map is one corner cell, the rusher's is the middle of the arena, so the
    // distance each Mimic keeps from the boss has to differ.
    const avgDistance = (summary: ReturnType<typeof summarizeReplay>): number => {
      let total = 0;
      let n = 0;
      const bot = makeMimic(summary);
      const spy: PlayerBot = {
        name: bot.name,
        reset: (s) => bot.reset(s),
        act(state, rng) {
          total += Math.hypot(state.player.x - state.boss.x, state.player.y - state.boss.y);
          n += 1;
          return bot.act(state, rng);
        },
      };
      playMatchState(idle, spy, 5);
      return total / Math.max(1, n);
    };
    const camperDistance = avgDistance(camperSummary);
    const rusherDistance = avgDistance(rusherSummary);
    expect(Math.abs(camperDistance - rusherDistance)).toBeGreaterThan(60);
  });

  it('shoots on the human\'s trigger discipline, not its own', () => {
    const eager = summarizeMatch(idle, kiter(), 11);
    const shy = { ...eager, player: { ...eager.player, shots: 2 } };
    const shotsWith = (summary: typeof eager): number =>
      playMatchState(idle, makeMimic(summary), 5).counts.shots;
    expect(shotsWith(eager)).toBeGreaterThan(shotsWith(shy) * 3);
  });

  it('survives an all-zero heat map (a replay with no dwell data)', () => {
    const summary = summarizeMatch(idle, camper(), 11);
    const empty = {
      ...summary,
      history: {
        playerPosHeat: new Array<number>(64).fill(0),
        playerDashDirs: new Array<number>(8).fill(0),
        playerShotsDuring: { move: 0, burst: 0, charge: 0, slam: 0, spawn: 0 },
      },
      player: { ...summary.player, shots: 0, dashes: 0 },
    };
    const result = runMatchWith(chaser, makeMimic(empty), 1);
    expect(result.ticks).toBeGreaterThan(0);
  });

  /**
   * Calibration (analysis item 3): `accuracy` used to be fixed at 0.72 regardless
   * of who the Mimic imitated. It is now derived from the summary's real hit rate
   * (`boss.damageTaken / player.shots`) unless a caller overrides it — and that
   * override still has to work, because Gate 3's `accuracy` probe path
   * (`measureMimicWinRate`'s `opts.accuracy`) and every existing `makeMimic`
   * caller that passes one rely on it.
   */
  describe('accuracy calibration', () => {
    it('derives a sharper accuracy for a summary with a higher measured hit rate', () => {
      const sharp: ReturnType<typeof summarizeReplay> = {
        ...summarizeMatch(idle, camper(), 11),
        player: { ...summarizeMatch(idle, camper(), 11).player, shots: 100 },
        boss: { ...summarizeMatch(idle, camper(), 11).boss, damageTaken: 100 },
      };
      const wild = { ...sharp, player: { ...sharp.player, shots: 100 }, boss: { ...sharp.boss, damageTaken: 20 } };
      expect(accuracyFromSummary(sharp)).toBeGreaterThan(accuracyFromSummary(wild));
    });

    it('never derives a blind (0) or laser-perfect (1) accuracy, even from a degenerate summary', () => {
      const base = summarizeMatch(idle, camper(), 11);
      const noHits = { ...base, player: { ...base.player, shots: 200 }, boss: { ...base.boss, damageTaken: 0 } };
      const aboveHundredPercent = { ...base, player: { ...base.player, shots: 2 } }; // damageTaken unchanged, hits > shots
      for (const summary of [noHits, aboveHundredPercent]) {
        const acc = accuracyFromSummary(summary);
        expect(acc).toBeGreaterThan(0);
        expect(acc).toBeLessThan(1);
      }
    });

    it('falls back to the old fixed default when a summary carries no shots at all', () => {
      const base = summarizeMatch(idle, camper(), 11);
      const noShots = { ...base, player: { ...base.player, shots: 0 } };
      expect(accuracyFromSummary(noShots)).toBe(0.72);
    });

    it('an explicit opts.accuracy still overrides the derived value', () => {
      const summary = summarizeMatch(idle, camper(), 11);
      const derived = accuracyFromSummary(summary);
      const overridden = makeMimic(summary, { accuracy: derived + 0.1 > 1 ? derived - 0.1 : derived + 0.1 });
      // The override took effect: replaying with the bare derived accuracy (no
      // override) and with the override must not collapse to the same trace.
      const overriddenTrace = inputTrace(chaser, overridden, 5);
      const derivedTrace = inputTrace(chaser, makeMimic(summary), 5);
      expect(hashValue(overriddenTrace)).not.toBe(hashValue(derivedTrace));
    });
  });
});

describe('match seeding', () => {
  it('derives a well-spread player seed from adjacent match seeds', () => {
    const seeds = new Set([1, 2, 3, 4, 5].map(playerSeed));
    expect(seeds.size).toBe(5);
    // Adjacent match seeds must not give adjacent xorshift states, or two matches
    // would play out almost identically for the first few hundred ticks.
    expect(Math.abs(playerSeed(1) - playerSeed(2))).toBeGreaterThan(1000);
  });
});
