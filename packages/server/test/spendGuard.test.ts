/**
 * The two spend controls, and the one failure that motivated them.
 *
 * On 2026-09-03 eleven eval runs in one evening exhausted the account's credit while
 * every individual request sat comfortably inside the per-IP rate limit. So there are
 * now two controls of deliberately different shape — a per-IP bucket for abuse, and a
 * **global daily counter** for the bill — and this file pins the second one plus the
 * `REMATCH_PROVIDER=none` off switch that makes local development free by default.
 *
 * What is asserted, in order of how much it would hurt to get wrong:
 *
 * 1. Past the cap the server serves **fallback-only**, not an error — the player still
 *    gets four beats and a boss, which is the same supported mode a fresh clone runs
 *    in (spec AC 1).
 * 2. `REMATCH_PROVIDER=none` wins over a present, valid key. "I set it to none and it
 *    billed me anyway" is the exact failure this is here to prevent.
 * 3. `/api/health` reports the same counter the endpoint enforces.
 * 4. The cap-reached log line fires **once**, not per request.
 *
 * No network and no API key: the model is `mockProvider`, as everywhere in this suite.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  CAPPED_MESSAGE,
  NO_KEY_MESSAGE,
  fallbackOnly,
  handleRewrite,
  type RewriteHandlerOptions,
} from '../src/handleRewrite.ts';
import type { ServerRewriteEvent } from '../src/events.ts';
import { pickFallback } from '../src/fallback.ts';
import { activeModel, activeVendor, hasApiKey, providerDisabled, selection } from '../src/providers.ts';
import {
  DEFAULT_DAILY_CAP,
  createSpendGuard,
  resolveDailyCap,
  utcDay,
} from '../src/spendGuard.ts';
import { ANALYSIS_JSON, MATCHES, asCoderReply, readHarnessFixture, requestBody } from './helpers.ts';
import { mockProvider } from '@rematch/agents';

/** The harness's hand-written Round 2 boss — a file that really passes all four gates. */
const APPROVED_SOURCE = readHarnessFixture('round2-candidate');

/**
 * One `POST /api/rewrite` through the handler, with a scripted model.
 *
 * `noProvider: true` omits `provider` entirely rather than passing `undefined` — under
 * `exactOptionalPropertyTypes` those are different things, and the whole point of that
 * case is to reach `resolveProviders(env)` and let the *environment* decide.
 */
async function runOnce(
  opts: Omit<RewriteHandlerOptions, 'provider'> & { noProvider?: boolean } = {},
): Promise<ServerRewriteEvent[]> {
  const { noProvider = false, ...rest } = opts;
  const events: ServerRewriteEvent[] = [];
  await handleRewrite(
    requestBody(),
    (event) => void events.push(event),
    undefined,
    {
      ...(noProvider ? {} : { provider: mockProvider([ANALYSIS_JSON, asCoderReply(APPROVED_SOURCE)]) }),
      candidates: 1,
      maxAttempts: 1,
      harnessOpts: { gate3: { matches: MATCHES, workers: 2 } },
      env: {},
      ...rest,
    },
  );
  return events;
}

describe('resolveDailyCap', () => {
  it('defaults to 50 — twelve full games, far less than an eval loop burns', () => {
    expect(resolveDailyCap({})).toBe(DEFAULT_DAILY_CAP);
    expect(DEFAULT_DAILY_CAP).toBe(50);
  });

  it('reads REMATCH_MAX_REWRITES_PER_DAY, and treats 0 as "never spend"', () => {
    expect(resolveDailyCap({ REMATCH_MAX_REWRITES_PER_DAY: '4' })).toBe(4);
    expect(resolveDailyCap({ REMATCH_MAX_REWRITES_PER_DAY: '0' })).toBe(0);
  });

  it('falls back to the default on nonsense rather than taking the demo down', () => {
    // A typo in an env var must not be a fatal error at boot.
    for (const raw of ['', '   ', 'lots', 'NaN']) {
      expect(resolveDailyCap({ REMATCH_MAX_REWRITES_PER_DAY: raw })).toBe(DEFAULT_DAILY_CAP);
    }
    // Negative is clamped to "never spend", not to the default.
    expect(resolveDailyCap({ REMATCH_MAX_REWRITES_PER_DAY: '-3' })).toBe(0);
  });
});

