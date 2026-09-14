/**
 * The build-time default source: `VITE_DEFAULT_AGENT`.
 *
 * The deployed product is a static site with no `/api/rewrite` behind it. Without a
 * build default, `resolveSource`'s host rule reads "not local ⇒ SSE", so the first
 * interlude on the published site would POST at the static host, take a 404, and
 * fall through to the mock — scripted output wearing no label that says so. Building
 * with `VITE_DEFAULT_AGENT=recorded` puts the recorded real run there instead, badged
 * `RECORDED RUN · <model> · <date>`.
 *
 * What is pinned here is the precedence, because that is the part a demo depends on:
 *
 * - `?agent=` always wins — the URL switch keeps working on the deployed build;
 * - a default of `recorded`/`mock` decides without ever touching the network;
 * - a default of `sse`, an unrecognised value, or none leaves every existing row
 *   exactly as it was;
 * - `localDefaultApplies` (observed through `bootProbeLocalServer`, which returns
 *   `null` without probing when the row does not apply) never disagrees with
 *   `resolveSource` about which row applies.
 *
 * Options are injected rather than stubbed onto `location`/`import.meta.env`, the
 * same way the rest of `interlude-select.test.ts` does it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { bootProbeLocalServer, resolveSource, type RewriteRequest } from '../src/interlude/source.ts';

/** The deployed shape: a real host, no configured base, nothing forced in the URL. */
const deployed = { search: '', hostname: 'rematch.vercel.app', apiBase: undefined } as const;

const request = { round: 2, seed: 7 } as unknown as RewriteRequest;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('VITE_DEFAULT_AGENT', () => {
  it('plays the recorded run on a deployed host, instead of POSTing at a static site', async () => {
    // The regression this exists to stop: `kind: 'sse'` here means the published
    // build tries a server that is not there.
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ runs: [] }), { status: 200 }));
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no request should reach the network'))));

    const { source, kind } = resolveSource({
      ...deployed,
      defaultAgent: 'recorded',
      recorded: { baseUrl: '/', fetchImpl: fetchMock as unknown as typeof fetch },
    });
    expect(kind).toBe('recorded');

    // Running it asks for the recorded index — no `/api/rewrite` anywhere.
    await expect(source(request, () => {}, new AbortController().signal)).rejects.toThrow(/lists no runs/);
    expect(String((fetchMock.mock.calls[0] as [string])[0])).toBe('/recorded/index.json');
    expect(fetchMock.mock.calls.every((call) => !String((call as [string])[0]).includes('/api/'))).toBe(true);
  });

  it('still honours ?run= under the default, same as ?agent=recorded does', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 404 }));
    const { source, kind, speed } = resolveSource({
      ...deployed,
      search: '?run=kiter-a&speed=20',
      defaultAgent: 'recorded',
      recorded: { baseUrl: '/', fetchImpl: fetchMock as unknown as typeof fetch },
    });
    expect(kind).toBe('recorded');
    expect(speed).toBe(20);

    await expect(source(request, () => {}, new AbortController().signal)).rejects.toThrow(/HTTP 404/);
    expect(String((fetchMock.mock.calls[0] as [string])[0])).toBe('/recorded/kiter-a.json');
  });

  it('loses to ?agent=mock — the URL switch keeps working on the deployed build', () => {
    expect(resolveSource({ ...deployed, search: '?agent=mock', defaultAgent: 'recorded' }).kind).toBe('mock');
  });

  it('loses to ?agent=sse and ?agent=server, which still force the server with no safety net', () => {
    for (const agent of ['sse', 'server']) {
      expect(resolveSource({ ...deployed, search: `?agent=${agent}`, defaultAgent: 'recorded' }).kind).toBe('sse');
    }
    // …and on localhost too, where the default would otherwise have answered first.
    expect(resolveSource({ search: '?agent=sse', hostname: 'localhost', apiBase: undefined, defaultAgent: 'recorded' }).kind).toBe('sse');
  });

  it('loses to ?agent=recorded when the default is mock', () => {
    expect(resolveSource({ ...deployed, search: '?agent=recorded', defaultAgent: 'mock' }).kind).toBe('recorded');
  });

  it('plays the mock when the default is mock, on any host', () => {
    expect(resolveSource({ ...deployed, defaultAgent: 'mock' }).kind).toBe('mock');
    expect(resolveSource({ search: '', hostname: 'localhost', apiBase: 'https://api', defaultAgent: 'mock' }).kind).toBe('mock');
  });

  it('changes nothing when it is unset, a value it does not know, or sse', () => {
    // `sse` means "decide as you always did" — it is not a way to force the server.
    for (const defaultAgent of [undefined, '', 'RECORDED', 'live', 'sse']) {
      expect(resolveSource({ ...deployed, defaultAgent }).kind, String(defaultAgent)).toBe('sse');
      expect(resolveSource({ search: '', hostname: 'localhost', apiBase: undefined, defaultAgent }).kind, String(defaultAgent)).toBe(
        'mock',
      );
    }
  });

  it('does not swallow an unrecognised ?agent=, which stays as good as absent', () => {
    // `?agent=banana` has never forced anything; the default answers it, and
    // `localDefaultApplies` agrees (asserted below).
    expect(resolveSource({ ...deployed, search: '?agent=banana', defaultAgent: 'recorded' }).kind).toBe('recorded');
  });

  describe('agreement with the boot probe', () => {
    // `bootProbeLocalServer` returns `null` without probing exactly when
    // `localDefaultApplies` is false, so it is how that private predicate is observed.
    const local = { search: '', hostname: 'localhost', apiBase: undefined } as const;
    const never = (): never => {
      throw new Error('the probe must not run');
    };

    it('skips the probe when the build default already decided (recorded, mock)', async () => {
      for (const defaultAgent of ['recorded', 'mock']) {
        await expect(
          bootProbeLocalServer({ ...local, defaultAgent }, never as unknown as typeof fetch),
          defaultAgent,
        ).resolves.toBeNull();
      }
    });

    it('still probes when the default is sse, unset, or unrecognised — those rows still need it', async () => {
      // A fresh `Response` per call: a body can only be read once.
      const fetchMock = vi.fn(
        async () => new Response(JSON.stringify({ ok: true, hasApiKey: true, provider: 'anthropic' }), { status: 200 }),
      );
      for (const defaultAgent of ['sse', undefined, 'banana']) {
        await expect(bootProbeLocalServer({ ...local, defaultAgent }, fetchMock as unknown as typeof fetch)).resolves.toEqual({
          useServer: true,
          fallbackOnly: false,
        });
      }
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('skips the probe on a forced ?agent=, default or no default', async () => {
      for (const search of ['?agent=mock', '?agent=recorded', '?agent=sse', '?agent=server']) {
        await expect(
          bootProbeLocalServer({ ...local, search, defaultAgent: 'recorded' }, never as unknown as typeof fetch),
          search,
        ).resolves.toBeNull();
      }
    });
  });
});
