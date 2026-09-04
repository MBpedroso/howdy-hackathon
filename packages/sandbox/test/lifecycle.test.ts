/**
 * Lifecycle and leaks.
 *
 * This suite exists because a leaked QuickJS handle is not a soft failure: on
 * `runtime.dispose()` QuickJS asserts `list_empty(&rt->gc_obj_list)`, and a
 * failed assertion **aborts the wasm module**, which is memoized per process —
 * so one leak takes down every later load in the harness, the sim and the server.
 * Loading and disposing 200 runners is therefore a real test, not a formality:
 * if any path forgot a `dispose`, this file crashes.
 *
 * Gate 3 will load and dispose a runner per simulated match (200+ per verdict),
 * so this is also the closest thing to a Gate 3 smoke test available today.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createSandbox, getQuickJSModule, type SandboxFactory } from '../src/index.ts';
import { makeView, readGoodFixture, strategy } from './helpers.ts';

let sandbox: SandboxFactory;

beforeAll(async () => {
  sandbox = await createSandbox();
});

describe('dispose', () => {
  it('load → init → decide → dispose, 200 times, without leaking a handle', () => {
    const source = readGoodFixture('chaser');
    for (let i = 0; i < 200; i++) {
      const runner = sandbox.load(source);
      runner.init(i);
      const result = runner.decide(makeView({ tick: i }));
      expect(result.ok).toBe(true);
      runner.dispose();
    }
  });

  it('does not grow the wasm heap across 200 load/dispose cycles', async () => {
    const wasm = await getQuickJSModule();
    const heapBytes = (): number => {
      // `getWasmMemory` is an extension quickjs-emscripten adds to the module;
      // it is not in the published types.
      const memory = (wasm as unknown as { getWasmMemory?: () => { buffer: { byteLength: number } } }).getWasmMemory?.();
      return memory?.buffer.byteLength ?? 0;
    };
    const source = readGoodFixture('orbiter');
    const cycle = (n: number): void => {
      for (let i = 0; i < n; i++) {
        const runner = sandbox.load(source);
        runner.init(i);
        for (let tick = 0; tick < 20; tick++) runner.decide(makeView({ tick }));
        runner.dispose();
      }
    };

    cycle(20); // let the heap reach its working size
    const before = heapBytes();
    cycle(200);
    const after = heapBytes();
    // A leaked runtime would keep its ~100 KB of QuickJS heap alive; 200 of them
    // would force the wasm memory to grow. Equality is the expectation, with one
    // growth step of slack for allocator noise.
    expect(after - before).toBeLessThanOrEqual(before === 0 ? 0 : 16 * 1024 * 1024);
    expect(before).toBeGreaterThan(0);
  });

  it('disposing a runner whose strategy failed is still clean', () => {
    const sources = [
      strategy('while (true) {}'),
      strategy('return missing.x;'),
      strategy('function f(n) { return f(n + 1); } return f(0);'),
      strategy('mem.a.push(1); return { type: "idle" };', { initBody: 'return { a: [] };' }),
      strategy('const a = { type: "idle" }; a.self = a; return a;'),
    ];
    for (let i = 0; i < 20; i++) {
      for (const source of sources) {
        const runner = sandbox.loadUnchecked(source, { memoryCheckEvery: 1 });
        runner.init(i);
        for (let tick = 0; tick < 3; tick++) runner.decide(makeView({ tick }));
        runner.dispose();
      }
    }
  });

  it('disposing a runner whose load failed leaves nothing behind', () => {
    for (let i = 0; i < 40; i++) {
      expect(() => sandbox.loadUnchecked('export const meta = 1; oops(')).toThrow();
      expect(() => sandbox.loadUnchecked(`throw new Error('x');\n${strategy('return { type: "idle" };')}`)).toThrow();
      expect(() => sandbox.load(strategy('return { t: Date.now() };'))).toThrow();
    }
  });

  it('dispose is idempotent, and a disposed runner fails instead of crashing', () => {
    const runner = sandbox.load(readGoodFixture('idle'));
    runner.init(1);
    runner.dispose();
    runner.dispose();
    const result = runner.decide(makeView());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe('load');
    // Reports the last measurement rather than calling into a dead context.
    expect(runner.memoryBytes()).toBeGreaterThanOrEqual(0);
  });

  it('runners are isolated: one strategy cannot see the other memory', () => {
    const writer = sandbox.loadUnchecked(
      strategy('mem.marker = "writer"; return { type: "idle", marker: mem.marker };'),
    );
    const reader = sandbox.loadUnchecked(strategy('return { type: "idle", marker: mem.marker || "none" };'));
    try {
      writer.init(1);
      reader.init(1);
      expect(writer.decide(makeView())).toMatchObject({ ok: true, action: { marker: 'writer' } });
      expect(reader.decide(makeView())).toMatchObject({ ok: true, action: { marker: 'none' } });
    } finally {
      writer.dispose();
      reader.dispose();
    }
  });
});
