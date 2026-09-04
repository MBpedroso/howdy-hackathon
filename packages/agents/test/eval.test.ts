/**
 * The eval itself, driven by mock providers.
 *
 * `pnpm eval:agents` produces AC 6's evidence, so a bug in its aggregation would
 * be a bug in the evidence. This runs the whole thing — three canned replays, real
 * gates, scripted models — and asserts on the report and the artifact.
 */
import { readFileSync, rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  PASS_RATE_TARGET,
  formatEvalTable,
  mockProvider,
  runEval,
  selectCanned,
  workersPerRun,
  writeEvalArtifact,
  type Analysis,
  type EvalReport,
} from '../src/index.ts';
import { asCoderReply, readGood, readHarnessFixture } from './helpers.ts';

const ANALYSIS: Analysis = {
  observations: ['Camped cell 63 for 93% of the round.', 'Never dashed.', 'Fired 163 shots.'],
  playerArchetype: 'camper',
  counterPlan: 'Slam the bottom-right corner and hold mid range.',
};

const tmp = mkdtempSync(join(tmpdir(), 'rematch-eval-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('selectCanned', () => {
  it('defaults to all ten', () => {
    expect(selectCanned(undefined)).toHaveLength(10);
    expect(selectCanned('  ')).toHaveLength(10);
  });

  it('filters, preserving the canonical order', () => {
    expect(selectCanned('kiter-b, camper-a')).toEqual(['camper-a', 'kiter-b']);
  });

  it('refuses a name that matches nothing, rather than silently running zero', () => {
    expect(() => selectCanned('nope')).toThrow(/no canned replay matched/);
  });
});

describe('runEval', () => {
  let report: EvalReport;

  it('runs every replay and scores the pass rate', async () => {
    report = await runEval({
      names: ['camper-a', 'dodger-a', 'kiter-a'],
      matches: 16,
      maxAttempts: 2,
      // One file per attempt: this suite scripts the Coder call by call, and its
      // subject is the aggregation, not the parallel-candidate search.
      candidates: 1,
      makeProviders: (replay) => ({
        analyst: mockProvider([JSON.stringify(ANALYSIS)], { model: 'mock-analyst' }),
        coder: mockProvider(
          // `kiter-a` gets a boss that does nothing: it fails both halves of Gate 3
          // twice over, so the eval has one failing run to aggregate.
          replay === 'kiter-a'
            ? [asCoderReply(readGood('idle'))]
            : [asCoderReply(readGood('chaser')), asCoderReply(readHarnessFixture('round2-candidate'))],
          { model: 'mock-coder' },
        ),
      }),
    });

    expect(report.total).toBe(3);
    expect(report.approved).toBe(2);
    expect(report.passRate).toBeCloseTo(2 / 3);
    expect(report.round).toBe(2);
    expect(report.matches).toBe(16);
    expect(report.models).toEqual({ analyst: 'mock-analyst', coder: 'mock-coder' });
    expect(report.target).toBe(PASS_RATE_TARGET);
  });

  it('records AC 6 evidence: rejected, then approved, with no human input', () => {
    // Both approved runs were rejected by Gate 3 first (chaser is too hard) and
    // then approved on attempt 2 — which is exactly what AC 6 asks to see recorded.
    expect(report.rejectedThenApproved).toEqual(['camper-a', 'dodger-a']);
    expect(report.gate3ThenApproved).toEqual(['camper-a', 'dodger-a']);
  });

  it('reports attempts, gates, tokens and wall time per run', () => {
    const approved = report.runs.find((r) => r.replay === 'camper-a');
    expect(approved).toBeDefined();
    expect(approved!.approved).toBe(true);
    expect(approved!.attempts).toBe(2);
    expect(approved!.gatesFailed).toEqual(['3 balance']);
    expect(approved!.strategyName).toBe('Warden');
    expect(approved!.archetype).toBe('camper');
    expect(approved!.tokens.input).toBeGreaterThan(0);
    expect(approved!.tokens.output).toBeGreaterThan(0);
    // Analyst (1) + Coder attempt 1 (1) + Coder attempt 2 (1).
    expect(approved!.modelCalls).toBe(3);
    expect(approved!.ms).toBeGreaterThan(0);

    const failed = report.runs.find((r) => r.replay === 'kiter-a');
    expect(failed!.approved).toBe(false);
    expect(failed!.failureReason).toBe('max-attempts');
    expect(failed!.gatesFailed).toEqual(['3 balance', '3 balance']);
  });

  it('keeps every event, so the artifact is a full trace', () => {
    for (const run of report.runs) {
      const types = new Set(run.events.map((e) => e.type));
      expect(types.has('replay')).toBe(true);
      expect(types.has('analysis.done')).toBe(true);
      expect(types.has('rewrite.done')).toBe(true);
      expect(types.has('trial.gate')).toBe(true);
      expect(types.has('verdict')).toBe(true);
      expect(types.has('done')).toBe(true);
    }
  });

  it('formats a table with a pass rate and the AC 6 line', () => {
    const rendered = formatEvalTable(report);
    expect(rendered).toContain('camper-a');
    expect(rendered).toContain('3 balance');
    expect(rendered).toContain('pass rate 2/3 = 67%');
    expect(rendered).toContain('AC 6 evidence: 2 run(s)');
    // One header row, three data rows, a blank, and two summary lines.
    expect(rendered.split('\n')).toHaveLength(7);
  });

  it('writes a JSON artifact that round-trips', () => {
    const file = writeEvalArtifact(report, tmp);
    expect(file).toMatch(/eval-.*\.json$/);
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as EvalReport;
    expect(parsed.total).toBe(3);
    expect(parsed.runs).toHaveLength(3);
    expect(parsed.runs[0]!.events.length).toBeGreaterThan(5);
    expect(parsed.spec).toContain('AC 6');
    // The rejection sentences survive serialization — they are the evidence.
    const reasons = parsed.runs
      .flatMap((r) => r.events)
      .filter((e) => e.type === 'verdict' && !e.approved)
      .map((e) => (e.type === 'verdict' ? e.reason : undefined));
    expect(reasons.some((r) => r?.includes('vs panel'))).toBe(true);
  });
});

