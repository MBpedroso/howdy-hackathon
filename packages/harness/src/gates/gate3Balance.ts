/**
 * Gate 3 — balance. The gate that decides whether a strategy is *fun*, which is
 * the one property no static check can see.
 *
 * Two assertions (spec §6.2), both measured by simulating real matches in the same
 * QuickJS sandbox the live game uses:
 *
 * ```
 * ADAPTED :  win_rate(boss vs Mimic)  >= 0.70          "it countered how you played"
 * FAIR    :  win_rate(boss vs panel)  in BAND[round]   "…but a different approach still beats it"
 * ```
 *
 * ADAPTED needs the player's replay, so it is checked **only** when a
 * `mimicSummary` is supplied — the balance-regression suite and the CLI often have
 * no human to mimic, and a gate that failed for lack of input would be useless
 * there. FAIR is always checked.
 *
 * ## The match budget
 * `matches` (default 200, per spec §6.2) is split in half: `N/2` against the Mimic,
 * `N/2` spread evenly across the four scripted bots. The panel's half is spent the
 * same way whether or not a summary was given, so the FAIR number for one strategy
 * and round is comparable across runs — a verdict you cannot compare is not
 * evidence. Seeds come from a fixed set (`seedsFor`), so the verdict is identical
 * on every machine, and the two assertions never share a match.
 *
 * ## Progress
 * The gate is the slow one — 200 matches is seconds, not milliseconds — so it
 * reports `onProgress(done, total)` across both halves of the budget. The
 * simulator batches the callbacks; `gate3Plan` is the same arithmetic run up front,
 * so a caller can label its meter before the first match starts.
 *
 * ## The reason string
 * Quantitative and directive, per spec §6.3 — it is the only feedback the Coder
 * agent gets:
 *
 * ```
 * 0.91 vs panel — too hard (band 0.35–0.50 for round 2; Camper 1.00, Kiter 0.96,
 *   Rusher 0.92, Dodger 0.76); 0.41 vs Mimic — didn't adapt (need >= 0.70)
 * ```
 */
import type { ReplaySummary } from '@rematch/engine';
import type { SandboxFactory } from '@rematch/sandbox';
import { BOT_KINDS } from '../bots/index.ts';
import { simulate, type BotRate, type SimulateResult } from '../sim/simulate.ts';
import type { BotSpec } from '../sim/protocol.ts';
import {
  ADAPTED_MIN,
  DEFAULT_MATCHES,
  DEFAULT_ROUND,
  SEED_OFFSET,
  bandFor,
  formatBand,
  seedsFor,
  type BalanceRound,
} from './balanceConfig.ts';
import { gateFail, gateOk, type GateResult } from './types.ts';

export type Gate3Options = {
  /** Which round's fairness band to check (spec §6.2). Default 2. */
  round?: BalanceRound;
  /**
   * The player's replay, compressed by `summarizeReplay`. Supplying it enables the
   * ADAPTED assertion; without it only FAIR is checked.
   */
  mimicSummary?: ReplaySummary;
  /** Total matches. Default 200. Half vs the Mimic, half across the panel. */
  matches?: number;
  /** Worker threads. Default `availableParallelism() - 1`. 1 runs inline. */
  workers?: number;
  /** Aim accuracy for every bot, 0–1. Defaults are per-bot; override for a probe. */
  accuracy?: number;
  /** Inline path only (workers = 1): reuse an existing sandbox. */
  sandbox?: SandboxFactory;
  /**
   * Progress across **both** halves of the budget: `done` runs from 0 to
   * `gate3Plan(opts).total`, the panel's matches first and the Mimic's after, so a
   * caller sees one bar for the gate rather than two. Batched by the simulator
   * (`progressBatch`) and closed with a final `(total, total)`.
   */
  onProgress?: (done: number, total: number) => void;
  now?: () => number;
};

/** How the match budget is spent, computed before anything runs. */
export type Gate3Plan = {
  /** Seeds per panel bot. */
  perBotSeeds: number;
  /** Seeds against the Mimic. 0 when no summary was supplied. */
  mimicSeeds: number;
  /** `perBotSeeds x 4`. */
  panelMatches: number;
  mimicMatches: number;
  /** What `detail.matches` will report, and the denominator of `onProgress`. */
  total: number;
};

/**
 * The match plan for a set of options.
 *
 * Exported because a progress meter needs the denominator *before* the gate runs,
 * and because rounding (`matches / 2 / 4`) means the total is rarely exactly
 * `matches`: at 60 requested the gate really runs 62. A meter that started at 60
 * and finished at 62 would be the only dishonest number on the Trial beat.
 */
