/**
 * The recorded source, and the timeline arithmetic behind it.
 *
 * What is worth pinning here is everything that could make the recorded mode *lie* or
 * *hang*, because those are the two failures a demo cannot survive:
 *
 * - the badge names the run's own model and date, never a hardcoded string;
 * - the events come out in stream order with the recorded gaps, divided by `speed`;
 * - a non-monotonic or truncated file still plays forward rather than stalling;
 * - the terminal `done` still carries the approved `source`, which is what the next
 *   round loads through QuickJS;
 * - an unreachable or empty file **throws** instead of silently becoming the mock.
 *
 * The last one is the important one. `sseSource` deliberately falls through to the
 * mock when there is no server; `recordedSource` deliberately does not, because its
 * asset is committed to this repo and a badge reading `RECORDED RUN` above scripted
 * mock output would be worse than an error.
 *
 * Timing here is asserted on the *delays*, not by waiting: `delaysOf` is pure, so the
 * cadence is arithmetic and the replay test runs at speed 10 000.
 */
import { describe, expect, it, vi } from 'vitest';

import type { RewriteEvent } from '../src/interlude/events.ts';
import {
  delaysOf,
  loadRecordedIndex,
  provenanceLabel,
  recordedSource,
  type RecordedFile,
  type RecordedHeader,
} from '../src/interlude/recorded.ts';
import { countRejections, verify } from '../scripts/record-run.ts';
import { buildTimeline } from '../scripts/timeline.ts';
import type { RewriteRequest } from '../src/interlude/source.ts';

const request = { round: 2, seed: 7 } as unknown as RewriteRequest;

const header: RecordedHeader = {
  provider: 'openai',
  model: 'gpt-5.4-mini',
  round: 2,
  archetype: 'camper',
  recordedAt: '2026-09-03T23:53:46.645Z',
  approved: true,
  attempts: 2,
};

/** A three-event recorded file: enough to be a run, small enough to read. */
function file(overrides: Partial<RecordedFile> = {}): RecordedFile {
  const events: RewriteEvent[] = [
    { type: 'analysis.delta', delta: 'camped' },
    { type: 'verdict', attempt: 1, approved: false, reason: '0.62 vs panel — too hard' },
    {
      type: 'done',
      result: {
        approved: true,
        source: 'export const meta = { name: "Warden I", rationale: "r", version: 1 };',
        meta: { name: 'Warden I', rationale: 'r', version: 1 },
        attempts: [],
        analysis: { observations: [], playerArchetype: 'camper', counterPlan: 'c' },
      },
    },
  ];
  return { ...header, at: [0, 1000, 2500], events, ...overrides };
}