describe('running replays concurrently', () => {
  it('splits the cores across the concurrent runs, leaving one for the main thread', () => {
    // Gate 3 saturates every core it is given, so N runs at once must each take
    // 1/N of the pool or they simply queue behind each other.
    expect(workersPerRun(1, 12)).toBe(11);
    expect(workersPerRun(3, 12)).toBe(3);
    expect(workersPerRun(4, 12)).toBe(2);
    // Never zero, however small the machine or however large the fan-out.
    expect(workersPerRun(8, 2)).toBe(1);
    expect(workersPerRun(3, 1)).toBe(1);
  });

  it('reports runs in `names` order however the pool finished them', async () => {
    // The slowest replay is listed first, so an appended-on-arrival report would
    // come back in the wrong order and no two runs would be diffable.
    const delays: Record<string, number> = { 'camper-a': 120, 'dodger-a': 10, 'kiter-a': 40 };
    const report = await runEval({
      names: ['camper-a', 'dodger-a', 'kiter-a'],
      matches: 16,
      maxAttempts: 1,
      candidates: 1,
      concurrency: 3,
      gate3Workers: 1,
      makeProviders: (replay) => ({
        analyst: mockProvider([{ text: JSON.stringify(ANALYSIS), delayMs: delays[replay] ?? 0 }], {
          model: 'mock-analyst',
        }),
        coder: mockProvider([asCoderReply(readHarnessFixture('round2-candidate'))], { model: 'mock-coder' }),
      }),
    });

    expect(report.runs.map((r) => r.replay)).toEqual(['camper-a', 'dodger-a', 'kiter-a']);
    expect(report.concurrency).toBe(3);
    expect(report.gate3Workers).toBe(1);
    // Every replay produced a run, whatever the harness made of it.
    expect(report.runs.every((r) => r.attempts >= 1)).toBe(true);
  }, 60_000);
});
