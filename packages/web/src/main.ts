/**
 * Entry point. Finds the three nodes `index.html` provides, boots the app, and
 * publishes the debug surface as `window.__rematch`.
 *
 * `window.__rematch` is not a convenience: spec AC 3 requires the browser and Node to
 * agree on a replay hash byte for byte, and the only way to prove that from outside is
 * to hand the browser a recorded input log and read the hash back out. The e2e suite
 * does exactly that (`e2e/determinism.spec.ts`).
 */
import './ui/styles.css';

import { createApp, type DebugApi } from './app.ts';
import { createAudioToggle } from './ui/audioToggle.ts';
import { initCrt } from './ui/crt.ts';

declare global {
  interface Window {
    /** Debug + e2e surface. Present in every build; harmless and read-only. */
    __rematch?: DebugApi;
  }
}

function required<T extends Element>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (node === null) throw new Error(`main: missing ${selector}`);
  return node;
}

// Scanlines and vignette, on before the first screen paints so the look is never
// applied a frame late. `?crt=0` turns it off; the effect itself is CSS only.
initCrt(window.location.search);

const app = createApp({
  canvas: required<HTMLCanvasElement>('#arena'),
  hud: required<HTMLElement>('#hud'),
  screen: required<HTMLElement>('#screen'),
});

window.__rematch = app.debug;

// The mute toggle — audio's one piece of UI, visible on every screen from the
// moment the game boots. Initializing Tone.js itself happens later, off a real
// gesture (a screen's primary button, the interlude's FIGHT button, or a click on
// this toggle) — see `audio/engine.ts`'s `init()`.
createAudioToggle();

void app.boot();
