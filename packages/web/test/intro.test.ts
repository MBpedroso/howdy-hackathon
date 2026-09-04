/**
 * The start screen's memory, and the three ways to not see it.
 *
 * DOM-free on purpose (`vitest.config.ts`: every unit test here is): the decision is
 * a pure function of the URL and one remembered flag, and the storage is injected,
 * so the interesting cases — including a `localStorage` that throws, which is a real
 * browser state and not a hypothetical — are all reachable in Node.
 */
import { describe, expect, it } from 'vitest';

import {
  SKIP_INTRO_KEY,
  introDecision,
  readSkipIntro,
  writeSkipIntro,
  type StorageLike,
} from '../src/ui/intro.ts';

/** An in-memory `localStorage`. */
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

describe('the remembered "skip intro" box', () => {
  it('round-trips through storage under one namespaced key', () => {
    const storage = memory();
    expect(readSkipIntro(storage)).toBe(false);

    expect(writeSkipIntro(true, storage)).toBe(true);
    expect(storage.data[SKIP_INTRO_KEY]).toBe('1');
    expect(readSkipIntro(storage)).toBe(true);

    // Unticking removes the key rather than writing a falsy value: nothing else
    // should have to know what "0" means.
    expect(writeSkipIntro(false, storage)).toBe(true);
    expect(SKIP_INTRO_KEY in storage.data).toBe(false);
    expect(readSkipIntro(storage)).toBe(false);
  });

  it('treats any other stored value as "not remembered"', () => {
    expect(readSkipIntro(memory({ [SKIP_INTRO_KEY]: 'yes' }))).toBe(false);
    expect(readSkipIntro(memory({ [SKIP_INTRO_KEY]: '0' }))).toBe(false);
  });

  it('never throws when storage is unavailable or hostile', () => {
    expect(readSkipIntro(null)).toBe(false);
    expect(writeSkipIntro(true, null)).toBe(false);
    // The direction matters: a failed read degrades to "show the intro".
    expect(readSkipIntro(hostile)).toBe(false);
    expect(writeSkipIntro(true, hostile)).toBe(false);
  });
});

describe('introDecision', () => {
  it('shows the intro the first time and says why', () => {
    expect(introDecision({ search: '?seed=1' })).toEqual({ show: true, reason: 'first-time' });
    expect(introDecision()).toEqual({ show: true, reason: 'first-time' });
  });

  it('skips it once the box has been ticked', () => {
    expect(introDecision({ search: '', remembered: true })).toEqual({ show: false, reason: 'remembered' });
  });

  // The e2e suite and every demo link depend on this, so it is first in precedence:
  // a spec that asks for a round must get a round, ticked box or not.
  it('always bypasses it for ?autostart=1, whatever else is set', () => {
    expect(introDecision({ search: '?autostart=1' })).toEqual({ show: false, reason: 'autostart' });
    expect(introDecision({ search: '?autostart=true&intro=1', remembered: false })).toEqual({
      show: false,
      reason: 'autostart',
    });
  });

  it('lets ?intro= force it either way, over the remembered box', () => {
    // How the screen gets demoed and screenshotted after the box has been ticked.
    expect(introDecision({ search: '?intro=1', remembered: true })).toEqual({ show: true, reason: 'url' });
    expect(introDecision({ search: '?intro=0', remembered: false })).toEqual({ show: false, reason: 'url' });
  });

  it('ignores values it does not understand', () => {
    expect(introDecision({ search: '?autostart=maybe&intro=please' })).toEqual({
      show: true,
      reason: 'first-time',
    });
  });
});
