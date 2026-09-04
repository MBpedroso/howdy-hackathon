/**
 * Generate `canned/*.json` — the eval's ten replays.
 *
 * ```
 * pnpm --filter @rematch/agents gen-canned
 * ```
 *
 * Each spec plays one reference bot, as the player, against one reference strategy
 * on a fixed seed, and writes `summarizeReplay` of the final state. No LLM, no
 * network, no clock: run it twice and the files are identical, which is the only
 * reason the eval's pass rate means anything across runs.
 *
 * Every spec is a round the **player won**, because that is the only round that
 * reaches the interlude (spec §2.1: a loss goes to the game-over screen). Which
 * reference strategy each archetype plays against is therefore not free — it is
 * whichever one that archetype can actually beat, since the round-1 boss is by
 * design a boss the player gets past. `cornerbreaker` is used wherever the
 * archetype beats it (the mobile ones), and the weaker references where it does
 * not: a Camper loses to `cornerbreaker` on every seed, which is exactly what
 * `cornerbreaker` was written to do.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { summarizeReplay, type ReplaySummary } from '@rematch/engine';
import { getSandbox, makeBot, makeMimic, playMatchState, type BotKind, type PlayerBot } from '@rematch/harness';
import { CANNED_NAMES, type CannedName } from '../src/canned.ts';

type GoodStrategy = 'idle' | 'chaser' | 'orbiter' | 'cornerbreaker';

type Spec = {
  name: CannedName;
  /** A scripted bot, or a Mimic built from an already-generated summary. */
  bot: { kind: BotKind; accuracy: number } | { kind: 'mimic'; of: CannedName; accuracy: number };
  boss: GoodStrategy;
  seed: number;
};

/**
 * Accuracy is the skill dial (`BASE_AIM_ERROR` scales by `1 - accuracy`). The `-a`
 * variant of each archetype is a competent player, the `-b` variant is the same
 * archetype played differently — sloppier or sharper — so the Analyst has to
 * distinguish *degree* as well as kind.
 */
const SPECS: readonly Spec[] = [
  { name: 'camper-a', bot: { kind: 'camper', accuracy: 0.85 }, boss: 'idle', seed: 0x1a2b3c4d },
  { name: 'camper-b', bot: { kind: 'camper', accuracy: 0.68 }, boss: 'idle', seed: 0x4d5e6f70 },
  { name: 'kiter-a', bot: { kind: 'kiter', accuracy: 0.82 }, boss: 'cornerbreaker', seed: 0x3c4d5e6f },
  { name: 'kiter-b', bot: { kind: 'kiter', accuracy: 0.7 }, boss: 'orbiter', seed: 0x2b3c4d5e },
  { name: 'rusher-a', bot: { kind: 'rusher', accuracy: 0.85 }, boss: 'cornerbreaker', seed: 0x1a2b3c4d },
  { name: 'rusher-b', bot: { kind: 'rusher', accuracy: 0.95 }, boss: 'idle', seed: 0x6f708192 },
  // The Dodger only dashes when something is telegraphed at it, so it is paired
  // with `chaser`: against `cornerbreaker` it wins with **zero** dashes, and a
  // replay with an empty dash rose cannot exercise the Analyst's archetype call.
  { name: 'dodger-a', bot: { kind: 'dodger', accuracy: 0.85 }, boss: 'chaser', seed: 0x92a3b4c5 },
  { name: 'dodger-b', bot: { kind: 'dodger', accuracy: 0.7 }, boss: 'chaser', seed: 0x1a2b3c4d },
  { name: 'mimic-camper', bot: { kind: 'mimic', of: 'camper-a', accuracy: 0.85 }, boss: 'idle', seed: 0x92a3b4c5 },
  { name: 'mimic-rusher', bot: { kind: 'mimic', of: 'rusher-a', accuracy: 0.88 }, boss: 'idle', seed: 0xa3b4c5d6 },
];

const outDir = new URL('../canned/', import.meta.url);
const goodDir = new URL('../../contract/test/fixtures/strategies/good/', import.meta.url);

function readStrategy(name: GoodStrategy): string {
  return readFileSync(new URL(`${name}.js`, goodDir), 'utf8');
}

async function main(): Promise<void> {
  mkdirSync(fileURLToPath(outDir), { recursive: true });
  const sandbox = await getSandbox();
  const summaries = new Map<CannedName, ReplaySummary>();

  const missing = CANNED_NAMES.filter((n) => !SPECS.some((s) => s.name === n));
  if (missing.length > 0) throw new Error(`no spec for canned replay(s): ${missing.join(', ')}`);

  for (const spec of SPECS) {
    let bot: PlayerBot;
    if (spec.bot.kind === 'mimic') {
      const source = summaries.get(spec.bot.of);
      if (source === undefined) {
        throw new Error(`${spec.name} mimics ${spec.bot.of}, which must be generated first`);
      }
      bot = makeMimic(source, { accuracy: spec.bot.accuracy });
    } else {
      bot = makeBot(spec.bot.kind, { accuracy: spec.bot.accuracy });
    }

    const bossStrategy = readStrategy(spec.boss);
    const runner = sandbox.load(bossStrategy);
    let summary: ReplaySummary;
    try {
      summary = summarizeReplay(playMatchState(runner, bot, spec.seed));
    } finally {
      runner.dispose();
    }
    summaries.set(spec.name, summary);

    const file = fileURLToPath(new URL(`${spec.name}.json`, outDir));
    writeFileSync(
      file,
      `${JSON.stringify(
        {
          name: spec.name,
          generatedBy: 'pnpm --filter @rematch/agents gen-canned',
          spec: { bot: spec.bot, boss: spec.boss, seed: spec.seed },
          bossStrategy,
          summary,
        },
        null,
        2,
      )}\n`,
    );

    const hot = summary.history.playerPosHeat.reduce((m, v) => (v > m ? v : m), 0);
    console.log(
      `${spec.name.padEnd(13)} vs ${spec.boss.padEnd(14)} ${summary.outcome.padEnd(10)} ` +
        `${String(summary.durations.ticks).padStart(4)}t  shots ${String(summary.player.shots).padStart(3)}  ` +
        `dashes ${String(summary.player.dashes).padStart(3)}  bossHp ${String(summary.boss.hpEnd).padStart(3)}  ` +
        `peakCell ${(hot * 100).toFixed(0)}%`,
    );
  }

  console.log(`\nwrote ${SPECS.length} canned replays to ${fileURLToPath(outDir)}`);
}

await main();
