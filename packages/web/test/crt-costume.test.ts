/**
 * The CRT overlay is a costume, checked the way `test/audio-costume.test.ts` and
 * `test/fighters.test.ts` check theirs: by reading the source of the modules that
 * simulate the game rather than by trusting a docstring.
 *
 * The stake is spec AC 3 — "same seed + same input log produces an identical final
 * state hash in browser and Node". `ui/crt.ts` reaches for `document` and
 * `URLSearchParams` off a `location.search`, neither of which the harness,
 * `gen-inputlog.ts` or a recorded-run replay has. An import of it from a sim module
 * would be a browser-only dependency on the deterministic side of the line, and the
 * scanlines a player can already turn off with `?crt=0` are the least defensible
 * reason imaginable to have one.
 *
 * The second test runs the inverse: the costume must not start importing the engine
 * either, because the moment it does it stops being a leaf and becomes a path.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { crtEnabled } from '../src/ui/crt.ts';

/** Loose on purpose: it must catch `from '../ui/crt.ts'` and `from './crt'` alike. */
const CRT_IMPORT = /from\s+['"][^'"]*\/crt(?:\.ts)?['"]/;

describe('the CRT overlay is a costume', () => {
  it('is not imported by anything that simulates the game', () => {
    const url = new URL('../src/', import.meta.url);
    for (const file of ['game/round.ts', 'game/strategy.ts', 'game/loop.ts', 'game/seeds.ts']) {
      const source = readFileSync(new URL(file, url), 'utf8');
      expect(source, `${file} must not import the CRT module`).not.toMatch(CRT_IMPORT);
    }
  });

  it('never imports engine, contract or sandbox', () => {
    const source = readFileSync(new URL('../src/ui/crt.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('@rematch/engine');
    expect(source).not.toContain('@rematch/contract');
    expect(source).not.toContain('@rematch/sandbox');
  });
});

describe('crtEnabled', () => {
  it('is on by default — the effect is the intended look, not an easter egg', () => {
    expect(crtEnabled('')).toBe(true);
    expect(crtEnabled('?agent=mock&autostart=1')).toBe(true);
  });

  it('is off for the one opt-out value, wherever it sits in the query', () => {
    expect(crtEnabled('?crt=0')).toBe(false);
    expect(crtEnabled('?agent=mock&crt=0&autostart=1')).toBe(false);
  });

  it('treats any other value as on, including the empty one', () => {
    // `?crt` and `?crt=1` both read as "the player mentioned it and did not say no".
    expect(crtEnabled('?crt=1')).toBe(true);
    expect(crtEnabled('?crt')).toBe(true);
    expect(crtEnabled('?crt=off')).toBe(true);
  });
});
