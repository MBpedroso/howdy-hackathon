/**
 * How long one interlude gets, and who decides.
 *
 * Spec AC 5 says 45 s, and that is still the default and still what the deployed
 * (recorded-only) site does. What this file pins is the one row that may raise it:
 * a **locally probed** server advertises its own loop deadline on `/api/health`
 * (`REMATCH_DEADLINE_MS`), and the client adopts it when it is larger — spec §13
 * delta 25.
 *
 * The bug it exists for is measurable. With `REMATCH_PROVIDER=claude-cli` the local
 * server is configured for 90 s, but the browser sent `budgetMs: 45000`, so
 * `clampToClientBudget` cut the loop back to 43 s — enough for one Analyst call and
 * one Coder attempt, never two. Three real runs on 2026-09-11 ended identically:
 * `artifacts/server/rewrite-2026-09-11T16-{18-39-211,20-25-072,21-33-548}Z.json`,
 * each `request.budgetMs 45000`, `summary.attempts 1`, `summary.ms ~43 005`,
 * `reason: 'deadline'`.
 *
 * Three things have to hold for that to stop happening, and each is asserted below:
 * the probe carries the advertised number, the adoption rule prefers an explicit
 * `?deadline=` over it and ignores anything at or below the default, and the
 * `budgetMs` on the wire equals whatever came out — because a budget that disagrees
 * with the client's own timer is exactly delta 21's failure.
 */
import { describe, expect, it } from 'vitest';

import {
  adoptDeadlineMs,
  interludeRequest,
  INTERLUDE_DEADLINE_MS,
  MAX_ADOPTED_DEADLINE_MS,
} from '../src/interlude/index.ts';
import { clockView } from '../src/interlude/ui.ts';

/** The parts of a `RoundWonContext` the request is built from, and nothing else. */
const context = {
  round: 1,
  seed: 3221225473,
  source: 'export const meta = { name: "Cornerbreaker", rationale: "y", version: 1 };',
  summary: {
    seed: 1,
    strategy: { name: 'Cornerbreaker', rationale: 'y', version: 1 },
    outcome: 'playerWon',
  },
} as unknown as Parameters<typeof interludeRequest>[0];

describe('adoptDeadlineMs', () => {
  it('is AC 5 45 s when nobody says otherwise — the deployed site, the mock, the recorded run', () => {
    expect(adoptDeadlineMs(undefined, undefined)).toBe(INTERLUDE_DEADLINE_MS);
    expect(INTERLUDE_DEADLINE_MS).toBe(45_000);
  });

  it('adopts a locally probed server’s larger deadline, which is the whole point', () => {
    expect(adoptDeadlineMs(undefined, 90_000)).toBe(90_000);
  });

  it('ignores an advertised deadline at or below the default: AC 5 is the promise', () => {
    expect(adoptDeadlineMs(undefined, 40_000)).toBe(INTERLUDE_DEADLINE_MS);
    expect(adoptDeadlineMs(undefined, INTERLUDE_DEADLINE_MS)).toBe(INTERLUDE_DEADLINE_MS);
  });

  it('lets an explicit deadline win in both directions — ?deadline= is how the e2e suite proves the fallback', () => {
    expect(adoptDeadlineMs(6_000, 90_000)).toBe(6_000);
    expect(adoptDeadlineMs(120_000, undefined)).toBe(120_000);
    expect(adoptDeadlineMs(120_000, 90_000)).toBe(120_000);
  });

  it('caps what it adopts, so a typo in REMATCH_DEADLINE_MS cannot hang the round', () => {
    expect(adoptDeadlineMs(undefined, 900_000)).toBe(MAX_ADOPTED_DEADLINE_MS);
    expect(MAX_ADOPTED_DEADLINE_MS).toBe(180_000);
  });

  it('falls back to the default rather than passing a nonsense number on', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(adoptDeadlineMs(bad, undefined), `explicit ${bad}`).toBe(INTERLUDE_DEADLINE_MS);
      expect(adoptDeadlineMs(undefined, bad), `advertised ${bad}`).toBe(INTERLUDE_DEADLINE_MS);
    }
  });

  it('truncates to whole milliseconds — the server parses budgetMs as an integer', () => {
    expect(adoptDeadlineMs(6_000.5, undefined)).toBe(6_000);
    expect(adoptDeadlineMs(undefined, 90_000.9)).toBe(90_000);
  });
});

describe('interludeRequest', () => {
  it('sends budgetMs equal to the adopted deadline, so the server’s loop gets the time', () => {
    for (const [explicit, advertised] of [
      [undefined, undefined],
      [undefined, 90_000],
      [6_000, 90_000],
      [undefined, 900_000],
    ] as const) {
      const deadlineMs = adoptDeadlineMs(explicit, advertised);
      expect(interludeRequest(context, deadlineMs).budgetMs, `${String(explicit)}/${String(advertised)}`).toBe(deadlineMs);
    }
  });

  it('carries the round being written and nothing the agents may not see', () => {
    const request = interludeRequest(context, 90_000);
    expect(request.round).toBe(2);
    expect(request.seed).toBe(3221225473);
    expect(request.prevSource).toBe(context.source);
    expect(request.prevMeta).toEqual(context.summary.strategy);
    expect(Object.keys(request).sort()).toEqual(['budgetMs', 'prevMeta', 'prevSource', 'round', 'seed', 'summary']);
  });
});

describe('clockView', () => {
  it('turns the clock over at the default budget when nothing raised it', () => {
    expect(clockView(44_900)).toEqual({ text: '44.9s', over: false });
    expect(clockView(45_001)).toEqual({ text: '45.0s', over: true });
  });

  it('keys "over" off the adopted deadline, not the constant', () => {
    // The bug: a 90 s budget with a clock that went red at 45 s, telling the player
    // the run was late while the server still had half its time left.
    expect(clockView(46_000, 90_000).over).toBe(false);
    expect(clockView(90_001, 90_000).over).toBe(true);
    expect(clockView(6_001, 6_000).over).toBe(true);
  });
});
