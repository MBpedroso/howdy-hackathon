/**
 * Action validator — runs on every tick, on every value a strategy returns.
 *
 * Guarantees:
 *  - `validateAction` NEVER throws. Any input at all (null, arrays, functions,
 *    symbols, Proxies, objects with throwing getters, cyclic monsters) yields a
 *    result object. The sandbox boundary must not be able to crash the engine.
 *  - The returned `action` is a freshly built, canonical `BossAction`. Extra
 *    properties on the strategy's object are dropped, never forwarded.
 *
 * On `{ ok: false }` the engine coerces the tick to `{ type: 'idle' }` and counts a
 * contract violation (spec §4.3). Coercion is the engine's job, not the validator's,
 * so the caller can log the reason before discarding the action.
 */

import { BURST_COUNTS, CONSTANTS, type BossAction, type BossView, type PrimitiveName } from './types.ts';

export type ValidationOk = { ok: true; action: BossAction };
export type ValidationErr = { ok: false; reason: string };
export type ValidationResult = ValidationOk | ValidationErr;

const ERR = (reason: string): ValidationErr => ({ ok: false, reason });

/** Property read that survives throwing getters and revoked Proxies. */
function get(target: unknown, key: string): unknown {
  try {
    return (target as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function isPlainish(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Finite JS number. Rejects NaN, ±Infinity, numeric strings, bigints, booleans. */
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Short, allocation-bounded, throw-proof rendering of an arbitrary value. */
function describe(v: unknown): string {
  try {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    const t = typeof v;
    switch (t) {
      case 'string': {
        const s = v as string;
        return JSON.stringify(s.length > 32 ? `${s.slice(0, 32)}…` : s);
      }
      case 'symbol':
        return (v as symbol).toString();
      case 'bigint':
        return `${(v as bigint).toString()}n`;
      case 'function':
        return 'function';
      case 'object':
        return 'object';
      default:
        return String(v as number | boolean | undefined);
    }
  } catch {
    return '<unprintable>';
  }
}

function readArena(view: unknown): { w: number; h: number } {
  const arena = get(view, 'arena');
  const w = get(arena, 'w');
  const h = get(arena, 'h');
  return {
    w: isFiniteNumber(w) && w > 0 ? w : CONSTANTS.arena.w,
    h: isFiniteNumber(h) && h > 0 ? h : CONSTANTS.arena.h,
  };
}

/** Ticks remaining on `name`. A missing / malformed cooldown record reads as ready. */
function readCooldown(view: unknown, name: PrimitiveName): number {
  const cd = get(get(view, 'boss'), 'cooldowns');
  const v = get(cd, name);
  return isFiniteNumber(v) && v > 0 ? v : 0;
}

function ticks(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/**
 * Validate one strategy action against the world it was produced for.
 *
 * `view` is only consulted for arena bounds and cooldowns; a malformed view degrades
 * to the contract defaults rather than failing the action, so a broken engine state
 * can never be blamed on the strategy.
 */
export function validateAction(action: unknown, view: BossView): ValidationResult {
  try {
    return validateInner(action, view);
  } catch (err) {
    // Defence in depth: nothing below is supposed to throw.
    const message = err instanceof Error ? err.message : describe(err);
    return ERR(`validator error: ${message}`);
  }
}

function validateInner(action: unknown, view: BossView): ValidationResult {
  if (typeof action === 'function') return ERR('action must be a plain object, got function');
  if (Array.isArray(action)) return ERR('action must be a plain object, got array');
  if (!isPlainish(action)) return ERR(`action must be a plain object, got ${describe(action)}`);

  const rawType = get(action, 'type');
  if (typeof rawType !== 'string') return ERR(`action.type must be a string, got ${describe(rawType)}`);

  if (rawType === 'idle') return { ok: true, action: { type: 'idle' } };

  if (rawType !== 'move' && rawType !== 'burst' && rawType !== 'charge' && rawType !== 'slam' && rawType !== 'spawn') {
    return ERR(`unknown action type: ${describe(rawType)}`);
  }

  const type: PrimitiveName = rawType;

  // Cooldowns are checked before field shape: "on cooldown" is the more actionable
  // rejection reason for the Coder agent, and the action is dead either way.
  const remaining = readCooldown(view, type);
  if (remaining > 0) return ERR(`cooldown: ${type} (${ticks(remaining)} ticks)`);

  switch (type) {
    case 'move':
      return validateMove(action);
    case 'burst':
      return validateBurst(action);
    case 'charge':
      return validateCharge(action);
    case 'slam':
    case 'spawn':
      return validatePoint(type, action, view);
  }
}

/**
 * `move` is normalized to a unit vector, so a strategy may return any magnitude.
 * A zero-length vector (dx = dy = 0, or ±0) carries no direction, so it is accepted
 * and canonicalized to `{ type: 'idle' }` rather than rejected — "stand still" is a
 * legitimate intent and must not cost the strategy a contract violation.
 */
function validateMove(action: Record<string, unknown>): ValidationResult {
  const dx = get(action, 'dx');
  const dy = get(action, 'dy');
  if (!isFiniteNumber(dx)) return ERR(`move.dx must be a finite number, got ${describe(dx)}`);
  if (!isFiniteNumber(dy)) return ERR(`move.dy must be a finite number, got ${describe(dy)}`);

  // Scale by the larger component first so |dx|,|dy| near Number.MAX_VALUE cannot
  // overflow the magnitude to Infinity and collapse the vector to (0, 0).
  const scale = Math.max(Math.abs(dx), Math.abs(dy));
  if (scale === 0) return { ok: true, action: { type: 'idle' } };

  const sx = dx / scale;
  const sy = dy / scale;
  const mag = Math.sqrt(sx * sx + sy * sy);
  if (!Number.isFinite(mag) || mag === 0) return { ok: true, action: { type: 'idle' } };

  return { ok: true, action: { type: 'move', dx: sx / mag, dy: sy / mag } };
}

function validateBurst(action: Record<string, unknown>): ValidationResult {
  const angle = get(action, 'angle');
  const count = get(action, 'count');
  if (!isFiniteNumber(angle)) return ERR(`burst.angle must be a finite number, got ${describe(angle)}`);
  if (!isFiniteNumber(count)) return ERR(`burst.count must be a finite number, got ${describe(count)}`);
  if (count !== 3 && count !== 5 && count !== 8) {
    return ERR(`burst.count must be one of ${BURST_COUNTS.join(', ')}, got ${describe(count)}`);
  }
  return { ok: true, action: { type: 'burst', angle, count } };
}

function validateCharge(action: Record<string, unknown>): ValidationResult {
  const angle = get(action, 'angle');
  if (!isFiniteNumber(angle)) return ERR(`charge.angle must be a finite number, got ${describe(angle)}`);
  return { ok: true, action: { type: 'charge', angle } };
}

function validatePoint(type: 'slam' | 'spawn', action: Record<string, unknown>, view: BossView): ValidationResult {
  const x = get(action, 'x');
  const y = get(action, 'y');
  if (!isFiniteNumber(x)) return ERR(`${type}.x must be a finite number, got ${describe(x)}`);
  if (!isFiniteNumber(y)) return ERR(`${type}.y must be a finite number, got ${describe(y)}`);

  const arena = readArena(view);
  if (x < 0 || x > arena.w) return ERR(`${type}.x out of arena bounds: ${x} not in [0, ${arena.w}]`);
  if (y < 0 || y > arena.h) return ERR(`${type}.y out of arena bounds: ${y} not in [0, ${arena.h}]`);

  return type === 'slam' ? { ok: true, action: { type: 'slam', x, y } } : { ok: true, action: { type: 'spawn', x, y } };
}
