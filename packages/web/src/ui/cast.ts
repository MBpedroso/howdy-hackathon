/**
 * The cast — who the three agents are, on screen.
 *
 * A playtester's verdict on the interlude was: *"today it is just numbers on a
 * screen; the player can't connect what's happening to who is doing it."* The
 * numbers were never the problem — every one of them is real — but four panels of
 * measured output with no author read as one machine talking to itself. So the
 * three things that actually take turns during a rewrite are given a face, a name,
 * a colour and one line of plain language, and the same three appear on the start
 * screen before the first fight so the player already knows them when the interlude
 * opens.
 *
 * This module is **data and strings only** — no DOM, no CSS, no fetch — so it can be
 * unit tested in Node (`test/cast.test.ts`) and imported by both the start screen
 * (`ui/screens.ts`) and the interlude (`interlude/ui.ts`). The DOM half is
 * `ui/portrait.ts`.
 *
 * ## Portraits, and why there are two kinds
 *
 * The shipped portraits are raster PNGs a human generated with an image model
 * (`public/agents/<id>.png`, 1024×1024 on `#0B0F1A`) — which is a documented
 * override of spec §2.3's "no raster art", recorded as delta 17 in `docs/SPEC.md`
 * §13. Everything else on screen is still CSS and canvas.
 *
 * Until a file is dropped in, `placeholderSvg` stands in: the same square, the same
 * dark navy ground, the agent's accent, and one flat icon that says what the agent
 * *does* (a lens, a code bracket, a gate). The swap needs no code change — the
 * `<img>` in `ui/portrait.ts` falls back to this on `error` — which is what lets the
 * screen ship, and be screenshotted, before the art exists.
 *
 * ## The accents are not decoration
 *
 * They are how "who is acting now" is legible at a glance: the active panel takes
 * the acting agent's colour and the others dim. Chosen by the human (2026-09-04)
 * and deliberately *outside* the fight's palette (`render/palette.ts`), because the
 * cast is the interlude's language and the boss/player colours are the fight's.
 */

/** The four members. `boss` is the strategy that comes back, not an agent. */
export type AgentId = 'analyst' | 'coder' | 'judge' | 'boss';

/** Which placeholder icon stands in for a missing portrait. */
export type AgentIcon = 'lens' | 'brackets' | 'gate' | 'sigil' | 'target';

export type Agent = {
  id: AgentId;
  /** Shown on screen, in the interlude header and on the start screen's card. */
  name: string;
  /** The accent. Hex, because it is written into inline SVG as well as into CSS. */
  accent: string;
  /**
   * One line, in plain language, of what this one does. This is the sentence the
   * playtester was missing, so it says what the agent *does to you* rather than
   * what it is: "watches your replay", not "an LLM-backed analysis stage".
   */
  role: string;
  /**
   * The one member of the cast that is not a model, and the project's whole thesis.
   * The start screen renders its card differently because of this flag.
   */
  deterministic?: true;
  icon: AgentIcon;
};

/**
 * The Judge's second colour: green for an approval, red for a rejection.
 *
 * It is one agent with two verdicts rather than two colours of chrome, so the stamp
 * picks between these and the card uses `accent`.
 */
export const JUDGE_APPROVE = '#22C55E';

export const AGENTS: Readonly<Record<AgentId, Agent>> = {
  analyst: {
    id: 'analyst',
    name: 'Analyst',
    accent: '#2DD4BF',
    role: 'Reads your replay and identifies your habits.',
    icon: 'lens',
  },
  coder: {
    id: 'coder',
    name: 'Coder',
    accent: '#F59E0B',
    role: "Rewrites the boss's strategy to counter you.",
    icon: 'brackets',
  },
  judge: {
    id: 'judge',
    name: 'Judge',
    accent: '#EF4444',
    // "Not an AI" used to open this line. It moved to the DETERMINISTIC chip that
    // sits on the same card — the sentence is the *job*, and the card had the same
    // claim twice while being the shortest thing on screen that had to land.
    role: 'Runs 200 simulated fights and rejects anything unfair, broken, or unsafe.',
    deterministic: true,
    icon: 'gate',
  },
  boss: {
    id: 'boss',
    name: 'The boss',
    accent: '#C026D3',
    role: 'The strategy that comes back to fight you.',
    icon: 'sigil',
  },
};

/** The three that take turns during a rewrite, in the order they act. */
export const CAST: readonly Agent[] = [AGENTS.analyst, AGENTS.coder, AGENTS.judge];

/** Where a portrait lives, relative to the site root. `public/agents/<id>.png`. */
export const PORTRAIT_DIR = 'agents';

