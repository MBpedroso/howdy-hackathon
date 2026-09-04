/**
 * Shared e2e plumbing: the typed view of `window.__rematch`, and the two waits every
 * spec needs (the app booted; the simulation reached some state).
 */
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import type { InputLog } from '@rematch/engine';

export type RecordedRound = {
  sessionSeed: number;
  round: number;
  seed: number;
  strategy: string;
  ticks: number;
  outcome: string;
  hash: string;
  /** One entry per tick, exactly as the engine consumes them. */
  log: InputLog;
};

export function loadFixture(): RecordedRound {
  const path = new URL('./fixtures/inputlog-round1.json', import.meta.url);
  return JSON.parse(readFileSync(path, 'utf8')) as RecordedRound;
}

// `window.__rematch` is typed once, in `src/main.ts`'s `declare global`. Both files
// are in this package's tsconfig program, so the specs get that type for free — and
// declaring it a second time here would silently fork the two definitions.

/** Wait until the sandbox is up and a round is live. */
export async function waitForRound(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const api = window.__rematch;
    return api !== undefined && api.ready && api.round > 0 && api.state !== null;
  });
}

/** Wait until the app has booted (a screen is showing, sandbox instantiated). */
export async function waitForBoot(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__rematch?.ready === true);
}

/**
 * Load the recorded round into the page and stop the clock: the round restarts from
 * tick 0 with the deterministic sandbox clock, and every following tick comes from the
 * log. Nothing advances until a spec calls `fastForward`.
 */
export async function armReplay(page: Page, log: InputLog): Promise<void> {
  await page.evaluate(async (recorded) => {
    await window.__rematch?.driveWith(recorded);
  }, log);
}
