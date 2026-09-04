/**
 * Source selection and the SSE source's failure modes.
 *
 * The rules being pinned here are the ones that decide whether a demo works at all:
 *
 * - `?agent=mock` always plays the mock, so the demo has a switch that cannot fail.
 * - `?agent=recorded` plays a recorded real run, and `?run=` picks which.
 * - A local dev server with no API server behind it plays the mock by default.
 * - A deployed build talks to the server.
 * - A *mid-stream* failure ends visibly (`fallback` + `done`, spec AC 5) rather than
 *   hanging; a failure *before the first event* is reported as
 *   `SourceUnavailableError`, which is what lets `pnpm dev` fall through to the mock
 *   instead of showing a jury an error.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { serverFallbackPick, type RewriteEvent, type RewriteResult } from '../src/interlude/events.ts';
import {
  bootProbeLocalServer,
  LIVE_FALLBACK_BADGE,
  probeHealth,
  resolveSource,
  SourceUnavailableError,
  sseSource,
  withFallbackSource,
  type LocalProbeOutcome,
  type RewriteRequest,
} from '../src/interlude/source.ts';

/**
 * Enough of a `ReplaySummary` for the mock's canned analysis to be built from it —
 * the fall-through test really does play the whole mock run.
 */
const request = {
  round: 2,
  summary: {
    seed: 1,
    strategy: { name: 'Cornerbreaker', rationale: 'y', version: 1 },
    outcome: 'playerWon',
    durations: { ticks: 1800, seconds: 30, firstBossHitTick: 60, firstPlayerHitTick: 300 },
    player: { hpStart: 6, hpEnd: 2, dashes: 9, shots: 200, damageTaken: 4 },
    boss: { hpStart: 100, hpEnd: 0, damageTaken: 100, primitives: { move: 900, burst: 12, charge: 0, slam: 6, spawn: 2 }, minionsSpawned: 2, damageToMinions: 6 },
    history: {
      playerPosHeat: new Array<number>(64).fill(1 / 64),
      playerDashDirs: [1, 1, 1, 1, 3, 1, 1, 0],
      playerShotsDuring: { move: 150, burst: 30, charge: 0, slam: 18, spawn: 2 },
    },
    contract: { violations: 0, strategyKilled: false, droppedEvents: 0 },
    timeline: [{ tick: 10, kind: 'playerShot' }],
    timelineTotal: 400,
  },
  prevSource: 'export const meta = {};',
  prevMeta: { name: 'Cornerbreaker', rationale: 'y', version: 1 },
  seed: 7,
} as unknown as RewriteRequest;

