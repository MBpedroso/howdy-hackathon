/**
 * Canvas 2D renderer. Flat shapes, one palette — and exactly two images: the
 * mascot faces the player picked for themselves and for the boss (`render/sprites.ts`,
 * a documented departure from spec §2.3, recorded in `docs/SPEC.md` §13).
 *
 * The sprite is drawn *inside* the entity's collision circle and clipped to it, so
 * nothing the player sees is bigger than what can be hit. Every tell, shot, minion
 * and telegraph is still drawn, because the tells are the fairness contract and a
 * picture cannot be relied on to arrive.
 *
 * Contract with the rest of the client:
 *  - it **reads** `GameState` and never writes to it;
 *  - it draws in arena units (0..800) — the only transform is one uniform scale plus
 *    a sub-pixel camera-shake translation, so a circle is always a circle;
 *  - it is idempotent: drawing the same state twice produces the same picture (the
 *    only time-varying inputs are `state.tick` and the effect ages derived from it),
 *    which is what makes the e2e screenshots stable.
 *
 * The telegraphs get most of the attention here, because they are the fight's
 * fairness contract: the boss may only hurt you in a way you were shown first.
 *  - `charge` (20 ticks): a lance from the boss along the charge angle that grows in
 *    length and width as the tell completes. Where the wedge is, the boss will be.
 *  - `slam` (40 ticks): a ring on the floor whose inner disc fills toward the edge.
 *    When the disc reaches the ring, the slam lands — and the ring flashes.
 *  - `burst` has no telegraph in the engine (it is instant), so the boss gets a hard
 *    wind-up pulse on the tick it fires, which is the honest tell: *this just happened*.
 */
import { CONSTANTS } from '@rematch/contract';
import { ENGINE_CONSTANTS, TELEGRAPHS, type GameState } from '@rematch/engine';

import { createEffectTracker, type Effect, type EffectTracker } from './effects.ts';
import { createHabitHighlightTracker, type HabitHighlight, type HabitHighlightTracker } from './habitHighlight.ts';
import type { HotCell } from './habitCells.ts';
import { alpha, PALETTE as C } from './palette.ts';
import { preloadFighters, sprite } from './sprites.ts';
import { computeViewport, type Viewport } from './viewport.ts';
import { DEFAULT_BOSS_FIGHTER, DEFAULT_PLAYER_FIGHTER, FIGHTERS, type FighterId } from '../ui/fighters.ts';

const ARENA = CONSTANTS.arena.w;
const E = ENGINE_CONSTANTS;
/** Distance a charge covers once the tell resolves: 30 ticks at 10 px/tick. */
const CHARGE_REACH = E.charge.speed * E.charge.ticks;
/** 8 columns, matching the boss's 8x8 heat grid exactly. */
const GRID_CELLS = 8;
const TAU = Math.PI * 2;

export type Renderer = {
  /** Re-fit the canvas to the window. Returns the viewport it settled on. */
  resize(): Viewport;
  /** Draw one frame. */
  draw(state: GameState): void;
  viewport(): Viewport;
  /** Drop effect history — call when a round starts. */
  reset(): void;
  /**
   * Change who the two fighters look like. Cosmetic and it stops here: the
   * renderer never writes to `GameState`, so a costume cannot reach the
   * simulation, the replay hash or a strategy's view (`ui/fighters.ts`).
   */
  setFighters(fighters: { player: FighterId; boss: FighterId }): void;
  /**
   * The current round's habit cells — the previous round's top habit cells
   * (`render/habitCells.ts`), or `[]` when there is none (round 1, a retry). Call
   * once per round, before the first `draw`.
   */
  setHabitCells(cells: readonly HotCell[]): void;
  /**
   * The habit-cell highlight `draw` last drew, if any — `app.ts` reads this right
   * after `draw` to position the "YOUR HABIT" DOM caption (`ui/habitCaption.ts`)
   * over the same cell, in the same frame.
   */
  activeHabitHighlight(): { x: number; y: number } | null;
};

/** Non-null 2D context. A separate function so `ctx` is non-nullable inside every
 *  drawing closure below — TypeScript does not carry a narrowing across a closure. */
function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', { alpha: false });
  if (ctx === null) throw new Error('renderer: 2d context unavailable');
  return ctx;
}

