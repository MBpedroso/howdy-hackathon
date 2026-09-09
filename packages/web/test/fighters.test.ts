/**
 * The four fighters, as data — and the one property that matters more than any of
 * the strings: a pick is a costume.
 *
 * Worth testing for the same reason `cast.test.ts` is: the ids are a contract with
 * two things outside the code. They are the filenames a human drops into
 * `public/fighters/`, and they are the values written into `localStorage`, so a
 * rename is a silent 404 on one side and a forgotten choice on the other.
 *
 * The determinism guarantee itself is asserted where it lives — no engine or
 * harness module imports this file, and the test below pins that by inspection of
 * the module graph rather than by trusting the docstring.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BOSS_FIGHTER,
  DEFAULT_PLAYER_FIGHTER,
  FIGHTERS,
  FIGHTER_LIST,
  FIGHTER_ORDER,
  fighterFaceSvg,
  fighterUrl,
  isFighterId,
  type FighterId,
} from '../src/ui/fighters.ts';
import { preloadFighters, resetSpritesForTest, sprite } from '../src/render/sprites.ts';
import {
  BOSS_FIGHTER_KEY,
  PLAYER_FIGHTER_KEY,
  readFighter,
  writeFighter,
  type StorageLike,
} from '../src/ui/intro.ts';

/** An in-memory `localStorage`, as in `intro.test.ts`. */
function memory(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
    removeItem: (key) => {
      delete data[key];
    },
  };
}

/** A tab with site data blocked: every access throws, and the game must still boot. */
const hostile: StorageLike = {
  getItem() {
    throw new Error('SecurityError: access denied');
  },
  setItem() {
    throw new Error('SecurityError: access denied');
  },
  removeItem() {
    throw new Error('SecurityError: access denied');
  },
};

