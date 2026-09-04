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
const TRAIL_TICKS = 14;

export type EffectTracker = {
  /** Ingest everything that happened since the last call. Call once per frame. */
  sync(state: GameState): void;
  /** Live effects, oldest first. */
  effects(): readonly Effect[];
  /** Recent player positions, for the dash trail. */
  trail(): readonly TrailPoint[];
  /** 0..1 camera-shake amount for this frame. */
  shake(tick: number): number;
  /** 0..1 red screen flash for this frame. */
  hitFlash(tick: number): number;
  /** Forget everything — called when a new round starts. */
  reset(): void;
};

export function createEffectTracker(): EffectTracker {
  let seen = 0;
  let live: Effect[] = [];
  let trailPoints: TrailPoint[] = [];
  /** Last slam target seen in a telegraph, so the resolution flash lands on it. */
  let slamTarget: { x: number; y: number } | null = null;

  function push(kind: EffectKind, x: number, y: number, tick: number, hit = 0): void {
    live.push({ kind, x, y, born: tick, ttl: TTL[kind], hit });
    if (live.length > MAX_EFFECTS) live = live.slice(-MAX_EFFECTS);
  }

  function ingest(state: GameState, ev: TimelineEvent): void {
    const b = state.boss;
    const p = state.player;
    switch (ev.kind) {
      case 'bossBurst':
        push('burst', b.x, b.y, ev.tick);
        return;
      case 'bossSlamHit':
      case 'bossSlamMiss': {
        const t = slamTarget ?? { x: p.x, y: p.y };
        push('slam', t.x, t.y, ev.tick, ev.kind === 'bossSlamHit' ? 1 : 0);
        return;
      }
      case 'bossChargeHit':
        push('chargeHit', p.x, p.y, ev.tick);
        return;
      case 'playerHit':
        push('playerHit', p.x, p.y, ev.tick);
        return;
      case 'bossHit':
        push('bossHit', b.x, b.y, ev.tick);
        return;
      case 'bossSpawn':
        push('spawn', p.x, p.y, ev.tick);
        return;
      case 'minionDown':
        push('minionDown', p.x, p.y, ev.tick);
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
        if (ev !== undefined) ingest(state, ev);
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

    hitFlash(tick: number): number {
      let amount = 0;
      for (const e of live) {
        if (e.kind !== 'playerHit') continue;
        const t = 1 - (tick - e.born) / 14;
        if (t > amount) amount = t;
      }
      return amount < 0 ? 0 : amount > 1 ? 1 : amount;
    },

    reset(): void {
      seen = 0;
      live = [];
      trailPoints = [];
      slamTarget = null;
    },
  };
}
