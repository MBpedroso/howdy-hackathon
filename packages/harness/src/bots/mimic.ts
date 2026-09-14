/**
 * `Mimic` — the bot built from the *human's* own replay (spec §6.1), and the whole
 * point of Gate 3's ADAPTED assertion: a boss that beats the panel proves it is
 * strong, a boss that beats the Mimic proves it learned something about *you*.
 *
 * It is constructed from a `ReplaySummary` — the same compressed object the Analyst
 * agent reads, and nothing more. Four channels, one per field (group) the summary
 * carries:
 *
 *  | Summary field         | Mimicked behaviour |
 *  |-----------------------|--------------------|
 *  | `history.playerPosHeat` (8x8) | where it walks: a target cell sampled in proportion to the human's dwell time |
 *  | `history.playerDashDirs` (8)  | which way it dashes, and how often (`player.dashes / ticks`) |
 *  | `history.playerShotsDuring`   | when it shoots: biased towards the primitives the human shot during |
 *  | `player.shots` vs `boss.damageTaken` | how well it shoots: the aimer's `accuracy`, see `accuracyFromSummary` |
 *
 * A camper summary (dwell concentrated in one corner cell, dashes in one or two
 * bins) and a rusher summary (dwell spread through the middle, dashes everywhere)
 * therefore produce visibly different play, which `test/bots.test.ts` asserts by
 * measuring both — the Mimic is worthless as an oracle if it collapses to one bot.
 *
 * ## What is deliberately *not* a channel: dodge quality
 *
 * `player.damageTaken` (how much the human got hit) looks like an obvious fourth
 * channel, feeding the survival-floor thresholds below — but the summary has no
 * companion field for "how much the boss threw at them". `boss.primitives` counts
 * *uses* of each primitive, not projectiles: a `burst` can be a 3-shot cone or an
 * 8-shot ring (`ENGINE_CONSTANTS.burst.ringCount`, contract §4.3 delta 3), a `slam`
 * either lands or doesn't, and minion contact damage is folded into the same
 * `damageTaken` total. Two humans with identical dodge skill would score
 * differently here purely because one fought a burst-heavy boss and the other a
 * slam-heavy one — the ratio measures the boss, not the player. That is exactly
 * the speculative-mapping case the calibration work was warned off of, so the
 * survival floor stays the fixed floor it already was.
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

/** Accuracy used when a summary carries no evidence at all (`player.shots === 0`) — the fixed value every Mimic used before this file could derive one. */
const NO_EVIDENCE_ACCURACY = 0.72;

/**
 * The two calibrated points `BASE_AIM_ERROR`'s own doc comment already commits to:
 * at `accuracy = 0.7` "roughly half [the] shots" land at typical range, and at
 * `accuracy = 0.85` "the whole aim cone lands on the boss" — effectively a 100%
 * hit rate. Read as `(hitRate, accuracy)` pairs, they are the only two data points
 * the codebase has already reviewed and shipped an interpretation for.
 */
const ANCHOR_LO = { hitRate: 0.5, accuracy: 0.7 };
const ANCHOR_HI = { hitRate: 1.0, accuracy: 0.85 };

/**
 * Sane bounds on the derived accuracy, so a degenerate summary (zero shots, or a
 * hand-edited fixture with a hit count above its own shot count) cannot hand the
 * aimer a 0 (uniform-random) or 1 (laser-perfect) value. They are exactly what the
 * line through the two anchors above produces at `hitRate` 0 and 1, so they are a
 * restatement of that line's own range rather than a second, independent choice.
 */
const MIN_ACCURACY = ANCHOR_LO.accuracy - ANCHOR_LO.hitRate * ((ANCHOR_HI.accuracy - ANCHOR_LO.accuracy) / (ANCHOR_HI.hitRate - ANCHOR_LO.hitRate)); // 0.55
const MAX_ACCURACY = ANCHOR_HI.accuracy; // 0.85

/**
 * Map a measured hit rate onto the aimer's `accuracy` with a straight line through
 * `ANCHOR_LO` and `ANCHOR_HI`.
 *
 * The physically literal way to do this is to invert `makeAimer`'s geometry: it
 * rotates the aimed angle by a value uniform in `±spread` where `spread =
 * BASE_AIM_ERROR * (1 - accuracy)`, a shot lands when that error falls inside the
 * boss's angular half-width at some reference range, so hit rate is
 * `min(1, halfAngle / spread)` — which *does* reduce to the anchors above at
 * `halfAngle ≈ 0.093 rad` (the boss at ~300 px, the range `BASE_AIM_ERROR`'s
 * comment itself uses). That was the first version of this function, and it was
 * wrong in a way only measurement caught (§5 Q3, `scripts/mimic-calibration.ts`):
 * inverting `min(1, halfAngle / spread)` has a pole as `hitRate → 0`, so a
 * genuinely low hit rate — which the `camper-round1` fixture has, 0.355, real
 * long-range camping data — drives `accuracy` down far enough that the Mimic
 * could no longer reliably kill even a boss that never attacks within the round's
 * 3600-tick clock (measured: 95% boss "wins", all by timeout, against `idle.js`).
 * A camper who plays worse than a target that stands still is not the weaker
 * player the calibration is supposed to model — it is a bug wearing the shape of
 * one, the same failure mode the survival floor's own comment warns about for the
 * dodge channel. A straight line through the same two anchors has no pole: it is
 * bounded to `[MIN_ACCURACY, MAX_ACCURACY]` for any `hitRate` in `[0, 1]` by
 * construction, so the explicit clamp below is a documented invariant rather than
 * a rescue. It is a cruder fit far from the anchors, which is the honest price of
 * not blowing up there.
 */
function accuracyFromHitRate(hitRate: number): number {
  const slope = (ANCHOR_HI.accuracy - ANCHOR_LO.accuracy) / (ANCHOR_HI.hitRate - ANCHOR_LO.hitRate);
  const raw = ANCHOR_LO.accuracy + slope * (hitRate - ANCHOR_LO.hitRate);
  return Math.min(MAX_ACCURACY, Math.max(MIN_ACCURACY, raw));
}

/**
 * The player's real aim, from the summary alone. `boss.damageTaken` is hit count
 * times the fixed per-hit damage (`ENGINE_CONSTANTS.projectile.player.damage` — an
 * exported constant, read here rather than assumed, so this keeps working if it
 * ever stops being 1), and `player.shots` is every shot fired, hit or miss — so
 * their ratio is the hit rate the human's engagement actually produced.
 *
 * `shots === 0` means no evidence either way, so it falls back to
 * `NO_EVIDENCE_ACCURACY` rather than dividing by zero. The rate is also clamped to
 * `[0, 1]` before it reaches `accuracyFromHitRate`: a caller can hand this a
 * summary where `boss.damageTaken` was left untouched while `player.shots` was
 * edited down (a fixture built to test trigger discipline in isolation does
 * exactly this), which would otherwise read as a hit rate above 1.
 */
export function accuracyFromSummary(summary: ReplaySummary): number {
  const shots = summary.player.shots;
  if (shots <= 0) return NO_EVIDENCE_ACCURACY;
  const hits = summary.boss.damageTaken / E.projectile.player.damage;
  return accuracyFromHitRate(clamp01(hits / shots));
}

export function makeMimic(summary: ReplaySummary, opts: BotOptions = {}): PlayerBot {
  const aimer = makeAimer(opts.accuracy ?? accuracyFromSummary(summary));
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
