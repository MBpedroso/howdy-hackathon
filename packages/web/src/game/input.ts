/**
 * Live player input: keyboard + mouse -> one `PlayerInput` per tick.
 *
 * The engine's input record is tiny and digital on purpose (WASD axes, a dash bit, an
 * aim vector, a shoot bit) because it is also the replay format. Everything here is
 * about producing that record honestly:
 *
 *  - **Move**: WASD and the arrow keys, both mapped to the same axes. Diagonals are
 *    normalized by the engine, never by us.
 *  - **Dash**: Space, edge-triggered with an 8-tick buffer. A held key would auto-dash
 *    every time the 45-tick cooldown expired, which feels like a bug; a bare edge would
 *    throw away a press made 3 ticks before the cooldown ended, which feels worse. The
 *    buffer is the standard fix and it costs one counter.
 *  - **Aim**: the pointer's position in *arena* coordinates minus the player's, so the
 *    aim vector is a direction and the engine normalizes it. Before the mouse has ever
 *    moved there is nothing to aim at, so aim falls back to the boss — the player's
 *    first shot always goes somewhere sensible and `aimLen` is never 0.
 *  - **Shoot**: mouse held. The engine enforces the 8-tick shot cooldown.
 *
 * The key-mapping and axis logic is exported as pure functions and unit-tested; only
 * `createInputSource` touches the DOM.
 */
import { IDLE_INPUT, type Axis, type PlayerInput } from '@rematch/engine';
import { clientToArena, type Rect } from '../render/viewport.ts';

/** The five things a keyboard can express. */
export type Control = 'up' | 'down' | 'left' | 'right' | 'dash';

/**
 * `KeyboardEvent.code` -> control. `code` and not `key`, so the bindings are physical:
 * WASD still works on AZERTY, and Shift/CapsLock do not change anything.
 */
export const KEY_BINDINGS: Readonly<Record<string, Control>> = Object.freeze({
  KeyW: 'up',
  KeyS: 'down',
  KeyA: 'left',
  KeyD: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Space: 'dash',
});

/** Keys whose default browser action must be suppressed (page scroll, mostly). */
export const PREVENT_DEFAULT_CODES: readonly string[] = Object.freeze([
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
]);

export function keyBinding(code: string): Control | null {
  return KEY_BINDINGS[code] ?? null;
}

/** Ticks a dash press stays queued after the key goes down. */
export const DASH_BUFFER_TICKS = 8;

/** Which controls are currently held. */
export type Held = Readonly<Record<Control, boolean>>;

/** Digital axis from a pair of opposing keys. Both held cancels out, as it should. */
export function axisFrom(negative: boolean, positive: boolean): Axis {
  if (negative === positive) return 0;
  return positive ? 1 : -1;
}

/** WASD/arrows -> the engine's two axes. `+y` is down: canvas and arena agree. */
export function moveFrom(held: Held): { moveX: Axis; moveY: Axis } {
  return {
    moveX: axisFrom(held.left, held.right),
    moveY: axisFrom(held.up, held.down),
  };
}

/** Where the player is, and what to aim at when the mouse has never moved. */
export type AimContext = {
  player: { x: number; y: number };
  fallback: { x: number; y: number };
};

/**
 * Build the tick's input from raw state. Pure: `createInputSource` collects the raw
 * state from the DOM and hands it here, and the unit tests hand it fixtures.
 */
export function buildInput(
  held: Held,
  pointer: { x: number; y: number } | null,
  shooting: boolean,
  dashQueued: boolean,
  ctx: AimContext,
): PlayerInput {
  const { moveX, moveY } = moveFrom(held);
  const target = pointer ?? ctx.fallback;
  let aimX = target.x - ctx.player.x;
  let aimY = target.y - ctx.player.y;
  // A zero aim vector would make the engine fall back to the movement direction and
  // silently swallow the shot; +x is the same default `IDLE_INPUT` uses.
  if (aimX === 0 && aimY === 0) {
    aimX = IDLE_INPUT.aimX;
    aimY = IDLE_INPUT.aimY;
  }
  return { moveX, moveY, dash: dashQueued, aimX, aimY, shoot: shooting };
}

