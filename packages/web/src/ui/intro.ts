/**
 * Whether the start screen is shown — the whole decision, as a pure function.
 *
 * There are three ways to not see the intro and they are not the same thing:
 *
 * | Input | Decision | Why it exists |
 * |---|---|---|
 * | `?autostart=1` | never show it | the e2e suite and the demo scripts jump straight into a fight. **First** in precedence, because a spec that asks for a round must get a round |
 * | `?intro=0` / `?intro=1` | force either way | forcing it *on* is how the screen gets demoed and screenshotted after the box has been ticked; forcing it *off* is a one-shot skip |
 * | the remembered box | skip it | "skip intro next time", from `localStorage` |
 *
 * The reason is returned along with the answer because "why is there no start
 * screen" is otherwise a five-minute question, and `?intro=1` is the answer to it.
 *
 * `localStorage` is wrapped in `try`/`catch` on **both** sides: it throws outright
 * in a Chromium tab with site data blocked, in a private window in some browsers,
 * and inside a screenshot/thumbnail context — and a game that will not boot because
 * it could not remember a checkbox would be an absurd way to fail. Every read
 * degrades to "not remembered", which shows the intro: the safe direction.
 */

/** The `localStorage` key. Namespaced, because the origin is shared with nothing. */
export const SKIP_INTRO_KEY = 'rematch.skipIntro';

/** The slice of `Storage` this needs. Injectable, so the tests need no DOM. */
export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

/** `globalThis.localStorage`, or `null` when it is absent or throws on access. */
export function defaultStorage(): StorageLike | null {
  try {
    const storage = (globalThis as { localStorage?: StorageLike }).localStorage;
    return storage ?? null;
  } catch {
    return null;
  }
}

/** Has the player asked not to see the intro again? */
export function readSkipIntro(storage: StorageLike | null = defaultStorage()): boolean {
  if (storage === null) return false;
  try {
    return storage.getItem(SKIP_INTRO_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Remember (or forget) the choice. Returns whether it actually persisted, so a
 * caller could tell the player it did not — nothing does today, and the box still
 * works for the rest of the session either way.
 */
export function writeSkipIntro(value: boolean, storage: StorageLike | null = defaultStorage()): boolean {
  if (storage === null) return false;
  try {
    if (value) storage.setItem(SKIP_INTRO_KEY, '1');
    else storage.removeItem(SKIP_INTRO_KEY);
    return true;
  } catch {
    return false;
  }
}

export type IntroDecision = {
  show: boolean;
  reason: 'autostart' | 'url' | 'remembered' | 'first-time';
};

/**
 * Show the start screen, or go straight to Round 1.
 *
 * `search` is `location.search`; `remembered` is `readSkipIntro()`. Both are
 * parameters rather than reads so this is a function of its inputs and the boot
 * path has nothing to mock.
 */
export function introDecision(options: { search?: string; remembered?: boolean } = {}): IntroDecision {
  const params = new URLSearchParams(options.search ?? '');
  const autostart = params.get('autostart');
  if (autostart === '1' || autostart === 'true') return { show: false, reason: 'autostart' };

  const intro = params.get('intro');
  if (intro === '1' || intro === 'true') return { show: true, reason: 'url' };
  if (intro === '0' || intro === 'false') return { show: false, reason: 'url' };

  if (options.remembered === true) return { show: false, reason: 'remembered' };
  return { show: true, reason: 'first-time' };
}
