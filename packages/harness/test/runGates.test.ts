/**
 * `runGates` sequencing, and the CLI's contract with the shell.
 *
 * The short-circuit test is the important one: spec AC 8 says a strategy
 * containing `Date.now()` must be "rejected before it executes in the game", and
 * the harness is where that is enforced. If Gate 1 failing still let Gate 2 boot
 * a QuickJS runtime, the guarantee would be a comment rather than a control.
 */
import { describe, expect, it } from 'vitest';
import type { SandboxFactory } from '@rematch/sandbox';
import { DEFAULT_GATES, formatGateResult, runGates } from '../src/index.ts';
import { main, type CliIo } from '../src/cli.ts';
import { badFixturePath, goodFixturePath, GOOD_FIXTURES, readBad, readGood } from './helpers.ts';

describe('runGates', () => {
  it('approves every good fixture through gates 1 and 2', async () => {
    for (const name of GOOD_FIXTURES) {
      const result = await runGates(readGood(name));
      if (!result.approved) {
        throw new Error(`${name} rejected at gate ${result.stoppedAt}: ${JSON.stringify(result.results.at(-1))}`);
      }
      expect(result.results.map((r) => r.gate)).toEqual([1, 2]);
      expect(result.stoppedAt).toBeUndefined();
    }
  });

  it('defaults to gates 1 and 2 — the implemented ones', () => {
    expect(DEFAULT_GATES).toEqual([1, 2]);
  });

  it('stops at gate 1 and never loads the sandbox', async () => {
    // A sandbox that records every attempt to use it. If Gate 2 ran at all it
    // would call `load` — so `loads === 0` is direct evidence that a Gate 1
    // rejection never reaches the VM (spec AC 8).
    let loads = 0;
    const trap = {
      load: () => {
        loads += 1;
        throw new Error('gate 2 must not load the sandbox after a gate 1 rejection');
      },
      loadUnchecked: () => {
        loads += 1;
        throw new Error('gate 2 must not load the sandbox after a gate 1 rejection');
      },
    } as unknown as SandboxFactory;

    const result = await runGates(readBad('uses-date'), { gate2: { sandbox: trap } });
    expect(result.approved).toBe(false);
    expect(result.stoppedAt).toBe(1);
    expect(result.results).toHaveLength(1);
    expect(loads).toBe(0);
  });

  it('stops at gate 2 for a runtime failure, having run gate 1 first', async () => {
    const result = await runGates(readBad('returns-string'));
    expect(result.approved).toBe(false);
    expect(result.stoppedAt).toBe(2);
    expect(result.results.map((r) => [r.gate, r.ok])).toEqual([
      [1, true],
      [2, false],
    ]);
  });

  it('runs the requested gates in ascending order and ignores duplicates', async () => {
    const result = await runGates(readGood('idle'), { gates: [2, 1, 2] });
    expect(result.results.map((r) => r.gate)).toEqual([1, 2]);
  });

  it('reports gate 3 as the stopping point when it is requested', async () => {
    const result = await runGates(readGood('idle'), { gates: [1, 3] });
    expect(result.approved).toBe(false);
    expect(result.stoppedAt).toBe(3);
    expect(result.results.at(-1)).toMatchObject({ gate: 3, ok: false, reason: 'not implemented' });
  });

  it('passes options through to gate 2', async () => {
    const result = await runGates(readGood('chaser'), { gate2: { states: 30, sequenceTicks: 0, seed: 5 } });
    expect(result.approved).toBe(true);
    expect(result.results[1]?.detail).toMatchObject({ states: 30, seed: 5 });
  });

  it('every rejection carries a non-empty, single-sentence reason', async () => {
    for (const name of ['nan-angle', 'ignores-cooldowns', 'returns-string', 'memory-hog'] as const) {
      const result = await runGates(readBad(name));
      expect(result.approved, name).toBe(false);
      const last = result.results.at(-1)!;
      expect(last.ok).toBe(false);
      if (last.ok) continue;
      expect(last.reason.length).toBeGreaterThan(20);
      expect(last.reason).not.toContain('\n');
    }
  });
});

