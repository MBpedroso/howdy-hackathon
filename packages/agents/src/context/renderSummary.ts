/**
 * `ReplaySummary` → text an LLM can actually read.
 *
 * The Analyst's whole job is pattern recognition over one round, and the raw
 * summary is ~90 numbers with no shape: `playerPosHeat` is a flat 64-element array
 * that reads as noise in JSON and as a *map* when it is printed as an 8x8 grid.
 * So the renderer is not cosmetic — it is the context engineering. Every choice
 * here is "which projection makes the pattern visible in the fewest tokens":
 *
 *  - heat map → 8x8 grid of digits 0-9 (peak-relative), with the hottest cells
 *    also named in arena coordinates, because the strategy will need coordinates
 *  - dash directions → a compass rose, so "always dashed left" is one glance
 *  - `playerShotsDuring` → a table against the boss's own primitive counts, which
 *    is the only way "attacked only during my slam cooldown" is visible
 *  - timeline → the top 30 notable events, shots collapsed into counts
 *
 * The Analyst gets this and nothing else (spec §8): no code, no engine source, no
 * contract. It is reasoning about a player, not about a program.
 */
import type { ReplaySummary } from '@rematch/engine';
import type { PrimitiveName, StrategyMeta } from '@rematch/contract';

/** How many timeline events the Analyst is shown. Spec §8's "top 30". */
export const TIMELINE_BUDGET = 30;

const GRID = 8;
/** Bin 0 is centred on +x and bins run counter-clockwise (`engine.dirBin`). */
const COMPASS = ['E', 'NE', 'N', 'NW', 'W', 'SW', 'S', 'SE'] as const;

/**
 * 8x8 grid of digits, scaled to the *peak* cell rather than to 1.0.
 *
 * Peak-relative is the load-bearing detail: a player who spent the whole round in
 * one cell gives that cell 0.95 and every other cell ~0.001, so an absolute scale
 * prints one 9 and 63 zeroes and throws away the secondary pattern. Against the
 * peak, the corner reads 9 and the approach lane still reads 2-3.
 */
export function renderHeatGrid(heat: readonly number[]): string {
  const peak = heat.reduce((m, v) => (v > m ? v : m), 0);
  const lines: string[] = ['     x→  0   1   2   3   4   5   6   7'];
  for (let row = 0; row < GRID; row += 1) {
    const cells: string[] = [];
    for (let col = 0; col < GRID; col += 1) {
      const v = heat[row * GRID + col] ?? 0;
      const digit = peak <= 0 ? 0 : Math.min(9, Math.round((v / peak) * 9));
      cells.push(digit === 0 ? ' . ' : ` ${digit} `);
    }
    lines.push(`y=${row}    ${cells.join(' ')}`);
  }
  return lines.join('\n');
}

/** Cell index → the centre of that cell in arena coordinates. */
export function cellCentre(cell: number, arenaW: number, arenaH: number): { x: number; y: number } {
  const col = cell % GRID;
  const row = (cell - col) / GRID;
  return {
    x: Math.round(((col + 0.5) * arenaW) / GRID),
    y: Math.round(((row + 0.5) * arenaH) / GRID),
  };
}

/** `(x=650, y=750) 41% of the round` — the cells worth naming, hottest first. */
export function renderHotCells(
  heat: readonly number[],
  arenaW: number,
  arenaH: number,
  count = 4,
): string {
  const ranked = heat
    .map((share, cell) => ({ cell, share }))
    .filter((c) => c.share > 0)
    .sort((a, b) => b.share - a.share || a.cell - b.cell)
    .slice(0, count);
  if (ranked.length === 0) return '  (no position samples)';
  return ranked
    .map((c) => {
      const { x, y } = cellCentre(c.cell, arenaW, arenaH);
      return `  cell ${c.cell} (col ${c.cell % GRID}, row ${(c.cell - (c.cell % GRID)) / GRID}) ~ x=${x}, y=${y} — ${(c.share * 100).toFixed(1)}% of the round`;
    })
    .join('\n');
}

/** The dash rose: 8 bins, counts and share, plus the dominant direction. */
export function renderDashRose(dirs: readonly number[]): string {
  const total = dirs.reduce((a, b) => a + b, 0);
  if (total === 0) return '  never dashed';
  const rows = dirs.map((n, i) => {
    const share = n / total;
    const bar = '#'.repeat(Math.round(share * 20));
    return `  ${(COMPASS[i] ?? '?').padEnd(2)} ${String(n).padStart(3)}  ${(share * 100).toFixed(0).padStart(3)}%  ${bar}`;
  });
  const topIdx = dirs.reduce((best, n, i) => (n > (dirs[best] ?? 0) ? i : best), 0);
  const top = dirs[topIdx] ?? 0;
  rows.push(
    `  dominant: ${COMPASS[topIdx] ?? '?'} (${((top / total) * 100).toFixed(0)}% of ${total} dashes)`,
  );
  return rows.join('\n');
}

/**
 * Shots the player fired while each boss primitive was active, next to how often
 * the boss used it. The ratio is the signal: 40 shots during 3 slams means the
 * player is farming the slam window, and that is a thing a strategy can punish.
 */
export function renderShotsDuring(
  shotsDuring: Readonly<Record<PrimitiveName, number>>,
  primitives: Readonly<Record<PrimitiveName, number>>,
  totalShots: number,
): string {
  const names = Object.keys(shotsDuring) as PrimitiveName[];
  const lines = ['  primitive   boss used   player shots during   shots/use'];
  for (const name of names) {
    const uses = primitives[name] ?? 0;
    const shots = shotsDuring[name] ?? 0;
    const ratio = uses === 0 ? '—' : (shots / uses).toFixed(1);
    lines.push(
      `  ${name.padEnd(11)} ${String(uses).padStart(9)}   ${String(shots).padStart(19)}   ${ratio.padStart(9)}`,
    );
  }
  lines.push(`  (${totalShots} shots in total)`);
  return lines.join('\n');
}

