/**
 * The one piece of audio UI: a mute/unmute button, visible on every screen —
 * mounted once, directly into `document.body`, independent of `#hud` and `#screen`
 * so it survives every teardown `app.ts` does between rounds (`main.ts` creates it
 * exactly once, next to `createApp`).
 *
 * Flat, high-contrast, inline SVG — spec §2.3's own house style, the same discipline
 * `ui/fighters.ts`'s `fighterFaceSvg` follows for its stand-in faces. No image asset,
 * because there is nothing here an image would do better than two paths.
 *
 * Clicking it does two things, in order: it is the "first interaction" `audio/engine.ts`
 * is waiting for (so unmuting on the very first click still gets sound as soon as the
 * chain finishes building), and it flips the persisted preference
 * (`audio/mute.ts`) — both through the engine's own functions, never by reaching
 * into its state directly.
 */
import { init, isMuted, setMuted } from '../audio/engine.ts';

export type AudioToggle = {
  dispose(): void;
};

/** Flat speaker glyph, waves or a slash — 20x20, matches the toolbar's monochrome text colour. */
function iconSvg(muted: boolean): string {
  const body = '<path d="M3 8h3.2l4.3-3.8v11.6L6.2 12H3z" fill="currentColor"/>';
  if (muted) {
    return [
      '<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">',
      body,
      '<g stroke="currentColor" stroke-width="1.6" stroke-linecap="round">',
      '<path d="M13 7.5l4.5 5M17.5 7.5L13 12.5"/>',
      '</g>',
      '</svg>',
    ].join('');
  }
  return [
    '<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">',
    body,
    '<g fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">',
    '<path d="M13.2 7c1 .9 1 5.1 0 6"/>',
    '<path d="M15.3 5c2 2 2 8 0 10"/>',
    '</g>',
    '</svg>',
  ].join('');
}

export function createAudioToggle(host: HTMLElement = document.body): AudioToggle {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'audio-toggle';
  btn.dataset.testid = 'audio-toggle';

  function paint(muted: boolean): void {
    btn.innerHTML = iconSvg(muted);
    btn.setAttribute('aria-pressed', String(muted));
    btn.setAttribute('aria-label', muted ? 'Unmute sound' : 'Mute sound');
    btn.title = muted ? 'Sound is off — click to unmute' : 'Sound is on — click to mute';
    btn.dataset.muted = String(muted);
  }

  paint(isMuted());

  function onClick(ev: MouseEvent): void {
    // The overlay under a screen treats a click anywhere as its primary action
    // (`ui/screens.ts`); the toggle must not also fight, skip the intro or advance
    // a beat.
    ev.stopPropagation();
    // Clicking mute is itself a gesture — build the chain now so an *unmute* is
    // ready to be heard immediately rather than waiting for a second click.
    void init();
    const next = !isMuted();
    setMuted(next);
    paint(next);
  }
  btn.addEventListener('click', onClick);

  host.append(btn);

  return {
    dispose(): void {
      btn.removeEventListener('click', onClick);
      btn.remove();
    },
  };
}