/** A `fetch` stub returning an event stream built from the given text. */
function streamResponse(body: string, init: { status?: number } = {}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
  return new Response(stream, {
    status: init.status ?? 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function frame(event: RewriteEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveSource', () => {
  it('forces the mock on ?agent=mock, whatever the host says', () => {
    expect(resolveSource({ search: '?agent=mock', hostname: 'rematch.vercel.app', apiBase: 'https://api' }).kind).toBe('mock');
  });

  it('forces a recorded run on ?agent=recorded, whatever the host says', () => {
    // The demo URL must not depend on where it is opened, and it must never be
    // silently upgraded to a live run — `recorded` is the mode that costs nothing.
    for (const hostname of ['localhost', 'rematch.vercel.app']) {
      expect(resolveSource({ search: '?agent=recorded', hostname, apiBase: 'https://api' }).kind).toBe('recorded');
    }
  });

  it('passes ?run= through to the recorded source, and ?speed= with it', async () => {
    // Asserted through the fetch the source makes, because which file it asks for is
    // the only externally visible consequence of `?run=`.
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 404 }));
    const { source, kind, speed } = resolveSource({
      search: '?agent=recorded&run=kiter-a&speed=20',
      hostname: 'localhost',
      recorded: { baseUrl: '/', fetchImpl: fetchMock as unknown as typeof fetch },
    });
    expect(kind).toBe('recorded');
    expect(speed).toBe(20);

    await expect(source(request, () => {}, new AbortController().signal)).rejects.toThrow(/HTTP 404/);
    expect(String((fetchMock.mock.calls[0] as [string])[0])).toBe('/recorded/kiter-a.json');
  });

  it('asks index.json for the default run when ?run= is absent', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ runs: [] }), { status: 200 }));
    const { source } = resolveSource({
      search: '?agent=recorded',
      hostname: 'localhost',
      recorded: { baseUrl: '/', fetchImpl: fetchMock as unknown as typeof fetch },
    });
    await expect(source(request, () => {}, new AbortController().signal)).rejects.toThrow(/lists no runs/);
    expect(String((fetchMock.mock.calls[0] as [string])[0])).toBe('/recorded/index.json');
  });

  it('defaults to the mock on localhost with no configured API base and no boot probe', () => {
    // `localProbe` absent — the probe never ran, or hasn't settled — is exactly
    // like a probe that came back against the server: the pre-probe behaviour,
    // unchanged.
    for (const hostname of ['localhost', '127.0.0.1', '::1']) {
      expect(resolveSource({ search: '', hostname, apiBase: undefined }).kind).toBe('mock');
    }
  });

  it('uses the server when deployed, or when VITE_API_BASE is set — no probe involved', () => {
    expect(resolveSource({ search: '', hostname: 'rematch.vercel.app', apiBase: undefined }).kind).toBe('sse');
    expect(resolveSource({ search: '', hostname: 'localhost', apiBase: '' }).kind).toBe('sse');
    expect(resolveSource({ search: '', hostname: 'localhost', apiBase: 'http://localhost:8787' }).kind).toBe('sse');
    // Even a `localProbe` that says "no server there" is irrelevant on these rows:
    // they already have an unambiguous answer and never consult it.
    expect(
      resolveSource({ search: '', hostname: 'rematch.vercel.app', apiBase: undefined, localProbe: { useServer: false, reason: 'x' } })
        .kind,
    ).toBe('sse');
    expect(resolveSource({ search: '', hostname: 'localhost', apiBase: '', localProbe: { useServer: false, reason: 'x' } }).kind).toBe(
      'sse',
    );
  });

  it('reads the mock speed from ?speed=', () => {
    expect(resolveSource({ search: '?agent=mock&speed=20', hostname: 'localhost' }).speed).toBe(20);
    expect(resolveSource({ search: '?agent=mock', hostname: 'localhost' }).speed).toBe(1);
    // Nonsense is ignored rather than turned into a division by zero.
    expect(resolveSource({ search: '?agent=mock&speed=0', hostname: 'localhost' }).speed).toBe(1);
    expect(resolveSource({ search: '?agent=mock&speed=abc', hostname: 'localhost' }).speed).toBe(1);
  });

  it('falls through to the mock when the server is unreachable, and says so', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const switches: Array<{ kind: string; why: string }> = [];
    const { source, kind } = resolveSource(
      { search: '?speed=5000', hostname: 'localhost', apiBase: 'http://localhost:9999' },
      (k, why) => void switches.push({ kind: k, why }),
    );
    expect(kind).toBe('sse');

    const events: RewriteEvent[] = [];
    await source(request, (e) => void events.push(e), new AbortController().signal);

    // The badge flipped, and the player still got a whole run.
    expect(switches).toHaveLength(1);
    expect(switches[0]?.kind).toBe('mock');
    expect(switches[0]?.why).toContain('could not reach the rewrite service');
    expect(events[0]?.type).toBe('replay');
    const last = events.at(-1);
    expect(last?.type).toBe('done');
    if (last?.type === 'done') expect(last.result.approved).toBe(true);
  });

  it('does not silently substitute the mock when the URL asked for the server', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const { source, kind } = resolveSource({ search: '?agent=sse', hostname: 'localhost' });
    expect(kind).toBe('sse');
    await expect(source(request, () => {}, new AbortController().signal)).rejects.toBeInstanceOf(SourceUnavailableError);
  });

  describe('consulting a settled boot probe (localProbe)', () => {
    const base = { search: '', hostname: 'localhost', apiBase: undefined } as const;

    it('plays the server, badge LIVE, when the probe found a working provider', () => {
      const { kind, note } = resolveSource({ ...base, localProbe: { useServer: true, fallbackOnly: false } });
      expect(kind).toBe('sse');
      expect(note).toBeUndefined();
    });

    it('still plays the server, but badges it fallback-only, when the probe found no working provider', () => {
      // Streaming the server's own honest fallback-only path is more truthful than
      // the mock's scripted one — so this is SSE, not a reason to default to mock.
      const { kind, note } = resolveSource({ ...base, localProbe: { useServer: true, fallbackOnly: true } });
      expect(kind).toBe('sse');
      expect(note).toBe(LIVE_FALLBACK_BADGE);
    });

    it('plays the mock when the probe came back against the server', () => {
      const { kind, note } = resolveSource({ ...base, localProbe: { useServer: false, reason: 'could not reach /api/health: timed out' } });
      expect(kind).toBe('mock');
      expect(note).toBeUndefined();
    });

    it('ignores a probe outcome on a forced ?agent=, whichever way it went', () => {
      expect(resolveSource({ search: '?agent=mock', hostname: 'localhost', localProbe: { useServer: true, fallbackOnly: false } }).kind).toBe(
        'mock',
      );
      expect(resolveSource({ search: '?agent=sse', hostname: 'localhost', localProbe: { useServer: false, reason: 'x' } }).kind).toBe(
        'sse',
      );
    });

    it('keeps the "SSE failed before first event → mock" safety net for a probed server too', async () => {
      // The boot probe answers "was a server there a moment ago", not "is one there
      // right now" — the same failure-before-first-event safety net still has to
      // catch it going away in between.
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
      const switches: Array<{ kind: string; why: string }> = [];
      const { source, kind } = resolveSource(
        { ...base, search: '?speed=5000', localProbe: { useServer: true, fallbackOnly: false } },
        (k, why) => void switches.push({ kind: k, why }),
      );
      expect(kind).toBe('sse');

      const events: RewriteEvent[] = [];
      await source(request, (e) => void events.push(e), new AbortController().signal);

      expect(switches).toHaveLength(1);
      expect(switches[0]?.kind).toBe('mock');
      const last = events.at(-1);
      expect(last?.type).toBe('done');
      if (last?.type === 'done') expect(last.result.approved).toBe(true);
    });
  });
});

