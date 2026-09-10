/**
 * The "YOUR HABIT" caption over a habit-cell highlight (`render/habitHighlight.ts`).
 *
 * Text on the arena floor is DOM, not canvas, for the same reason the HUD is
 * (`ui/hud.ts`'s header: crisp at any DPR, no font plumbing) — the renderer draws
 * the pulsing cell itself in `render/renderer.ts`, this positions three words over
 * it. `app.ts` drives both from the same tick, in `render/frame`, so they cannot
 * drift apart by more than one frame.
 */
export type HabitCaption = {
  /** Position the caption over one cell's centre (arena units) and reveal it. */
  show(arenaX: number, arenaY: number, cssSize: number, arenaSize: number): void;
  hide(): void;
};

export function createHabitCaption(root: HTMLElement): HabitCaption {
  const el = document.createElement('div');
  el.className = 'habit-caption';
  el.dataset.testid = 'habit-caption';
  el.textContent = 'YOUR HABIT';
  el.hidden = true;
  root.append(el);

  return {
    show(arenaX, arenaY, cssSize, arenaSize): void {
      const scale = cssSize / arenaSize;
      el.style.left = `${arenaX * scale}px`;
      el.style.top = `${arenaY * scale}px`;
      el.hidden = false;
    },
    hide(): void {
      el.hidden = true;
    },
  };
}
