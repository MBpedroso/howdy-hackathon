/**
 * A portrait, as DOM — the only file that knows how the raster art and the SVG
 * placeholder swap for one another.
 *
 * ```
 * <span class="rm-portrait" data-agent="analyst" style="--accent:#2DD4BF">
 *   <span class="rm-portrait-ph"><svg …/></span>   <!-- always present -->
 *   <img src="./agents/analyst.png" …/>            <!-- on top, once it loads -->
 * </span>
 * ```
 *
 * The placeholder is rendered **first and always**, and the `<img>` is layered over
 * it and only becomes visible on `load`. Two reasons, both from watching this fail
 * the other way round:
 *
 * 1. No flash. An `<img>` with an `onerror` handler paints a broken-image glyph for
 *    a frame before the handler runs, and the interlude is a screen people watch
 *    frame by frame in a screen recording.
 * 2. Dropping the PNGs in needs **no code change** (that is the whole deal with the
 *    human generating them separately) and neither does taking them out again.
 *
 * The 404 while the art is missing is real and visible in the browser console. It is
 * not hidden — `e2e/helpers.ts` filters exactly that one message out of its console
 * assertion and says why, so the day the files land the filter stops matching and
 * nothing else about the suite changes.
 */
import { AGENTS, placeholderSvg, portraitUrl, type AgentId } from './cast.ts';
import { FIGHTERS, fighterFaceSvg, fighterUrl, type FighterId } from './fighters.ts';

export type PortraitOptions = {
  /** CSS pixels. The square is `size × size`. */
  size: number;
  /**
   * Render it greyed and half-lit: an agent that has not started acting yet. The
   * Replay panel opens this way, because the Analyst has not read anything.
   */
  dim?: boolean;
  /** Overrides the `src` base. Tests only. */
  baseUrl?: string;
};

/**
 * Build one portrait.
 *
 * `data-testid="portrait-<id>"` so a spec can assert the cast is on screen without
 * depending on whether the raster art has landed.
 */
export function createPortrait(id: AgentId, options: PortraitOptions): HTMLElement {
  const agent = AGENTS[id];
  const wrap = document.createElement('span');
  wrap.className = 'rm-portrait';
  wrap.dataset.agent = id;
  wrap.dataset.testid = `portrait-${id}`;
  wrap.style.setProperty('--accent', agent.accent);
  wrap.style.setProperty('--portrait-size', `${options.size}px`);
  if (options.dim === true) wrap.dataset.dim = '1';
  wrap.title = agent.name;

  const placeholder = document.createElement('span');
  placeholder.className = 'rm-portrait-ph';
  // Static markup this module built from `cast.ts`'s own constants — no external
  // input reaches it. `innerHTML` is how an SVG string becomes SVG elements.
  placeholder.innerHTML = placeholderSvg(id);
  wrap.append(placeholder);

  const img = document.createElement('img');
  img.className = 'rm-portrait-img';
  img.alt = agent.name;
  img.decoding = 'async';
  img.width = options.size;
  img.height = options.size;
  img.addEventListener('load', () => {
    img.dataset.ok = '1';
  });
  img.addEventListener('error', () => {
    // The art is not there. Leave the placeholder as the portrait and stop asking.
    img.remove();
  });
  img.src = portraitUrl(id, options.baseUrl);
  wrap.append(img);

  return wrap;
}

/** `dim` after the fact: the Analyst lights up when it starts reading. */
export function setPortraitDim(portrait: HTMLElement, dim: boolean): void {
  if (dim) portrait.dataset.dim = '1';
  else delete portrait.dataset.dim;
}

/**
 * A fighter's face — the same placeholder-under-an-`<img>` trick as
 * `createPortrait`, for the four mascots.
 *
 * Separate function rather than a branch inside `createPortrait` because a fighter
 * is not an agent: it has no accent-driven "who is acting now" state, no `dim`, and
 * its art is a transparent crop rather than a square on navy. What the two share is
 * the failure behaviour, and that is the part worth keeping identical — the SVG
 * stand-in is always present, the raster is layered over it and only shows on
 * `load`, and a missing file removes the `<img>` and stops asking.
 */
export function createFighterFace(id: FighterId, size: number, baseUrl?: string): HTMLElement {
  const fighter = FIGHTERS[id];
  const wrap = document.createElement('span');
  wrap.className = 'rm-face';
  wrap.dataset.fighter = id;
  wrap.style.setProperty('--accent', fighter.accent);
  wrap.style.setProperty('--face-size', `${size}px`);

  const placeholder = document.createElement('span');
  placeholder.className = 'rm-face-ph';
  // Static markup built from `fighters.ts`'s own constants — no external input.
  placeholder.innerHTML = fighterFaceSvg(id);
  wrap.append(placeholder);

  const img = document.createElement('img');
  img.className = 'rm-face-img';
  img.alt = '';
  img.decoding = 'async';
  img.width = size;
  img.height = size;
  img.addEventListener('load', () => {
    img.dataset.ok = '1';
  });
  img.addEventListener('error', () => {
    img.remove();
  });
  img.src = fighterUrl(id, baseUrl);
  wrap.append(img);

  return wrap;
}
