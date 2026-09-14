/**
 * Transient visuals, derived from the engine's event log.
 *
 * The renderer is not allowed to touch state, and the engine has no notion of a
 * "flash". But it does record every notable moment in `state.events`, so the effects
 * layer just tails that array: each new event becomes a short-lived, purely cosmetic
 * effect, aged in **ticks** (not milliseconds) so effects freeze when the game is
 * paused and never desync from the simulation.
 *
 * Two positions cannot be recovered from an event alone, so they are remembered while
 * they are still on screen: the slam target (the telegraph is already cleared by the
 * tick the slam resolves) and the player's dash trail.
 */
import type { GameState, TimelineEvent } from '@rematch/engine';

export type EffectKind = 'burst' | 'slam' | 'chargeHit' | 'playerHit' | 'bossHit' | 'minionDown' | 'spawn';

export type Effect = {
  kind: EffectKind;
  x: number;
  y: number;
  /** Tick the effect was created on. */
  born: number;
  /** Lifetime in ticks. */
  ttl: number;
  /** 0 for a miss, 1 for a hit — only meaningful for `slam`. */
  hit: number;
  /**
   * The index of the event this effect came from. Not a display value: it is the
   * seed for the spark geometry below, so the same replay throws the same sparks
   * (`sparks`). The event log is deterministic, so this is too.
   */
  seed: number;
};

/** How long each kind lives, in ticks. */
const TTL: Readonly<Record<EffectKind, number>> = {
  burst: 14,
  slam: 18,
  chargeHit: 20,
  playerHit: 26,
  bossHit: 8,
  minionDown: 12,
  spawn: 20,
};

/** Trail sample: where the player was, and when. */
export type TrailPoint = { x: number; y: number; tick: number };

const MAX_EFFECTS = 64;
export const TRAIL_TICKS = 14;

// ------------------------------------------------------------------- 90s hit feel
//
// Three small pure helpers, kept here rather than in the renderer so they can be
// tested without a canvas — and so the one rule that matters stays enforceable:
// everything below is a function of (event index, tick), never of a random source.
// The renderer is idempotent (`renderer.ts` header) and the e2e screenshots depend
// on it, so a spark that moved between two draws of the same tick would be a bug.

/** Kinds that throw sparks: every moment where something took damage. */
export const SPARK_KINDS: readonly EffectKind[] = ['bossHit', 'playerHit', 'chargeHit', 'minionDown'];

/** One spark: an angle to fly out along, and how long the line is, in arena units. */
export type Spark = { angle: number; length: number };

export const SPARK_MIN = 5;
export const SPARK_MAX = 8;
export const SPARK_LENGTH_MIN = 6;
export const SPARK_LENGTH_MAX = 14;

const TAU = Math.PI * 2;

/**
 * A cheap 32-bit integer hash of two small numbers. Not cryptographic and not
 * trying to be: it only has to spread nearby (event, particle) pairs apart so two
 * consecutive hits do not throw the same fan of sparks.
 */
function hash2(a: number, b: number): number {
  let h = (Math.trunc(a) * 0x9e3779b1) ^ (Math.trunc(b) * 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 13), 0x297a2d39);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * The spark fan for one hit: 5-8 short lines on a roughly even ring, each nudged
 * off its slot so the fan does not read as a wheel spoke pattern.
 *
 * Pure and total: the same seed always produces the same array.
 */
export function sparks(seed: number): readonly Spark[] {
  const span = SPARK_MAX - SPARK_MIN + 1;
  const count = SPARK_MIN + (hash2(seed, 0) % span);
  const lengthSpan = SPARK_LENGTH_MAX - SPARK_LENGTH_MIN + 1;
  const out: Spark[] = [];
  for (let i = 0; i < count; i += 1) {
    const h = hash2(seed, i + 1);
    // Even slot, then up to +-40% of a slot of jitter: still legible as a burst,
    // never a perfect star.
    const jitter = ((h % 1000) / 1000 - 0.5) * 0.8 * (TAU / count);
    out.push({
      angle: (i / count) * TAU + jitter,
      length: SPARK_LENGTH_MIN + ((h >>> 12) % lengthSpan),
    });
  }
  return out;
}

/** Which entity a white sprite-flash belongs to. */
export type FlashTarget = 'player' | 'boss';

/** How long the struck entity stays washed out, in ticks. */
export const FLASH_TICKS = 4;
const FLASH_PEAK = 0.85;

/**
 * The classic sprite-flash: the struck body is overpainted near-white on the tick
 * it is hit, and the overlay is gone four ticks later. Linear on purpose — a curve
 * here reads as a glow, and a glow is not what a 90s hit looked like.
 */
export function flashAlpha(age: number): number {
  if (age < 0 || age >= FLASH_TICKS) return 0;
  return FLASH_PEAK * (1 - age / FLASH_TICKS);
}

/** The playerHit event that owns the full-canvas red flash is a hard 2-frame cut. */
export const HIT_FLASH_TICKS = 2;

/** One dash afterimage: where the player was, and how solid the ghost is. */
export type Ghost = { x: number; y: number; alpha: number };

/** Stepped, not interpolated — three discrete afterimages, nearest first. */
export const GHOST_ALPHAS: readonly number[] = [0.35, 0.2, 0.1];

/**
 * Sample the dash trail down to at most three discrete ghosts.
 *
 * The trail holds one point per tick, which drawn straight is a smear; a 90s
 * afterimage is a small number of separate copies of the sprite. The newest point
 * is skipped because that is where the player is actually being drawn this frame.
 */