export function createRenderer(canvas: HTMLCanvasElement): Renderer {
  const ctx = context2d(canvas);

  const effects: EffectTracker = createEffectTracker();
  const habitHighlights: HabitHighlightTracker = createHabitHighlightTracker();
  let habitCells: readonly HotCell[] = [];
  let lastHabitHighlight: { x: number; y: number } | null = null;
  let fighters: { player: FighterId; boss: FighterId } = {
    player: DEFAULT_PLAYER_FIGHTER,
    boss: DEFAULT_BOSS_FIGHTER,
  };
  // Start the four decodes now rather than on the first frame that wants one: the
  // fight begins on a click and a face that pops in two seconds late is worse than
  // one that was never there.
  preloadFighters();
  let viewport: Viewport = computeViewport(canvas.width, canvas.height, ARENA, 1);

  function resize(): Viewport {
    viewport = computeViewport(window.innerWidth, window.innerHeight, ARENA, window.devicePixelRatio || 1);
    canvas.width = viewport.pixelSize;
    canvas.height = viewport.pixelSize;
    canvas.style.width = `${viewport.cssSize}px`;
    canvas.style.height = `${viewport.cssSize}px`;
    return viewport;
  }

  // ------------------------------------------------------------- primitives

  function disc(x: number, y: number, r: number, fill: string): void {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fillStyle = fill;
    ctx.fill();
  }

  function ring(x: number, y: number, r: number, stroke: string, width: number): void {
    ctx.beginPath();
    ctx.arc(x, y, Math.max(0, r), 0, TAU);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = width;
    ctx.stroke();
  }

  // ------------------------------------------------------------------ floor

  function drawFloor(): void {
    ctx.fillStyle = C.floor;
    ctx.fillRect(0, 0, ARENA, ARENA);

    const cell = ARENA / GRID_CELLS;
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < GRID_CELLS; i += 1) {
      const p = i * cell;
      ctx.moveTo(p, 0);
      ctx.lineTo(p, ARENA);
      ctx.moveTo(0, p);
      ctx.lineTo(ARENA, p);
    }
    ctx.stroke();

    // Centre cross and border: cheap orientation cues in an otherwise empty room.
    ctx.strokeStyle = C.gridStrong;
    ctx.beginPath();
    ctx.moveTo(ARENA / 2, ARENA / 2 - 14);
    ctx.lineTo(ARENA / 2, ARENA / 2 + 14);
    ctx.moveTo(ARENA / 2 - 14, ARENA / 2);
    ctx.lineTo(ARENA / 2 + 14, ARENA / 2);
    ctx.stroke();

    ctx.strokeStyle = C.border;
    ctx.lineWidth = 3;
    ctx.strokeRect(1.5, 1.5, ARENA - 3, ARENA - 3);
  }

  // ------------------------------------------------------------- telegraphs

  /** The slam tell: a ring that fills from the middle out over 40 ticks. */
  function drawSlamTelegraph(x: number, y: number, ticksLeft: number): void {
    const r = E.slam.radius;
    const progress = 1 - Math.max(0, ticksLeft) / TELEGRAPHS.slam;
    const eased = progress * progress;

    disc(x, y, r, alpha(C.telegraphSlam, 0.07 + 0.1 * progress));
    disc(x, y, r * eased, alpha(C.telegraphSlam, 0.26 + 0.3 * progress));

    ctx.setLineDash([14, 10]);
    ring(x, y, r, alpha(C.telegraphSlam, 0.5 + 0.5 * progress), 2 + 3 * progress);
    ctx.setLineDash([]);

    // Crosshair that closes in, so the target is readable even when the ring overlaps
    // the arena edge.
    const tick = r * 0.34 * (1 - progress) + 8;
    ctx.strokeStyle = alpha(C.telegraphSlam, 0.75);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x - tick, y);
    ctx.lineTo(x + tick, y);
    ctx.moveTo(x, y - tick);
    ctx.lineTo(x, y + tick);
    ctx.stroke();
  }

  /** The charge tell: a lance from the boss that grows over 20 ticks. */
  function drawChargeTelegraph(bx: number, by: number, angleRad: number, ticksLeft: number): void {
    const progress = 1 - Math.max(0, ticksLeft) / TELEGRAPHS.charge;
    const halfWidth = 5 + 23 * progress;
    const reach = CHARGE_REACH;

    ctx.save();
    ctx.translate(bx, by);
    ctx.rotate(angleRad);

    // Full extent, faint: where the charge *will* reach, from the first tick.
    ctx.fillStyle = alpha(C.telegraphCharge, 0.08);
    ctx.fillRect(0, -halfWidth, reach, halfWidth * 2);
    ctx.strokeStyle = alpha(C.telegraphCharge, 0.35);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(0, -halfWidth, reach, halfWidth * 2);

    // The fill that races down the lance as the tell completes.
    const filled = reach * progress;
    ctx.fillStyle = alpha(C.telegraphCharge, 0.34);
    ctx.fillRect(0, -halfWidth, filled, halfWidth * 2);

    // Arrowhead at the fill front.
    const head = 26;
    ctx.beginPath();
    ctx.moveTo(filled, -halfWidth - 6);
    ctx.lineTo(filled + head, 0);
    ctx.lineTo(filled, halfWidth + 6);
    ctx.closePath();
    ctx.fillStyle = alpha(C.telegraphCharge, 0.55 + 0.45 * progress);
    ctx.fill();

    ctx.restore();
  }

  // ---------------------------------------------------- habit-cell highlight

  /**
   * "It knows your ground": a subtle pulsing outline over one cell of the floor
   * grid, drawn while a `HabitHighlight` (`habitHighlight.ts`) is alive. Floor
   * decoration — drawn right after `drawFloor`, so the boss, minions and
   * projectiles all render on top of it rather than under a highlight.
   */
  function drawHabitHighlight(h: HabitHighlight, tick: number): void {
    const age = tick - h.born;
    const life = 1 - Math.min(1, Math.max(0, age / h.ttl));
    if (life <= 0) return;
    const half = ARENA / GRID_CELLS / 2;
    const { x, y } = h.cell;
    // Two pulses over the highlight's lifetime — "flags something", not "flickers".
    const pulse = 0.6 + 0.4 * Math.sin((age / h.ttl) * Math.PI * 4);

    ctx.fillStyle = alpha(C.boss, 0.1 * pulse * life);
    ctx.fillRect(x - half, y - half, half * 2, half * 2);
    ctx.strokeStyle = alpha(C.boss, (0.35 + 0.4 * pulse) * life);
    ctx.lineWidth = 2.5;
    ctx.strokeRect(x - half, y - half, half * 2, half * 2);
  }

  // ---------------------------------------------------------------- effects

  function drawEffect(e: Effect, tick: number): void {
    const t = (tick - e.born) / e.ttl;
    if (t < 0 || t > 1) return;
    const fade = 1 - t;

    switch (e.kind) {
      case 'burst': {
        // The wind-up pulse: a hard ring leaving the boss the tick it fires.
        ring(e.x, e.y, E.boss.radius + 46 * t, alpha(C.bossShot, 0.75 * fade), 5 * fade + 1);
        disc(e.x, e.y, E.boss.radius * (1 + 0.25 * fade), alpha(C.bossShot, 0.18 * fade));
        return;
      }
      case 'slam': {
        const r = E.slam.radius;
        const col = e.hit === 1 ? C.boss : C.telegraphSlam;
        disc(e.x, e.y, r * (1 + 0.12 * t), alpha(col, 0.5 * fade * fade));
        ring(e.x, e.y, r * (1 + 0.18 * t), alpha(col, fade), 3 + 6 * fade);
        return;
      }
      case 'chargeHit':
      case 'playerHit': {
        ring(e.x, e.y, E.player.radius + 34 * t, alpha(C.boss, 0.9 * fade), 4 * fade + 1);
        return;
      }
      case 'bossHit': {
        disc(e.x, e.y, E.boss.radius + 4, alpha(C.spark, 0.16 * fade));
        return;
      }
      case 'spawn': {
        ring(e.x, e.y, 30 * (1 - fade) + 6, alpha(C.minion, 0.6 * fade), 2);
        return;
      }
      case 'minionDown': {
        ring(e.x, e.y, E.minion.radius + 22 * t, alpha(C.minion, 0.7 * fade), 2);
        return;
      }
    }
  }

  // ----------------------------------------------------------------- actors

  function drawProjectiles(state: GameState): void {
    for (const p of state.projectiles) {
      const mine = p.owner === 'player';
      const col = mine ? C.playerShot : C.bossShot;
      // Motion streak: two frames of travel behind the head. Reads as speed and
      // makes a dense burst legible as individual bullets.
      ctx.strokeStyle = alpha(col, 0.35);
      ctx.lineWidth = E.projectile.radius * 1.4;
      ctx.beginPath();
      ctx.moveTo(p.x - p.vx * 1.6, p.y - p.vy * 1.6);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      disc(p.x, p.y, E.projectile.radius, col);
    }
  }

  function drawMinions(state: GameState): void {
    for (const m of state.minions) {
      const r = E.minion.radius;
      // Materialization grace: a minion that cannot hit you yet is drawn hollow.
      const arming = m.hitCooldown > E.minion.hitCooldown;
      disc(m.x, m.y, r, alpha(C.minion, arming ? 0.25 : 1));
      ring(m.x, m.y, r + 3, alpha(C.minion, 0.55), 2);
      const frac = m.hp / E.minion.hp;
      ctx.beginPath();
      ctx.arc(m.x, m.y, r + 7, -Math.PI / 2, -Math.PI / 2 + TAU * frac);
      ctx.strokeStyle = alpha(C.minion, 0.9);
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
  }

  /**
   * Draw a fighter's face inside its collision circle, or report that there was
   * nothing to draw so the caller keeps its flat disc.
   *
   * Clipped to the circle on purpose. The crop includes gloves and an outstretched
   * arm, and a sprite wider than the hitbox would make the fight lie about what can
   * be hit — so the mascot's *ball* is scaled onto the circle and everything outside
   * it is cut. The ball's place in the crop is per-fighter measured data
   * (`ui/fighters.ts`, `Ball`), not the image centre: centring the image put
   * Jupiter's face left of the boss and cropped Earth's at the chin.
   *
   * The face is drawn *unrotated*: these mascots face the viewer, and a spinning
   * head reads as a bug rather than as aim. Facing stays the job of the tick each
   * caller already draws.
   */
  function drawFace(id: FighterId, x: number, y: number, r: number, dim: number): boolean {
    const img = sprite(id);
    if (img === null) return false;
    const ball = FIGHTERS[id].ball;
    // Draw the image at the width that makes its ball exactly `r`, then offset so
    // the ball's centre lands on the entity's centre.
    const side = r / ball.r;
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.clip();
    if (dim < 1) ctx.globalAlpha = dim;
    ctx.drawImage(img, x - ball.cx * side, y - ball.cy * side, side, side);
    ctx.restore();
    return true;
  }

  function drawBoss(state: GameState): void {
    const b = state.boss;
    const r = E.boss.radius;
    const charging = b.chargeTicksLeft > 0;

    if (charging) disc(b.x, b.y, r + 16, alpha(C.boss, 0.2));
    // The crimson disc goes down first either way: it is the colour language
    // ("anything that can hurt you is warm") and it is what shows through the
    // transparent corners of the crop.
    disc(b.x, b.y, r, C.boss);
    // The dark inset is the *bare* boss's eye. With a face on, it would be a hole
    // punched through the mascot, so it is drawn only when there is no face.
    const faced = drawFace(fighters.boss, b.x, b.y, r, 1);
    if (!faced) disc(b.x, b.y, r - 9, alpha(C.void, 0.55));
    ring(b.x, b.y, r + 2, alpha(C.boss, 0.8), 2);

    // Facing tick. It starts at the rim rather than inside the body when a face is
    // on, because a 3 px white line across the mascot's eyes reads as damage.
    ctx.strokeStyle = C.text;
    ctx.lineWidth = 3;
    ctx.beginPath();
    const inner = faced ? r + 1 : r - 12;
    ctx.moveTo(b.x + Math.cos(b.facing) * inner, b.y + Math.sin(b.facing) * inner);
    ctx.lineTo(b.x + Math.cos(b.facing) * (r + 9), b.y + Math.sin(b.facing) * (r + 9));
    ctx.stroke();

    // HP bar above the boss — the one number the player reads mid-fight.
    const w = 96;
    const h = 7;
    const x = b.x - w / 2;
    const y = b.y - r - 20;
    ctx.fillStyle = alpha(C.void, 0.75);
    ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
    ctx.fillStyle = C.bossDim;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = C.boss;
    ctx.fillRect(x, y, (w * Math.max(0, b.hp)) / E.boss.hp, h);
  }

  function drawPlayer(state: GameState, trail: readonly { x: number; y: number; tick: number }[]): void {
    const p = state.player;
    const r = E.player.radius;
    const dashing = p.dashTicksLeft > 0;

    if (dashing) {
      for (const point of trail) {
        const age = state.tick - point.tick;
        const fade = 1 - age / 12;
        if (fade <= 0) continue;
        disc(point.x, point.y, r * (0.35 + 0.5 * fade), alpha(C.player, 0.22 * fade));
      }
      disc(p.x, p.y, r + 12, alpha(C.player, 0.18));
    }

    // Blink while invulnerable so "that hit did nothing" is visible, not inferred.
    const blinking = p.invulnTicks > 0 && state.tick % 8 < 4;
    const body = blinking ? alpha(C.player, 0.35) : C.player;
    disc(p.x, p.y, r, body);
    // The blink is "that hit did nothing", and it has to survive having a face on
    // top of it — so the face blinks with the body instead of covering it.
    const pFaced = drawFace(fighters.player, p.x, p.y, r, blinking ? 0.4 : 1);
    ring(p.x, p.y, r + 3, alpha(dashing ? C.playerShot : C.player, 0.7), 2);

    // Aim line. From the centre on a bare disc; from the rim over a face, for the
    // same reason as the boss's tick — the player is only 12 px of radius, and a
    // line through the middle of that is the whole sprite.
    ctx.strokeStyle = C.void;
    ctx.lineWidth = 3;
    ctx.beginPath();
    const pInner = pFaced ? r + 1 : 0;
    ctx.moveTo(p.x + Math.cos(p.facing) * pInner, p.y + Math.sin(p.facing) * pInner);
    ctx.lineTo(p.x + Math.cos(p.facing) * (r + 6), p.y + Math.sin(p.facing) * (r + 6));
    ctx.stroke();

    // Dash-ready pip: a small arc that refills over the 45-tick cooldown.
    if (!dashing) {
      const ready = 1 - p.dashCooldown / E.player.dashCooldown;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 8, -Math.PI / 2, -Math.PI / 2 + TAU * ready);
      ctx.strokeStyle = alpha(C.playerShot, ready >= 1 ? 0.85 : 0.4);
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  // ------------------------------------------------------------------- draw

  function draw(state: GameState): void {
    effects.sync(state);
    habitHighlights.sync(state, habitCells);
    const tick = state.tick;
    const shake = effects.shake(tick);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = C.void;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const jitterX = shake === 0 ? 0 : (Math.sin(tick * 2.7) * 7 - 3) * shake;
    const jitterY = shake === 0 ? 0 : (Math.cos(tick * 3.1) * 7 - 3) * shake;
    ctx.setTransform(viewport.scale, 0, 0, viewport.scale, jitterX * viewport.scale, jitterY * viewport.scale);

    drawFloor();

    const habit = habitHighlights.current(tick);
    lastHabitHighlight = habit === null ? null : { x: habit.cell.x, y: habit.cell.y };
    if (habit !== null) drawHabitHighlight(habit, tick);

    const tg = state.boss.telegraph;
    if (tg !== null) {
      if (tg.type === 'slam') drawSlamTelegraph(tg.x, tg.y, tg.ticksLeft);
      else drawChargeTelegraph(state.boss.x, state.boss.y, tg.angle, tg.ticksLeft);
    }

    drawMinions(state);
    drawProjectiles(state);
    drawBoss(state);
    drawPlayer(state, effects.trail());

    for (const e of effects.effects()) drawEffect(e, tick);

    const flash = effects.hitFlash(tick);
    if (flash > 0) {
      ctx.fillStyle = alpha(C.boss, 0.16 * flash);
      ctx.fillRect(0, 0, ARENA, ARENA);
    }
  }

  return {
    resize,
    draw,
    viewport(): Viewport {
      return viewport;
    },
    reset(): void {
      effects.reset();
      habitHighlights.reset();
      lastHabitHighlight = null;
    },
    setFighters(next: { player: FighterId; boss: FighterId }): void {
      // Copied, not aliased: the caller holds a mutable object of its own and a
      // shared reference would make "who is on screen" change without a call.
      fighters = { player: next.player, boss: next.boss };
    },
    setHabitCells(cells: readonly HotCell[]): void {
      habitCells = cells;
    },
    activeHabitHighlight(): { x: number; y: number } | null {
      return lastHabitHighlight;
    },
  };
}
