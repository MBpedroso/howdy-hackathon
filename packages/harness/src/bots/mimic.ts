/**
 * `Mimic` — the bot built from the *human's* own replay (spec §6.1), and the whole
 * point of Gate 3's ADAPTED assertion: a boss that beats the panel proves it is
 * strong, a boss that beats the Mimic proves it learned something about *you*.
 *
 * It is constructed from a `ReplaySummary` — the same compressed object the Analyst
 * agent reads, and nothing more. Three channels, one per field the summary carries:
 *
 *  | Summary field         | Mimicked behaviour |
 *  |-----------------------|--------------------|
 *  | `history.playerPosHeat` (8x8) | where it walks: a target cell sampled in proportion to the human's dwell time |
 *  | `history.playerDashDirs` (8)  | which way it dashes, and how often (`player.dashes / ticks`) |
 *  | `history.playerShotsDuring`   | when it shoots: biased towards the primitives the human shot during |
 *
 * A camper summary (dwell concentrated in one corner cell, dashes in one or two
 * bins) and a rusher summary (dwell spread through the middle, dashes everywhere)
 * therefore produce visibly different play, which `test/bots.test.ts` asserts by
 * measuring both — the Mimic is worthless as an oracle if it collapses to one bot.
 */
import {
  activePrimitives,
  ENGINE_CONSTANTS as E,
  PRIMITIVE_NAMES,
  type GameState,
  type PlayerInput,
  type ReplaySummary,
  type Rng,
} from '@rematch/engine';
import { dashReady, input, makeAimer, nearestIncoming, pushOffWalls, slamTelegraph, unit } from './shared.ts';
import type { BotOptions, PlayerBot } from './types.ts';

const COLS = 8;
/** Ticks before a new target cell is drawn, even if the last one was not reached. */
const RESAMPLE_TICKS = 70;