export type InputSource = {
  /** Sample the input for one tick. Consumes a queued dash. */
  sample(ctx: AimContext): PlayerInput;
  /** True once the pointer has produced a position. */
  hasPointer(): boolean;
  /** Drop every held key — used on blur and between rounds. */
  clear(): void;
  dispose(): void;
};

export type InputSourceOptions = {
  /** The element pointer coordinates are measured against. */
  canvas: HTMLCanvasElement;
  /** Arena side length in arena units (800). */
  arenaSize: number;
  /** Event target for keys and mouse buttons. Defaults to `window`. */
  target?: Window;
};

/**
 * Attach listeners and start collecting input. `dispose()` removes every listener.
 */
export function createInputSource(options: InputSourceOptions): InputSource {
  const { canvas, arenaSize } = options;
  const target: Window = options.target ?? window;

  const held: Record<Control, boolean> = { up: false, down: false, left: false, right: false, dash: false };
  let pointer: { x: number; y: number } | null = null;
  let shooting = false;
  let dashTicks = 0;

  function onKeyDown(ev: KeyboardEvent): void {
    if (PREVENT_DEFAULT_CODES.includes(ev.code)) ev.preventDefault();
    const control = keyBinding(ev.code);
    if (control === null) return;
    // `repeat` events must not re-arm the buffer: holding Space would auto-dash.
    if (control === 'dash') {
      if (!ev.repeat && !held.dash) dashTicks = DASH_BUFFER_TICKS;
      held.dash = true;
      return;
    }
    held[control] = true;
  }

  function onKeyUp(ev: KeyboardEvent): void {
    if (PREVENT_DEFAULT_CODES.includes(ev.code)) ev.preventDefault();
    const control = keyBinding(ev.code);
    if (control === null) return;
    held[control] = false;
  }

  function onPointerMove(ev: PointerEvent): void {
    const rect: Rect = canvas.getBoundingClientRect();
    pointer = clientToArena(rect, ev.clientX, ev.clientY, arenaSize);
  }

  function onPointerDown(ev: PointerEvent): void {
    // Only the primary button shoots; right-click stays a context menu.
    if (ev.button !== 0) return;
    onPointerMove(ev);
    shooting = true;
  }

  function onPointerUp(ev: PointerEvent): void {
    if (ev.button !== 0) return;
    shooting = false;
  }

  function clear(): void {
    held.up = false;
    held.down = false;
    held.left = false;
    held.right = false;
    held.dash = false;
    shooting = false;
    dashTicks = 0;
  }

  target.addEventListener('keydown', onKeyDown);
  target.addEventListener('keyup', onKeyUp);
  target.addEventListener('pointermove', onPointerMove);
  target.addEventListener('pointerdown', onPointerDown);
  target.addEventListener('pointerup', onPointerUp);
  target.addEventListener('pointercancel', onPointerUp);
  target.addEventListener('blur', clear);

  return {
    sample(ctx: AimContext): PlayerInput {
      // `dash` stays set for the whole buffer window and the engine takes it when it
      // can: if the cooldown ends inside the window the dash fires, and the leftover
      // ticks land inside the 10-tick dash itself, where the engine ignores them.
      const dash = dashTicks > 0;
      if (dashTicks > 0) dashTicks -= 1;
      return buildInput(held, pointer, shooting, dash, ctx);
    },
    hasPointer(): boolean {
      return pointer !== null;
    },
    clear,
    dispose(): void {
      clear();
      target.removeEventListener('keydown', onKeyDown);
      target.removeEventListener('keyup', onKeyUp);
      target.removeEventListener('pointermove', onPointerMove);
      target.removeEventListener('pointerdown', onPointerDown);
      target.removeEventListener('pointerup', onPointerUp);
      target.removeEventListener('pointercancel', onPointerUp);
      target.removeEventListener('blur', clear);
    },
  };
}