describe('createSpendGuard', () => {
  it('allows exactly `cap` claims and refuses the rest', () => {
    const guard = createSpendGuard({ cap: 3 });
    expect([guard.claim(), guard.claim(), guard.claim(), guard.claim()]).toEqual([true, true, true, false]);
    expect(guard.report()).toMatchObject({ rewritesToday: 3, dailyCap: 3, spendGuard: 'capped' });
  });

  it('refuses everything at cap 0 — the never-spend setting for a public deploy', () => {
    const guard = createSpendGuard({ cap: 0 });
    expect(guard.claim()).toBe(false);
    expect(guard.report().spendGuard).toBe('capped');
  });

  it('reports `ok` with a live count while there is budget left', () => {
    const guard = createSpendGuard({ cap: 5 });
    guard.claim();
    guard.claim();
    expect(guard.report()).toMatchObject({ rewritesToday: 2, dailyCap: 5, spendGuard: 'ok' });
  });

  it('logs once when the cap is reached, not once per refused request', () => {
    // A line repeated on every request for the rest of the day is a line nobody
    // reads, which defeats the point of having it.
    const onCapped = vi.fn();
    const guard = createSpendGuard({ cap: 2, onCapped });
    guard.claim();
    guard.claim();
    guard.claim();
    guard.claim();
    expect(onCapped).toHaveBeenCalledTimes(1);
    expect(onCapped.mock.calls[0]?.[0]).toMatchObject({ rewritesToday: 2, spendGuard: 'capped' });
  });

  it('rolls over at midnight UTC, against an injected clock', () => {
    // UTC rather than local so the roll-over does not depend on the host's zone.
    let at = Date.parse('2026-09-03T23:59:00.000Z');
    const guard = createSpendGuard({ cap: 1, now: () => at });

    expect(guard.claim()).toBe(true);
    expect(guard.claim()).toBe(false);
    expect(guard.report().day).toBe('2026-09-03');

    at = Date.parse('2026-09-04T00:01:00.000Z');
    expect(guard.report()).toMatchObject({ rewritesToday: 0, spendGuard: 'ok', day: '2026-09-04' });
    expect(guard.claim()).toBe(true);
  });

  it('warns again on a new day, because it is new information', () => {
    let at = Date.parse('2026-09-03T12:00:00.000Z');
    const onCapped = vi.fn();
    const guard = createSpendGuard({ cap: 1, now: () => at, onCapped });
    guard.claim();
    expect(onCapped).toHaveBeenCalledTimes(1);

    at = Date.parse('2026-09-04T12:00:00.000Z');
    guard.claim();
    guard.claim();
    expect(onCapped).toHaveBeenCalledTimes(2);
  });
});

describe('utcDay', () => {
  it('is the UTC calendar day, not the host’s', () => {
    expect(utcDay(Date.parse('2026-09-03T23:59:59.999Z'))).toBe('2026-09-03');
    expect(utcDay(Date.parse('2026-09-04T00:00:00.000Z'))).toBe('2026-09-04');
  });
});

describe('REMATCH_PROVIDER=none', () => {
  const withKeys = { OPENAI_API_KEY: 'sk-test-not-a-real-key', ANTHROPIC_API_KEY: 'sk-ant-also-fake' };

  it('forces fallback-only even when both keys are present', () => {
    // The whole reason `none` exists: an off switch that leaves the credential in
    // place, because deleting it from `.env` under time pressure is how keys get lost.
    const env = { ...withKeys, REMATCH_PROVIDER: 'none' };
    expect(providerDisabled(env)).toBe(true);
    expect(hasApiKey(env)).toBe(false);
    expect(activeVendor(env)).toBeNull();
    expect(activeModel(env)).toBeNull();
    expect(selection(env).reason).toContain('REMATCH_PROVIDER=none');
  });

  it('is case- and whitespace-insensitive, because a human types it', () => {
    for (const raw of ['none', 'NONE', ' None ']) {
      expect(hasApiKey({ ...withKeys, REMATCH_PROVIDER: raw })).toBe(false);
    }
  });

  it('does not disable anything for a real vendor value', () => {
    expect(providerDisabled({ ...withKeys, REMATCH_PROVIDER: 'openai' })).toBe(false);
    expect(hasApiKey({ ...withKeys, REMATCH_PROVIDER: 'openai' })).toBe(true);
  });

  it('throws if anyone builds providers anyway, rather than silently billing', () => {
    expect(() => selection({ ...withKeys, REMATCH_PROVIDER: 'none' }).create()).toThrow(/none/);
  });

  it('serves the no-key fallback stream through the real handler', async () => {
    const events = await runOnce({
      noProvider: true,
      env: { ...withKeys, REMATCH_PROVIDER: 'none' },
    });
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('replay');
    expect(types).toContain('fallback');
    expect(types.at(-1)).toBe('done');
    // Fallback-only mode says so in as many words; nothing is fabricated.
    const analysisDone = events.find((e) => e.type === 'analysis.done');
    if (analysisDone?.type !== 'analysis.done') throw new Error('expected analysis.done');
    expect(analysisDone.analysis.observations[0]).toBe(NO_KEY_MESSAGE);
  });
});