export function ghosts(trail: readonly TrailPoint[], tick: number): readonly Ghost[] {
  const usable = trail.filter((p) => tick - p.tick > 0 && tick - p.tick <= TRAIL_TICKS);
  if (usable.length === 0) return [];
  const step = Math.max(1, Math.floor(usable.length / GHOST_ALPHAS.length));
  const out: Ghost[] = [];
  for (let i = 0; i < GHOST_ALPHAS.length; i += 1) {
    const index = usable.length - 1 - i * step;
    const point = usable[index];
    const a = GHOST_ALPHAS[i];
    if (point === undefined || a === undefined) break;
    out.push({ x: point.x, y: point.y, alpha: a });
  }
  return out;
}

export type EffectTracker = {
  /** Ingest everything that happened since the last call. Call once per frame. */
  sync(state: GameState): void;
  /** Live effects, oldest first. */
  effects(): readonly Effect[];
  /** Recent player positions, for the dash trail. */
  trail(): readonly TrailPoint[];
  /** 0..1 camera-shake amount for this frame. */
  shake(tick: number): number;
  /** 0..1 red screen flash for this frame — stepped, not faded (`HIT_FLASH_TICKS`). */
  hitFlash(tick: number): number;
  /** 0..1 white sprite-flash to overpaint the struck entity with this frame. */
  flash(target: FlashTarget, tick: number): number;
  /** Forget everything — called when a new round starts. */
  reset(): void;
};

export function createEffectTracker(): EffectTracker {
  let seen = 0;
  let live: Effect[] = [];
  let trailPoints: TrailPoint[] = [];
  /** Last slam target seen in a telegraph, so the resolution flash lands on it. */
  let slamTarget: { x: number; y: number } | null = null;

  function push(kind: EffectKind, x: number, y: number, tick: number, seed: number, hit = 0): void {
    live.push({ kind, x, y, born: tick, ttl: TTL[kind], hit, seed });
    if (live.length > MAX_EFFECTS) live = live.slice(-MAX_EFFECTS);
  }

  function ingest(state: GameState, ev: TimelineEvent, seed: number): void {
    const b = state.boss;
    const p = state.player;
    switch (ev.kind) {
      case 'bossBurst':
        push('burst', b.x, b.y, ev.tick, seed);
        return;
      case 'bossSlamHit':
      case 'bossSlamMiss': {
        const t = slamTarget ?? { x: p.x, y: p.y };
        push('slam', t.x, t.y, ev.tick, seed, ev.kind === 'bossSlamHit' ? 1 : 0);
        return;
      }
      case 'bossChargeHit':
        push('chargeHit', p.x, p.y, ev.tick, seed);
        return;
      case 'playerHit':
        push('playerHit', p.x, p.y, ev.tick, seed);
        return;
      case 'bossHit':
        push('bossHit', b.x, b.y, ev.tick, seed);
        return;
      case 'bossSpawn':
        push('spawn', p.x, p.y, ev.tick, seed);
        return;
      case 'minionDown':
        push('minionDown', p.x, p.y, ev.tick, seed);
        return;
      default:
        return;
    }
  }

  return {
    sync(state: GameState): void {
      // A new round resets `events`; detect it by the log shrinking.
      if (state.events.length < seen) {
        seen = 0;
        live = [];
        trailPoints = [];
        slamTarget = null;
      }

      const tg = state.boss.telegraph;
      if (tg !== null && tg.type === 'slam') slamTarget = { x: tg.x, y: tg.y };

      for (let i = seen; i < state.events.length; i += 1) {
        const ev = state.events[i];
        if (ev !== undefined) ingest(state, ev, i);
      }
      seen = state.events.length;

      const tick = state.tick;
      const last = trailPoints[trailPoints.length - 1];
      if (last === undefined || last.tick !== tick) {
        trailPoints.push({ x: state.player.x, y: state.player.y, tick });
      }
      trailPoints = trailPoints.filter((t) => tick - t.tick <= TRAIL_TICKS);
      live = live.filter((e) => tick - e.born <= e.ttl);
    },

    effects(): readonly Effect[] {
      return live;
    },

    trail(): readonly TrailPoint[] {
      return trailPoints;
    },

    shake(tick: number): number {
      let amount = 0;
      for (const e of live) {
        if (e.kind !== 'playerHit' && e.kind !== 'chargeHit' && !(e.kind === 'slam' && e.hit === 1)) continue;
        const t = 1 - (tick - e.born) / 10;
        if (t > amount) amount = t;
      }
      return amount < 0 ? 0 : amount > 1 ? 1 : amount;
    },

    // A hard cut, not a fade: two frames of full red and then nothing. A ramp reads
    // as a bloom; an arcade cabinet just swapped the palette for a frame or two.
    hitFlash(tick: number): number {
      for (const e of live) {
        if (e.kind !== 'playerHit') continue;
        const age = tick - e.born;
        if (age >= 0 && age < HIT_FLASH_TICKS) return 1;
      }
      return 0;
    },

    flash(target: FlashTarget, tick: number): number {
      const kind: EffectKind = target === 'boss' ? 'bossHit' : 'playerHit';
      let amount = 0;
      for (const e of live) {
        if (e.kind !== kind) continue;
        const a = flashAlpha(tick - e.born);
        if (a > amount) amount = a;
      }
      return amount;
    },

    reset(): void {
      seen = 0;
      live = [];
      trailPoints = [];
      slamTarget = null;
    },
  };
}
