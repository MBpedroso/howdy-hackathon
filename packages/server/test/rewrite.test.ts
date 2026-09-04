/**
 * `POST /api/rewrite` end to end, over a socket, with the real harness.
 *
 * The model is mocked; nothing else is. Gate 1 really rejects `Date`, Gate 3 really
 * simulates matches, the fallback pool is really read from disk, and every assertion
 * here is made against bytes that came back over HTTP — because the failures this
 * endpoint actually has are framing failures, and a handler tested in isolation
 * cannot have them.
 *
 * Three claims are the reason the file exists:
 *
 *  1. **The stream is the interlude.** Spec §2.2's four beats arrive as events, in
 *     order, and the last one is always `done`. A client that renders events and
 *     nothing else (`packages/web/src/interlude/`) is then complete by construction.
 *  2. **A rejection is visible.** Spec §2.2: "The player must be able to read every
 *     rejection." So the harness's sentence has to survive the wire verbatim, and
 *     `verdict` has to arrive per attempt rather than once at the end.
 *  3. **Every ending ships a boss.** Approved, out of attempts, or no API key at
 *     all — the terminal frame always carries something the player can fight, which
 *     for the three failing cases means `result.fallback` (spec AC 5).
 */
import { describe, expect, it, vi } from 'vitest';
import { staticCheck } from '@rematch/contract';
import { NO_KEY_MESSAGE } from '../src/handleRewrite.ts';
import {
  asCoderReply,
  doneOf,
  eventsOf,
  payload,
  postRewrite,
  readGood,
  readHarnessFixture,
  requestBody,
  scriptedProvider,
  startServer,
  type StreamResult,
} from './helpers.ts';

/** The hand-written Round 2 boss: passes all four gates inside round 2's band. */
const APPROVED = (): string => asCoderReply(readHarnessFixture('round2-candidate'));

