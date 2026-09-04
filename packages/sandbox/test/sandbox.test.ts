/**
 * The sandbox's functional contract: every reference strategy loads and decides,
 * and every way a strategy can misbehave comes back as a `RunnerFailure` instead
 * of an exception, a hang, or a crash.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { CONSTANTS, validateAction, type StrategyRunner } from '@rematch/contract';
import { createSandbox, monotonicClock, MONOTONIC_STEP_MS, SandboxLoadError, type SandboxFactory } from '../src/index.ts';
import { GOOD_FIXTURES, makeView, readGoodFixture, strategy } from './helpers.ts';

let sandbox: SandboxFactory;

beforeAll(async () => {
  sandbox = await createSandbox();
});

/** Run `fn` with a runner and always dispose it, even when an expectation fails. */
function withRunner(source: string, fn: (runner: StrategyRunner) => void, unchecked = false): void {
  const runner = unchecked ? sandbox.loadUnchecked(source) : sandbox.load(source);
  try {
    fn(runner);
  } finally {
    runner.dispose();
  }
}

describe('reference strategies', () => {
  for (const name of GOOD_FIXTURES) {
    it(`${name} loads, exposes meta, and returns a valid action`, () => {
      withRunner(readGoodFixture(name), (runner) => {
        expect(runner.meta.name.length).toBeGreaterThan(0);
        expect(runner.meta.name.length).toBeLessThanOrEqual(CONSTANTS.limits.metaNameMaxChars);
        expect(runner.meta.rationale.length).toBeGreaterThan(0);
        expect(typeof runner.meta.version).toBe('number');

        runner.init(1234);
        const view = makeView();
        const result = runner.decide(view);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(validateAction(result.action, view).ok).toBe(true);
        expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
        expect(runner.memoryBytes()).toBeLessThanOrEqual(CONSTANTS.limits.memoryBytes);
      });
    });
  }

  it('survives 3600 ticks — one full match — without failing', () => {
    withRunner(readGoodFixture('orbiter'), (runner) => {
      runner.init(99);
      for (let tick = 0; tick < 3600; tick++) {
        const result = runner.decide(makeView({ tick }));
        if (!result.ok) throw new Error(`tick ${tick}: ${JSON.stringify(result.failure)}`);
      }
      expect(runner.memoryBytes()).toBeLessThanOrEqual(CONSTANTS.limits.memoryBytes);
    });
  });
});

describe('time budget', () => {
  it('an infinite loop in decide is a timeout, not a hang', () => {
    withRunner(strategy('while (true) {}'), (runner) => {
      runner.init(1);
      const started = performance.now();
      const result = runner.decide(makeView());
      const wall = performance.now() - started;

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.kind).toBe('timeout');
      // The budget is 2 ms; the interrupt handler is polled every few thousand
      // bytecodes, so allow generous slack but nowhere near a hang.
      expect(wall).toBeLessThan(50);
    });
  });

  it('a busy-loop that exceeds the budget every tick fails every tick', () => {
    // ~5 ms of arithmetic: over budget, but not an infinite loop.
    withRunner(strategy('let x = 0; for (let i = 0; i < 4e7; i++) x += i; return { type: "idle", x };'), (runner) => {
      runner.init(1);
      for (let i = 0; i < 3; i++) {
        const result = runner.decide(makeView({ tick: i }));
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.failure.kind).toBe('timeout');
      }
    });
  });

  it('an infinite loop at module top level fails the load rather than hanging', () => {
    const started = performance.now();
    expect(() => sandbox.loadUnchecked(`while (true) {}\n${strategy('return { type: "idle" };')}`)).toThrow(
      SandboxLoadError,
    );
    expect(performance.now() - started).toBeLessThan(2000);
  });

  /**
   * The monotonic clock is what every *reproducible* caller passes — the harness
   * simulator and both sides of an AC 3 replay — so the containment guarantee has to
   * survive it. It does, in a different currency: the budget stops bounding
   * milliseconds and starts bounding interrupt polls, because the interrupt handler
   * is itself what advances the clock.
   */
  it('an infinite loop is still caught on the monotonic clock, deterministically', () => {
    const source = strategy('while (true) {}');
    const failures: Array<{ kind: string; ms?: number }> = [];
    for (let run = 0; run < 2; run += 1) {
      const runner = sandbox.load(source, { now: monotonicClock() });
      try {
        runner.init(1);
        const started = performance.now();
        const result = runner.decide(makeView());
        // Bounded in wall clock too: ~256 polls of the handler, ~35 ms in practice.
        expect(performance.now() - started).toBeLessThan(500);
        expect(result.ok).toBe(false);
        if (!result.ok) failures.push({ kind: result.failure.kind, ms: result.elapsedMs });
      } finally {
        runner.dispose();
      }
    }
    expect(failures.map((f) => f.kind)).toEqual(['timeout', 'timeout']);
    // The whole point: the reported cost is identical run to run, and it is a
    // multiple of the clock step rather than whatever the machine was doing.
    expect(failures[0]?.ms).toBe(failures[1]?.ms);
    expect((failures[0]?.ms ?? 0) / MONOTONIC_STEP_MS).toBe(
      Math.round((failures[0]?.ms ?? 0) / MONOTONIC_STEP_MS),
    );
  });

  it('a healthy strategy on the monotonic clock never times out', () => {
    const runner = sandbox.load(readGoodFixture('cornerbreaker'), { now: monotonicClock() });
    try {
      runner.init(1);
      for (let i = 0; i < 200; i += 1) {
        expect(runner.decide(makeView({ tick: i })).ok, `tick ${i}`).toBe(true);
      }
    } finally {
      runner.dispose();
    }
  });

  it('a runaway init is a timeout, not a hang', () => {
    withRunner(strategy('return { type: "idle" };', { initBody: 'while (true) {}' }), (runner) => {
      let thrown: unknown;
      try {
        runner.init(3);
      } catch (err) {
        thrown = err;
      }
      expect((thrown as { failure?: { kind?: string } }).failure?.kind).toBe('timeout');
      // The failure is remembered, so a caller that swallowed the throw still
      // cannot run an uninitialized strategy.
      expect(runner.decide(makeView()).ok).toBe(false);
    });
  });
});

