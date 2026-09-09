/**
 * The fighter sprites, for the canvas — an image cache and nothing else.
 *
 * The renderer is otherwise flat shapes on a flat palette (spec §2.3, "no raster
 * art"), and this is the second documented departure from that after the agent
 * portraits: the two fighters wear the mascot art the human supplied. Recorded as a
 * delta in `docs/SPEC.md` §13. Everything else in the fight — telegraphs, shots,
 * minions, the floor grid, every tell — is still drawn, because the tells are the
 * fight's fairness contract and a picture cannot be relied on to arrive.
 *
 * ## Why a cache with a null return, and not a promise
 *
 * `draw` runs 60 times a second and must never await anything. So this module
 * starts the four loads once and answers `sprite(id)` synchronously with either a
 * decoded image or `null`, and the renderer draws its existing disc when the answer
 * is `null`. Three consequences, all wanted:
 *
 *  - the first frames of a cold load are the old flat look, not a blank arena;
 *  - a missing or corrupt file is permanently the old flat look, not a crash;
 *  - the fight is playable before the art decodes, which matters because the game
 *    starts on a click and the images are ~90 KB each.
 *
 * The cache is module-level rather than per-renderer: there is one canvas, the art
 * is immutable, and a round change must not re-decode four PNGs.
 */
import { FIGHTER_ORDER, fighterUrl, type FighterId } from '../ui/fighters.ts';

/** Decoded images, by id. Absent until `load` fires; never removed. */
const ready = new Map<FighterId, HTMLImageElement>();
/** Loads already started, so `preload` is idempotent and cheap to call per round. */
const started = new Set<FighterId>();

/** Is the environment one where an `<img>` can exist at all? Node tests are not. */
function canLoad(): boolean {
  return typeof Image !== 'undefined';
}

/**
 * Start loading every fighter's art. Safe to call repeatedly and from anywhere;
 * safe to never call, in which case `sprite` simply keeps answering `null`.
 */
export function preloadFighters(): void {
  if (!canLoad()) return;
  for (const id of FIGHTER_ORDER) {
    if (started.has(id)) continue;
    started.add(id);
    const img = new Image();
    img.decoding = 'async';
    img.addEventListener('load', () => {
      // Guard against a zero-sized decode: `drawImage` of a broken image throws.
      if (img.naturalWidth > 0 && img.naturalHeight > 0) ready.set(id, img);
    });
    // No handler on `error`: the absence of an entry *is* the fallback, and the 404
    // stays visible in the console on purpose (see `ui/portrait.ts` for the same
    // reasoning, and `e2e/helpers.ts` for the one place it is tolerated).
    img.src = fighterUrl(id);
  }
}

/** The decoded image for a fighter, or `null` while it is not usable yet. */
export function sprite(id: FighterId): HTMLImageElement | null {
  return ready.get(id) ?? null;
}

/** Tests only: forget everything, so a case can assert the cold path. */
export function resetSpritesForTest(): void {
  ready.clear();
  started.clear();
}
