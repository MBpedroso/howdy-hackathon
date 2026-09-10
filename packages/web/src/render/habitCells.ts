/**
 * "Where the player used to live" — the previous round's hottest position cells,
 * and the point-in-cell test that lets the renderer notice when the boss aims at
 * one of them.
 *
 * Pure and cosmetic on purpose: this is the whole feature's math, factored out of
 * the drawing code so `test/habit-cells.test.ts` can pin the ranking and the
 * geometry without a canvas.
 *
 * `cellCentre` and the ranking rule mirror `rankHotCells`/`cellCentre` in
 * `packages/agents/src/context/renderSummary.ts` — the Analyst's own projection of
 * the same 8x8 grid the Coder is told about (`playerProfile.ts`'s hot cells, per
 * `docs/AI-DEV-LOG.md` 2026-09-09's "#7"). `web` cannot import `@rematch/agents`
 * (see `test/fighters.test.ts`'s "a fighter is a costume" pattern, extended below),
 * so the same handful of lines is reimplemented here rather than shared. If the grid
 * size or the tie-break rule in the reference ever changes, this needs the same edit
 * by hand — there is no build-time guard against the two drifting apart, only this
 * comment.
 */
import type { ReplaySummary } from '@rematch/engine';

/** 8 columns, matching the boss's heat grid (`renderer.ts`'s own `GRID_CELLS`). */
export const GRID_CELLS = 8;

/** How many of the previous round's hottest cells the highlight considers. */
export const HABIT_CELL_COUNT = 3;

export type HotCell = {
  cell: number;
  /** This cell's share of the round (already normalized upstream, 0..1). */
  share: number;
  /** Cell centre, in arena units. */
  x: number;
  y: number;
};

/** Cell index -> the centre of that cell, in arena coordinates. */
export function cellCentre(cell: number, arenaW: number, arenaH: number): { x: number; y: number } {
  const col = cell % GRID_CELLS;
  const row = (cell - col) / GRID_CELLS;
  return {
    x: ((col + 0.5) * arenaW) / GRID_CELLS,
    y: ((row + 0.5) * arenaH) / GRID_CELLS,
  };
}

/**
 * The top `count` hottest cells — share descending, cell index ascending to break a
 * tie deterministically — each resolved to its arena centre. Same rule as the
 * reference implementation's `rankHotCells`.
 */
export function rankHotCells(
  heat: readonly number[],
  arenaW: number,
  arenaH: number,
  count = HABIT_CELL_COUNT,
): HotCell[] {
  return heat
    .map((share, cell) => ({ cell, share }))
    .filter((c) => c.share > 0)
    .sort((a, b) => b.share - a.share || a.cell - b.cell)
    .slice(0, count)
    .map((c) => ({ cell: c.cell, share: c.share, ...cellCentre(c.cell, arenaW, arenaH) }));
}

/** Half a cell's side, in arena units. */
export function cellHalfExtent(arenaSize: number): number {
  return arenaSize / GRID_CELLS / 2;
}

/** Whether an arena point falls inside `cell`'s square. */
export function pointInCell(point: { x: number; y: number }, cell: HotCell, arenaW: number, arenaH: number): boolean {
  return (
    Math.abs(point.x - cell.x) <= cellHalfExtent(arenaW) && Math.abs(point.y - cell.y) <= cellHalfExtent(arenaH)
  );
}

/** The first of `cells` whose square contains `point`, or `null`. */
export function habitCellAt(
  point: { x: number; y: number },
  cells: readonly HotCell[],
  arenaW: number,
  arenaH: number,
): HotCell | null {
  for (const cell of cells) {
    if (pointInCell(point, cell, arenaW, arenaH)) return cell;
  }
  return null;
}

/**
 * The player's top habit cells from the previous round's replay summary, or `[]`
 * when there is no previous round to read from — round 1, or a retry (`app.ts`'s
 * `startRound` passes `null` on purpose in both cases; see its comment).
 */
export function habitCellsFromSummary(
  summary: ReplaySummary | null,
  arenaW: number,
  arenaH: number,
  count = HABIT_CELL_COUNT,
): HotCell[] {
  if (summary === null) return [];
  return rankHotCells(summary.history.playerPosHeat, arenaW, arenaH, count);
}