export function gate3Plan(opts: Gate3Options = {}): Gate3Plan {
  const matches = Math.max(8, Math.trunc(opts.matches ?? DEFAULT_MATCHES));
  const perBotSeeds = Math.max(1, Math.round(matches / 2 / BOT_KINDS.length));
  const mimicSeeds = opts.mimicSummary === undefined ? 0 : Math.max(1, Math.round(matches / 2));
  const panelMatches = perBotSeeds * BOT_KINDS.length;
  const mimicMatches = mimicSeeds;
  return { perBotSeeds, mimicSeeds, panelMatches, mimicMatches, total: panelMatches + mimicMatches };
}

const pct = (v: number): string => v.toFixed(2);

/** `Camper 1.00, Kiter 0.96, …` — the per-bot breakdown inside a reason. */
function renderPerBot(rates: readonly BotRate[]): string {
  return rates.map((b) => `${b.name} ${pct(b.winRate)}`).join(', ');
}

export async function gate3Balance(source: string, opts: Gate3Options = {}): Promise<GateResult> {
  const now = opts.now ?? ((): number => performance.now());
  const started = now();
  const elapsed = (): number => now() - started;

  const round = opts.round ?? DEFAULT_ROUND;
  const [lo, hi] = bandFor(round);
  const matches = Math.max(8, Math.trunc(opts.matches ?? DEFAULT_MATCHES));
  const accuracy = opts.accuracy;

  // N/2 across the four panel bots, N/2 against the Mimic.
  const plan = gate3Plan(opts);
  const { perBotSeeds } = plan;
  const mimicSeeds = Math.max(1, plan.mimicSeeds);

  const panelSpecs: BotSpec[] = BOT_KINDS.map((kind) =>
    accuracy === undefined ? { kind } : { kind, accuracy },
  );

  const shared = {
    source,
    ...(opts.workers === undefined ? {} : { workers: opts.workers }),
    ...(opts.sandbox === undefined ? {} : { sandbox: opts.sandbox }),
  };

  // One bar over two simulations: the panel's matches occupy [0, panelMatches) and
  // the Mimic's continue from there, so `done` never restarts.
  const onProgress = opts.onProgress;
  const relay =
    onProgress === undefined
      ? {}
      : { onProgress: (done: number): void => onProgress(Math.min(done, plan.total), plan.total) };
  const relayMimic =
    onProgress === undefined
      ? {}
      : {
          onProgress: (done: number): void =>
            onProgress(Math.min(plan.panelMatches + done, plan.total), plan.total),
        };

  let panel: SimulateResult;
  let mimic: SimulateResult | undefined;
  try {
    panel = await simulate({
      ...shared,
      ...relay,
      bots: panelSpecs,
      seeds: seedsFor(perBotSeeds, SEED_OFFSET.panel),
    });
    if (opts.mimicSummary !== undefined) {
      const spec: BotSpec =
        accuracy === undefined
          ? { kind: 'mimic', summary: opts.mimicSummary }
          : { kind: 'mimic', summary: opts.mimicSummary, accuracy };
      mimic = await simulate({
        ...shared,
        ...relayMimic,
        bots: [spec],
        seeds: seedsFor(mimicSeeds, SEED_OFFSET.mimic),
      });
    }
  } catch (err) {
    // A load failure here means Gate 2 was skipped or the sandbox itself broke;
    // either way it is a rejection with a reason, not a thrown gate.
    return gateFail(3, elapsed(), `the balance simulation could not run: ${(err as Error).message}`, {
      round,
      band: [lo, hi],
      matches,
    });
  }

  const detail = {
    round,
    band: [lo, hi] as const,
    thresholds: { adaptedMin: ADAPTED_MIN, fairMin: lo, fairMax: hi },
    matches: panel.matches + (mimic?.matches ?? 0),
    workers: panel.workers,
    panel: {
      winRate: panel.winRate,
      matches: panel.matches,
      perBot: panel.perBot,
      violations: panel.violations,
      killed: panel.killed,
      ms: panel.ms,
    },
    ...(mimic === undefined
      ? { adapted: 'skipped: no replay summary was supplied' as const }
      : {
          mimic: {
            winRate: mimic.winRate,
            matches: mimic.matches,
            avgTicks: mimic.perBot[0]?.avgTicks ?? 0,
            violations: mimic.violations,
            killed: mimic.killed,
            ms: mimic.ms,
          },
        }),
  };

  const problems: string[] = [];
  if (panel.winRate > hi) {
    problems.push(
      `${pct(panel.winRate)} vs panel — too hard (band ${formatBand(round)} for round ${round}; ${renderPerBot(panel.perBot)})`,
    );
  } else if (panel.winRate < lo) {
    problems.push(
      `${pct(panel.winRate)} vs panel — too easy (band ${formatBand(round)} for round ${round}; ${renderPerBot(panel.perBot)})`,
    );
  }
  if (mimic !== undefined && mimic.winRate < ADAPTED_MIN) {
    problems.push(`${pct(mimic.winRate)} vs Mimic — didn't adapt (need >= ${pct(ADAPTED_MIN)})`);
  }

  if (problems.length > 0) return gateFail(3, elapsed(), problems.join('; '), detail);
  return gateOk(3, elapsed(), detail);
}
