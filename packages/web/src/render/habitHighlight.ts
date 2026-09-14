/**
 * "It knows your ground" — a brief floor highlight the tick the boss telegraphs a
 * slam whose target sits inside one of the player's habit cells (`habitCells.ts`),
 * or spawns a minion inside one.
 *
 * Same shape as `effects.ts`'s tracker for the same reason: it tails `state.events`
 * so it never re-derives "did something new just happen" from a diff of positions,
 * and it ages in ticks so it freezes with the sim rather than drifting against
 * wall-clock time. Kept as its own module instead of a new `EffectKind` because it
 * depends on `habitCells`, which the general effect tracker has no reason to know
 * about — and because "was this the tick a slam started" needs `state.boss.telegraph`
 * read at the same tick as the event, which `effects.ts` already does for its own
 * `slam` effect (see its `ingest`).
 */
import { CONSTANTS } from '@rematch/contract';
import type { GameState } from '@rematch/engine';

import { habitCellAt, type HotCell } from './habitCells.ts';

const ARENA_W = CONSTANTS.arena.w;
const ARENA_H = CONSTANTS.arena.h;

export type HabitHighlight = {
  cell: HotCell;
  /** Tick the highlight was triggered. */
  born: number;
  /** Lifetime in ticks. */
  ttl: number;
};

/** ~1 second at 60 ticks/second — "brief", per the brief. */
export const HABIT_HIGHLIGHT_TTL_TICKS = 60;

export type HabitHighlightTracker = {
  /**
   * Ingest everything that happened since the last call. Call once per frame with
   * this round's habit cells (`[]` when there is no previous summary — the tracker
   * then never triggers, which is the silent-no-op the feature promises).
   */
  sync(state: GameState, cells: readonly HotCell[]): void;
  /** The most recently triggered highlight still alive on `tick`, or `null`. */
  current(tick: number): HabitHighlight | null;
  /** Forget everything — call when a new round starts. */
  reset(): void;
};

export function createHabitHighlightTracker(): HabitHighlightTracker {
  let seen = 0;
  let live: HabitHighlight[] = [];

  function trigger(point: { x: number; y: number }, cells: readonly HotCell[], tick: number): void {
    const cell = habitCellAt(point, cells, ARENA_W, ARENA_H);
    if (cell !== null) live.push({ cell, born: tick, ttl: HABIT_HIGHLIGHT_TTL_TICKS });
  }

  return {
    sync(state, cells): void {
      // A new round resets `events`; detect it the same way `effects.ts` does.
      if (state.events.length < seen) {
        seen = 0;
        live = [];
      }

      if (cells.length > 0) {
        for (let i = seen; i < state.events.length; i += 1) {
          const ev = state.events[i];
          if (ev === undefined) continue;
          if (ev.kind === 'bossSlamStart') {
            const tg = state.boss.telegraph;
            if (tg !== null && tg.type === 'slam') trigger({ x: tg.x, y: tg.y }, cells, ev.tick);
          } else if (ev.kind === 'bossSpawn') {
            const id = typeof ev.detail === 'number' ? ev.detail : null;
            const minion = id === null ? undefined : state.minions.find((m) => m.id === id);
            if (minion !== undefined) trigger({ x: minion.x, y: minion.y }, cells, ev.tick);
          }
        }
      }
      seen = state.events.length;

      const tick = state.tick;
      live = live.filter((h) => tick - h.born <= h.ttl);
    },

    current(tick): HabitHighlight | null {
      if (live.length === 0) return null;
      return live[live.length - 1] ?? null;
    },

    reset(): void {
      seen = 0;
      live = [];
    },
  };
}