/** A `fetch` stub that answers `recorded/*.json` from a map of bodies. */
function stubFetch(bodies: Record<string, unknown>): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string) => {
    const key = Object.keys(bodies).find((name) => url.endsWith(name));
    if (key === undefined) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(bodies[key]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

describe('provenanceLabel', () => {
  it('names the run’s own model and its recorded date', () => {
    // The whole honesty claim of the recorded mode is this one string, so it is built
    // from the file's header rather than from anything the client knows.
    expect(provenanceLabel(header)).toBe('RECORDED RUN · gpt-5.4-mini · 2026-09-03');
  });

  it('slices the ISO date rather than localising it', () => {
    // A timezone-dependent badge would put a different date in the video than in the
    // docs citing the same run.
    expect(provenanceLabel({ model: 'm', recordedAt: '2026-09-03T00:30:00.000Z' })).toContain('2026-09-03');
    expect(provenanceLabel({ model: 'm', recordedAt: '2026-09-03T23:59:59.999Z' })).toContain('2026-09-03');
  });
});

describe('delaysOf', () => {
  it('turns absolute offsets into inter-event gaps', () => {
    expect(delaysOf(file(), 1)).toEqual([0, 1000, 1500]);
  });

  it('divides every gap by speed, so 20x is the e2e suite’s ~1 s run', () => {
    expect(delaysOf(file(), 20)).toEqual([0, 50, 75]);
  });

  it('never returns a negative delay, even for a hand-edited non-monotonic file', () => {
    // A negative `setTimeout` would fire immediately anyway, but the guarantee worth
    // having is that the events still arrive in order rather than in a burst that
    // depends on the browser's timer coalescing.
    const delays = delaysOf(file({ at: [0, 5000, 1000] }), 1);
    expect(delays.every((d) => d >= 0)).toBe(true);
    expect(delays).toEqual([0, 5000, 0]);
  });

  it('plays the tail of a truncated `at` immediately rather than dropping it', () => {
    expect(delaysOf(file({ at: [0] }), 1)).toEqual([0, 0, 0]);
  });
});

describe('recordedSource', () => {
  it('replays every event in order and reports the header before the first one', async () => {
    const fetchMock = stubFetch({ 'mimic-camper.json': file() });
    const seen: RewriteEvent[] = [];
    const headers: Array<{ header: RecordedHeader; name: string }> = [];

    await recordedSource('mimic-camper', {
      speed: 10_000,
      baseUrl: '/',
      fetchImpl: fetchMock as unknown as typeof fetch,
      onHeader: (h, name) => void headers.push({ header: h, name }),
    })(request, (event) => void seen.push(event), new AbortController().signal);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as [string])[0])).toBe('/recorded/mimic-camper.json');
    expect(headers).toHaveLength(1);
    expect(headers[0]?.name).toBe('mimic-camper');
    expect(headers[0]?.header.model).toBe('gpt-5.4-mini');
    expect(seen.map((e) => e.type)).toEqual(['analysis.delta', 'verdict', 'done']);
  });

  it('ends with a done carrying the approved source the next round loads', async () => {
    // The recorded mode is not a video: `result.source` really goes through the
    // sandbox, which is what the e2e suite proves by reading the Round 2 boss's name
    // out of the loaded module.
    const seen: RewriteEvent[] = [];
    await recordedSource('mimic-camper', {
      speed: 10_000,
      baseUrl: '/',
      fetchImpl: stubFetch({ 'mimic-camper.json': file() }) as unknown as typeof fetch,
    })(request, (event) => void seen.push(event), new AbortController().signal);

    const last = seen.at(-1);
    if (last?.type !== 'done') throw new Error('expected a terminal done');
    expect(last.result.approved).toBe(true);
    if (last.result.approved) {
      expect(last.result.source).toContain('export const meta');
      expect(last.result.meta.name).toBe('Warden I');
    }
  });

  it('reads index.json and takes the first run when ?run= is absent', async () => {
    const fetchMock = stubFetch({
      'index.json': { runs: [{ name: 'mimic-camper', model: 'gpt-5.4-mini', recordedAt: header.recordedAt }] },
      'mimic-camper.json': file(),
    });
    const seen: RewriteEvent[] = [];

    await recordedSource(null, {
      speed: 10_000,
      baseUrl: '/',
      fetchImpl: fetchMock as unknown as typeof fetch,
    })(request, (event) => void seen.push(event), new AbortController().signal);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(seen).toHaveLength(3);
  });

  it('stops emitting the moment the caller aborts', async () => {
    const controller = new AbortController();
    const seen: RewriteEvent[] = [];
    // Real gaps this time, so the abort lands between events rather than after them.
    const promise = recordedSource('mimic-camper', {
      speed: 1,
      baseUrl: '/',
      fetchImpl: stubFetch({ 'mimic-camper.json': file() }) as unknown as typeof fetch,
    })(request, (event) => void seen.push(event), controller.signal);

    controller.abort();
    await expect(promise).resolves.toBeUndefined();
    expect(seen.length).toBeLessThan(3);
  });

  it('throws rather than substituting the mock when the file is missing', async () => {
    // The asset is committed, so a 404 is a broken build. Playing scripted mock output
    // under a `RECORDED RUN` badge would be the one dishonest thing on screen.
    await expect(
      recordedSource('nope', {
        baseUrl: '/',
        fetchImpl: stubFetch({}) as unknown as typeof fetch,
      })(request, () => {}, new AbortController().signal),
    ).rejects.toThrow(/HTTP 404/);
  });

  it('throws on a file with no events', async () => {
    await expect(
      recordedSource('empty', {
        baseUrl: '/',
        fetchImpl: stubFetch({ 'empty.json': file({ events: [] }) }) as unknown as typeof fetch,
      })(request, () => {}, new AbortController().signal),
    ).rejects.toThrow(/no events/);
  });
});

