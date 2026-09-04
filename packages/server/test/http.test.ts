/**
 * The framing around `handleRewrite`: routes, validation, limits, CORS, keep-alive.
 *
 * Everything here is cheap — no test in this file runs the loop with a model — and
 * everything here is a thing that would otherwise fail in front of a jury: a body
 * that streams before it is checked, a limiter that locks a player out of their own
 * game, a preflight that turns the deployed URL into a blank screen.
 */
import { describe, expect, it } from 'vitest';
import { BALANCE_ROUNDS } from '@rematch/harness';
import { MAX_BODY_BYTES } from '../src/http.ts';
import { DEFAULT_DAILY_CAP } from '../src/spendGuard.ts';
import { asCoderReply, postRewrite, readHarnessFixture, requestBody, scriptedProvider, startServer } from './helpers.ts';

describe('GET /api/health', () => {
  it('reports the mode the interlude will run in', async () => {
    const server = await startServer();
    try {
      const res = await fetch(`${server.url}/api/health`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');
      const body = (await res.json()) as Record<string, unknown>;
      expect(body['ok']).toBe(true);
      // `env: {}` in the test defaults, so this is the fresh-clone answer (AC 1).
      expect(body['hasApiKey']).toBe(false);
      expect(body['provider']).toBeNull();
      expect(body['model']).toBeNull();
      expect(body['fallbackRounds']).toEqual([...BALANCE_ROUNDS]);
      // The spend guard's state, so an operator can see it before a jury does.
      expect(body['rewritesToday']).toBe(0);
      expect(body['dailyCap']).toBe(DEFAULT_DAILY_CAP);
      expect(body['spendGuard']).toBe('ok');
    } finally {
      await server.close();
    }
  });

  it('reports the daily spend cap, and reports it as capped once it is spent', async () => {
    // `/api/health` and the endpoint must read the *same* counter — a health check
    // that disagrees with what the endpoint enforces is worse than none.
    const server = await startServer({ env: { REMATCH_MAX_REWRITES_PER_DAY: '0' } });
    try {
      const body = (await (await fetch(`${server.url}/api/health`)).json()) as Record<string, unknown>;
      expect(body['dailyCap']).toBe(0);
      // Cap 0 is the never-spend setting, so the guard is capped from the first look.
      expect(body['spendGuard']).toBe('capped');
    } finally {
      await server.close();
    }
  });

  it('reports REMATCH_PROVIDER=none as fallback-only even with a key set', async () => {
    const server = await startServer({ env: { OPENAI_API_KEY: 'sk-test', REMATCH_PROVIDER: 'none' } });
    try {
      const body = (await (await fetch(`${server.url}/api/health`)).json()) as Record<string, unknown>;
      expect(body['hasApiKey']).toBe(false);
      expect(body['provider']).toBeNull();
      expect(body['model']).toBeNull();
    } finally {
      await server.close();
    }
  });

  it('names the model when a credential is present', async () => {
    const server = await startServer({
      env: { ANTHROPIC_API_KEY: 'sk-ant-test', REMATCH_MODEL: 'claude-sonnet-5' },
    });
    try {
      const body = (await (await fetch(`${server.url}/api/health`)).json()) as Record<string, unknown>;
      expect(body['hasApiKey']).toBe(true);
      expect(body['provider']).toBe('anthropic');
      expect(body['model']).toBe('claude-sonnet-5');
    } finally {
      await server.close();
    }
  });

  it('names the vendor, not just the model, so the demo cannot lie about who it calls', async () => {
    const server = await startServer({ env: { OPENAI_API_KEY: 'sk-test', REMATCH_PROVIDER: 'openai' } });
    try {
      const body = (await (await fetch(`${server.url}/api/health`)).json()) as Record<string, unknown>;
      expect(body['provider']).toBe('openai');
      expect(body['model']).toMatch(/^gpt-/);
    } finally {
      await server.close();
    }
  });
});

describe('GET /api/fallback/:round', () => {
  it('returns a pre-approved strategy for every round with a band', async () => {
    const server = await startServer();
    try {
      for (const round of BALANCE_ROUNDS) {
        const res = await fetch(`${server.url}/api/fallback/${round}?seed=7`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { name: string; source: string };
        expect(body.name).toBeTruthy();
        expect(body.source).toMatch(/export function decide/);
      }
    } finally {
      await server.close();
    }
  });

  it('rejects a round with no pool, and a seed that is not a number', async () => {
    const server = await startServer();
    try {
      // Round 1 is the opening boss: nothing was generated for it, and it has no
      // fairness band (spec §6.2), so it has no pool either.
      const round1 = await fetch(`${server.url}/api/fallback/1`);
      expect(round1.status).toBe(400);
      expect(((await round1.json()) as { error: string }).error).toMatch(/round must be one of/);

      const badSeed = await fetch(`${server.url}/api/fallback/2?seed=nope`);
      expect(badSeed.status).toBe(400);
    } finally {
      await server.close();
    }
  });
});

describe('POST /api/rewrite — validation', () => {
  const cases: readonly [name: string, body: unknown, pattern: RegExp][] = [
    ['a round with no fairness band', requestBody({ round: 1 }), /round must be one of/],
    ['a round past the last one', requestBody({ round: 6 }), /round must be one of/],
    ['a non-integer seed', requestBody({ seed: 1.5 }), /seed must be an integer/],
    ['an empty prevSource', requestBody({ prevSource: '   ' }), /prevSource must be a non-empty string/],
    ['a prevMeta with no name', requestBody({ prevMeta: { rationale: 'x', version: 1 } }), /prevMeta\.name/],
    ['a missing summary', requestBody({ summary: undefined }), /summary must be an object/],
    [
      'a heat grid that is not 8x8',
      requestBody({ summary: { ...requestBody()['summary'] as object, history: { playerPosHeat: [1, 2], playerDashDirs: [0, 0, 0, 0, 0, 0, 0, 0], playerShotsDuring: {} } } }),
      /playerPosHeat must be 64 numbers/,
    ],
    ['a body that is not an object', '"nope"', /body must be a JSON object/],
  ];

  it('answers 400 with the field named, before a single frame is streamed', async () => {
    const server = await startServer();
    try {
      for (const [name, body, pattern] of cases) {
        const res = await postRewrite(server.url, body);
        expect(res.status, name).toBe(400);
        // Not an event stream: there is still a status code to say no with.
        expect(res.headers.get('content-type'), name).toContain('application/json');
        expect(res.frames, name).toHaveLength(0);
        expect((JSON.parse(res.raw) as { error: string }).error, name).toMatch(pattern);
      }
    } finally {
      await server.close();
    }
  });

  it('answers 400 for a body that is not JSON at all', async () => {
    const server = await startServer();
    try {
      const res = await postRewrite(server.url, 'not json {');
      expect(res.status).toBe(400);
      expect((JSON.parse(res.raw) as { error: string }).error).toMatch(/not valid JSON/);
    } finally {
      await server.close();
    }
  });

  it('answers 413 for a body over the cap without reading all of it', async () => {
    const server = await startServer({ bodyLimitBytes: 4096 });
    try {
      const res = await postRewrite(server.url, { round: 2, pad: 'x'.repeat(8192) });
      expect(res.status).toBe(413);
      expect((JSON.parse(res.raw) as { error: string }).error).toMatch(/at most 4096 bytes/);
    } finally {
      await server.close();
    }
  });

  it('caps bodies at 512 KB by default', () => {
    // Stated as a test because the number is a promise to the client: a
    // `ReplaySummary` is ~8 KB and `prevSource` is capped at 64 K chars, so the cap
    // is ~6x the largest legitimate body.
    expect(MAX_BODY_BYTES).toBe(512 * 1024);
  });
});

describe('POST /api/rewrite — the rate limit', () => {
  it('refuses past the bucket, with a Retry-After, and does not charge for a 400', async () => {
    // Two rewrites per ten minutes, so the third is refused. The real limit is six.
    const server = await startServer({ rateLimit: { capacity: 2, windowMs: 600_000 } });
    try {
      // A malformed body is refunded, so it cannot consume the quota.
      for (let i = 0; i < 3; i += 1) {
        expect((await postRewrite(server.url, requestBody({ round: 1 }))).status).toBe(400);
      }

      // Fallback-only mode (no provider), so each accepted request is cheap.
      expect((await postRewrite(server.url, requestBody())).status).toBe(200);
      expect((await postRewrite(server.url, requestBody())).status).toBe(200);

      const refused = await postRewrite(server.url, requestBody());
      expect(refused.status).toBe(429);
      expect(refused.headers.get('content-type')).toContain('application/json');
      expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
      const body = JSON.parse(refused.raw) as { error: string; retryAfterSeconds: number };
      expect(body.error).toMatch(/too many rewrites/);
      expect(body.retryAfterSeconds).toBeGreaterThan(0);
    } finally {
      await server.close();
    }
  });
});

describe('CORS', () => {
  it('answers a preflight and echoes an allowed origin', async () => {
    const server = await startServer();
    try {
      const preflight = await fetch(`${server.url}/api/rewrite`, {
        method: 'OPTIONS',
        headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'POST' },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
      expect(preflight.headers.get('access-control-allow-methods')).toContain('POST');
      // Without `Vary: Origin` a shared cache can hand one origin's allow header
      // to a request from another.
      expect(preflight.headers.get('vary')).toBe('Origin');
    } finally {
      await server.close();
    }
  });

  it('refuses an origin that is not on the list', async () => {
    const server = await startServer();
    try {
      const res = await fetch(`${server.url}/api/health`, { headers: { origin: 'https://evil.example' } });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toMatch(/is not allowed/);
    } finally {
      await server.close();
    }
  });

  it('allows an origin from REMATCH_ORIGIN and from VERCEL_URL', async () => {
    const server = await startServer({
      env: { REMATCH_ORIGIN: 'https://rematch.example', VERCEL_URL: 'rematch-abc.vercel.app' },
    });
    try {
      for (const origin of ['https://rematch.example', 'https://rematch-abc.vercel.app']) {
        const res = await fetch(`${server.url}/api/health`, { headers: { origin } });
        expect(res.status, origin).toBe(200);
        expect(res.headers.get('access-control-allow-origin'), origin).toBe(origin);
      }
    } finally {
      await server.close();
    }
  });
});

describe('the stream stays warm', () => {
  it('sends `: keepalive` comments while the loop is quiet', async () => {
    // The Analyst takes 150 ms and the keep-alive fires every 20 ms, which is the
    // same shape as Gate 3 simulating for 20 s behind a 30 s idle timeout.
    const provider = scriptedProvider([asCoderReply(readHarnessFixture('round2-candidate'))], { delayMs: 150 });
    const server = await startServer({ provider, keepaliveMs: 20 });
    try {
      const res = await postRewrite(server.url, requestBody());
      expect(res.comments.filter((c) => c === 'keepalive').length).toBeGreaterThan(0);
      // A comment is not a frame: the client's parser must not see an empty event.
      expect(res.events.every((e) => typeof e.type === 'string')).toBe(true);
      expect(res.events.at(-1)?.type).toBe('done');
    } finally {
      await server.close();
    }
  });
});

describe('unknown routes', () => {
  it('answers 404 as JSON', async () => {
    const server = await startServer();
    try {
      const res = await fetch(`${server.url}/api/nope`);
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: string }).error).toMatch(/no route for GET \/api\/nope/);

      // The rewrite route is POST-only; a GET must not be a 200 with no body.
      const wrongMethod = await fetch(`${server.url}/api/rewrite`);
      expect(wrongMethod.status).toBe(404);
    } finally {
      await server.close();
    }
  });
});
