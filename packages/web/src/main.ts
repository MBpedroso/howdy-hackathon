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

const app = createApp({
  canvas: required<HTMLCanvasElement>('#arena'),
  hud: required<HTMLElement>('#hud'),
  screen: required<HTMLElement>('#screen'),
});

window.__rematch = app.debug;

void app.boot();