describe('probeHealth', () => {
  it('reports a working provider', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, hasApiKey: true, provider: 'anthropic' }), { status: 200 }));
    await expect(probeHealth('', fetchMock as unknown as typeof fetch)).resolves.toEqual({ useServer: true, fallbackOnly: false });
    expect(fetchMock).toHaveBeenCalledWith('/api/health', expect.objectContaining({ signal: expect.anything() }));
  });

  it('reports fallback-only when there is no API key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, hasApiKey: false, provider: 'anthropic' }), { status: 200 }));
    await expect(probeHealth('', fetchMock as unknown as typeof fetch)).resolves.toEqual({ useServer: true, fallbackOnly: true });
  });

  it('reports fallback-only when the provider is "none"', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, hasApiKey: true, provider: 'none' }), { status: 200 }));
    await expect(probeHealth('', fetchMock as unknown as typeof fetch)).resolves.toEqual({ useServer: true, fallbackOnly: true });
  });

  it('reports useServer: false on a non-2xx response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('nope', { status: 500 }));
    await expect(probeHealth('', fetchMock as unknown as typeof fetch)).resolves.toEqual({
      useServer: false,
      reason: '/api/health answered 500',
    });
  });

  it('reports useServer: false on a body without ok: true', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ nope: true }), { status: 200 }));
    const result = await probeHealth('', fetchMock as unknown as typeof fetch);
    expect(result.useServer).toBe(false);
  });

  it('reports useServer: false, never throws, when fetch itself rejects', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const result = await probeHealth('', fetchMock as unknown as typeof fetch);
    expect(result).toEqual({ useServer: false, reason: 'could not reach /api/health: Failed to fetch' });
  });

  it('aborts and reports useServer: false when the server never answers within timeoutMs', async () => {
    // A realistic `fetch`: it settles only when its abort signal fires, exactly
    // like the browser's. `timeoutMs` is 15 here purely so the test is fast — the
    // production default (`LOCAL_PROBE_TIMEOUT_MS`) is asserted separately below.
    const fetchMock = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
    );
    const result = await probeHealth('', fetchMock as unknown as typeof fetch, 15);
    expect(result).toEqual({ useServer: false, reason: 'could not reach /api/health: no response within 15ms' });
  });

  it('defaults its timeout to LOCAL_PROBE_TIMEOUT_MS', async () => {
    const fetchMock = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
    );
    const result = await probeHealth('', fetchMock as unknown as typeof fetch);
    expect(result).toEqual({ useServer: false, reason: 'could not reach /api/health: no response within 1500ms' });
  });
});