describe('handleRewrite past the daily cap', () => {
  it('serves fallback-only rather than an error, and says which limit was hit', async () => {
    const guard = createSpendGuard({ cap: 1 });

    // First request spends the only slot and really runs the loop.
    const first = await runOnce({ spendGuard: guard });
    expect(first.map((e) => e.type)).toContain('rewrite.done');

    const second = await runOnce({ spendGuard: guard });
    const types = second.map((e) => e.type);
    // No model call at all: no `rewrite.done`, but still a complete four-beat stream.
    expect(types).not.toContain('rewrite.done');
    expect(types[0]).toBe('replay');
    expect(types).toContain('fallback');
    expect(types.at(-1)).toBe('done');

    const analysisDone = second.find((e) => e.type === 'analysis.done');
    if (analysisDone?.type !== 'analysis.done') throw new Error('expected analysis.done');
    // The capped sentence, not the no-key one: the two are different situations and
    // only one of them resolves at midnight.
    expect(analysisDone.analysis.observations[0]).toBe(CAPPED_MESSAGE);

    const done = second.at(-1);
    if (done?.type !== 'done') throw new Error('expected done');
    expect(done.result.approved).toBe(false);
    // Spec AC 5's visible fallback still travels in the terminal frame, so the client
    // needs no second request at the moment something has gone wrong.
    expect((done.result as { fallback?: { source?: string } }).fallback?.source).toBeTruthy();
  });

  it('never spends a slot on a request that was not going to call a model', async () => {
    // A no-key request must not count against the budget — otherwise a deployment
    // with no credential would "use up" a cap it can never spend.
    const guard = createSpendGuard({ cap: 1 });
    await runOnce({ noProvider: true, env: {}, spendGuard: guard });
    expect(guard.report().rewritesToday).toBe(0);

    // …and the slot is still there for a request that will.
    const events = await runOnce({ spendGuard: guard });
    expect(events.map((e) => e.type)).toContain('rewrite.done');
    expect(guard.report().rewritesToday).toBe(1);
  });

  it('`spendGuard: false` disables the cap for suites that need many rewrites', async () => {
    const events = await runOnce({ spendGuard: false });
    expect(events.map((e) => e.type)).toContain('rewrite.done');
  });
});

describe('fallbackOnly', () => {
  it('carries the reason it was given into the Analysis beat and the done message', () => {
    // One function for both reasons rather than two copies of a whole beat.
    const events: ServerRewriteEvent[] = [];
    const result = fallbackOnly(
      requestBody() as never,
      (event) => void events.push(event),
      pickFallback(2, 1),
      CAPPED_MESSAGE,
    );
    expect(result.approved).toBe(false);
    if (!result.approved) expect(result.message).toBe('daily rewrite budget reached');
    const analysisDone = events.find((e) => e.type === 'analysis.done');
    if (analysisDone?.type !== 'analysis.done') throw new Error('expected analysis.done');
    expect(analysisDone.analysis.observations[0]).toBe(CAPPED_MESSAGE);
  });

  it('defaults to the no-key sentence, so existing callers are unchanged', () => {
    const events: ServerRewriteEvent[] = [];
    fallbackOnly(requestBody() as never, (event) => void events.push(event), pickFallback(2, 1));
    const analysisDone = events.find((e) => e.type === 'analysis.done');
    if (analysisDone?.type !== 'analysis.done') throw new Error('expected analysis.done');
    expect(analysisDone.analysis.observations[0]).toBe(NO_KEY_MESSAGE);
  });
});
