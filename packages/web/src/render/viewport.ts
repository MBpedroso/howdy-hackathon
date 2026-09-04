/**
 * Viewport maths — how an 800x800 arena lands on a screen of any shape.
 *
 * The arena is square and stays square: the canvas element is sized to the largest
 * square that fits the window (letterboxed by the page background), the backing store
 * is that square times the device pixel ratio, and the 2D context gets one uniform
 * scale. No non-uniform scaling anywhere, so a circle is always a circle and the mouse
 * maps back to arena coordinates with a single divide.
 *
 * Everything here is pure so the mouse->arena mapping can be unit-tested without a DOM.
 */

/** Minimum on-screen size of the arena, in CSS pixels. Below this we just clip. */
export const MIN_STAGE_PX = 320;

/** Fraction of the smaller window dimension the arena is allowed to use. */
export const STAGE_FILL = 0.94;

/** Largest square that fits `w x h`, in CSS pixels. */
export function fitSquare(w: number, h: number, fill: number = STAGE_FILL): number {
  const side = Math.floor(Math.min(w, h) * fill);
  return Math.max(MIN_STAGE_PX, side);
}

/** The rectangle fields we need off `getBoundingClientRect()`. */
export type Rect = { left: number; top: number; width: number; height: number };

export type Viewport = {
  /** On-screen side of the arena, in CSS pixels. */
  cssSize: number;
  /** Backing-store side, in device pixels. */
  pixelSize: number;
  /** Device pixels per arena unit — the ctx transform. */
  scale: number;
  dpr: number;
};

export function computeViewport(windowW: number, windowH: number, arenaSize: number, dpr: number): Viewport {
  const cssSize = fitSquare(windowW, windowH);
  // Clamp the DPR: a 3x retina display at 940 CSS px would allocate an 8 Mpx backing
  // store per frame for a flat-shaded scene that gains nothing from it.
  const clamped = Math.max(1, Math.min(dpr, 2));
  const pixelSize = Math.round(cssSize * clamped);
  return { cssSize, pixelSize, scale: pixelSize / arenaSize, dpr: clamped };
}

/**
 * Map a pointer event's client coordinates into arena coordinates.
 *
 * Driven by the canvas's own `getBoundingClientRect()` rather than by the viewport we
 * computed, so CSS zoom, a scrolled page and a stale resize all stay correct. The
 * result is deliberately NOT clamped: a mouse outside the arena is still a valid aim
 * direction, and the engine only ever uses the aim vector's direction.
 */
export function clientToArena(rect: Rect, clientX: number, clientY: number, arenaSize: number): { x: number; y: number } {
  const w = rect.width > 0 ? rect.width : 1;
  const h = rect.height > 0 ? rect.height : 1;
  return {
    x: ((clientX - rect.left) / w) * arenaSize,
    y: ((clientY - rect.top) / h) * arenaSize,
  };
}