/** Vite's configured base, or `./` outside a bundle (the unit tests). */
function defaultBase(): string {
  return (import.meta.env?.BASE_URL as string | undefined) ?? './';
}

/**
 * `./agents/analyst.png` — the URL the `<img>` tries first.
 *
 * Built from Vite's `BASE_URL` the same way `interlude/recorded.ts` builds its
 * asset URLs, so the game keeps working when it is served from a subpath.
 */
export function portraitUrl(id: AgentId, baseUrl?: string): string {
  const base = baseUrl ?? defaultBase();
  const prefix = base === '' ? './' : base.endsWith('/') ? base : `${base}/`;
  return `${prefix}${PORTRAIT_DIR}/${id}.png`;
}

/** The dark navy the human is generating the portraits against. */
export const PORTRAIT_BG = '#0B0F1A';

/**
 * The icon, as SVG children on a 64×64 grid.
 *
 * Flat strokes, no gradients, no text: this has to read at 24 px in a diff header
 * and at 96 px on the start screen, and it has to survive being drawn in one
 * colour.
 */
function iconPaths(icon: AgentIcon): string {
  switch (icon) {
    case 'lens':
      // A magnifier over a crosshair: it is looking at *where you were*.
      return [
        '<circle cx="28" cy="28" r="13"/>',
        '<path d="M37.5 37.5 L49 49"/>',
        '<path d="M28 19.5 V24 M28 32 V36.5 M19.5 28 H24 M32 28 H36.5"/>',
      ].join('');
    case 'brackets':
      // `</>`: the beat where a file is written.
      return ['<path d="M23 20 L13 32 L23 44"/>', '<path d="M41 20 L51 32 L41 44"/>', '<path d="M35.5 18 L28.5 46"/>'].join('');
    case 'gate':
      // A portcullis. Bars you either pass or you do not — no opinion involved.
      return [
        '<path d="M13 20 H51"/>',
        '<path d="M13 44 H51"/>',
        '<path d="M20 20 V44 M27 20 V44 M34 20 V44 M41 20 V44"/>',
      ].join('');
    case 'sigil':
      // The boss: a diamond with an eye. Not an agent, a thing that comes back.
      return ['<path d="M32 13 L51 32 L32 51 L13 32 Z"/>', '<circle cx="32" cy="32" r="4.5"/>'].join('');
    case 'target':
      return ['<circle cx="32" cy="32" r="15"/>', '<circle cx="32" cy="32" r="5"/>', '<path d="M32 9 V17 M32 47 V55 M9 32 H17 M47 32 H55"/>'].join('');
    default: {
      const never: never = icon;
      void never;
      return '';
    }
  }
}

/**
 * One icon on its own, for the start screen's four "how a round works" steps.
 *
 * Same paths as a portrait's, no ground and no silhouette: a step is a label, not a
 * character.
 */
export function iconSvg(icon: AgentIcon, accent: string): string {
  return [
    '<svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">',
    `<g fill="none" stroke="${accent}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">`,
    iconPaths(icon),
    '</g>',
    '</svg>',
  ].join('');
}

/**
 * The stand-in portrait: a square, the agent's accent, and its icon.
 *
 * Deliberately not a face. A generated face that is *nearly* the shipped portrait
 * is worse than an obvious placeholder, because nobody can tell whether the art
 * landed. A silhouette plus the agent's own icon reads as "this is the Analyst" at
 * every size and as "the portrait is not here yet" on inspection.
 *
 * Returned as markup rather than as an element so the function is testable in Node
 * and so `ui/portrait.ts` owns every DOM decision.
 */
export function placeholderSvg(id: AgentId): string {
  const agent = AGENTS[id];
  const mechanical =
    agent.deterministic === true
      ? `<rect x="3.5" y="3.5" width="57" height="57" fill="none" stroke="${agent.accent}" stroke-width="1.5" stroke-dasharray="5 4" opacity="0.6"/>`
      : '';
  return [
    `<svg viewBox="0 0 64 64" role="img" aria-label="${agent.name}" focusable="false">`,
    `<rect width="64" height="64" fill="${PORTRAIT_BG}"/>`,
    // Head and shoulders, faint: enough for the square to read as a portrait.
    `<circle cx="32" cy="25" r="14" fill="${agent.accent}" opacity="0.10"/>`,
    `<path d="M4 64 C8 49 20 43 32 43 C44 43 56 49 60 64 Z" fill="${agent.accent}" opacity="0.13"/>`,
    mechanical,
    `<g fill="none" stroke="${agent.accent}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">`,
    iconPaths(agent.icon),
    '</g>',
    '</svg>',
  ].join('');
}
