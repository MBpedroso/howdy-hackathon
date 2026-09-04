/**
 * Containment — the security boundary itself, tested with Gate 1 **out of the
 * way**.
 *
 * Everything here is loaded through `loadUnchecked`, which skips `staticCheck`.
 * That is the point: spec §11 lists
 * "generated code escapes sandbox" as a risk mitigated by "QuickJS + static gate
 * + no host bindings", and a test that only exercised the static gate would
 * prove nothing about the other two. Each case below is a name a strategy is
 * forbidden to mention — and would still be unable to use if it did.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createSandbox, SANDBOX_DELETED_GLOBALS, type SandboxFactory } from '../src/index.ts';
import { makeView, strategy } from './helpers.ts';

let sandbox: SandboxFactory;

beforeAll(async () => {
  sandbox = await createSandbox();
});

/** Evaluate an expression inside a strategy's `decide` and return its value. */
function evaluate(expression: string): unknown {
  const runner = sandbox.loadUnchecked(strategy(`return { type: "idle", value: ${expression} };`));
  try {
    runner.init(1);
    const result = runner.decide(makeView());
    if (!result.ok) throw new Error(`decide failed: ${JSON.stringify(result.failure)}`);
    return (result.action as Record<string, unknown>)['value'];
  } finally {
    runner.dispose();
  }
}

describe('globals that do not exist', () => {
  // Removed as *intrinsics*: the constructor is never created, so no prototype
  // chain can lead back to it.
  it.each(['Date', 'RegExp', 'Proxy'])('typeof %s is undefined', (name) => {
    expect(evaluate(`typeof ${name}`)).toBe('undefined');
  });

  // Deleted from the global object by the prelude.
  it.each(SANDBOX_DELETED_GLOBALS.filter((n) => n !== 'globalThis'))('typeof %s is undefined', (name) => {
    expect(evaluate(`typeof ${name}`)).toBe('undefined');
  });

  // Never present in QuickJS in the first place — asserted so that a future
  // variant change that added them would fail here rather than in production.
  it.each([
    'fetch',
    'XMLHttpRequest',
    'setTimeout',
    'setInterval',
    'queueMicrotask',
    'console',
    'process',
    'require',
    'window',
    'self',
    'global',
    'performance',
    'crypto',
    'structuredClone',
    'WebAssembly',
    'Intl',
    'localStorage',
    'navigator',
    'document',
    'Worker',
    'Buffer',
    'Deno',
    'Bun',
    'importScripts',
    'WeakRef',
    'FinalizationRegistry',
    'Atomics',
  ])('typeof %s is undefined', (name) => {
    expect(evaluate(`typeof ${name}`)).toBe('undefined');
  });

  it('Math.random is gone and Math is frozen against putting it back', () => {
    expect(evaluate('typeof Math.random')).toBe('undefined');
    expect(evaluate('(function () { try { Math.random = function () { return 0.5; }; } catch (e) {} return typeof Math.random; })()')).toBe(
      'undefined',
    );
  });

  it('the function constructors are unreachable through prototypes', () => {
    // `Function` is deleted, and the prelude deletes `constructor` from every
    // function prototype — after which the lookup walks to `Object`.
    expect(evaluate('(function () {}).constructor === Object')).toBe(true);
    expect(evaluate('(function* () {}).constructor === Object')).toBe(true);
    expect(evaluate('(async function () {}).constructor === Object')).toBe(true);
  });

  it('there is no route back to the global object', () => {
    expect(evaluate('typeof globalThis')).toBe('undefined');
    // A module body is strict-mode code, so an unresolvable assignment throws
    // rather than creating a global.
    const runner = sandbox.loadUnchecked(strategy('smuggled = 1; return { type: "idle" };'));
    try {
      runner.init(1);
      const result = runner.decide(makeView());
      expect(result.ok).toBe(false);
      if (!result.ok && result.failure.kind === 'throw') {
        expect(result.failure.message).toMatch(/smuggled|not defined|not extensible/);
      }
    } finally {
      runner.dispose();
    }
  });
});

describe('the sandbox harness cannot be tampered with', () => {
  it('rand and the entry points are non-writable', () => {
    // Strict-mode assignment to a non-writable global property throws, which is
    // reported as an ordinary failure rather than silently replacing our PRNG.
    const runner = sandbox.loadUnchecked(strategy('rand = function () { return 0.5; }; return { type: "idle" };'));
    try {
      runner.init(1);
      const result = runner.decide(makeView());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure.kind).toBe('throw');
    } finally {
      runner.dispose();
    }
  });

  it('the entry points cannot be deleted', () => {
    // `delete rand` on an unqualified name is a SyntaxError in strict-mode code,
    // and module bodies are always strict — so the attempt does not even load.
    // The qualified form (`delete globalThis.rand`) needs a global object, and
    // there is no route to one.
    expect(() => sandbox.loadUnchecked(strategy('delete rand; return { type: "idle" };'))).toThrow();
    expect(evaluate('typeof rand')).toBe('function');
  });
});

describe('what the sandbox does keep', () => {
  it('keeps the pure builtins a strategy needs', () => {
    expect(evaluate('typeof Math.atan2')).toBe('function');
    expect(evaluate('typeof JSON.stringify')).toBe('function');
    expect(evaluate('typeof Object.keys')).toBe('function');
    expect(evaluate('typeof Array.isArray')).toBe('function');
    expect(evaluate('typeof Map')).toBe('function');
    expect(evaluate('typeof Float64Array')).toBe('function');
    expect(evaluate('typeof parseFloat')).toBe('function');
  });

  it('exposes rand() in [0, 1)', () => {
    const runner = sandbox.loadUnchecked(
      strategy('const xs = []; for (let i = 0; i < 500; i++) xs.push(rand()); return { type: "idle", xs };'),
    );
    try {
      runner.init(42);
      const result = runner.decide(makeView());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const xs = (result.action as { xs: number[] }).xs;
      expect(xs).toHaveLength(500);
      expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
      expect(Math.max(...xs)).toBeLessThan(1);
      // Not a randomness test, just a smoke check that it is not a constant.
      expect(new Set(xs).size).toBeGreaterThan(400);
      const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
      expect(mean).toBeGreaterThan(0.4);
      expect(mean).toBeLessThan(0.6);
    } finally {
      runner.dispose();
    }
  });
});