describe('loadRecordedIndex', () => {
  it('rejects an index that lists no runs', async () => {
    await expect(
      loadRecordedIndex({ baseUrl: '/', fetchImpl: stubFetch({ 'index.json': { runs: [] } }) as unknown as typeof fetch }),
    ).rejects.toThrow(/lists no runs/);
  });
});

describe('buildTimeline', () => {
  it('pins the measured durations and interpolates between them', () => {
    // The Analyst measured 3 000 ms and the gate 500 ms; the two deltas in between
    // carry no duration of their own and are spread across the Analyst's beat.
    const events: RewriteEvent[] = [
      { type: 'replay', summary: {} as never, round: 2 },
      { type: 'analysis.delta', delta: 'a' },
      { type: 'analysis.done', analysis: {} as never, calls: 1, promptChars: 10, usage: { inputTokens: 1, outputTokens: 1 }, ms: 3000 },
      { type: 'trial.gate', attempt: 1, gate: { gate: 1, name: 'static', ok: true, ms: 500 } },
      { type: 'done', result: { approved: false, attempts: [], reason: 'max-attempts' } },
    ];
    const { at, pinned, totalMs } = buildTimeline({ events, runMs: 3500 });

    expect(pinned).toBe(4);
    expect(totalMs).toBe(3500);
    expect(at[0]).toBe(0);
    // Halfway between the `replay` pin at 0 and the `analysis.done` pin at 3 000.
    expect(at[1]).toBeCloseTo(1500, 0);
    expect(at[2]).toBeCloseTo(3000, 0);
    expect(at[3]).toBeCloseTo(3500, 0);
    expect(at[4]).toBe(3500);
  });

  it('lands the last event exactly on the run’s real wall clock', () => {
    // The claim the demo makes is "this took as long as it really took", so the
    // reconstructed timeline is scaled onto `EvalRun.ms` rather than left to drift.
    const events: RewriteEvent[] = [
      { type: 'replay', summary: {} as never, round: 2 },
      { type: 'analysis.done', analysis: {} as never, calls: 1, promptChars: 1, usage: { inputTokens: 1, outputTokens: 1 }, ms: 1000 },
      { type: 'done', result: { approved: false, attempts: [], reason: 'deadline' } },
    ];
    expect(buildTimeline({ events, runMs: 23_542 }).totalMs).toBe(23_542);
  });

  it('pins each candidate’s rewrite.done at its own measured Coder time', () => {
    // Candidates stream concurrently and finish in their own order, so a single
    // attempt-level duration would collapse the tab strip's staggered arrival.
    const events: RewriteEvent[] = [
      { type: 'replay', summary: {} as never, round: 2 },
      { type: 'rewrite.delta', attempt: 1, delta: 'x', candidate: 0, candidates: 2 },
      { type: 'rewrite.done', attempt: 1, source: 's', diff: 'd', candidate: 0, candidates: 2 },
      { type: 'rewrite.done', attempt: 1, source: 's', diff: 'd', candidate: 1, candidates: 2 },
      { type: 'done', result: { approved: false, attempts: [], reason: 'deadline' } },
    ];
    const { at } = buildTimeline({
      events,
      runMs: 9000,
      attempts: [{ coder: { ms: 8000 }, candidates: [{ candidate: 0, coder: { ms: 6000 } }, { candidate: 1, coder: { ms: 9000 } }] }],
    });
    // Scaled onto 9 000 ms total, so candidate 0 lands at 6/9 of the run.
    expect(at[2]).toBeCloseTo(6000, 0);
    expect(at[3]).toBeCloseTo(9000, 0);
  });

  it('is monotonic and finite for every committed recorded asset', async () => {
    // The real files, checked as data: a non-monotonic `at[]` would make the demo
    // stutter, and a NaN would make it hang. Cheaper to assert than to watch.
    const { readdirSync, readFileSync } = await import('node:fs');
    const dir = new URL('../public/recorded/', import.meta.url);
    const names = readdirSync(dir).filter((n) => n.endsWith('.json') && n !== 'index.json');
    expect(names.length).toBeGreaterThan(0);

    for (const name of names) {
      const run = JSON.parse(readFileSync(new URL(name, dir), 'utf8')) as RecordedFile;
      expect(run.at, name).toHaveLength(run.events.length);
      expect(run.at.every((v) => Number.isFinite(v) && v >= 0), name).toBe(true);
      for (let i = 1; i < run.at.length; i += 1) {
        expect((run.at[i] as number) >= (run.at[i - 1] as number), `${name} at[${i}]`).toBe(true);
      }
      // Every recorded run is an approved one that shows the harness saying no first.
      expect(run.approved, name).toBe(true);
      expect(run.events.filter((e) => e.type === 'trial.gate' && !e.gate.ok).length, name).toBeGreaterThan(0);
      expect(run.events.at(-1)?.type, name).toBe('done');
    }
  });
});

