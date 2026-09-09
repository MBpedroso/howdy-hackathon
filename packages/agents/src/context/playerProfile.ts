/**
 * The Coder's PLAYER PROFILE block — a compact, machine-readable projection of the
 * same `ReplaySummary` `renderSummary` turns into prose for the Analyst.
 *
 * Analysis item 7 (`docs/ANALYSIS-learning-signal-2026-09-09.md`): today the Coder
 * gets the player's shape only through the Analyst's prose and JSON observations,
 * and re-typing a place into a number is exactly the kind of transcription a model
 * gets subtly wrong — "cell 57 ≈ x=150, y=750" becomes a NaN or an off-by-a-cell
 * constant, and that is a Gate 2 or FAIR failure waiting to be found rather than a
 * measurement the Coder already has. Numbers the strategy aims with should arrive
 * as numbers, ready to paste into a `const PROFILE = {...}` — see `coderPrompt`'s
 * "# PLAYER PROFILE" section, which says exactly that.
 *
 * Reuses `rankHotCells` (`renderSummary.ts`) for the cell ranking and coordinate
 * math instead of re-deriving it — the whole point is that this and the Analyst's
 * prose can never quietly disagree about which cell is "hottest".
 *
 * Same content for every one of an attempt's K candidates: `rewrite()` computes it
 * once per call, from `input.summary`, and passes the identical string into every
 * `runCoder` — a fact that matters for the prompt cache the way `takenNames` does
 * not, so it belongs in the *message*, not the ~13.5 KB cached system prompt (spec
 * §6.3's cache-control boundary), even though it does not change per candidate.
 */
import type { ReplaySummary } from '@rematch/engine';
import type { PrimitiveName } from '@rematch/contract';
import { rankHotCells } from './renderSummary.ts';

/** One full turn, radians. Kept local rather than imported: the engine does not
 *  export it, and the denial test (`test/context.test.ts`) holds the Coder prompt
 *  to mentioning no engine identifier at all — this way there is nothing to leak. */
const TAU = Math.PI * 2;

export type PlayerProfile = {
  /** Top ~4 hottest cells, resolved to arena coordinates. Same ranking as `renderHotCells`. */
  hotCells: { x: number; y: number; share: number }[];
  dashes: {
    total: number;
    /** Bin centre, radians. Bin 0 is `+x`, bins run counter-clockwise (`engine.dirBin`'s
     *  convention) — 0 when there were no dashes to have a direction at all. */
    dominantAngleRad: number;
    /** That bin's share of all dashes, 0 when there were none. */
    dominantShare: number;
  };
  playerShotsDuring: Readonly<Record<PrimitiveName, number>>;
  durations: { ticks: number };
};

/** Round to 4 decimal places: plenty of precision for a pixel coordinate or a
 *  share, and it keeps the JSON free of float noise a model might copy verbatim
 *  into a constant. */
const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

const HOT_CELLS = 4;

/**
 * The profile, as a typed value — `renderPlayerProfile` is this, `JSON.stringify`d.
 * Split so a test (or a future consumer) can assert on the numbers without parsing
 * the rendered text back out.
 */
export function playerProfile(summary: ReplaySummary, arenaW = 800, arenaH = 800): PlayerProfile {
  const dirs = summary.history.playerDashDirs;
  const total = dirs.reduce((a, b) => a + b, 0);
  let bin = 0;
  for (let i = 1; i < dirs.length; i += 1) {
    if ((dirs[i] ?? 0) > (dirs[bin] ?? 0)) bin = i;
  }
  const bins = dirs.length > 0 ? dirs.length : 8;

  return {
    hotCells: rankHotCells(summary.history.playerPosHeat, arenaW, arenaH, HOT_CELLS).map((c) => ({
      x: c.x,
      y: c.y,
      share: round4(c.share),
    })),
    dashes: {
      total,
      dominantAngleRad: total === 0 ? 0 : round4((bin * TAU) / bins),
      dominantShare: total === 0 ? 0 : round4((dirs[bin] ?? 0) / total),
    },
    playerShotsDuring: summary.history.playerShotsDuring,
    durations: { ticks: summary.durations.ticks },
  };
}

/** The fenced JSON block `coderPrompt` embeds in its "# PLAYER PROFILE" section. */
export function renderPlayerProfile(summary: ReplaySummary, arenaW = 800, arenaH = 800): string {
  return JSON.stringify(playerProfile(summary, arenaW, arenaH), null, 2);
}
