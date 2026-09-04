/**
 * What crosses the worker boundary, and how a bot is described in a message.
 *
 * A `PlayerBot` is a closure: it cannot be posted to a worker. So the simulator
 * passes **specs** — plain data — and each worker builds its own bot instances from
 * them. That also keeps the two execution paths honest: the inline path builds bots
 * from exactly the same specs, so "1 worker" and "8 workers" cannot drift.
 */
import type { ReplaySummary } from '@rematch/engine';
import { makeBot, makeMimic, type BotKind, type PlayerBot } from '../bots/index.ts';
import type { MatchResult } from './runMatch.ts';

export type BotSpec =
  | { kind: BotKind; accuracy?: number }
  | { kind: 'mimic'; summary: ReplaySummary; accuracy?: number };

/** Build the bot a spec describes. Deterministic: no state outlives the call. */
export function botFromSpec(spec: BotSpec): PlayerBot {
  const opts = spec.accuracy === undefined ? {} : { accuracy: spec.accuracy };
  return spec.kind === 'mimic' ? makeMimic(spec.summary, opts) : makeBot(spec.kind, opts);
}

/** `Mimic`, `Camper`, … — the key a result is reported under. */
export function botSpecName(spec: BotSpec): string {
  return botFromSpec(spec).name;
}

export type ToWorker =
  | { type: 'init'; source: string; specs: BotSpec[] }
  | { type: 'job'; index: number; bot: number; seed: number }
  | { type: 'stop' };

export type FromWorker =
  | { type: 'ready'; loadMs: number }
  | { type: 'done'; index: number; result: MatchResult }
  | { type: 'error'; message: string; index?: number };
