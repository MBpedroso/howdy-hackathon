/**
 * The four fighters — who you can be, and who you can fight.
 *
 * Purely cosmetic, and that is a hard rule rather than a note. A fighter choice
 * never reaches `GameState`, never reaches the engine, and never reaches a
 * strategy's `view`. Two reasons, both load-bearing:
 *
 *  1. **Determinism.** Spec AC 3 is "same seed + same input log produces an
 *     identical final state hash in browser and Node". A skin that entered the
 *     state would make the hash depend on a menu click, and the Node harness has
 *     no menu. Every replay, every recorded run and every one of Gate 3's 200
 *     matches stays valid across this feature because the simulation cannot see it.
 *  2. **Fairness.** The boss's difficulty is the Judge's business. A skin that
 *     changed a radius or a speed would be a balance change wearing a costume.
 *
 * So this module is data and strings only — the same shape as `ui/cast.ts`, and for
 * the same reason: it is imported by the start screen (`ui/screens.ts`) and, later,
 * by the renderer, and it is unit tested in Node with no DOM.
 *
 * ## Portraits
 *
 * `public/fighters/<id>.png` — 512x512 head-and-gloves crops of the four mascots on
 * transparency, cut from the full-body originals the human supplied (the legs are
 * dropped on purpose: the fight is played from above and they would be four pixels
 * tall). `scripts/crop-fighters.py` is the cut, kept so a re-supplied original can
 * be re-cropped the same way.
 *
 * If a file is missing, `fighterFaceSvg` stands in: the same ball, the same accent,
 * the same one feature that tells the four apart. That is the identical late-binding
 * trick `ui/cast.ts` uses for the agent portraits (`docs/SPEC.md` §13, delta 17), and
 * it is what let this screen be built and screenshotted before the art was cropped.
 */

/**
 * The four. Ids are stable — they are written to `localStorage` *and* they are the
 * filenames under `public/fighters/` — and they are the mascots' own names rather
 * than descriptions of what they look like, so the code and the art agree.
 */
export type FighterId = 'neptune' | 'saturn' | 'jupiter' | 'earth';

/**
 * Where the mascot's ball sits inside its crop, as fractions of the square.
 *
 * The canvas draws a face inside the fighter's collision circle, so it needs the
 * *ball's* centre and radius rather than the image's: the crops keep the gloves and
 * one outstretched arm, which pull the bounding box sideways — Jupiter's ball sits
 * at 0.38 of the width and Earth's at 0.63. Centring the image instead put one
 * face left of the boss and cropped the other at the chin.
 *
 * Measured, not guessed: `scripts/crop-fighters.py --geometry` finds the largest
 * circle that fits inside the opaque mask and prints these numbers. Re-run it if
 * the art is ever re-supplied.
 */
export type Ball = { cx: number; cy: number; r: number };

export type Fighter = {
  id: FighterId;
  /** Shown under the face on the picker, and in the HUD. */
  name: string;
  /** The ball's place in the crop. See `Ball`. */
  ball: Ball;
  /** The mascot's own colour, sampled from the art. Hex: it goes into inline SVG. */
  accent: string;
  /**
   * Three or four words, on the picker. Flavour only — it must not describe an
   * ability, because there are none. A picker whose captions imply stats is a
   * picker that lies.
   */
  tag: string;
};

export const FIGHTERS: Readonly<Record<FighterId, Fighter>> = {
  neptune: {
    id: 'neptune',
    name: 'Neptune',
    accent: '#4a7fbf',
    tag: 'Hat on, unimpressed',
    ball: { cx: 0.568, cy: 0.568, r: 0.389 },
  },
  saturn: {
    id: 'saturn',
    name: 'Saturn',
    accent: '#f28f21',
    tag: 'Ringed, moustache, star',
    ball: { cx: 0.457, cy: 0.484, r: 0.285 },
  },
  jupiter: {
    id: 'jupiter',
    name: 'Jupiter',
    accent: '#d81e1e',
    tag: 'Striped, two holsters',
    ball: { cx: 0.381, cy: 0.471, r: 0.338 },
  },
  earth: {
    id: 'earth',
    name: 'Earth',
    accent: '#2f8f86',
    tag: 'Grinning, worldwide',
    ball: { cx: 0.633, cy: 0.477, r: 0.348 },
  },
};

/** Picker order. Fixed, so the grid does not reshuffle between visits. */
export const FIGHTER_ORDER: readonly FighterId[] = ['neptune', 'saturn', 'jupiter', 'earth'];

export const FIGHTER_LIST: readonly Fighter[] = FIGHTER_ORDER.map((id) => FIGHTERS[id]);

/** Defaults: the player is cool-coloured, the boss is warm — `render/palette.ts`'s rule. */
export const DEFAULT_PLAYER_FIGHTER: FighterId = 'earth';
export const DEFAULT_BOSS_FIGHTER: FighterId = 'jupiter';

