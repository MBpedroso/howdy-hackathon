/**
 * Mute persistence (`audio/mute.ts`) — the same storage discipline `test/intro.test.ts`
 * pins for "skip intro", applied to its own namespaced key. DOM-free: the storage is
 * injected, so the interesting cases — a `localStorage` that throws, a stale value
 * from an older build — are all reachable in Node.
 */
import { describe, expect, it } from 'vitest';

import { AUDIO_MUTED_KEY, readMuted, writeMuted, type StorageLike } from '../src/audio/mute.ts';

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

describe('mute persistence', () => {
  it('defaults to unmuted — sound is opt-out, not opt-in, once unlocked', () => {
    expect(readMuted(memory())).toBe(false);
  });

  it('round-trips through storage under one namespaced key', () => {
    const storage = memory();
    expect(writeMuted(true, storage)).toBe(true);
    expect(storage.data[AUDIO_MUTED_KEY]).toBe('1');
    expect(readMuted(storage)).toBe(true);

    // Unmuting removes the key rather than writing a falsy value — the same
    // convention `ui/intro.ts`'s `writeSkipIntro` uses, so a reader never has to
    // know what "0" means.
    expect(writeMuted(false, storage)).toBe(true);
    expect(AUDIO_MUTED_KEY in storage.data).toBe(false);
    expect(readMuted(storage)).toBe(false);
  });

  it('treats a stale/corrupt value as unmuted', () => {
    expect(readMuted(memory({ [AUDIO_MUTED_KEY]: 'yes' }))).toBe(false);
    expect(readMuted(memory({ [AUDIO_MUTED_KEY]: '' }))).toBe(false);
  });

  it('degrades to unmuted, and writes report failure, when storage throws or is absent', () => {
    expect(readMuted(hostile)).toBe(false);
    expect(writeMuted(true, hostile)).toBe(false);

    expect(readMuted(null)).toBe(false);
    expect(writeMuted(true, null)).toBe(false);
  });
});