describe('bootProbeLocalServer', () => {
  it('skips the network entirely when a forced ?agent= already answers the question', async () => {
    const fetchMock = vi.fn();
    for (const search of ['?agent=mock', '?agent=recorded', '?agent=sse', '?agent=server']) {
      await expect(bootProbeLocalServer({ search, hostname: 'localhost' }, fetchMock as unknown as typeof fetch)).resolves.toBeNull();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips the network when VITE_API_BASE is configured', async () => {
    const fetchMock = vi.fn();
    await expect(
      bootProbeLocalServer({ search: '', hostname: 'localhost', apiBase: 'http://localhost:8787' }, fetchMock as unknown as typeof fetch),
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips the network on a non-local host — already a decided SSE row', async () => {
    const fetchMock = vi.fn();
    await expect(
      bootProbeLocalServer({ search: '', hostname: 'rematch.vercel.app', apiBase: undefined }, fetchMock as unknown as typeof fetch),
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('probes and says nothing when the server answers ok', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, hasApiKey: true, provider: 'anthropic' }), { status: 200 }));
    const result = await bootProbeLocalServer({ search: '', hostname: 'localhost', apiBase: undefined }, fetchMock as unknown as typeof fetch);
    expect(result).toEqual({ useServer: true, fallbackOnly: false });
    expect(infoSpy).not.toHaveBeenCalled();
    infoSpy.mockRestore();
  });

  it('probes, decides mock, and logs exactly one explanatory line when the server is unreachable', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const result = await bootProbeLocalServer({ search: '', hostname: 'localhost', apiBase: undefined }, fetchMock as unknown as typeof fetch);
    expect(result).toEqual({ useServer: false, reason: 'could not reach /api/health: Failed to fetch' });
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0]?.[0]).toContain('Failed to fetch');
    infoSpy.mockRestore();
  });

  it('probes, decides mock, and logs when the server times out', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const fetchMock = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
    );
    const result = await bootProbeLocalServer(
      { search: '', hostname: 'localhost', apiBase: undefined },
      fetchMock as unknown as typeof fetch,
      15,
    );
    expect(result).toEqual({ useServer: false, reason: 'could not reach /api/health: no response within 15ms' });
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0]?.[0]).toContain('no response within 15ms');
    infoSpy.mockRestore();
  });

  it('does not log when the server is reachable but fallback-only', async () => {
    // Fallback-only is still SSE (spec's more-truthful-than-the-mock rule) — the
    // console line is reserved for the "we defaulted to the mock" case only.
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, hasApiKey: false, provider: 'none' }), { status: 200 }));
    const result = await bootProbeLocalServer({ search: '', hostname: 'localhost', apiBase: undefined }, fetchMock as unknown as typeof fetch);
    expect(result).toEqual({ useServer: true, fallbackOnly: true });
    expect(infoSpy).not.toHaveBeenCalled();
    infoSpy.mockRestore();
  });
});