describe('memory budget', () => {
  it('a strategy that grows its memory every tick fails with a memory failure', () => {
    const runner = sandbox.load(strategy('mem.a.push(view.tick); return { type: "idle" };', { initBody: 'return { a: [] };' }), );
    try {
      runner.init(1);
      let failure: { kind: string; bytes?: number } | undefined;
      for (let tick = 0; tick < 2000 && failure === undefined; tick++) {
        const result = runner.decide(makeView({ tick }));
        if (!result.ok) failure = result.failure as { kind: string; bytes?: number };
      }
      expect(failure?.kind).toBe('memory');
      expect(failure?.bytes ?? 0).toBeGreaterThan(CONSTANTS.limits.memoryBytes);
    } finally {
      runner.dispose();
    }
  });

  it('the memory failure is sticky — a dead strategy stays dead', () => {
    withRunner(
      strategy('mem.a.push(view.tick); return { type: "idle" };', { initBody: 'return { a: [] };' }),
      (runner) => {
        runner.init(1);
        for (let tick = 0; tick < 2000; tick++) runner.decide(makeView({ tick }));
        const first = runner.decide(makeView());
        const second = runner.decide(makeView());
        expect(first.ok).toBe(false);
        expect(second.ok).toBe(false);
        if (!first.ok && !second.ok) {
          expect(first.failure).toEqual(second.failure);
          expect(second.failure.kind).toBe('memory');
        }
      },
    );
  });

  it('init() returning an over-sized memory object is a memory failure', () => {
    const runner = sandbox.load(
      strategy('return { type: "idle" };', { initBody: 'return { pad: new Array(5000).fill("x") };' }),
    );
    try {
      expect(() => runner.init(1)).toThrow(/memory limit exceeded/);
    } finally {
      runner.dispose();
    }
  });

  it('memoryCheckEvery: 1 catches growth on the very next tick', () => {
    const runner = sandbox.load(
      strategy('for (let i = 0; i < 5000; i++) mem.a.push(i); return { type: "idle" };', {
        initBody: 'return { a: [] };',
      }),
      // A generous time budget, so the *memory* failure is the only one that can
      // fire. 5000 `push`es is nowhere near an infinite loop, but it is more than
      // 2 ms of work when the test process is descheduled — which it is, under
      // `pnpm -r`'s parallelism — and then this asserts on `timeout` instead.
      { memoryCheckEvery: 1, decideBudgetMs: 1000 },
    );
    try {
      runner.init(1);
      const result = runner.decide(makeView());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure.kind).toBe('memory');
    } finally {
      runner.dispose();
    }
  });

  it('a non-ASCII memory object is measured in bytes, not UTF-16 units', () => {
    // 3000 code points of 3-byte UTF-8 = 9000 bytes, but `String#length` is 3000.
    const runner = sandbox.load(
      strategy('return { type: "idle" };', { initBody: 'return { pad: new Array(3000).fill("\\u4e2d").join("") };' }),
    );
    try {
      expect(() => runner.init(1)).toThrow(/memory limit exceeded/);
    } finally {
      runner.dispose();
    }
  });
});