describe('formatGateResult', () => {
  it('renders a pass and a failure the way the CLI prints them', () => {
    expect(formatGateResult({ gate: 1, name: 'static', ok: true, ms: 3.4 })).toBe('✓ Gate 1 static 3ms');
    expect(formatGateResult({ gate: 2, name: 'fuzz', ok: false, ms: 120, reason: 'because' })).toBe(
      '✗ Gate 2 fuzz — because',
    );
  });
});

describe('cli', () => {
  /** Collects what the CLI would print, without touching the real streams. */
  function captureStdout(): { text: () => string; err: () => string; io: CliIo; restore: () => void } {
    let out = '';
    let err = '';
    return {
      text: () => out,
      err: () => err,
      io: { out: (text) => (out += text), err: (text) => (err += text) },
      restore: () => undefined,
    };
  }

  it('exits 0 and prints one line per gate for a good strategy', async () => {
    const out = captureStdout();
    try {
      const code = await main([goodFixturePath('chaser')], out.io);
      expect(code).toBe(0);
      expect(out.text()).toMatch(/✓ Gate 1 static \d+ms/);
      expect(out.text()).toMatch(/✓ Gate 2 fuzz \d+ms/);
      expect(out.text()).toMatch(/APPROVED/);
    } finally {
      out.restore();
    }
  });

  it('exits 1 and prints the reason for a rejected strategy', async () => {
    const out = captureStdout();
    try {
      const code = await main([badFixturePath('ignores-cooldowns')], out.io);
      expect(code).toBe(1);
      expect(out.text()).toMatch(/✗ Gate 2 fuzz — asked for a primitive/);
      expect(out.text()).toMatch(/REJECTED at gate 2/);
    } finally {
      out.restore();
    }
  });

  it('--json emits a machine-readable verdict', async () => {
    const out = captureStdout();
    try {
      const code = await main([badFixturePath('uses-date'), '--json'], out.io);
      expect(code).toBe(1);
      const parsed = JSON.parse(out.text()) as { approved: boolean; stoppedAt: number; results: unknown[] };
      expect(parsed.approved).toBe(false);
      expect(parsed.stoppedAt).toBe(1);
      expect(parsed.results).toHaveLength(1);
    } finally {
      out.restore();
    }
  });

  it('--gates selects the gates', async () => {
    const out = captureStdout();
    try {
      const code = await main([badFixturePath('ignores-cooldowns'), '--gates', '1'], out.io);
      expect(code).toBe(0);
      expect(out.text()).toMatch(/APPROVED/);
    } finally {
      out.restore();
    }
  });

  it('--states and --seed reach gate 2', async () => {
    const out = captureStdout();
    try {
      const code = await main([badFixturePath('nan-angle'), '--states', '50', '--seed', '3', '--json'], out.io);
      expect(code).toBe(1);
      const parsed = JSON.parse(out.text()) as { results: Array<{ detail?: { seed?: number; states?: number } }> };
      expect(parsed.results[1]?.detail).toMatchObject({ seed: 3, states: 50 });
    } finally {
      out.restore();
    }
  });

  it('exits 2 on a missing file and on a bad option', async () => {
    const out = captureStdout();
    expect(await main(['/definitely/not/a/strategy.js'], out.io)).toBe(2);
    expect(out.err()).toMatch(/cannot read/);
    expect(await main(['--nope'], out.io)).toBe(2);
    expect(out.err()).toMatch(/unknown option '--nope'/);
    expect(await main([], out.io)).toBe(2);
    expect(await main(['--gates', '9'], out.io)).toBe(2);
    expect(await main(['--gates'], out.io)).toBe(2);
    expect(await main(['a.js', 'b.js'], out.io)).toBe(2);
  });

  it('ignores the -- separator that pnpm forwards', async () => {
    const out = captureStdout();
    const code = await main(['--', goodFixturePath('idle'), '--gates', '1'], out.io);
    expect(code).toBe(0);
    expect(out.text()).toMatch(/APPROVED/);
  });

  it('--help exits 0', async () => {
    const out = captureStdout();
    try {
      expect(await main(['--help'], out.io)).toBe(0);
      expect(out.text()).toMatch(/Usage: pnpm harness/);
    } finally {
      out.restore();
    }
  });
});
