/**
 * The intro sequence — four screens, as data and one state machine.
 *
 * ## Why it is four screens and not one
 *
 * The start screen it replaces carried the whole pitch at once: three "why" cards,
 * four pipeline steps, a fighter picker, the controls and two boss tells, on one
 * 1280x800 card. Everything on it was true and it was laid out carefully, and it
 * still asked a first-time player to read eleven blocks before pressing a button.
 * A brief on 2026-09-09 asked for the opposite shape — an arcade attract sequence
 * where each screen is understandable in three to five seconds and the primary
 * action is never in doubt.
 *
 * So the same content is dealt out over four beats:
 *
 *  1. `hook`    — the title, the crew, and START. Nothing to read but seven words.
 *  2. `concept` — the loop, in three steps and one arrow diagram.
 *  3. `agents`  — who does it: Analyst feeds Coder, Coder passes through Judge.
 *  4. `arena`   — the promise, your fighter, the controls, and the way in.
 *
 * ## Why this file is data only
 *
 * No DOM, no CSS, no timers — so the sequence's *shape* is unit-testable in Node
 * (`test/intro-sequence.test.ts`) and the DOM half in `ui/screens.ts` cannot drift
 * from it. The two things worth pinning are the order and the key map: an arcade
 * intro where Enter sometimes skips and sometimes advances is worse than no intro.
 *
 * `ui/intro.ts` is the neighbouring module and a different question — *whether* the
 * intro is shown at all (`?autostart=1`, `?intro=`, the remembered box). This one is
 * *what* it shows once that has been decided.
 */

/** The four beats, in order. Ids are stable: CSS and the e2e suite read them. */
export type IntroScreen = 'hook' | 'concept' | 'agents' | 'arena';

export const INTRO_SCREENS: readonly IntroScreen[] = ['hook', 'concept', 'agents', 'arena'];

/**
 * What the primary action does next: the following screen, or start the fight.
 *
 * A total function over the union so a screen added to `INTRO_SCREENS` without a
 * case here fails the exhaustiveness check rather than silently dead-ending.
 */
export function nextScreen(current: IntroScreen): IntroScreen | 'fight' {
  switch (current) {
    case 'hook':
      return 'concept';
    case 'concept':
      return 'agents';
    case 'agents':
      return 'arena';
    case 'arena':
      return 'fight';
    default: {
      const never: never = current;
      void never;
      return 'fight';
    }
  }
}

/** 1-based position, for the `● ● ○ ○` progress dots. */
export function screenIndex(screen: IntroScreen): number {
  return INTRO_SCREENS.indexOf(screen) + 1;
}

/**
 * The key map, as one function.
 *
 * `continue` on Enter and Space, `skip` on Escape — the brief's contract, and the
 * only two verbs the sequence has. Everything else returns `null` so the caller
 * does not preventDefault on keys it does not own.
 *
 * `Space` is deliberately *not* excluded for focused controls here: that exclusion
 * is `screens.ts`'s job, because it depends on what the event's target is (a
 * checkbox, a fighter button) and this function is given only the code.
 */
export function introKeyAction(code: string): 'continue' | 'skip' | null {
  if (code === 'Enter' || code === 'NumpadEnter' || code === 'Space') return 'continue';
  if (code === 'Escape') return 'skip';
  return null;
}

/** The label on each screen's primary button. */
export function primaryLabel(screen: IntroScreen): string {
  if (screen === 'hook') return 'START';
  if (screen === 'arena') return 'ENTER THE ARENA';
  return 'NEXT →';
}

/** One step of screen 2's "how a round works". */
export type ConceptStep = { n: string; title: string; text: string };

/**
 * The loop, in three steps. Shorter than the four it replaces on purpose: the
 * fourth was the Judge, and the Judge gets a whole screen of its own next.
 */
export const CONCEPT_STEPS: readonly ConceptStep[] = [
  { n: '01', title: 'You fight', text: 'Beat the boss and play normally. Every move is recorded.' },
  { n: '02', title: 'The system watches', text: 'Your replay is analyzed to identify your habits and patterns.' },
  { n: '03', title: 'The boss changes', text: 'The boss is rewritten to counter the way you played.' },
];

/** Screen 2's arrow diagram. Three nouns, because the loop is three nouns. */
export const CONCEPT_FLOW: readonly string[] = ['YOU', 'REPLAY', 'NEW BOSS'];

/** Where the crew artwork lives, relative to the site root. */
export const HERO_DIR = 'intro';
export const HERO_FILE = 'crew.png';

function defaultBase(): string {
  return (import.meta.env?.BASE_URL as string | undefined) ?? './';
}

/**
 * `./intro/crew.png`. Built from Vite's base like `cast.ts`'s `portraitUrl`, so the
 * game keeps working when it is served from a subpath.
 */
export function heroUrl(baseUrl?: string): string {
  const base = baseUrl ?? defaultBase();
  const prefix = base === '' ? './' : base.endsWith('/') ? base : `${base}/`;
  return `${prefix}${HERO_DIR}/${HERO_FILE}`;
}