describe('record-run: verify', () => {
  /**
   * The recorder greps the **finished bytes** rather than trusting its own pipeline.
   * These assets are published, so "I checked the code path" is a weaker claim than
   * "I checked the file", and this is the check that makes the stronger one.
   */
  it('refuses anything that looks like a credential or a prompt', () => {
    const cases: Array<[string, RegExp]> = [
      ['{"key":"sk-proj-abcdefghijklmnop"}', /sk- API key/],
      ['{"h":"Bearer abcdefghijklmnopqrst"}', /bearer token/],
      ['{"env":"OPENAI_API_KEY"}', /credential variable name/],
      ['{"env":"ANTHROPIC_AUTH_TOKEN"}', /credential variable name/],
      ['{"messages": [{"role":"user"}]}', /raw prompt field/],
      ['{"system": "You are the Coder"}', /raw prompt field/],
    ];
    for (const [json, why] of cases) {
      expect(() => verify(json, 'x.json'), json).toThrow(why);
    }
  });

  it('passes the real recorded assets, which is the case that matters', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const dir = new URL('../public/recorded/', import.meta.url);
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
      expect(() => verify(readFileSync(new URL(name, dir), 'utf8'), name), name).not.toThrow();
    }
  });

  it('does not trip on the words themselves — only on the shapes', () => {
    // `promptChars` is a count and belongs in the stream; a `sk-` inside prose is not
    // a key. A scanner that cried wolf would get switched off.
    expect(() => verify('{"promptChars": 5133, "raw": "the sk- prefix"}', 'x.json')).not.toThrow();
  });
});

describe('record-run: countRejections', () => {
  it('counts one per failing gate — the number a viewer sees in the log', () => {
    const events: RewriteEvent[] = [
      { type: 'trial.gate', attempt: 1, gate: { gate: 1, name: 'static', ok: true, ms: 1 } },
      { type: 'trial.gate', attempt: 1, gate: { gate: 3, name: 'balance', ok: false, ms: 900, reason: 'too easy' } },
      { type: 'trial.gate', attempt: 1, gate: { gate: 3, name: 'balance', ok: false, ms: 800, reason: 'too hard' } },
    ];
    expect(countRejections(events)).toBe(2);
  });

  it('agrees with what the e2e suite asserts on screen for mimic-camper', async () => {
    // The recorded default shows five rejected candidate files. If this number moves,
    // `e2e/recorded.spec.ts` is asserting a stale count.
    const { readFileSync } = await import('node:fs');
    const run = JSON.parse(
      readFileSync(new URL('../public/recorded/mimic-camper.json', import.meta.url), 'utf8'),
    ) as RecordedFile;
    expect(countRejections(run.events)).toBe(5);
  });
});
