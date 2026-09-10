/**
 * `render/habitHighlight.ts` — the tracker that turns "a slam or spawn landed
 * inside a habit cell" into a brief, aged highlight. Built on a real `GameState`
 * (via `createGame`/`pushEvent`, as `hud.test.ts` does) rather than a hand-rolled
 * fake, so the tracker is exercised against the exact shapes `step.ts` produces.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createGame, pushEvent, type GameState } from '@rematch/engine';

import { createHabitHighlightTracker, HABIT_HIGHLIGHT_TTL_TICKS } from '../src/render/habitHighlight.ts';
import type { HotCell } from '../src/render/habitCells.ts';

const noopRunner = {
  meta: { name: 'Test', rationale: 'x', version: 1 },
  init: () => {},
  decide: () => ({ ok: true as const, action: { type: 'idle' as const }, elapsedMs: 0 }),
  memoryBytes: () => 0,
  dispose: () => {},
};

function game(): GameState {
  return createGame(1, noopRunner);
}

const HABIT_CELL: HotCell = { cell: 9, share: 0.5, x: 150, y: 150 };
const AWAY_CELL: HotCell = { cell: 40, share: 0.2, x: 550, y: 550 };

describe('createHabitHighlightTracker', () => {
  it('does nothing on an ordinary tick with no cells', () => {
    const tracker = createHabitHighlightTracker();
    const state = game();
    tracker.sync(state, []);
    expect(tracker.current(state.tick)).toBeNull();
  });

  it('triggers when a slam telegraph lands inside a habit cell', () => {
    const tracker = createHabitHighlightTracker();
    const state = game();
    state.boss.telegraph = { type: 'slam', ticksLeft: 40, x: 150, y: 150 };
    pushEvent(state, 'bossSlamStart');

    tracker.sync(state, [HABIT_CELL]);

    const hit = tracker.current(state.tick);
    expect(hit).not.toBeNull();
    expect(hit?.cell).toEqual(HABIT_CELL);
    expect(hit?.born).toBe(state.tick);
    expect(hit?.ttl).toBe(HABIT_HIGHLIGHT_TTL_TICKS);
  });

  it('does not trigger when the slam lands outside every habit cell', () => {
    const tracker = createHabitHighlightTracker();
    const state = game();
    state.boss.telegraph = { type: 'slam', ticksLeft: 40, x: 400, y: 400 };
    pushEvent(state, 'bossSlamStart');

    tracker.sync(state, [HABIT_CELL, AWAY_CELL]);
    expect(tracker.current(state.tick)).toBeNull();
  });

  it('a charge telegraph never triggers it — only slam and spawn are wired up', () => {
    const tracker = createHabitHighlightTracker();
    const state = game();
    state.boss.telegraph = { type: 'charge', ticksLeft: 20, angle: 0 };
    pushEvent(state, 'bossChargeStart', 0);

    tracker.sync(state, [HABIT_CELL]);
    expect(tracker.current(state.tick)).toBeNull();
  });

  it('triggers when a spawned minion lands inside a habit cell', () => {
    const tracker = createHabitHighlightTracker();
    const state = game();
    state.minions.push({ id: 7, x: 150, y: 150, hp: 10, hitCooldown: 0 });
    pushEvent(state, 'bossSpawn', 7);

    tracker.sync(state, [HABIT_CELL]);
    expect(tracker.current(state.tick)?.cell).toEqual(HABIT_CELL);
  });

  it('ignores a spawn event whose minion id is not on the board (defensive)', () => {
    const tracker = createHabitHighlightTracker();
    const state = game();
    pushEvent(state, 'bossSpawn', 999);

    tracker.sync(state, [HABIT_CELL]);
    expect(tracker.current(state.tick)).toBeNull();
  });

  it('is silent no matter what happens when there is no previous summary (cells === [])', () => {
    const tracker = createHabitHighlightTracker();
    const state = game();
    state.boss.telegraph = { type: 'slam', ticksLeft: 40, x: 150, y: 150 };
    pushEvent(state, 'bossSlamStart');
    state.minions.push({ id: 1, x: 150, y: 150, hp: 10, hitCooldown: 0 });
    pushEvent(state, 'bossSpawn', 1);

    tracker.sync(state, []);
    expect(tracker.current(state.tick)).toBeNull();
  });

  it('ages out after its ttl and is gone', () => {
    const tracker = createHabitHighlightTracker();
    const state = game();
    state.boss.telegraph = { type: 'slam', ticksLeft: 40, x: 150, y: 150 };
    pushEvent(state, 'bossSlamStart');
    tracker.sync(state, [HABIT_CELL]);
    const bornTick = state.tick;

    state.tick = bornTick + HABIT_HIGHLIGHT_TTL_TICKS;
    tracker.sync(state, [HABIT_CELL]);
    expect(tracker.current(state.tick)).not.toBeNull(); // still alive at exactly the ttl edge

    state.tick = bornTick + HABIT_HIGHLIGHT_TTL_TICKS + 1;
    tracker.sync(state, [HABIT_CELL]);
    expect(tracker.current(state.tick)).toBeNull();
  });

  it('resets when the event log shrinks — a new round starting, same as effects.ts', () => {
    const tracker = createHabitHighlightTracker();
    const state = game();
    state.boss.telegraph = { type: 'slam', ticksLeft: 40, x: 150, y: 150 };
    pushEvent(state, 'bossSlamStart');
    tracker.sync(state, [HABIT_CELL]);
    expect(tracker.current(state.tick)).not.toBeNull();

    const fresh = game();
    tracker.sync(fresh, [HABIT_CELL]);
    expect(tracker.current(fresh.tick)).toBeNull();
  });

  it('an explicit reset() also clears it', () => {
    const tracker = createHabitHighlightTracker();
    const state = game();
    state.boss.telegraph = { type: 'slam', ticksLeft: 40, x: 150, y: 150 };
    pushEvent(state, 'bossSlamStart');
    tracker.sync(state, [HABIT_CELL]);
    expect(tracker.current(state.tick)).not.toBeNull();

    tracker.reset();
    expect(tracker.current(state.tick)).toBeNull();
  });
});

describe('habit highlight is read-only presentation', () => {
  it('is not imported by anything that simulates the game', () => {
    const url = new URL('../src/', import.meta.url);
    for (const file of ['game/round.ts', 'game/strategy.ts', 'game/loop.ts', 'game/seeds.ts']) {
      const source = readFileSync(new URL(file, url), 'utf8');
      expect(source).not.toContain('habitHighlight.ts');
    }
  });
});