describe('the four fighters', () => {
  it('are the four mascots, in a fixed picker order', () => {
    expect(FIGHTER_ORDER).toEqual(['neptune', 'saturn', 'jupiter', 'earth']);
    expect(FIGHTER_LIST.map((f) => f.id)).toEqual([...FIGHTER_ORDER]);
    expect(Object.keys(FIGHTERS).sort()).toEqual([...FIGHTER_ORDER].sort());
  });

  it('each carry a name, an accent and a caption', () => {
    for (const fighter of FIGHTER_LIST) {
      expect(fighter.name.length).toBeGreaterThan(2);
      expect(fighter.accent).toMatch(/^#[0-9a-f]{6}$/);
      expect(fighter.tag.length).toBeGreaterThan(4);
    }
    // Four distinct colours: the picker tells them apart by colour, and the
    // unselected state dims rather than greyscales for exactly that reason.
    expect(new Set(FIGHTER_LIST.map((f) => f.accent)).size).toBe(4);
  });

  it('default to one fighter each side, and not the same one', () => {
    expect(isFighterId(DEFAULT_PLAYER_FIGHTER)).toBe(true);
    expect(isFighterId(DEFAULT_BOSS_FIGHTER)).toBe(true);
    expect(DEFAULT_PLAYER_FIGHTER).not.toBe(DEFAULT_BOSS_FIGHTER);
  });

  it('guard unknown ids — a stale value from an older build is not a fighter', () => {
    expect(isFighterId('neptune')).toBe(true);
    expect(isFighterId('marshal')).toBe(false);
    expect(isFighterId(null)).toBe(false);
    expect(isFighterId(undefined)).toBe(false);
    // `Object.hasOwn`, not `in`: an inherited key is not one of the four.
    expect(isFighterId('toString')).toBe(false);
    expect(isFighterId('constructor')).toBe(false);
  });
});

describe('the ball geometry', () => {
  it('is inside the crop, and big enough to be the ball rather than a glove', () => {
    for (const fighter of FIGHTER_LIST) {
      const { cx, cy, r } = fighter.ball;
      expect(cx).toBeGreaterThan(0.2);
      expect(cx).toBeLessThan(0.8);
      expect(cy).toBeGreaterThan(0.2);
      expect(cy).toBeLessThan(0.8);
      // A glove is ~0.08 of the crop; the ball is a quarter of it or more. This is
      // the assertion that catches `--geometry` locking onto the wrong blob after
      // the art is re-supplied.
      expect(r).toBeGreaterThan(0.25);
      expect(r).toBeLessThan(0.5);
      // The ball has to fit inside the square it was measured in.
      expect(cx - r).toBeGreaterThan(0);
      expect(cx + r).toBeLessThan(1);
    }
  });

  it('is not the image centre — which is the whole reason it is measured', () => {
    // Jupiter's arm pulls its bounding box right, so its ball sits left of centre;
    // Earth's does the opposite. If both ever read 0.5, the measurement silently
    // stopped happening and every face is off by the width of an arm.
    expect(FIGHTERS.jupiter.ball.cx).toBeLessThan(0.45);
    expect(FIGHTERS.earth.ball.cx).toBeGreaterThan(0.55);
  });
});

describe('the sprite cache', () => {
  it('answers null in Node, so the renderer keeps its flat discs', () => {
    // `draw` runs 60 times a second and cannot await: the contract is a synchronous
    // answer, and "not loaded" and "no such environment" are the same answer.
    resetSpritesForTest();
    expect(() => {
      preloadFighters();
    }).not.toThrow();
    for (const id of FIGHTER_ORDER) expect(sprite(id)).toBeNull();
  });
});

describe('the art path', () => {
  it('is `<base>/fighters/<id>.png`, and respects a subpath base', () => {
    expect(fighterUrl('neptune', './')).toBe('./fighters/neptune.png');
    expect(fighterUrl('earth', '/rematch/')).toBe('/rematch/fighters/earth.png');
    // A base without its trailing slash still produces one slash, not two.
    expect(fighterUrl('jupiter', '/rematch')).toBe('/rematch/fighters/jupiter.png');
    expect(fighterUrl('saturn', '')).toBe('./fighters/saturn.png');
  });

  it('has a stand-in for every fighter, and they are not the same drawing', () => {
    const svgs = FIGHTER_ORDER.map((id) => fighterFaceSvg(id));
    for (const [i, svg] of svgs.entries()) {
      const fighter = FIGHTERS[FIGHTER_ORDER[i] as FighterId];
      expect(svg.startsWith('<svg viewBox="0 0 64 64"')).toBe(true);
      expect(svg.endsWith('</svg>')).toBe(true);
      // The accent is in the drawing, so a face is identifiable before the art lands.
      expect(svg).toContain(fighter.accent);
      expect(svg).toContain(`aria-label="${fighter.name}"`);
    }
    expect(new Set(svgs).size).toBe(4);
  });
});

describe('the remembered picks', () => {
  it('round-trip under one namespaced key each', () => {
    const storage = memory();
    expect(readFighter('player', storage)).toBe(DEFAULT_PLAYER_FIGHTER);
    expect(readFighter('boss', storage)).toBe(DEFAULT_BOSS_FIGHTER);

    expect(writeFighter('player', 'neptune', storage)).toBe(true);
    expect(writeFighter('boss', 'saturn', storage)).toBe(true);
    expect(storage.data[PLAYER_FIGHTER_KEY]).toBe('neptune');
    expect(storage.data[BOSS_FIGHTER_KEY]).toBe('saturn');
    expect(readFighter('player', storage)).toBe('neptune');
    expect(readFighter('boss', storage)).toBe('saturn');
  });

  it('are two independent keys — picking your own face does not reskin the boss', () => {
    const storage = memory();
    writeFighter('player', 'jupiter', storage);
    expect(readFighter('boss', storage)).toBe(DEFAULT_BOSS_FIGHTER);
    expect(PLAYER_FIGHTER_KEY).not.toBe(BOSS_FIGHTER_KEY);
  });

  it('fall back to the default on a value no build ever wrote', () => {
    const storage = memory({ [PLAYER_FIGHTER_KEY]: 'marshal', [BOSS_FIGHTER_KEY]: '' });
    expect(readFighter('player', storage)).toBe(DEFAULT_PLAYER_FIGHTER);
    expect(readFighter('boss', storage)).toBe(DEFAULT_BOSS_FIGHTER);
  });

  it('degrade to the defaults when storage throws or is absent', () => {
    expect(readFighter('player', hostile)).toBe(DEFAULT_PLAYER_FIGHTER);
    expect(readFighter('boss', hostile)).toBe(DEFAULT_BOSS_FIGHTER);
    expect(writeFighter('player', 'neptune', hostile)).toBe(false);

    expect(readFighter('player', null)).toBe(DEFAULT_PLAYER_FIGHTER);
    expect(writeFighter('boss', 'earth', null)).toBe(false);
  });
});

/**
 * The guarantee, checked structurally.
 *
 * A fighter is cosmetic, which is only true as long as nothing that simulates the
 * game can see one. Spec AC 3 ("same seed + same input log produces an identical
 * final state hash in browser and Node") and every recorded run, fallback strategy
 * and Gate 3 baseline depend on it: the Node harness has no picker, so a skin that
 * reached the state would make the browser and the harness disagree by a menu click.
 *
 * Asserted by reading the source rather than by trusting the docstring, because the
 * failure mode is somebody importing `fighters.ts` into the round or the renderer's
 * state and nothing going red.
 */
describe('a fighter is a costume', () => {
  it('is not imported by anything that simulates the game', () => {
    const url = new URL('../src/', import.meta.url);
    for (const file of ['game/round.ts', 'game/strategy.ts', 'game/loop.ts', 'game/seeds.ts']) {
      const source = readFileSync(new URL(file, url), 'utf8');
      expect(source).not.toContain('fighters.ts');
    }
  });

  it('never leaves the web package — no engine or contract type is involved', () => {
    const source = readFileSync(new URL('../src/ui/fighters.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('@rematch/engine');
    expect(source).not.toContain('@rematch/contract');
    expect(source).not.toContain('@rematch/sandbox');
  });
});

/** Types only: `FighterId` stays a union of the four, so a typo cannot compile. */
export const compileTimeOnly: FighterId[] = ['neptune', 'saturn', 'jupiter', 'earth'];
