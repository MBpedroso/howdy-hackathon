/**
 * Input mapping: keyboard -> engine axes, mouse -> aim vector.
 *
 * DOM-free on purpose — the mapping is pure, so it is tested here, and only the
 * listener plumbing in `createInputSource` needs a browser (the e2e suite covers it).
 */
import { describe, expect, it } from 'vitest';
import { axisFrom, buildInput, keyBinding, moveFrom, type Held } from '../src/game/input.ts';
import { clientToArena, computeViewport, fitSquare } from '../src/render/viewport.ts';

const NONE: Held = { up: false, down: false, left: false, right: false, dash: false };
const held = (partial: Partial<Held>): Held => ({ ...NONE, ...partial });
const AIM = { player: { x: 400, y: 400 }, fallback: { x: 400, y: 100 } };

describe('keyBinding', () => {
  it('maps WASD and arrows to the same controls', () => {
    expect(keyBinding('KeyW')).toBe('up');
    expect(keyBinding('ArrowUp')).toBe('up');
    expect(keyBinding('KeyA')).toBe('left');
    expect(keyBinding('ArrowLeft')).toBe('left');
    expect(keyBinding('Space')).toBe('dash');
  });

  it('ignores everything else', () => {
    expect(keyBinding('KeyQ')).toBeNull();
    expect(keyBinding('ShiftLeft')).toBeNull();
  });
});

describe('axes', () => {
  it('cancels opposing keys', () => {
    expect(axisFrom(true, true)).toBe(0);
    expect(axisFrom(false, false)).toBe(0);
    expect(axisFrom(true, false)).toBe(-1);
    expect(axisFrom(false, true)).toBe(1);
  });

  it('maps +y to down, matching the arena', () => {
    expect(moveFrom(held({ down: true }))).toEqual({ moveX: 0, moveY: 1 });
    expect(moveFrom(held({ up: true, right: true }))).toEqual({ moveX: 1, moveY: -1 });
  });
});

describe('buildInput', () => {
  it('aims at the pointer, relative to the player', () => {
    const input = buildInput(NONE, { x: 500, y: 400 }, false, false, AIM);
    expect(input.aimX).toBe(100);
    expect(input.aimY).toBe(0);
  });

  it('aims at the fallback (the boss) before the mouse has moved', () => {
    const input = buildInput(NONE, null, false, false, AIM);
    expect(input.aimX).toBe(0);
    expect(input.aimY).toBe(-300);
  });

  it('never emits a zero-length aim vector', () => {
    const input = buildInput(NONE, { x: 400, y: 400 }, false, false, AIM);
    expect(Math.hypot(input.aimX, input.aimY)).toBeGreaterThan(0);
  });

  it('passes dash and shoot through untouched', () => {
    const input = buildInput(held({ right: true }), { x: 0, y: 0 }, true, true, AIM);
    expect(input).toMatchObject({ moveX: 1, moveY: 0, dash: true, shoot: true });
  });
});

describe('viewport', () => {
  it('fits the largest square', () => {
    expect(fitSquare(1600, 900, 1)).toBe(900);
    expect(fitSquare(900, 1600, 1)).toBe(900);
    expect(fitSquare(100, 100, 1)).toBe(320); // clamped to the minimum
  });

  it('clamps the device pixel ratio', () => {
    expect(computeViewport(1000, 1000, 800, 3).dpr).toBe(2);
    expect(computeViewport(1000, 1000, 800, 0).dpr).toBe(1);
  });

  it('scales arena units to device pixels', () => {
    const v = computeViewport(1000, 1000, 800, 1);
    expect(v.cssSize).toBe(940);
    expect(v.scale).toBeCloseTo(940 / 800, 10);
  });

  it('maps client coordinates back into arena coordinates', () => {
    const rect = { left: 60, top: 40, width: 400, height: 400 };
    expect(clientToArena(rect, 60, 40, 800)).toEqual({ x: 0, y: 0 });
    expect(clientToArena(rect, 260, 240, 800)).toEqual({ x: 400, y: 400 });
    expect(clientToArena(rect, 460, 440, 800)).toEqual({ x: 800, y: 800 });
  });

  it('does not clamp a pointer outside the arena — it is still a direction', () => {
    const rect = { left: 0, top: 0, width: 800, height: 800 };
    expect(clientToArena(rect, -80, 900, 800)).toEqual({ x: -80, y: 900 });
  });
});
