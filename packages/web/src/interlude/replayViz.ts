/**
 * Beat 1's pictures: the heat grid, the dash rose and the timeline strip.
 *
 * Spec §2.2 asks for "a ghost heatmap of the player's positions and a timeline of
 * their attacks/dashes". Everything drawn here comes out of the same `ReplaySummary`
 * the Analyst is given and nothing else — which is the honest thing to draw, because
 * it is *literally* what the agent is looking at. The player and the agent see the
 * same three pictures at the same moment.
 *
 * Canvas rather than DOM for these three: an 8×8 grid, an 8-wedge rose and ~200
 * timeline marks are 80-odd nodes that change once, and the grid needs per-cell
 * colour interpolation that CSS would make worse, not better.
 *
 * Colours are `render/palette.ts`, unchanged: the interlude must not introduce a
 * second colour language for the same things (spec §2.3, and the palette's own rule
 * — warm hurts you, cool is yours).
 */
import { CONSTANTS } from '@rematch/contract';
import { ENGINE_CONSTANTS, type ReplaySummary, type TimelineEvent } from '@rematch/engine';

import { alpha, PALETTE } from '../render/palette.ts';

/** Set the backing store to the element's CSS size × DPR and scale the context. */
function prepare(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; w: number; h: number } | null {
  const rect = canvas.getBoundingClientRect();
  // Before layout (a hidden panel, a test that never attached) fall back to the
  // attribute size, so a draw is never silently a no-op.
  const w = rect.width > 0 ? rect.width : canvas.width;
  const h = rect.height > 0 ? rect.height : canvas.height;
  const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  const ctx = canvas.getContext('2d');
  if (ctx === null) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

/** `#rrggbb` -> [r,g,b]. */
function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** Linear interpolation between two hex colours, as `rgb(...)`. */
function mix(from: string, to: string, t: number): string {
  const a = rgb(from);
  const b = rgb(to);
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * k)}, ${Math.round(a[1] + (b[1] - a[1]) * k)}, ${Math.round(a[2] + (b[2] - a[2]) * k)})`;
}

/**
 * The 8×8 position heat map — the "ghost" of where the player lived.
 *
 * Normalized by the *maximum* cell rather than by the sum. The heat array already
 * sums to 1, so scaling by the sum would make a player who moved everywhere and a
 * player who stood in one cell both render as an almost-black grid; scaling by the
 * max means the hottest cell is always fully lit and the picture is about *shape*.
 * The hottest cell gets an amber outline because that is the cell the Coder is about
 * to aim a slam at, and the player should be able to see it coming.
 */
export function drawHeat(canvas: HTMLCanvasElement, heat: readonly number[]): void {
  const prepared = prepare(canvas);
  if (prepared === null) return;
  const { ctx, w, h } = prepared;
  const cells = 8;
  const cw = w / cells;
  const ch = h / cells;

  let max = 0;
  let hottest = 0;
  for (let i = 0; i < cells * cells; i += 1) {
    const v = heat[i] ?? 0;
    if (v > max) {
      max = v;
      hottest = i;
    }
  }

  for (let row = 0; row < cells; row += 1) {
    for (let col = 0; col < cells; col += 1) {
      const v = heat[row * cells + col] ?? 0;
      const t = max === 0 ? 0 : v / max;
      ctx.fillStyle = mix(PALETTE.floor, PALETTE.player, t * 0.92);
      ctx.fillRect(col * cw, row * ch, cw - 1, ch - 1);
    }
  }

  if (max > 0) {
    const col = hottest % cells;
    const row = (hottest - col) / cells;
    ctx.strokeStyle = PALETTE.telegraphSlam;
    ctx.lineWidth = 2;
    ctx.strokeRect(col * cw + 1, row * ch + 1, cw - 3, ch - 3);
  }

  ctx.strokeStyle = alpha(PALETTE.border, 0.8);
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
}

/**
 * The dash rose: 8 bins, bin 0 on +x, counter-clockwise (`engine/dirBin`).
 *
 * Canvas y grows downward and the engine's bins are in maths orientation, so each
 * wedge is drawn at `-angle`. Getting that backwards mirrors the rose vertically and
 * quietly tells the player the opposite of what they did.
 */
export function drawDashRose(canvas: HTMLCanvasElement, bins: readonly number[]): void {
  const prepared = prepare(canvas);
  if (prepared === null) return;
  const { ctx, w, h } = prepared;
  const cx = w / 2;
  const cy = h / 2;
  const radius = Math.min(w, h) / 2 - 4;

  let max = 0;
  for (const v of bins) if (v > max) max = v;

  ctx.strokeStyle = alpha(PALETTE.border, 0.9);
  ctx.lineWidth = 1;
  for (const r of [radius, radius * 0.5]) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  if (max === 0) return;
  const step = (Math.PI * 2) / 8;
  for (let i = 0; i < 8; i += 1) {
    const v = bins[i] ?? 0;
    if (v === 0) continue;
    const len = radius * (0.18 + 0.82 * (v / max));
    const mid = -i * step;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, len, mid - step * 0.38, mid + step * 0.38);
    ctx.closePath();
    ctx.fillStyle = alpha(PALETTE.player, 0.25 + 0.6 * (v / max));
    ctx.fill();
  }
}

/** Which row and colour a timeline mark gets. `null` = not drawn. */
function markStyle(kind: TimelineEvent['kind']): { row: 0 | 1 | 2; color: string; height: number } | null {
  switch (kind) {
    case 'playerShot':
      return { row: 0, color: alpha(PALETTE.playerShot, 0.5), height: 5 };
    case 'playerDash':
      return { row: 0, color: PALETTE.player, height: 11 };
    case 'bossBurst':
      return { row: 1, color: PALETTE.bossShot, height: 9 };
    case 'bossSlamStart':
      return { row: 1, color: PALETTE.telegraphSlam, height: 11 };
    case 'bossChargeStart':
      return { row: 1, color: PALETTE.telegraphCharge, height: 11 };
    case 'bossSpawn':
      return { row: 1, color: PALETTE.minion, height: 9 };
    case 'playerHit':
      return { row: 2, color: PALETTE.boss, height: 11 };
    case 'bossHit':
      return { row: 2, color: alpha(PALETTE.player, 0.55), height: 6 };
    case 'violation':
      return { row: 2, color: PALETTE.spark, height: 11 };
    default:
      // `bossSlamHit`/`bossSlamMiss`/`bossChargeHit`/`minionDown`/`outcome` are all
      // consequences of a mark already drawn; adding them makes the strip mud.
      return null;
  }
}

/**
 * The timeline strip: three lanes — yours, the boss's, and the hits — across the
 * round's duration.
 *
 * `summary.timeline` is already downsampled by the engine to at most
 * `limits.timelineMax` entries with every non-shot event preserved, so this draws it
 * as it comes: the shots thin out, the dashes and primitives do not.
 */
export function drawTimeline(canvas: HTMLCanvasElement, summary: ReplaySummary): void {
  const prepared = prepare(canvas);
  if (prepared === null) return;
  const { ctx, w, h } = prepared;
  const ticks = Math.max(1, summary.durations.ticks);
  const lanes = 3;
  const laneH = h / lanes;

  for (let i = 0; i < lanes; i += 1) {
    ctx.fillStyle = i % 2 === 0 ? alpha(PALETTE.grid, 0.85) : alpha(PALETTE.floor, 0.9);
    ctx.fillRect(0, i * laneH, w, laneH - 1);
  }

  // A second grid every 10 s, so the strip has a scale.
  ctx.strokeStyle = alpha(PALETTE.border, 0.7);
  ctx.lineWidth = 1;
  const per10s = CONSTANTS.ticksPerSecond * 10;
  for (let t = per10s; t < ticks; t += per10s) {
    const x = Math.round((t / ticks) * w) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }

  for (const ev of summary.timeline) {
    const style = markStyle(ev.kind);
    if (style === null) continue;
    const x = Math.min(w - 2, Math.max(0, (ev.tick / ticks) * (w - 2)));
    const top = style.row * laneH + (laneH - style.height) / 2;
    ctx.fillStyle = style.color;
    ctx.fillRect(x, top, style.height > 6 ? 2 : 1.5, style.height);
  }

  ctx.strokeStyle = alpha(PALETTE.border, 0.8);
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
}

/** The one-line stats caption under the pictures. */
export function replayCaption(summary: ReplaySummary): string {
  const s = summary;
  const primitives = Object.entries(s.boss.primitives)
    .filter(([, n]) => n > 0)
    .map(([name, n]) => `${name} ${n}`)
    .join(' · ');
  return (
    `${s.durations.seconds.toFixed(1)}s · ${s.player.hpEnd}/${ENGINE_CONSTANTS.player.hp} HP · ` +
    `${s.player.shots} shots · ${s.player.dashes} dashes · boss: ${primitives === '' ? 'nothing' : primitives}`
  );
}