/** Is this string one of the four? The guard every untrusted read goes through. */
export function isFighterId(value: unknown): value is FighterId {
  return typeof value === 'string' && Object.hasOwn(FIGHTERS, value);
}

/** Where a fighter's art lives, relative to the site root. */
export const FIGHTER_DIR = 'fighters';

function defaultBase(): string {
  return (import.meta.env?.BASE_URL as string | undefined) ?? './';
}

/** `./fighters/neptune.png`. Built from Vite's base, like `cast.ts`'s `portraitUrl`. */
export function fighterUrl(id: FighterId, baseUrl?: string): string {
  const base = baseUrl ?? defaultBase();
  const prefix = base === '' ? './' : base.endsWith('/') ? base : `${base}/`;
  return `${prefix}${FIGHTER_DIR}/${id}.png`;
}

/**
 * The stand-in face: a ball, the mascot's accent, gloves up, and the one feature
 * that identifies it — hat, moustache, stripes, meridians.
 *
 * On a 64×64 grid, no ground and no text, so it reads at 40 px in a HUD chip and at
 * 128 px on the picker, and so it can be drawn onto the canvas later from a data URL.
 * Faces only: the mascots' legs are cropped out on purpose (they would be four
 * pixels tall at fighting size, and the fight is played from above).
 */
export function fighterFaceSvg(id: FighterId): string {
  const f = FIGHTERS[id];
  return [
    `<svg viewBox="0 0 64 64" role="img" aria-label="${f.name}" focusable="false">`,
    // The ball. Flat fill, hard outline: the mascots are ink-and-flat-colour.
    `<circle cx="32" cy="34" r="21" fill="${f.accent}" stroke="#07080c" stroke-width="2.5"/>`,
    // The white belly-swoosh every one of the four has. Kept to the lower half and
    // narrower than the ball: at 60 px a full-width band swallows the accent, and
    // the accent is the only thing telling four round mascots apart.
    `<path d="M16 40 C23 34 41 34 48 40 C45 48 39 52 32 52 C25 52 19 48 16 40 Z" fill="#f6f7fb" opacity="0.9"/>`,
    featureSvg(id, f.accent),
    // Eyes, on top of the swoosh.
    '<g fill="#07080c">',
    '<ellipse cx="26" cy="31" rx="3.8" ry="5.4" fill="#f6f7fb"/>',
    '<ellipse cx="38" cy="31" rx="3.8" ry="5.4" fill="#f6f7fb"/>',
    '<circle cx="26.6" cy="32" r="2.1"/>',
    '<circle cx="38.6" cy="32" r="2.1"/>',
    '</g>',
    // Gloves, one each side — the "boxing" read, at any size.
    `<g fill="${f.accent}" stroke="#07080c" stroke-width="2.5">`,
    '<circle cx="8.5" cy="45" r="6.5"/>',
    '<circle cx="55.5" cy="45" r="6.5"/>',
    '</g>',
    '</svg>',
  ].join('');
}

/** The one distinguishing mark per mascot. Kept apart so the ball above is shared. */
function featureSvg(id: FighterId, accent: string): string {
  switch (id) {
    case 'neptune':
      // The cowboy hat, brim wide, star on the crown.
      return [
        `<g fill="${accent}" stroke="#07080c" stroke-width="2.5">`,
        '<path d="M5 19 C16 25 48 25 59 19 C52 17 46 16 42 15 L22 15 C18 16 12 17 5 19 Z"/>',
        '<path d="M21 15 C21 6 43 6 43 15 Z"/>',
        '</g>',
        '<circle cx="32" cy="11" r="2.2" fill="#f6f7fb"/>',
      ].join('');
    case 'saturn':
      // The moustache, and the star it comes with.
      return [
        '<g fill="none" stroke="#07080c" stroke-width="3" stroke-linecap="round">',
        '<path d="M31 40 C27 36 21 36 17 39"/>',
        '<path d="M33 40 C37 36 43 36 47 39"/>',
        '</g>',
        `<circle cx="32" cy="47" r="3.4" fill="${accent}" stroke="#07080c" stroke-width="2"/>`,
      ].join('');
    case 'jupiter':
      // The stripes, clipped to the ball.
      return [
        '<clipPath id="rm-f-jupiter"><circle cx="32" cy="34" r="21"/></clipPath>',
        '<g clip-path="url(#rm-f-jupiter)" fill="#f6f7fb" opacity="0.95">',
        '<rect x="11" y="17" width="42" height="5"/>',
        '<rect x="11" y="27" width="42" height="5"/>',
        '<rect x="11" y="43" width="42" height="5"/>',
        '</g>',
      ].join('');
    case 'earth':
      // The meridians. Thin, dark, over everything: it is a earth, not a ball.
      return [
        '<g fill="none" stroke="#07080c" stroke-width="1.4" opacity="0.75">',
        '<ellipse cx="32" cy="34" rx="9" ry="21"/>',
        '<path d="M13 28 H51 M11 40 H53"/>',
        '</g>',
      ].join('');
    default: {
      const never: never = id;
      void never;
      return '';
    }
  }
}