describe('throwing and malformed strategies', () => {
  it('a throwing decide is a throw failure carrying the message', () => {
    withRunner(strategy('return missingGlobal.x;'), (runner) => {
      runner.init(1);
      const result = runner.decide(makeView());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.kind).toBe('throw');
        if (result.failure.kind === 'throw') expect(result.failure.message).toMatch(/missingGlobal/);
      }
    });
  });

  it('a throw failure is not sticky — the next tick is evaluated again', () => {
    withRunner(strategy('if (view.tick === 0) { throw new Error("only tick 0"); } return { type: "idle" };'), (runner) => {
      runner.init(1);
      expect(runner.decide(makeView({ tick: 0 })).ok).toBe(false);
      expect(runner.decide(makeView({ tick: 1 })).ok).toBe(true);
    });
  });

  it('runaway recursion is a throw failure, not a wasm crash', () => {
    withRunner(strategy('function f(n) { return f(n + 1); } return f(0);'), (runner) => {
      runner.init(1);
      const result = runner.decide(makeView());
      expect(result.ok).toBe(false);
      if (!result.ok && result.failure.kind === 'throw') {
        expect(result.failure.message).toMatch(/stack overflow/);
      } else {
        expect(result.ok ? 'ok' : result.failure.kind).toBe('throw');
      }
    });
  });

  it('a cyclic action cannot be marshalled and is reported as such', () => {
    withRunner(strategy('const a = { type: "idle" }; a.self = a; return a;'), (runner) => {
      runner.init(1);
      const result = runner.decide(makeView());
      expect(result.ok).toBe(false);
      if (!result.ok && result.failure.kind === 'throw') {
        expect(result.failure.message).toMatch(/could not be serialized/);
      }
    });
  });

  it('a throwing getter on the action fails inside the VM', () => {
    withRunner(strategy('return { get type() { throw new Error("boom"); } };'), (runner) => {
      runner.init(1);
      const result = runner.decide(makeView());
      expect(result.ok).toBe(false);
    });
  });

  it('init() must return an object', () => {
    const runner = sandbox.load(strategy('return { type: "idle" };', { initBody: 'return 7;' }));
    try {
      expect(() => runner.init(1)).toThrow(/init\(\) must return an object, got number/);
    } finally {
      runner.dispose();
    }
  });

  it('decide() must be called after init()', () => {
    withRunner(readGoodFixture('idle'), (runner) => {
      const result = runner.decide(makeView());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure.kind).toBe('load');
    });
  });
});

