/**
 * `ui/roundBanner.ts`'s timing state machine — pure, so the whole sequence (armed,
 * held, gone) is asserted without a DOM or a real timer, the same split as
 * `interlude/castStatus.ts`'s `reduceCast`.
 *
 * Wall-clock `nowMs` throughout, not ticks: the interstitial is shown *before* the
 * round's simulation starts stepping (see the module doc), so there is no tick
 * clock yet to drive it with.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  bannerHolding,
  bannerVisible,
  BANNER_HOLD_MS,
  INITIAL_BANNER_STATE,
  reduceBanner,
  type BannerState,
} from '../src/ui/roundBanner.ts';

const NAME = 'Warden II';
const RATIONALE = 'You never leave the left wall, so the spawns land there now.';

describe('reduceBanner — arming', () => {
  it('arms only for a strategy the loop actually wrote (provenance "approved")', () => {
    const next = reduceBanner(INITIAL_BANNER_STATE, {
      type: 'roundStart',
      nowMs: 1_000,
      provenance: 'approved',
      name: NAME,
      rationale: RATIONALE,
    });
    expect(next.phase).toBe('holding');
    expect(next.name).toBe(NAME);
    expect(next.rationale).toBe(RATIONALE);
    expect(next.startedAtMs).toBe(1_000);
    expect(bannerVisible(next)).toBe(true);
    expect(bannerHolding(next)).toBe(true);
  });

  it('never arms for round 1\'s bundled boss, which claims nothing', () => {
    const next = reduceBanner(INITIAL_BANNER_STATE, {
      type: 'roundStart',
      nowMs: 0,
      provenance: 'bundled',
      name: NAME,
      rationale: RATIONALE,
    });
    expect(next).toEqual(INITIAL_BANNER_STATE);
    expect(bannerVisible(next)).toBe(false);
    expect(bannerHolding(next)).toBe(false);
  });

  it('never arms for a pre-approved fallback pick — it was not written for this player', () => {
    const next = reduceBanner(INITIAL_BANNER_STATE, {
      type: 'roundStart',
      nowMs: 0,
      provenance: 'fallback',
      name: NAME,
      rationale: RATIONALE,
    });
    expect(next.phase).toBe('hidden');
  });

  it('a fresh roundStart replaces whatever was holding', () => {
    const holding = reduceBanner(INITIAL_BANNER_STATE, {
      type: 'roundStart',
      nowMs: 10,
      provenance: 'approved',
      name: 'Old Boss',
      rationale: 'old rationale',
    });
    const restarted = reduceBanner(holding, {
      type: 'roundStart',
      nowMs: 500,
      provenance: 'approved',
      name: 'New Boss',
      rationale: 'new rationale',
    });
    expect(restarted).toEqual({ phase: 'holding', name: 'New Boss', rationale: 'new rationale', startedAtMs: 500 });
  });

  it('a retry (provenance is whatever the lost round was, but the caller never calls with "approved") gets no interstitial', () => {
    // `app.ts`'s retry path passes the provenance the round already had — this just
    // pins that "approved" is the only value this reducer treats as an interstitial,
    // which is the property the retry path relies on to stay silent.
    for (const provenance of ['bundled', 'fallback'] as const) {
      const next = reduceBanner(INITIAL_BANNER_STATE, {
        type: 'roundStart',
        nowMs: 0,
        provenance,
        name: NAME,
        rationale: RATIONALE,
      });
      expect(bannerHolding(next)).toBe(false);
    }
  });
});

describe('reduceBanner — the hold, on the wall clock', () => {
  function armedAt(nowMs: number): BannerState {
    return reduceBanner(INITIAL_BANNER_STATE, {
      type: 'roundStart',
      nowMs,
      provenance: 'approved',
      name: NAME,
      rationale: RATIONALE,
    });
  }

  it('a clock tick before any roundStart is a no-op', () => {
    expect(reduceBanner(INITIAL_BANNER_STATE, { type: 'clock', nowMs: 999_999 })).toEqual(INITIAL_BANNER_STATE);
  });

  it('stays holding for the whole hold window', () => {
    let state = armedAt(0);
    for (const nowMs of [1, 500, 1_000, BANNER_HOLD_MS - 1]) {
      state = reduceBanner(state, { type: 'clock', nowMs });
      expect(state.phase).toBe('holding');
    }
  });

  it('ends exactly at the hold boundary', () => {
    const held = armedAt(0);
    const atEdge = reduceBanner(held, { type: 'clock', nowMs: BANNER_HOLD_MS });
    expect(atEdge).toEqual(INITIAL_BANNER_STATE);
    expect(bannerHolding(atEdge)).toBe(false);
  });

  it('holds regardless of when the reducer was first armed — it is elapsed time, not absolute time, that matters', () => {
    const held = armedAt(12_345);
    const stillHeld = reduceBanner(held, { type: 'clock', nowMs: 12_345 + BANNER_HOLD_MS - 1 });
    expect(stillHeld.phase).toBe('holding');
    const ended = reduceBanner(held, { type: 'clock', nowMs: 12_345 + BANNER_HOLD_MS });
    expect(ended.phase).toBe('hidden');
  });

  it('a clock jump straight past the hold ends it in one call — no per-frame ticking required', () => {
    // `app.ts` drives this off a `requestAnimationFrame` ticker, but nothing in the
    // reducer may depend on being called every frame: a slow or backgrounded tab
    // must not extend the hold past its wall-clock duration.
    const held = armedAt(0);
    const jumped = reduceBanner(held, { type: 'clock', nowMs: BANNER_HOLD_MS + 60_000 });
    expect(jumped).toEqual(INITIAL_BANNER_STATE);
  });

  it('a clock event that arrives after it is already hidden changes nothing', () => {
    const gone = reduceBanner(armedAt(0), { type: 'clock', nowMs: BANNER_HOLD_MS });
    const later = reduceBanner(gone, { type: 'clock', nowMs: 999_999 });
    expect(later).toEqual(INITIAL_BANNER_STATE);
  });

  it('the hold is ~3.5 seconds — Matt\'s playtest ask ("por uns 3-4 segundos")', () => {
    expect(BANNER_HOLD_MS).toBe(3500);
  });
});

describe('the banner reducer is read-only presentation', () => {
  it('is not imported by anything that simulates the game', () => {
    const url = new URL('../src/', import.meta.url);
    for (const file of ['game/round.ts', 'game/strategy.ts', 'game/loop.ts', 'game/seeds.ts']) {
      const source = readFileSync(new URL(file, url), 'utf8');
      expect(source).not.toContain('roundBanner.ts');
    }
  });
});