describe('sseSource', () => {
  it('POSTs the request to /api/rewrite as JSON and asks for an event stream', async () => {
    const fetchMock = vi.fn().mockResolvedValue(streamResponse(frame({ type: 'analysis.delta', delta: 'hi' })));
    vi.stubGlobal('fetch', fetchMock);

    const events: RewriteEvent[] = [];
    await sseSource('http://localhost:8787/')(request, (e) => void events.push(e), new AbortController().signal);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // The trailing slash on the base must not double up.
    expect(url).toBe('http://localhost:8787/api/rewrite');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'content-type': 'application/json', accept: 'text/event-stream' });
    expect(JSON.parse(String(init.body))).toEqual(request);
    expect(events).toEqual([{ type: 'analysis.delta', delta: 'hi' }]);
  });

  it('delivers every event in the stream, in order', async () => {
    const sequence: RewriteEvent[] = [
      { type: 'analysis.delta', delta: 'a' },
      { type: 'rewrite.done', attempt: 1, source: 'x', diff: 'd' },
      { type: 'verdict', attempt: 1, approved: false, reason: 'too hard' },
      { type: 'done', result: { approved: false, attempts: [], reason: 'max-attempts' } },
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse(`: hello\n\n${sequence.map(frame).join('')}`)));

    const events: RewriteEvent[] = [];
    await sseSource('')(request, (e) => void events.push(e), new AbortController().signal);
    expect(events).toEqual(sequence);
  });

  it('drops a malformed frame and an unknown event type without ending the run', async () => {
    const body =
      'event: junk\ndata: {not json\n\n' +
      'event: future.beat\ndata: {"type":"future.beat"}\n\n' +
      frame({ type: 'done', result: { approved: false, attempts: [], reason: 'error' } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse(body)));

    const events: RewriteEvent[] = [];
    await sseSource('')(request, (e) => void events.push(e), new AbortController().signal);
    expect(events).toEqual([{ type: 'done', result: { approved: false, attempts: [], reason: 'error' } }]);
  });

  it('reports an unreachable service as unavailable, before the first event', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(sseSource('')(request, () => {}, new AbortController().signal)).rejects.toBeInstanceOf(SourceUnavailableError);
  });

  it('reports an HTTP error, with the body, as unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('no api key configured', { status: 500 })));
    await expect(sseSource('')(request, () => {}, new AbortController().signal)).rejects.toThrow(/answered 500: no api key configured/);
  });

  it('treats an immediately closed stream as unavailable, not as a finished run', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse('')));
    await expect(sseSource('')(request, () => {}, new AbortController().signal)).rejects.toBeInstanceOf(SourceUnavailableError);
  });

  it('turns a MID-stream failure into a visible ending, never a hang (spec AC 5)', async () => {
    // The server said something, *then* the connection broke. The chunk is queued
    // on the first `pull` and the error raised on the second, because
    // `controller.error()` discards anything still in the queue — enqueueing and
    // erroring in one `start` would test the wrong thing (a stream that delivered
    // nothing), which is the `unavailable` case above.
    let step = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (step === 0) {
          step = 1;
          controller.enqueue(new TextEncoder().encode(frame({ type: 'analysis.delta', delta: 'partial' })));
          return;
        }
        controller.error(new Error('network error'));
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, { status: 200 })));

    const events: RewriteEvent[] = [];
    await sseSource('')(request, (e) => void events.push(e), new AbortController().signal);

    expect(events.map((e) => e.type)).toEqual(['analysis.delta', 'fallback', 'done']);
    const last = events.at(-1);
    if (last?.type !== 'done') throw new Error('expected done');
    expect(last.result.approved).toBe(false);
    if (!last.result.approved) expect(last.result.reason).toBe('error');
  });

  it('says nothing at all when the caller aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' })));

    const events: RewriteEvent[] = [];
    await expect(sseSource('')(request, (e) => void events.push(e), controller.signal)).resolves.toBeUndefined();
    expect(events).toEqual([]);
  });
});

describe('withFallbackSource', () => {
  it('runs the secondary only when the primary never started', async () => {
    const secondary = vi.fn(async () => {});
    const unavailable = async (): Promise<void> => {
      throw new SourceUnavailableError('nothing there');
    };
    await withFallbackSource(unavailable, secondary)(request, () => {}, new AbortController().signal);
    expect(secondary).toHaveBeenCalledTimes(1);
  });

  it('lets any other error through, so a real bug is not hidden behind a mock', async () => {
    const secondary = vi.fn(async () => {});
    const broken = async (): Promise<void> => {
      throw new TypeError('a genuine bug');
    };
    await expect(
      withFallbackSource(broken, secondary)(request, () => {}, new AbortController().signal),
    ).rejects.toThrow('a genuine bug');
    expect(secondary).not.toHaveBeenCalled();
  });
});

describe('serverFallbackPick', () => {
  it('reads the pool entry the server attaches to a non-approved done', () => {
    // `@rematch/server` widens the terminal `done` with `result.fallback` so the
    // client can start the round from that frame alone (spec AC 5, no second
    // request). The field is the server's, so the client reads it structurally.
    expect(
      serverFallbackPick({
        approved: false,
        attempts: [],
        reason: 'max-attempts',
        fallback: { name: 'metronome', source: 'export const meta = {};' },
      } as unknown as RewriteResult),
    ).toEqual({ name: 'metronome', source: 'export const meta = {};' });
  });

  it('returns null when there is nothing usable — the mock, or an older server', () => {
    const cases: unknown[] = [
      { approved: false, attempts: [], reason: 'deadline' },
      { approved: false, attempts: [], reason: 'deadline', fallback: null },
      { approved: false, attempts: [], reason: 'deadline', fallback: { name: 'x' } },
      { approved: false, attempts: [], reason: 'deadline', fallback: { name: 'x', source: '   ' } },
      { approved: true, source: 'x', meta: {}, attempts: [], analysis: {} },
    ];
    for (const result of cases) expect(serverFallbackPick(result as RewriteResult)).toBeNull();
  });
});
