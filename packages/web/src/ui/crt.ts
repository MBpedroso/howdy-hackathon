/**
 * The CRT overlay's one switch.
 *
 * The effect itself is entirely in `ui/styles.css` — two fixed pseudo-elements on
 * `body`, scanlines and a corner vignette, matched only under
 * `html[data-crt='on']`. This module exists to set that attribute, and to make the
 * decision testable without a browser.
 *
 * Why it is opt-*out* rather than opt-in: the effect is the game's intended look, so
 * the default has to be the one a player gets by opening the page. `?crt=0` turns it
 * off, which is what a screenshot of the interlude wants (the rejection sentences are
 * contractual reading material — spec §2.2) and what anyone reading the diff on a
 * laptop in a bright room wants. Any other value, including a missing one, is on.
 *
 * Like `audio/` and `ui/fighters.ts`, this is a costume: it imports nothing, no
 * simulation module imports it, and `test/crt-costume.test.ts` asserts both
 * directions rather than trusting this paragraph.
 */

/**
 * Should the CRT layer be on for this query string?
 *
 * Pure, and separate from `initCrt` on purpose: the decision is the part worth
 * testing, and it needs no DOM to test.
 *
 * @param search a `location.search` string, with or without its leading `?`.
 */
export function crtEnabled(search: string): boolean {
  return new URLSearchParams(search).get('crt') !== '0';
}

/**
 * Stamp the decision onto the document element, where the stylesheet can see it.
 *
 * Called once from `main.ts` before the first screen renders, so the overlay is
 * never absent for a frame and then applied.
 *
 * `off` is written out rather than left unset: an explicit value is what makes the
 * state legible in devtools and in a Playwright trace.
 */
export function initCrt(search: string, root: HTMLElement = document.documentElement): void {
  root.dataset.crt = crtEnabled(search) ? 'on' : 'off';
}
