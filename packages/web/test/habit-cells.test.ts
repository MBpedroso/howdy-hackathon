/**
 * The pure math behind "it knows your ground" — see `src/render/habitCells.ts`'s
 * module doc for how this mirrors `packages/agents/src/context/renderSummary.ts`
 * without importing it.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ReplaySummary } from '@rematch/engine';

import {
  cellCentre,
  GRID_CELLS,
  habitCellAt,
  habitCellsFromSummary,
  pointInCell,
  rankHotCells,
  type HotCell,
} from '../src/render/habitCells.ts';

const W = 800;
const H = 800;

describe('cellCentre', () => {
  it('places cell 0 at the top-left cell centre', () => {
    expect(cellCentre(0, W, H)).toEqual({ x: 50, y: 50 });
  });

  it('places the last cell at the bottom-right cell centre', () => {
    expect(cellCentre(GRID_CELLS * GRID_CELLS - 1, W, H)).toEqual({ x: 750, y: 750 });
  });

  it('reads column-major within a row, row-major across rows — matches the engine\'s cell index', () => {
    // Cell 9 is column 1, row 1 (col = cell % 8, row = (cell - col) / 8).
    expect(cellCentre(9, W, H)).toEqual({ x: 150, y: 150 });
  });
});

describe('rankHotCells', () => {
  function heatWith(entries: Record<number, number>): number[] {
    const heat = new Array<number>(64).fill(0);
    for (const [cell, share] of Object.entries(entries)) heat[Number(cell)] = share;
    return heat;
  }

  it('ranks by share, descending', () => {
    const heat = heatWith({ 5: 0.1, 20: 0.6, 40: 0.3 });
    const ranked = rankHotCells(heat, W, H, 3);
    expect(ranked.map((c) => c.cell)).toEqual([20, 40, 5]);
  });

  it('breaks a tie by the lower cell index — deterministic, not array order', () => {
    const heat = heatWith({ 30: 0.5, 10: 0.5 });
    const ranked = rankHotCells(heat, W, H, 2);
    expect(ranked.map((c) => c.cell)).toEqual([10, 30]);
  });

  it('drops cells with no samples', () => {
    const heat = new Array<number>(64).fill(0);
    heat[7] = 0.2;
    expect(rankHotCells(heat, W, H, 3)).toHaveLength(1);
  });

  it('caps at `count`, defaulting to the brief\'s "top ~3"', () => {
    const heat = heatWith({ 1: 0.4, 2: 0.3, 3: 0.2, 4: 0.1 });
    expect(rankHotCells(heat, W, H)).toHaveLength(3);
    expect(rankHotCells(heat, W, H, 2)).toHaveLength(2);
  });

  it('resolves each ranked cell to its arena centre', () => {
    const heat = heatWith({ 9: 1 });
    expect(rankHotCells(heat, W, H, 1)).toEqual([{ cell: 9, share: 1, x: 150, y: 150 }]);
  });

  it('returns nothing for an all-zero heat map (no position samples)', () => {
    expect(rankHotCells(new Array<number>(64).fill(0), W, H)).toEqual([]);
  });
});

describe('pointInCell / habitCellAt', () => {
  const cell: HotCell = { cell: 9, share: 0.4, x: 150, y: 150 };

  it('is true for the cell\'s own centre and false one cell over', () => {
    expect(pointInCell({ x: 150, y: 150 }, cell, W, H)).toBe(true);
    expect(pointInCell({ x: 250, y: 150 }, cell, W, H)).toBe(false);
  });

  it('is inclusive at the cell\'s edge — the boundary counts as "in"', () => {
    // Cell 9 spans x,y in [100, 200]. 100 and 200 are its edges.
    expect(pointInCell({ x: 100, y: 150 }, cell, W, H)).toBe(true);
    expect(pointInCell({ x: 200, y: 150 }, cell, W, H)).toBe(true);
    expect(pointInCell({ x: 99.9, y: 150 }, cell, W, H)).toBe(false);
  });

  it('habitCellAt finds the containing cell among several, or null', () => {
    const other: HotCell = { cell: 40, share: 0.2, x: 550, y: 550 };
    expect(habitCellAt({ x: 150, y: 150 }, [cell, other], W, H)).toBe(cell);
    expect(habitCellAt({ x: 550, y: 550 }, [cell, other], W, H)).toBe(other);
    expect(habitCellAt({ x: 400, y: 400 }, [cell, other], W, H)).toBeNull();
  });

  it('habitCellAt is null against an empty cell list — the "no previous summary" case', () => {
    expect(habitCellAt({ x: 150, y: 150 }, [], W, H)).toBeNull();
  });
});

describe('habitCellsFromSummary', () => {
  function summaryWithHeat(heat: number[]): ReplaySummary {
    return {
      seed: 1,
      strategy: { name: 'x', rationale: 'x', version: 1 },
      outcome: 'playerWon',
      durations: { ticks: 100, seconds: 1.6, firstBossHitTick: null, firstPlayerHitTick: null },
      player: { hpStart: 5, hpEnd: 5, dashes: 0, shots: 0, damageTaken: 0 },
      boss: { hpStart: 100, hpEnd: 0, damageTaken: 100, primitives: {} as never, minionsSpawned: 0, damageToMinions: 0 },
      history: { playerPosHeat: heat, playerDashDirs: [], playerShotsDuring: {} as never },
      contract: { violations: 0, strategyKilled: false, droppedEvents: 0 },
      timeline: [],
      timelineTotal: 0,
    };
  }

  it('is empty when there is no previous round — round 1, or a retry', () => {
    expect(habitCellsFromSummary(null, W, H)).toEqual([]);
  });

  it('reads the top habit cells out of a real summary shape', () => {
    const heat = new Array<number>(64).fill(0);
    heat[9] = 0.5;
    heat[40] = 0.3;
    const cells = habitCellsFromSummary(summaryWithHeat(heat), W, H, 2);
    expect(cells.map((c) => c.cell)).toEqual([9, 40]);
  });
});

/**
 * The guarantee, checked structurally — same pattern as `fighters.test.ts`'s "a
 * fighter is a costume": this module is renderer presentation, not a decision the
 * simulation makes, so nothing that drives the fight may read it.
 */
describe('habit cells are read-only presentation', () => {
  it('is not imported by anything that simulates the game', () => {
    const url = new URL('../src/', import.meta.url);
    for (const file of ['game/round.ts', 'game/strategy.ts', 'game/loop.ts', 'game/seeds.ts']) {
      const source = readFileSync(new URL(file, url), 'utf8');
      expect(source).not.toContain('habitCells.ts');
      expect(source).not.toContain('habitHighlight.ts');
    }
  });
});
