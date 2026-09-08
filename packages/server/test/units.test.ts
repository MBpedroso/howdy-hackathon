/**
 * The pieces whose behaviour is a function of time, or of an event log, and which a
 * socket-level test can only observe indirectly: the token bucket, the validator's
 * happy path, the log line, and the SSE frame format.
 *
 * The bucket is the clearest case. `http.test.ts` proves the third request in a
 * two-token window is refused; it cannot prove the bucket *refills*, because that
 * would mean a test that waits minutes. With an injected clock it is three lines.
 */
import { describe, expect, it } from 'vitest';
import { frameOf } from '../src/events.ts';
import { summarizeRun } from '../src/log.ts';
import { DEFAULT_CAPACITY, DEFAULT_WINDOW_MS, createRateLimiter } from '../src/rateLimit.ts';
import { LOCAL_ORIGINS, allowedOrigins, corsFor } from '../src/cors.ts';
import { MAX_BUDGET_MS, MIN_BUDGET_MS, parseRewriteRequest } from '../src/request.ts';
import {
  CLIENT_BUDGET_RESERVE_MS,
  clampToClientBudget,
  DEFAULT_DEADLINE_MS,
} from '../src/handleRewrite.ts';
import { requestBody } from './helpers.ts';

describe('the token bucket', () => {
  it('allows a burst of `capacity`, then refuses', () => {
    let now = 0;
    const limiter = createRateLimiter({ capacity: 3, windowMs: 3000, now: () => now });
    expect([0, 1, 2].map(() => limiter.take('a').ok)).toEqual([true, true, true]);
    const refused = limiter.take('a');
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.retryAfterMs).toBe(1000);
  });

  it('drips a token back, rather than clearing on a window boundary', () => {
    let now = 0;
    const limiter = createRateLimiter({ capacity: 3, windowMs: 3000, now: () => now });
    for (let i = 0; i < 3; i += 1) limiter.take('a');
    expect(limiter.take('a').ok).toBe(false);

    // One third of the window is exactly one token. This is the property that keeps
    // a player who is playing normally from ever being told no.
    now += 1000;
    expect(limiter.take('a').ok).toBe(true);
    expect(limiter.take('a').ok).toBe(false);

    // It never fills past `capacity`, however long it is left alone.
    now += 10 * 3000;
    expect([0, 1, 2].map(() => limiter.take('a').ok)).toEqual([true, true, true]);
    expect(limiter.take('a').ok).toBe(false);
  });

  it('keeps one bucket per key, and refunds into the right one', () => {
    let now = 0;
    const limiter = createRateLimiter({ capacity: 1, windowMs: 1000, now: () => now });
    expect(limiter.take('a').ok).toBe(true);
    // A second client is unaffected by the first one's spending.
    expect(limiter.take('b').ok).toBe(true);
    expect(limiter.take('a').ok).toBe(false);

    limiter.refund('a');
    expect(limiter.take('a').ok).toBe(true);
    expect(limiter.size()).toBe(2);
  });

  it('defaults to a whole game plus two retries', () => {
    // Six per ten minutes: four rewrites is a full fight (rounds 2-5), so the limit
    // never bites on a game being played honestly.
    expect(DEFAULT_CAPACITY).toBe(6);
    expect(DEFAULT_WINDOW_MS).toBe(10 * 60 * 1000);
  });
});

describe('parseRewriteRequest', () => {
  it('accepts a real canned request and narrows the round', () => {
    const parsed = parseRewriteRequest(requestBody());
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.value.round).toBe(2);
    expect(parsed.value.summary.history.playerPosHeat).toHaveLength(64);
    expect(parsed.value.prevMeta.name).toBeTruthy();
  });

  it('rejects a round that is a string, even a numeric one', () => {
    // `JSON.parse('{"round":"2"}')` is a thing a client actually sends.
    const parsed = parseRewriteRequest(requestBody({ round: '2' }));
    expect(parsed.ok).toBe(false);
  });

  it('rejects a prevSource long enough to be a paste of the engine', () => {
    const parsed = parseRewriteRequest(requestBody({ prevSource: 'x'.repeat(64_001) }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/at most 64000 characters/);
  });

  it('carries an optional budgetMs, and is unchanged without one', () => {
    const withBudget = parseRewriteRequest(requestBody({ budgetMs: 45_000 }));
    if (!withBudget.ok) throw new Error(withBudget.error);
    expect(withBudget.value.budgetMs).toBe(45_000);
    // Absent rather than `undefined`: the field is what the server tests for.
    const without = parseRewriteRequest(requestBody());
    if (!without.ok) throw new Error(without.error);
    expect('budgetMs' in without.value).toBe(false);
  });

  it('rejects a budgetMs outside its bounds instead of clamping it silently', () => {
    for (const bad of [MIN_BUDGET_MS - 1, MAX_BUDGET_MS + 1, 0, -1]) {
      const parsed = parseRewriteRequest(requestBody({ budgetMs: bad }));
      expect(parsed.ok, `budgetMs ${bad}`).toBe(false);
      if (!parsed.ok) expect(parsed.error).toMatch(/budgetMs must be/);
    }
    const fractional = parseRewriteRequest(requestBody({ budgetMs: 45_000.5 }));
    expect(fractional.ok).toBe(false);
  });
});

/**
 * The clamp that stops the server outliving the browser.
 *
 * The bug it exists for is in `clampToClientBudget`'s own docstring: a 90 s
 * `REMATCH_DEADLINE_MS` against a client that hangs up at 45 s produced three Round 2
 * rewrites in a row that ended with `approved: null`, no `fallback` event and no
 * artifact. The arithmetic is trivial; the assertions are about which way it errs.
 */
