/**
 * The reference bot panel (spec §6.1) — the opponents Gate 3 measures a boss
 * against, because the one opponent it cannot use is the human.
 *
 * ```ts
 * for (const bot of PANEL) { bot.reset(seed); }   // then play a match with each
 * const mimic = makeMimic(summarizeReplay(finalState));
 * ```
 *
 * A bot instance is **stateful** (it remembers its orbit direction, its target
 * cell, the boss's last position for lead-aiming) and `reset(seed)` clears all of
 * it. One instance therefore plays any number of matches *sequentially*; it must
 * never be shared between concurrent matches, which is why each simulation worker
 * builds its own via `makeBot`.
 */
export { camper } from './camper.ts';
export { dodger } from './dodger.ts';
export { kiter } from './kiter.ts';
export { accuracyFromSummary, makeMimic } from './mimic.ts';
export { rusher } from './rusher.ts';
export { BASE_AIM_ERROR, BOT_KINDS, type BotKind, type BotOptions, type PlayerBot } from './types.ts';
export {
  makeAimer,
  nearestIncoming,
  slamTelegraph,
  chargeTelegraph,
  clearanceIfMoving,
  distanceToChargeLine,
  type Aimer,
} from './shared.ts';

import type { ReplaySummary } from '@rematch/engine';
import { camper } from './camper.ts';
import { dodger } from './dodger.ts';
import { kiter } from './kiter.ts';
import { makeMimic } from './mimic.ts';
import { rusher } from './rusher.ts';
import { BOT_KINDS, type BotKind, type BotOptions, type PlayerBot } from './types.ts';

const FACTORIES: Record<BotKind, (opts?: BotOptions) => PlayerBot> = {
  camper,
  kiter,
  rusher,
  dodger,
};

/** Build one scripted bot by name. */
export function makeBot(kind: BotKind, opts: BotOptions = {}): PlayerBot {
  return FACTORIES[kind](opts);
}

/**
 * The four scripted bots, in a fixed order. Order is load-bearing: it is the
 * reduction order of the FAIR aggregate, so a Gate 3 verdict is reproducible
 * down to the last floating-point bit regardless of how the work was scheduled.
 */
export const PANEL: readonly PlayerBot[] = BOT_KINDS.map((kind) => makeBot(kind));

/** A fresh panel — use this when matches may run concurrently. */
export function makePanel(opts: BotOptions = {}): PlayerBot[] {
  return BOT_KINDS.map((kind) => makeBot(kind, opts));
}

/** The Mimic, plus the four scripted bots. Convenience for the balance table. */
export function makeFullPanel(summary: ReplaySummary, opts: BotOptions = {}): PlayerBot[] {
  return [...makePanel(opts), makeMimic(summary, opts)];
}