describe('POST /api/rewrite — the approved path', () => {
  it('streams the four beats in order and ends with an approved `done`', async () => {
    const provider = scriptedProvider([APPROVED()]);
    const server = await startServer({ provider });
    try {
      const res = await postRewrite(server.url, requestBody());

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      expect(res.headers.get('cache-control')).toContain('no-cache');
      // The header that decides whether a proxy delivers beats or one long wait.
      expect(res.headers.get('x-accel-buffering')).toBe('no');

      // The wire contract (`packages/web/src/interlude/source.ts`): the `event:`
      // name equals the payload's `type`, so `curl -N` is readable.
      for (const [i, frame] of res.frames.entries()) {
        expect(frame.event).toBe(res.events[i]?.type);
      }

      const types = res.events.map((e) => e.type);
      expect(types[0]).toBe('replay');
      expect(types.at(-1)).toBe('done');
      // `done` is last and appears exactly once.
      expect(types.filter((t) => t === 'done')).toHaveLength(1);
      // Beat 2 and beat 3 both streamed rather than arriving whole.
      expect(eventsOf(res.events, 'analysis.delta').length).toBeGreaterThan(0);
      expect(eventsOf(res.events, 'rewrite.delta').length).toBeGreaterThan(0);
      expect(eventsOf(res.events, 'analysis.done')).toHaveLength(1);
      expect(eventsOf(res.events, 'rewrite.done')).toHaveLength(1);

      // Beat 4: all four gates, in order, each as its own event.
      const gates = eventsOf(res.events, 'trial.gate').map((e) => e.gate as { gate: number; name: string; ok: boolean });
      expect(gates.map((g) => g.gate)).toEqual([1, 2, 3, 4]);
      expect(gates.map((g) => g.name)).toEqual(['static', 'fuzz', 'balance', 'perf']);
      expect(gates.every((g) => g.ok)).toBe(true);
      // Gate 3's meter: `matchesDone: 0` when the matches start, a batch at a time
      // while they run (throttled in the loop), and the total when they finish. The
      // count depends on how fast the pool got through 24 matches, so the assertion
      // is on the ends and on the monotonicity, not on the number of frames.
      const progress = eventsOf(res.events, 'trial.progress') as unknown as Array<{
        matchesDone: number;
        matchesTotal: number;
        gate: string;
      }>;
      expect(progress.length).toBeGreaterThanOrEqual(2);
      expect(progress[0]).toMatchObject({ matchesDone: 0, gate: 'balance' });
      expect(progress.at(-1)?.matchesDone).toBe(progress[0]?.matchesTotal);
      let seen = -1;
      for (const step of progress) {
        expect(step.matchesTotal).toBe(progress[0]?.matchesTotal);
        expect(step.matchesDone).toBeGreaterThan(seen);
        seen = step.matchesDone;
      }

      const result = doneOf(res);
      expect(result.approved).toBe(true);
      expect(result.meta).toMatchObject({ name: expect.any(String), version: expect.any(Number) });
      expect(staticCheck(result.source ?? '').ok).toBe(true);
      // An approved result ships a strategy, so there is nothing to fall back to.
      expect(result.fallback).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it('carries a Gate 1 rejection to the client verbatim, then approves (spec AC 6)', async () => {
    // `runCoder` pre-checks its own file and gets one free `staticCheck` self-retry,
    // so a Gate 1 rejection only reaches the harness when the model repeats itself.
    const usesDate = asCoderReply(readHarnessFixture('uses-date'));
    const provider = scriptedProvider([usesDate, usesDate, APPROVED()]);
    const server = await startServer({ provider });
    try {
      const res = await postRewrite(server.url, requestBody());

      const verdicts = eventsOf(res.events, 'verdict');
      expect(verdicts.map((v) => v.approved)).toEqual([false, true]);

      const rejected = eventsOf(res.events, 'trial.gate')
        .map((e) => e.gate as { gate: number; ok: boolean; reason?: string })
        .find((g) => !g.ok);
      expect(rejected?.gate).toBe(1);
      // The sentence the player reads. Spec §4.4 / AC 8: rejected before it runs.
      expect(rejected?.reason).toMatch(/Date/);
      // The same sentence is on the attempt log the client gets in `done`.
      const result = doneOf(res);
      expect(result.approved).toBe(true);
      expect(result.attempts).toHaveLength(2);
      expect(result.attempts[0]?.reason).toBe(rejected?.reason);
    } finally {
      await server.close();
    }
  });
});

describe('POST /api/rewrite — every ending ships a boss', () => {
  it('attaches a pre-approved fallback when the attempts run out', async () => {
    // `chaser` is valid and fast but wins ~0.78 against the panel: Gate 3, too hard,
    // every time. Two attempts rather than four — the reason is the same and the
    // suite has 20 seconds for everything.
    const provider = scriptedProvider([asCoderReply(readGood('chaser'))]);
    const server = await startServer({ provider, maxAttempts: 2 });
    try {
      const res = await postRewrite(server.url, requestBody());

      expect(eventsOf(res.events, 'verdict').map((v) => v.approved)).toEqual([false, false]);
      const fallback = eventsOf(res.events, 'fallback');
      expect(fallback).toHaveLength(1);
      expect(fallback[0]?.reason).toBe('max-attempts');

      const result = doneOf(res);
      expect(result.approved).toBe(false);
      expect(result.reason).toBe('max-attempts');
      // The server-side addition to `RewriteResult` (see `src/events.ts`): the
      // client can start round 2 from this frame alone.
      expect(result.fallback?.name).toBeTruthy();
      expect(staticCheck(result.fallback?.source ?? '').ok).toBe(true);
      expect(result.fallback?.source).toMatch(/export function decide/);
    } finally {
      await server.close();
    }
  });

  it('falls back visibly when the deadline passes (spec AC 5)', async () => {
    // A model that never answers. 150 ms instead of 40 s, but the path is the one
    // AC 5 promises: "falls back visibly … in ≤ 50 s".
    const provider = scriptedProvider([APPROVED()], { stall: true });
    const server = await startServer({ provider, deadlineMs: 150, graceMs: 5_000 });
    try {
      const res = await postRewrite(server.url, requestBody());

      expect(res.status).toBe(200);
      const fallback = eventsOf(res.events, 'fallback');
      expect(fallback[0]?.reason).toBe('deadline');

      const result = doneOf(res);
      expect(result).toMatchObject({ approved: false, reason: 'deadline' });
      // Nothing was generated, so nothing was gated — and the player still gets a
      // boss out of the frame.
      expect(result.attempts).toHaveLength(0);
      expect(staticCheck(result.fallback?.source ?? '').ok).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('runs fallback-only with no API key, and says so (spec AC 1)', async () => {
    // No `provider` and an empty env: exactly a fresh clone with no `.env`.
    const server = await startServer();
    try {
      const res = await postRewrite(server.url, requestBody());

      expect(res.status).toBe(200);
      // Still a well-formed stream: the interlude needs no second code path.
      const types = res.events.map((e) => e.type);
      expect(types[0]).toBe('replay');
      expect(types.at(-1)).toBe('done');
      expect(types).toContain('analysis.done');
      expect(types).toContain('fallback');
      // No gates ran, because nothing was generated. Honesty over decoration.
      expect(eventsOf(res.events, 'trial.gate')).toHaveLength(0);

      const analysis = payload<{ analysis: { observations: string[] } }>(
        eventsOf(res.events, 'analysis.done')[0],
      );
      expect(analysis.analysis.observations[0]).toBe(NO_KEY_MESSAGE);
      // The streamed deltas carry the same sentence, so the panel types it out.
      const streamed = eventsOf(res.events, 'analysis.delta')
        .map((e) => e.delta as string)
        .join('');
      expect(streamed).toContain(NO_KEY_MESSAGE);

      const result = doneOf(res);
      expect(result).toMatchObject({ approved: false, reason: 'error', message: 'no api key' });
      expect(staticCheck(result.fallback?.source ?? '').ok).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('picks the same fallback for the same seed, and `GET /api/fallback` agrees', async () => {
    const server = await startServer();
    try {
      const body = requestBody({ seed: 12345 });
      const [a, b] = await Promise.all([
        postRewrite(server.url, body),
        postRewrite(server.url, body),
      ]);
      const nameOf = (res: StreamResult): string => doneOf(res).fallback?.name ?? '(none)';
      expect(nameOf(a)).toBe(nameOf(b));

      // The same pick is available as a plain GET, for a client that lost the frame.
      const direct = (await (await fetch(`${server.url}/api/fallback/2?seed=12345`)).json()) as {
        name: string;
        source: string;
      };
      expect(direct.name).toBe(nameOf(a));
    } finally {
      await server.close();
    }
  });
});

describe('POST /api/rewrite — the client leaving', () => {
  it('aborts the in-flight model call when the client disconnects', async () => {
    // The Analyst stalls forever. A real provider does the same thing when the
    // model is slow, and this is the case that costs money if nothing cancels it.
    const provider = scriptedProvider([APPROVED()], { stall: true });
    const server = await startServer({ provider, deadlineMs: 60_000 });
    const controller = new AbortController();
    try {
      const pending = postRewrite(server.url, requestBody(), { signal: controller.signal });
      // Wait for the provider to actually be called, so the abort has something to
      // interrupt rather than racing the request.
      await vi.waitUntil(() => provider.signals.length > 0, { timeout: 5_000 });
      expect(provider.signals[0]?.aborted).toBe(false);

      controller.abort();
      await expect(pending).rejects.toThrow();

      // The signal the *provider* was handed is aborted — the disconnect reached
      // the thing that spends tokens, not just the socket.
      await vi.waitUntil(() => provider.signals[0]?.aborted === true, { timeout: 5_000 });
    } finally {
      await server.close();
    }
  });
});