describe('marshalling', () => {
  it('a non-object return value survives the boundary for the validator to reject', () => {
    withRunner(strategy('return "burst";'), (runner) => {
      runner.init(1);
      const result = runner.decide(makeView());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.action).toBe('burst');
        expect(validateAction(result.action, makeView()).ok).toBe(false);
      }
    });
  });

  it('returning nothing arrives as undefined, not as a marshalling error', () => {
    withRunner(strategy('return undefined;'), (runner) => {
      runner.init(1);
      const result = runner.decide(makeView());
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.action).toBeUndefined();
    });
  });

  it('NaN and Infinity survive as NaN and Infinity, not as null', () => {
    withRunner(strategy('return { type: "burst", angle: 0 / 0, count: 5, hi: 1 / 0, lo: -1 / 0 };'), (runner) => {
      runner.init(1);
      const result = runner.decide(makeView());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const action = result.action as Record<string, unknown>;
      expect(Number.isNaN(action['angle'])).toBe(true);
      expect(action['hi']).toBe(Number.POSITIVE_INFINITY);
      expect(action['lo']).toBe(Number.NEGATIVE_INFINITY);
      // …which is what makes the validator's reason quantitative.
      const validated = validateAction(result.action, makeView());
      expect(validated.ok).toBe(false);
      if (!validated.ok) expect(validated.reason).toMatch(/NaN/);
    });
  });

  it('a string that looks like the non-finite tag is not mistaken for a number', () => {
    withRunner(strategy('return { type: "burst", angle: 1, count: 5, note: "\\u0000nf:NaN plain text" };'), (runner) => {
      runner.init(1);
      const result = runner.decide(makeView());
      expect(result.ok).toBe(true);
      if (result.ok) {
        // The tag only decodes when it is the *whole* value, so arbitrary strings
        // round-trip unchanged.
        expect((result.action as Record<string, unknown>)['note']).toBe('\u0000nf:NaN plain text');
      }
    });
  });

  it('the view is delivered faithfully, including projectiles and history', () => {
    withRunner(
      strategy(
        'return { type: "slam", x: view.projectiles.length, y: view.history.playerPosHeat[56] * 100, t: view.tick, d: view.player.isDashing };',
      ),
      (runner) => {
        runner.init(1);
        const view = makeView({
          tick: 777,
          player: { x: 1, y: 2, hp: 3, vx: 0, vy: 0, isDashing: true, lastShotTick: 5 },
          projectiles: Array.from({ length: 12 }, () => ({ x: 1, y: 2, vx: 3, vy: 4, owner: 'boss' as const })),
        });
        const result = runner.decide(view);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.action).toMatchObject({ x: 12, y: 100, t: 777, d: true });
        }
      },
    );
  });

  it('extra properties on the action are carried through for the validator to drop', () => {
    withRunner(strategy('return { type: "idle", sneaky: { deep: [1, 2, 3] } };'), (runner) => {
      runner.init(1);
      const result = runner.decide(makeView());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect((result.action as Record<string, unknown>)['sneaky']).toEqual({ deep: [1, 2, 3] });
        expect(validateAction(result.action, makeView())).toEqual({ ok: true, action: { type: 'idle' } });
      }
    });
  });
});

describe('load-time rejection', () => {
  it('runs Gate 1 itself, so unchecked source never reaches the VM', () => {
    expect(() => sandbox.load(strategy('return { type: "idle", t: Date.now() };'))).toThrow(SandboxLoadError);
    try {
      sandbox.load(strategy('return { type: "idle", t: Date.now() };'));
    } catch (err) {
      expect((err as SandboxLoadError).failure.kind).toBe('load');
      expect((err as Error).message).toMatch(/static check failed/);
      expect((err as Error).message).toMatch(/Date/);
    }
  });

  it('rejects a syntax error', () => {
    expect(() => sandbox.load('export function decide( {')).toThrow(SandboxLoadError);
  });

  it('rejects a module whose top level throws', () => {
    expect(() => sandbox.loadUnchecked(`throw new Error("nope");\n${strategy('return { type: "idle" };')}`)).toThrow(
      /nope/,
    );
  });

  it('rejects a missing decide export even without Gate 1', () => {
    expect(() =>
      sandbox.loadUnchecked(`export const meta = { name: 'x', rationale: 'y', version: 1 };
export function init() { return {}; }`),
    ).toThrow(/'decide' must be an exported function/);
  });

  it('validates meta at runtime, not only statically', () => {
    // Gate 1 only checks *literal* metadata; a computed name has to be caught here.
    expect(() =>
      sandbox.loadUnchecked(`export const meta = { name: 'x'.repeat(60), rationale: 'y', version: 1 };
export function init() { return {}; }
export function decide() { return { type: 'idle' }; }`),
    ).toThrow(/meta.name' is 60 characters/);
  });

  it('rejects top-level await instead of pumping the job queue', () => {
    expect(() =>
      sandbox.loadUnchecked(`const x = await 1;
${strategy('return { type: "idle" };')}`),
    ).toThrow();
  });

  it('rejects an import: no module loader is registered', () => {
    expect(() => sandbox.loadUnchecked(`import 'anything';\n${strategy('return { type: "idle" };')}`)).toThrow();
  });

  it('rejects a source over the size limit', () => {
    const padding = `// ${'x'.repeat(CONSTANTS.limits.sourceBytes)}\n`;
    expect(() => sandbox.load(padding + strategy('return { type: "idle" };'))).toThrow(/32768 bytes/);
  });
});
