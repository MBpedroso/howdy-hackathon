/**
 * The one setting audio has: muted or not. Persisted, and read/write follow the same
 * discipline `ui/intro.ts` established for "skip intro" and the fighter picks —
 * `localStorage` wrapped in `try`/`catch` on **both** sides, because it throws
 * outright in a tab with site data blocked, in a private window in some browsers, and
 * inside a screenshot/thumbnail context, and a game that would not boot because it
 * could not remember a mute toggle would be an absurd way to fail. Every read
 * degrades to "not muted" — sound is opt-out, not opt-in, once a gesture has unlocked
 * it (see `engine.ts`'s autoplay-policy note).
 *
 * A standalone module rather than a couple of exports tacked onto `ui/intro.ts`:
 * audio is a `packages/web`-only concern that never reaches the engine, and keeping
 * its storage key next to its own reducer (`sfx.ts`) and engine (`engine.ts`) is what
 * lets `test/audio-costume.test.ts` assert the whole folder never leaks into the
 * simulation without also re-reading `ui/intro.ts`'s unrelated keys.
 */

/** The slice of `Storage` this needs. Injectable, so the tests need no DOM. */
export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

/** Namespaced like every other key this client writes — see `ui/intro.ts`. */
export const AUDIO_MUTED_KEY = 'rematch.audio.muted';

/** `globalThis.localStorage`, or `null` when it is absent or throws on access. */
export function defaultStorage(): StorageLike | null {
  try {
    const storage = (globalThis as { localStorage?: StorageLike }).localStorage;
    return storage ?? null;
  } catch {
    return null;
  }
}

/** Has the player muted the game? Defaults to `false` — sound is on until told otherwise. */
export function readMuted(storage: StorageLike | null = defaultStorage()): boolean {
  if (storage === null) return false;
  try {
    return storage.getItem(AUDIO_MUTED_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Remember (or forget) the choice. Returns whether it actually persisted, so a caller
 * could tell the player it did not — nothing does today, and the toggle still works
 * for the rest of the session either way.
 */
export function writeMuted(value: boolean, storage: StorageLike | null = defaultStorage()): boolean {
  if (storage === null) return false;
  try {
    if (value) storage.setItem(AUDIO_MUTED_KEY, '1');
    else storage.removeItem(AUDIO_MUTED_KEY);
    return true;
  } catch {
    return false;
  }
}
