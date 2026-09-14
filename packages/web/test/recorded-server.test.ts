/**
 * Recording a **server rewrite artifact**, which is how the live `claude-cli` runs of
 * 2026-09-11 reach the demo.
 *
 * `recorded-source.test.ts` covers the eval path and the replay itself; what is new
 * here is the second input shape and the one beat it brought with it:
 *
 * - the header is assembled from a file that names neither provider nor model, so the
 *   badge's two strings come from the command line and must arrive intact;
 * - `done.result.attempts` is emptied exactly as in the eval path, because the same
 *   ~80 KB of candidate files already rode the stream;
 * - the `calibrate.*` frames are **kept** — they are the Judge doing arithmetic in
 *   public, and the whole reason a 44 s run beats a 23 s one as the default;
 * - a `calibrate.step` is the only event nothing in the stream times, so it is charged
 *   a flat second and *counted* as an assumption rather than passed off as a reading.
 *
 * The committed assets are then checked as data, the same way the eval ones are: a
 * recorded file that lies about its own timing is worse than no recorded file.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { RewriteEvent } from '../src/interlude/events.ts';
import {
  CALIBRATE_STEP_MS,
  countAssumed,
  countRejections,
  pinnable,
  toRecordedServer,
  verify,
} from '../scripts/record-run.ts';

/** The two runs this suite is about, and the facts the evidence records about them. */
const RUNS = [
  { name: 'silo-r2-calibrated', round: 2, strategy: 'Silo I', totalMs: 44_461, steps: 1, throttle: 0.5 },
  { name: 'cistern-r3-calibrated', round: 3, strategy: 'Cistern I', totalMs: 56_702, steps: 4, throttle: 0.771 },
] as const;

type RecordedOnDisk = {
  provider: string;
  model: string;
  round: number;
  recordedAt: string;
  approved: boolean;
  knownIssue?: string;
  timing: { totalMs: number; pinned: number; assumed: number; method: string };
  at: number[];
  events: RewriteEvent[];
};