/** Index sampled in proportion to `weights`; uniform when they are all zero. */
function sampleWeighted(weights: readonly number[], rng: Rng): number {
  let total = 0;
  for (const w of weights) total += w > 0 ? w : 0;
  if (total <= 0) return rng.int(Math.max(1, weights.length));
  let pick = rng.next() * total;
  for (let i = 0; i < weights.length; i += 1) {
    pick -= Math.max(0, weights[i] ?? 0);
    if (pick <= 0) return i;
  }
  return weights.length - 1;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function makeMimic(summary: ReplaySummary, opts: BotOptions = {}): PlayerBot {
  const aimer = makeAimer(opts.accuracy ?? 0.72);
  const heat = summary.history.playerPosHeat;
  const dashDirs = summary.history.playerDashDirs;
  const shotsDuring = summary.history.playerShotsDuring;
  const ticks = Math.max(1, summary.durations.ticks);

  // The trigger discipline of the human, as a probability per tick: `shots * the
  // shot cooldown / ticks` is the fraction of the round they held the button.
  const holdRate = clamp01((summary.player.shots * E.player.shotCooldown) / ticks);
  /**
   * Dash appetite, as a per-tick probability *while the dash is ready*.
   *
   * Not `dashes / ticks`: the dash has a 45-tick cooldown, so the interval between
   * two dashes is `cooldown + 1 / p`. Solving that for the human's observed mean
   * interval is the difference between a Mimic that dashes as often as they did and
   * one that dashes the instant the cooldown lifts, every time — which was 48 dashes
   * a match against a human's 2, and burned the dash the Mimic needed to survive.
   */
  const perDash = summary.player.dashes > 0 ? ticks / summary.player.dashes : Number.POSITIVE_INFINITY;
  const dashRate = perDash > E.player.dashCooldown + 1 ? clamp01(1 / (perDash - E.player.dashCooldown)) : 1;
  let shotsTotal = 0;
  for (const name of PRIMITIVE_NAMES) shotsTotal += shotsDuring[name];

  let targetX = E.player.startX;
  let targetY = E.player.startY;
  let drawnAt = -RESAMPLE_TICKS;
  let dashDirX = 1;
  let dashDirY = 0;
  let dashTicksLeft = 0;

  return {
    name: 'Mimic',

    reset(_seed: number): void {
      aimer.reset();
      targetX = E.player.startX;
      targetY = E.player.startY;
      drawnAt = -RESAMPLE_TICKS;
      dashTicksLeft = 0;
    },

    act(state: Readonly<GameState>, rng: Rng): PlayerInput {
      const p = state.player;
      const aim = aimer.aim(state, rng);

      // 0. Survival floor. The human dodged the things that would have killed them
      //    or their replay would have ended sooner, so the Mimic does too — in a
      //    direction drawn from *their* dash bins. This is a floor, not mimicry: a
      //    human who never dashed in a round with nothing to dodge would still dash
      //    at an incoming shot, and without the floor the Mimic is not a weaker
      //    human but a much worse player, which makes ADAPTED measure nothing.
      //    How often it dashes *by pattern* is still theirs (see `dashRate`).
      const slam = slamTelegraph(state);
      if (slam !== null) {
        const d = Math.hypot(p.x - slam.x, p.y - slam.y);
        if (d < E.slam.radius + 40) {
          const away = unit(p.x - slam.x, p.y - slam.y);
          const bail = d < E.slam.radius && slam.ticksLeft < 12 && dashReady(state);
          return input(pushOffWalls(state, away.x, away.y, 30), aim, bail, false);
        }
      }
      const threat = nearestIncoming(state, 26);
      if (threat !== null && threat.ticks < 8 && dashReady(state)) {
        // Sideways out of the line, on the side the human dashed towards most.
        const bin = sampleWeighted(dashDirs, rng);
        const preferred = (bin / COLS) * Math.PI * 2;
        const side = Math.cos(preferred) * -threat.dirY + Math.sin(preferred) * threat.dirX >= 0 ? 1 : -1;
        dashDirX = -threat.dirY * side;
        dashDirY = threat.dirX * side;
        dashTicksLeft = E.player.dashTicks;
        return input({ x: dashDirX, y: dashDirY }, aim, true, false);
      }

      // 1. Where to stand: a cell drawn from the human's heat map, re-drawn on
      //    arrival or every RESAMPLE_TICKS.
      const arrived = Math.hypot(targetX - p.x, targetY - p.y) < 24;
      if (arrived || state.tick - drawnAt >= RESAMPLE_TICKS) {
        const cell = sampleWeighted(heat, rng);
        const col = cell % COLS;
        const row = (cell - col) / COLS;
        const cellW = state.arena.w / COLS;
        const cellH = state.arena.h / COLS;
        targetX = col * cellW + cellW * (0.25 + rng.next() * 0.5);
        targetY = row * cellH + cellH * (0.25 + rng.next() * 0.5);
        drawnAt = state.tick;
      }

      // 2. Dashing: direction drawn from the human's 8 dash bins, held for the
      //    dash's duration so the input log looks like a real dash, not a jitter.
      let dash = false;
      if (dashTicksLeft > 0) {
        dashTicksLeft -= 1;
      } else if (p.dashCooldown === 0 && rng.next() < dashRate) {
        const bin = sampleWeighted(dashDirs, rng);
        const angle = (bin / COLS) * Math.PI * 2;
        dashDirX = Math.cos(angle);
        dashDirY = Math.sin(angle);
        dashTicksLeft = E.player.dashTicks;
        dash = true;
      }

      let move = { x: dashDirX, y: dashDirY };
      if (dashTicksLeft === 0 && !dash) {
        const towards = unit(targetX - p.x, targetY - p.y);
        move = pushOffWalls(state, towards.x, towards.y, 30);
      }

      // 3. Trigger: biased towards the primitives the human shot during.
      const active = activePrimitives(state);
      let share = 1 / PRIMITIVE_NAMES.length;
      if (shotsTotal > 0 && active.length > 0) {
        let hit = 0;
        for (const name of active) hit += shotsDuring[name];
        share = hit / shotsTotal;
      }
      const shoot = rng.next() < clamp01(holdRate * (0.3 + 2.2 * share));

      return input(move, aim, dash, shoot);
    },
  };
}