/**
 * The timeline, trimmed to `budget` entries.
 *
 * `playerShot` is ~90% of the events and carries no information one at a time, so
 * runs of shots collapse into `xN over ticks a-b`. What survives is every dash,
 * hit, boss primitive and contract violation — the events that mark *decisions*.
 */
export function renderTimeline(timeline: ReplaySummary['timeline'], total: number, budget = TIMELINE_BUDGET): string {
  type Row = { tick: number; text: string };
  const rows: Row[] = [];
  let shotRun: { from: number; to: number; n: number } | undefined;

  const flush = (): void => {
    if (shotRun === undefined) return;
    rows.push({
      tick: shotRun.from,
      text:
        shotRun.n === 1
          ? 'playerShot'
          : `playerShot x${shotRun.n} over ticks ${shotRun.from}-${shotRun.to}`,
    });
    shotRun = undefined;
  };

  for (const ev of timeline) {
    if (ev.kind === 'playerShot') {
      if (shotRun === undefined) shotRun = { from: ev.tick, to: ev.tick, n: 1 };
      else {
        shotRun.to = ev.tick;
        shotRun.n += 1;
      }
      continue;
    }
    flush();
    const detail = ev.detail === undefined ? '' : ` (${JSON.stringify(ev.detail)})`;
    rows.push({ tick: ev.tick, text: `${ev.kind}${detail}` });
  }
  flush();

  const kept = rows.slice(0, budget);
  const lines = kept.map((r) => `  t${String(r.tick).padStart(4)}  ${r.text}`);
  if (rows.length > kept.length) {
    lines.push(`  … ${rows.length - kept.length} more grouped events (${total} events recorded in total)`);
  }
  return lines.join('\n');
}

/** `{ name, rationale, version }` on one line, or a note that there was none. */
export function renderMeta(meta: StrategyMeta | undefined, label: string): string {
  if (meta === undefined) return `${label}: (none — this was the opening boss)`;
  return `${label}: "${meta.name}" v${meta.version} — ${meta.rationale}`;
}

export type RenderSummaryOptions = {
  round?: number;
  /** The `meta` of the strategy that lost, shown to the Analyst (spec §8). */
  prevMeta?: StrategyMeta;
  timelineBudget?: number;
};

/**
 * The Analyst's entire context, as text. Deterministic: the same summary renders
 * byte-for-byte the same string, so a canned replay produces a comparable prompt
 * on every run of the eval.
 */
export function renderSummary(summary: ReplaySummary, opts: RenderSummaryOptions = {}): string {
  const { durations: d, player: p, boss: b, history: h, contract: c } = summary;
  const arenaW = 800;
  const arenaH = 800;

  const hpLost = p.hpStart - p.hpEnd;
  const outcome =
    summary.outcome === 'playerWon'
      ? `the player won, with ${p.hpEnd}/${p.hpStart} HP left`
      : summary.outcome === 'bossWon'
        ? 'the boss won'
        : `the round ended '${summary.outcome}'`;

  const parts = [
    `ROUND ${opts.round ?? '?'} REPLAY — ${outcome}`,
    '',
    `Duration: ${d.ticks} ticks (${d.seconds.toFixed(1)}s of a 60s clock).`,
    `First time the player damaged the boss: ${d.firstBossHitTick === null ? 'never' : `tick ${d.firstBossHitTick}`}.`,
    `First time the player took damage: ${d.firstPlayerHitTick === null ? 'never — untouched' : `tick ${d.firstPlayerHitTick}`}.`,
    '',
    `Player: ${p.shots} shots, ${p.dashes} dashes, took ${p.damageTaken} damage (${hpLost}/${p.hpStart} HP lost).`,
    `Boss:   took ${b.damageTaken} damage, ended at ${b.hpEnd}/${b.hpStart} HP; spawned ${b.minionsSpawned} minions (${b.damageToMinions} damage went into them).`,
    renderMeta(opts.prevMeta ?? summary.strategy, 'Boss strategy this round'),
    '',
    'PLAYER POSITION HEAT MAP — 8x8 cells over the 800x800 arena.',
    'Digits are 0-9 relative to the hottest cell; `.` means never there.',
    'Column 0 is the left edge (x=0), row 0 is the top edge (y=0).',
    renderHeatGrid(h.playerPosHeat),
    '',
    'Where the player actually lived:',
    renderHotCells(h.playerPosHeat, arenaW, arenaH),
    '',
    'DASH DIRECTIONS — 8 compass bins:',
    renderDashRose(h.playerDashDirs),
    '',
    'SHOTS DURING EACH BOSS PRIMITIVE:',
    renderShotsDuring(h.playerShotsDuring, b.primitives, p.shots),
    '',
    `TIMELINE — the ${opts.timelineBudget ?? TIMELINE_BUDGET} most notable events:`,
    renderTimeline(summary.timeline, summary.timelineTotal, opts.timelineBudget ?? TIMELINE_BUDGET),
  ];

  if (c.violations > 0 || c.strategyKilled) {
    parts.push(
      '',
      `Note: the previous strategy committed ${c.violations} contract violations${c.strategyKilled ? ' and was killed by the sandbox' : ''}.`,
    );
  }

  return parts.join('\n');
}