function recorded(name: string): RecordedOnDisk {
  const url = new URL(`../public/recorded/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as RecordedOnDisk;
}

type Artifact = {
  generatedAt?: string;
  request?: { round?: number; seed?: number };
  summary?: { at?: string; ms?: number; round?: number; attempts?: number; approved?: boolean };
  events: RewriteEvent[];
};

/** A six-event server artifact: a rejection, a calibration step, and an approval. */
function artifact(overrides: Partial<Artifact> = {}): Artifact {
  const events: RewriteEvent[] = [
    { type: 'replay', summary: {} as never, round: 2 },
    {
      type: 'analysis.done',
      analysis: { observations: [], playerArchetype: 'camper', counterPlan: 'c' },
      calls: 1,
      promptChars: 10,
      usage: { inputTokens: 1, outputTokens: 1 },
      ms: 4000,
    },
    { type: 'trial.gate', attempt: 1, gate: { gate: 3, name: 'balance', ok: false, ms: 1000, reason: 'too hard' } },
    { type: 'calibrate.step', attempt: 1, candidate: 0, step: 1, pressure: 0.5, panel: 0.49, ok: true },
    { type: 'calibrate.done', attempt: 1, candidate: 0, steps: 1, pressure: 0.5, approved: true },
    {
      type: 'done',
      result: {
        approved: true,
        source: 'export const meta = { name: "Silo I", rationale: "r", version: 2 };',
        meta: { name: 'Silo I', rationale: 'r', version: 2 },
        // The heavy field the recorder drops: one full candidate file per attempt.
        attempts: [{ attempt: 1, source: 'x'.repeat(4000), coder: { ms: 6000 } }] as never,
        analysis: { observations: [], playerArchetype: 'camper', counterPlan: 'c' },
      },
    },
  ];
  return {
    generatedAt: '2026-09-11T18:45:45.327Z',
    request: { round: 2, seed: 1 },
    summary: { at: '2026-09-11T18:45:45.327Z', round: 2, ms: 12_000, attempts: 1, approved: true },
    events,
    ...overrides,
  };
}

describe('toRecordedServer', () => {
  it('builds the header from the artifact, and the vendor from the caller', () => {
    // The artifact records what the server did, never how it was configured — so a
    // recorder that inferred `sonnet` from the bytes would be making it up. These two
    // strings are the badge, which is the mode's entire honesty claim.
    const run = toRecordedServer(artifact(), { provider: 'claude-cli', model: 'sonnet' });

    expect(run.provider).toBe('claude-cli');
    expect(run.model).toBe('sonnet');
    expect(run.round).toBe(2);
    expect(run.archetype).toBe('camper');
    expect(run.recordedAt).toBe('2026-09-11T18:45:45.327Z');
    expect(run.approved).toBe(true);
    expect(run.attempts).toBe(1);
  });

  it('empties done.result.attempts and keeps the source the next round loads', () => {
    const run = toRecordedServer(artifact(), { provider: 'claude-cli', model: 'sonnet' });
    const done = run.events.at(-1);
    if (done?.type !== 'done' || !done.result.approved) throw new Error('expected an approved done');

    expect(done.result.attempts).toEqual([]);
    expect(done.result.source).toContain('export const meta');
    expect(done.result.meta.name).toBe('Silo I');
  });

  it('keeps the calibrate.* frames — they are the point of recording this run', () => {
    const run = toRecordedServer(artifact(), { provider: 'claude-cli', model: 'sonnet' });
    expect(run.events.map((event) => event.type)).toContain('calibrate.step');
    expect(run.events.map((event) => event.type)).toContain('calibrate.done');
  });

  it('charges every calibrate.step a flat second and counts it as an assumption', () => {
    const run = toRecordedServer(artifact(), { provider: 'claude-cli', model: 'sonnet' });
    // One step, so one offset in this file rests on SPEC §6.3's figure rather than on
    // anything the stream measured. `pinned` counts only the readings.
    expect(run.timing.assumed).toBe(1);
    expect(run.timing.pinned).toBe(4);
    expect(run.timing.method).toContain('flat 1 000 ms charged to every calibrate.step');
    expect(run.timing.totalMs).toBe(12_000);
  });

  it('refuses an artifact that cannot drive a replay', () => {
    expect(() => toRecordedServer(artifact({ events: [] }), { provider: 'p', model: 'm' })).toThrow(/`done` event/);
    expect(() =>
      toRecordedServer(artifact({ summary: { round: 2 } }), { provider: 'p', model: 'm' }),
    ).toThrow(/summary\.ms/);
  });
});

describe('pinnable', () => {
  it('dresses a calibrate.step as a gate so the timeline can pin it, and touches nothing else', () => {
    // The shadow array exists only for `buildTimeline`; an unpinned step would be
    // interpolated into whatever span it fell in, and in the round 3 run that is eight
    // steps smeared across two candidates' gate groups.
    const events = artifact().events;
    const shadow = pinnable(events);

    expect(shadow).toHaveLength(events.length);
    const step = shadow[3];
    if (step?.type !== 'trial.gate') throw new Error('expected the step to wear a gate');
    expect(step.gate.ms).toBe(CALIBRATE_STEP_MS);
    // Every other frame is the identical object, so nothing can be written out of it.
    expect(shadow[0]).toBe(events[0]);
    expect(shadow.at(-1)).toBe(events.at(-1));
  });

  it('counts the assumptions it made', () => {
    expect(countAssumed(artifact().events)).toBe(1);
    expect(countAssumed([])).toBe(0);
  });
});

describe('the committed 2026-09-11 recordings', () => {
  for (const run of RUNS) {
    it(`${run.name} replays the run it says it does`, () => {
      const file = recorded(run.name);

      expect(file.provider).toBe('claude-cli');
      expect(file.model).toBe('sonnet');
      expect(file.round).toBe(run.round);
      expect(file.recordedAt as string).toContain('2026-09-11');
      expect(file.approved).toBe(true);
      // These are the post-ACTIVE recordings: they rest under the Judge's throttle
      // rather than idling, so they have nothing to disclose.
      expect(file.knownIssue).toBeUndefined();

      // The replay lasts exactly as long as the real request did.
      const timing = file.timing;
      expect(timing.totalMs).toBe(run.totalMs);
      expect(file.at.at(-1)).toBe(run.totalMs);
      expect(timing.assumed).toBe(countAssumed(file.events));
      expect(timing.pinned).toBeGreaterThan(0);

      // The harness said no before it said yes, which is what the mode is evidence of.
      expect(countRejections(file.events)).toBeGreaterThan(0);

      const done = file.events.at(-1);
      if (done?.type !== 'done' || !done.result.approved) throw new Error('expected an approved done');
      expect(done.result.meta.name).toBe(run.strategy);
      expect(done.result.attempts).toEqual([]);
    });

    it(`${run.name} ships the file the Judge calibrated, not the one the Coder wrote`, () => {
      const file = recorded(run.name);
      const landed = file.events.filter((event) => event.type === 'calibrate.done').find((event) => event.approved);
      if (landed?.type !== 'calibrate.done') throw new Error('expected an approved calibration');

      expect(landed.steps).toBe(run.steps);
      expect(landed.pressure).toBeCloseTo(run.throttle, 3);

      const done = file.events.at(-1);
      if (done?.type !== 'done' || !done.result.approved) throw new Error('expected an approved done');
      // The three things the injected block does (`agents/src/calibrate.ts`): it
      // declares the value the search landed on, it signs itself, and it renames the
      // Coder's entry points so it can wrap them. All three have to survive the
      // recorder, because this is the source QuickJS loads in the next round.
      expect(done.result.source).toContain(`const THROTTLE = ${landed.pressure}`);
      expect(done.result.source).toContain('calibrated by the Judge');
      expect(done.result.source).toContain('__initRaw');
      expect(done.result.source).toContain('__decideRaw');
      // ACTIVE is why the rest is a march and not an `idle` — the fault the 09-03
      // recordings have and these do not.
      expect(done.result.source).toContain('__judgeRest');
      expect(done.result.source).not.toMatch(/type:\s*'idle'/);
    });
  }

  it('carries no credential and no prompt, checked on the bytes', () => {
    for (const run of RUNS) {
      const url = new URL(`../public/recorded/${run.name}.json`, import.meta.url);
      expect(() => verify(readFileSync(url, 'utf8'), `${run.name}.json`), run.name).not.toThrow();
    }
  });
});
