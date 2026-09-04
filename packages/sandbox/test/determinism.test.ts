/**
 * Determinism (spec AC 3, §5.2). Two runners loaded from the same source and
 * seeded with the same number must produce byte-identical action sequences, and
 * different seeds must actually diverge — otherwise the seed is decoration and
 * replays are a lie.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createSandbox, type SandboxFactory } from '../src/index.ts';
import { makeView, readGoodFixture, strategy } from './helpers.ts';

let sandbox: SandboxFactory;

beforeAll(async () => {
  sandbox = await createSandbox();
});

/** A strategy whose every decision is driven by `rand()`. */
const RANDOM_WALKER = strategy(
  `const r = rand();
   mem.calls = mem.calls + 1;
   if (r < 0.25) return { type: 'burst', angle: rand() * 6.283, count: 5 };
   if (r < 0.5) return { type: 'charge', angle: rand() * 6.283 };
   if (r < 0.75) return { type: 'slam', x: rand() * 800, y: rand() * 800 };
   return { type: 'move', dx: rand() * 2 - 1, dy: rand() * 2 - 1 };`,
  { initBody: 'return { calls: 0, seedNoise: rand() };', name: 'Walker' },
);

function run(source: string, seed: number, ticks: number): string[] {
  const runner = sandbox.load(source);
  try {
    runner.init(seed);
    const out: string[] = [];
    for (let tick = 0; tick < ticks; tick++) {
      const result = runner.decide(makeView({ tick }));
      out.push(result.ok ? JSON.stringify(result.action) : `FAIL:${JSON.stringify(result.failure)}`);
    }
    return out;
  } finally {
    runner.dispose();
  }
}

describe('seeded rand()', () => {
  it('same seed, two independent runners, identical action sequences', () => {
    const a = run(RANDOM_WALKER, 0xbeef, 240);
    const b = run(RANDOM_WALKER, 0xbeef, 240);
    expect(a).toEqual(b);
    expect(a.some((s) => s.includes('FAIL'))).toBe(false);
    // The walker really is branching, so equality above is not trivial.
    expect(new Set(a.map((s) => JSON.parse(s).type)).size).toBeGreaterThan(2);
  });

  it('different seeds diverge', () => {
    const a = run(RANDOM_WALKER, 1, 240);
    const b = run(RANDOM_WALKER, 2, 240);
    expect(a).not.toEqual(b);
  });

  it('re-init with the same seed rewinds the generator', () => {
    const runner = sandbox.load(RANDOM_WALKER);
    try {
      runner.init(7);
      // Compare actions only: `elapsedMs` is wall-clock and never repeats.
      const actions = (): string[] =>
        Array.from({ length: 30 }, (_, tick) => {
          const r = runner.decide(makeView({ tick }));
          return JSON.stringify(r.ok ? r.action : r.failure);
        });
      const first = actions();
      runner.init(7);
      const second = actions();
      expect(second).toEqual(first);
    } finally {
      runner.dispose();
    }
  });

  it('seed 0 is usable (the generator refuses to latch at zero)', () => {
    const a = run(RANDOM_WALKER, 0, 60);
    expect(a.some((s) => s.includes('FAIL'))).toBe(false);
    expect(new Set(a).size).toBeGreaterThan(1);
  });

  it('a strategy that ignores rand() is deterministic across seeds', () => {
    const source = readGoodFixture('orbiter');
    expect(run(source, 1, 120)).toEqual(run(source, 999, 120));
  });

  it('the same seed produces the same rand() stream inside two runners', () => {
    const dump = strategy('const xs = []; for (let i = 0; i < 16; i++) xs.push(rand()); return { type: "idle", xs };');
    const first = run(dump, 12345, 1);
    const second = run(dump, 12345, 1);
    expect(first[0]).toEqual(second[0]);
    // A regression pin: if the PRNG ever changes, every recorded replay breaks,
    // so the change has to be deliberate enough to update this expectation.
    const xs = (JSON.parse(first[0] as string) as { xs: number[] }).xs;
    expect(xs[0]).toBeCloseTo(0.16736852074973285, 12);
    expect(xs[15]).toBeCloseTo(0.800960571039468, 12);
  });
});
