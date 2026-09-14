/**
 * Audio is a costume too — checked the same way `test/fighters.test.ts` checks a
 * fighter pick: by reading the source of the modules that simulate the game, rather
 * than by trusting a docstring.
 *
 * The stakes are the same ones `fighters.test.ts` names. Spec AC 3 ("same seed + same
 * input log produces an identical final state hash in browser and Node") and every
 * recorded run, fallback strategy and Gate 3 baseline depend on nothing that touches
 * the simulation reaching for a browser-only API — and `AudioContext`/Tone.js is a
 * *harder* violation of that boundary than a fighter skin ever could be: it does not
 * exist in Node at all, so an import reaching `audio/engine.ts` from a sim module
 * would not silently desync a replay, it would throw the moment `pnpm --filter
 * @rematch/harness` or `gen-inputlog.ts` tried to load that module. This test is the
 * one that catches it before a human does.
 *
 * `audio/sfx.ts` and `audio/tracker.ts` *do* import `@rematch/engine`'s types
 * (`EventKind`, `GameState`) — same as `render/effects.ts`, which this folder is
 * modelled on (see `tracker.ts`'s header) — so unlike `ui/fighters.ts` this is not
 * "never touches the engine". The guarantee is the one that actually matters: no
 * module that *drives* the simulation ever imports anything under `audio/` or the
 * mute toggle that sits on top of it. `audio/thinking.ts` and `audio/musicState.ts`
 * (2026-09-11: the interlude's thinking texture and the music bed's playing/ducked
 * decision) import nothing at all beyond plain values — the loosest of any file in
 * this folder — and the `AUDIO_IMPORT` regex below already covers them without
 * naming them, since it matches any `/audio` path rather than a fixed file list.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** Loose on purpose: it must catch `from '../audio/engine.ts'` and `from './audio'` alike. */
const AUDIO_IMPORT = /from\s+['"][^'"]*\/audio(?:Toggle)?(?:\.ts)?['"]/;

describe('audio is a costume', () => {
  it('is not imported by anything that simulates the game', () => {
    const url = new URL('../src/', import.meta.url);
    for (const file of ['game/round.ts', 'game/strategy.ts', 'game/loop.ts', 'game/seeds.ts']) {
      const source = readFileSync(new URL(file, url), 'utf8');
      expect(source, `${file} must not import an audio module`).not.toMatch(AUDIO_IMPORT);
    }
  });

  it('the engine chain (audio/engine.ts) never imports engine, contract or sandbox', () => {
    // The inverse direction: the one module in this folder that actually touches
    // `AudioContext`/Tone.js must not be the place a stray `@rematch/engine` import
    // sneaks browser-only code toward the sim side either.
    const source = readFileSync(new URL('../src/audio/engine.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('@rematch/engine');
    expect(source).not.toContain('@rematch/contract');
    expect(source).not.toContain('@rematch/sandbox');
  });
});