describe('clampToClientBudget', () => {
  it('leaves the configured deadline alone when the client sends no budget', () => {
    expect(clampToClientBudget(90_000, undefined)).toBe(90_000);
    expect(clampToClientBudget(40_000, undefined)).toBe(40_000);
  });

  it('takes the client budget when it is the smaller of the two — the bug', () => {
    // The exact numbers from the playtest: server 90 s, browser 45 s.
    expect(clampToClientBudget(90_000, 45_000)).toBe(45_000 - CLIENT_BUDGET_RESERVE_MS);
  });

  it('keeps the configured deadline when it is already inside the budget', () => {
    // The shipped default: 40 s of loop inside a 45 s interlude, which already left
    // 5 s for the stream. The clamp must not shave that down a second time.
    expect(clampToClientBudget(DEFAULT_DEADLINE_MS, 45_000)).toBe(DEFAULT_DEADLINE_MS);
  });

  it('reserves time to report, so the fallback frame still lands', () => {
    // The whole point: finish *before* the client aborts, not with it.
    const budget = 20_000;
    expect(clampToClientBudget(90_000, budget)).toBeLessThan(budget);
  });

  it('never returns a non-positive deadline', () => {
    // Below the reserve the loop cannot do anything useful, but it must still be
    // able to emit an immediate fallback rather than time out at <= 0.
    expect(clampToClientBudget(90_000, CLIENT_BUDGET_RESERVE_MS)).toBe(1);
    expect(clampToClientBudget(90_000, 1)).toBe(1);
  });
});

describe('the SSE frame', () => {
  it('names the event after the payload type and sends one JSON line', () => {
    const frame = frameOf({ type: 'verdict', attempt: 2, approved: false, reason: 'too hard' });
    expect(frame).toBe(
      'event: verdict\ndata: {"type":"verdict","attempt":2,"approved":false,"reason":"too hard"}\n\n',
    );
    // No literal newline inside `data:`: a multi-line payload would need multiple
    // `data:` lines, and `JSON.stringify` escaping is what guarantees it cannot.
    expect(frame.split('\n')[1]?.startsWith('data: ')).toBe(true);
  });
});

describe('the log line', () => {
  it('sums both agents’ tokens and names the gate that rejected each attempt', () => {
    const usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 90 };
    const line = summarizeRun(
      [
        {
          type: 'analysis.done',
          analysis: { observations: [], playerArchetype: 'camper', counterPlan: 'x' },
          calls: 1,
          promptChars: 10,
          usage: { inputTokens: 7, outputTokens: 3 },
          ms: 5,
        },
        {
          type: 'done',
          result: {
            approved: false,
            reason: 'max-attempts',
            fallback: { name: 'hollow', source: '' },
            attempts: [
              {
                attempt: 1,
                source: '',
                diff: '',
                coder: { calls: 1, promptChars: 1, usage, ms: 1 },
                gates: [{ gate: 1, name: 'static', ok: false, ms: 1, reason: 'uses Date' }],
                approved: false,
                ms: 1,
              },
              {
                attempt: 2,
                source: '',
                diff: '',
                coder: { calls: 1, promptChars: 1, usage, ms: 1 },
                gates: [
                  { gate: 1, name: 'static', ok: true, ms: 1 },
                  { gate: 3, name: 'balance', ok: false, ms: 1, reason: '0.91 vs panel' },
                ],
                approved: false,
                ms: 1,
              },
            ],
          },
        },
      ],
      { route: 'POST /api/rewrite', status: 200, ms: 1234.6, round: 2 },
    );

    expect(line).toMatchObject({
      route: 'POST /api/rewrite',
      round: 2,
      attempts: 2,
      approved: false,
      ms: 1235,
      reason: 'max-attempts',
      fallback: 'hollow',
      rejectedBy: ['static', 'balance'],
      events: 2,
    });
    // The Analyst's usage counts too: 2x100 + 7.
    expect(line.tokens).toEqual({ input: 207, output: 43, cacheRead: 180 });
  });

  it('reports a stream that ended without a verdict rather than inventing one', () => {
    const line = summarizeRun([{ type: 'replay', summary: requestBody()['summary'] as never, round: 2 }], {
      route: 'POST /api/rewrite',
      status: 200,
      ms: 10,
    });
    expect(line.approved).toBeNull();
    expect(line.attempts).toBe(0);
    expect(line.round).toBeNull();
  });
});

describe('the CORS allow-list', () => {
  it('allows the dev ports and a request with no Origin at all', () => {
    const allowed = allowedOrigins({});
    for (const origin of LOCAL_ORIGINS) expect(corsFor(origin, allowed).allowed, origin).toBe(true);
    // curl, a health check, a same-origin fetch: CORS has nothing to say about it.
    expect(corsFor(undefined, allowed)).toEqual({ allowed: true, headers: {} });
    expect(corsFor('null', allowed).allowed).toBe(true);
  });

  it('adds `https://` to a bare VERCEL_URL and trims a trailing slash', () => {
    const allowed = allowedOrigins({ VERCEL_URL: 'x.vercel.app', REMATCH_ORIGIN: 'https://y.example/' });
    expect(allowed.has('https://x.vercel.app')).toBe(true);
    expect(corsFor('https://y.example', allowed).allowed).toBe(true);
    expect(corsFor('http://x.vercel.app', allowed).allowed).toBe(false);
  });
});
