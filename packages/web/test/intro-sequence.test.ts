/**
 * The intro sequence's shape — order, key map, labels.
 *
 * `ui/introSequence.ts` is data and one state machine on purpose, so the two
 * things an arcade intro cannot get wrong are pinned here rather than in the DOM:
 * the order of the beats, and the fact that Enter always means *continue* and
 * Escape always means *skip*. An intro where Enter sometimes skips is worse than
 * no intro, and that bug is invisible in a screenshot.
 *
 * The DOM half (`ui/screens.ts`) is covered by `e2e/boot.spec.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  CONCEPT_FLOW,
  CONCEPT_STEPS,
  INTRO_SCREENS,
  heroUrl,
  introKeyAction,
  nextScreen,
  primaryLabel,
  screenIndex,
  type IntroScreen,
} from '../src/ui/introSequence.ts';

describe('the order of the beats', () => {
  it('is hook, concept, agents, arena', () => {
    expect(INTRO_SCREENS).toEqual(['hook', 'concept', 'agents', 'arena']);
  });

  it('walks every beat exactly once and then starts the fight', () => {
    const walked: IntroScreen[] = [];
    let at: IntroScreen | 'fight' = INTRO_SCREENS[0] as IntroScreen;
    // Bounded so a cycle fails as a timeout-free assertion rather than hanging.
    for (let i = 0; i < 10 && at !== 'fight'; i += 1) {
      walked.push(at);
      at = nextScreen(at);
    }
    expect(at).toBe('fight');
    expect(walked).toEqual([...INTRO_SCREENS]);
  });

  it('numbers the dots 1..4 in order', () => {
    expect(INTRO_SCREENS.map(screenIndex)).toEqual([1, 2, 3, 4]);
  });
});

describe('the key map', () => {
  it('continues on Enter and Space, and skips on Escape', () => {
    expect(introKeyAction('Enter')).toBe('continue');
    expect(introKeyAction('NumpadEnter')).toBe('continue');
    expect(introKeyAction('Space')).toBe('continue');
    expect(introKeyAction('Escape')).toBe('skip');
  });

  it('claims nothing else, so the caller does not preventDefault on keys it does not own', () => {
    for (const code of ['KeyW', 'Tab', 'ArrowRight', 'Digit1', '']) {
      expect(introKeyAction(code)).toBeNull();
    }
  });
});

describe('the primary action', () => {
  it('is labelled on every beat, and never blank', () => {
    for (const screen of INTRO_SCREENS) {
      expect(primaryLabel(screen).trim().length).toBeGreaterThan(0);
    }
  });

  it('says START first and ENTER THE ARENA last', () => {
    expect(primaryLabel('hook')).toBe('START');
    expect(primaryLabel('arena')).toBe('ENTER THE ARENA');
    expect(primaryLabel('concept')).toBe(primaryLabel('agents'));
  });
});

describe('the copy', () => {
  it('is three numbered steps, in order, each with a sentence', () => {
    expect(CONCEPT_STEPS.map((s) => s.n)).toEqual(['01', '02', '03']);
    for (const step of CONCEPT_STEPS) {
      expect(step.title.trim().length).toBeGreaterThan(0);
      expect(step.text.trim().endsWith('.')).toBe(true);
    }
  });

  it('is three nouns in the flow diagram, because the loop is three nouns', () => {
    expect(CONCEPT_FLOW).toHaveLength(CONCEPT_STEPS.length);
    expect(CONCEPT_FLOW).toEqual(['YOU', 'REPLAY', 'NEW BOSS']);
  });
});

describe('the crew artwork URL', () => {
  it('hangs off the served base, so a subpath deploy still finds it', () => {
    expect(heroUrl('/rematch/')).toBe('/rematch/intro/crew.png');
    expect(heroUrl('/rematch')).toBe('/rematch/intro/crew.png');
    expect(heroUrl('')).toBe('./intro/crew.png');
  });
});
