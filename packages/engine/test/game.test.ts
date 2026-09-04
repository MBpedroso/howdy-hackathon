/** Round lifecycle: hashing, the replay summary the Analyst agent reads, and the
 *  in-process runner used by the engine's own tests. */
import { describe, expect, it } from 'vitest';
import { CONSTANTS, type BossAction, type BossView, type Memory, type StrategyModule } from '@rematch/contract';
import { ENGINE_CONSTANTS as E } from '../src/constants.ts';
import { canonicalJson, fnv1a64 } from '../src/hash.ts';
import { buildTimeline, createGame, hashState, replay, summarizeReplay } from '../src/game.ts';
import { makeInput, IDLE_INPUT } from '../src/input.ts';
import { nativeRunner, utf8Length } from '../src/nativeRunner.ts';
import { buildBossView } from '../src/view.ts';
import { step } from '../src/step.ts';
import type { TimelineEvent } from '../src/state.ts';
import { constantRunner, idleRunner, playMatch, randomInputLog } from './helpers.ts';

describe('canonicalJson', () => {
  it('is insensitive to key insertion order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('drops undefined properties, like JSON.stringify', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('renders -0 as 0 and non-finite numbers as null', () => {
    expect(canonicalJson(-0)).toBe('0');
    expect(canonicalJson(Number.NaN)).toBe('null');
    expect(canonicalJson(Number.POSITIVE_INFINITY)).toBe('null');
  });

  it('handles nested arrays and nulls', () => {
    expect(canonicalJson({ xs: [1, null, { z: 1, a: 2 }] })).toBe('{"xs":[1,null,{"a":2,"z":1}]}');
  });
});

describe('fnv1a64', () => {
  it('produces stable 16-hex-character digests', () => {
    const digests = ['', 'a', 'hello world', '{"tick":0}'].map(fnv1a64);
    for (const d of digests) expect(d).toMatch(/^[0-9a-f]{16}$/);
    expect(digests).toMatchSnapshot();
  });

  it('is sensitive to single-character changes', () => {
    expect(fnv1a64('rematch')).not.toBe(fnv1a64('rematci'));
  });
});

describe('utf8Length', () => {
  it('counts bytes, not code units', () => {
    expect(utf8Length('abc')).toBe(3);
    expect(utf8Length('é')).toBe(2);
    expect(utf8Length('€')).toBe(3);
    expect(utf8Length('😀')).toBe(4);
  });
});

describe('hashState', () => {
  it('is stable and detects any simulation difference', () => {
    const runner = idleRunner();
    const a = createGame(1, runner);
    const b = createGame(1, runner);
    expect(hashState(a)).toBe(hashState(b));

    step(a, makeInput({ moveX: 1 }), runner);
    step(b, makeInput({ moveX: 1 }), runner);
    expect(hashState(a)).toBe(hashState(b));

    step(b, makeInput({ moveX: 1 }), runner);
    expect(hashState(a)).not.toBe(hashState(b));
  });

  it('includes the strategy meta, so two strategies never collide silently', () => {
    const a = createGame(1, constantRunner({ type: 'idle' }, { name: 'A', rationale: 'a', version: 1 }));
    const b = createGame(1, constantRunner({ type: 'idle' }, { name: 'B', rationale: 'b', version: 1 }));
    expect(hashState(a)).not.toBe(hashState(b));
  });
});

describe('replay', () => {
  it('stops at the end of the input log', () => {
    const runner = idleRunner();
    const log = randomInputLog(5, 100);
    const { final } = replay(1, log, runner);
    expect(final.tick).toBe(100);
    expect(final.outcome).toBe('playing');
  });

  it('pads a sparse log with IDLE_INPUT rather than crashing', () => {
    const runner = idleRunner();
    const log = [makeInput({ moveX: 1 }), undefined as unknown as typeof IDLE_INPUT, makeInput({ moveX: 1 })];
    const { final } = replay(1, log, runner);
    expect(final.tick).toBe(3);
  });

  it('does not return frames unless asked', () => {
    const { frames } = replay(1, randomInputLog(5, 10), idleRunner());
    expect(frames).toBeUndefined();
  });

  it('frames are independent snapshots', () => {
    const { frames } = replay(1, randomInputLog(5, 10), idleRunner(), { keepFrames: true });
    expect(frames).toHaveLength(11);
    const first = frames?.[0];
    const last = frames?.[10];
    expect(first?.tick).toBe(0);
    expect(last?.tick).toBe(10);
    expect(first?.player.x).not.toBe(last?.player.x);
  });
});

describe('summarizeReplay', () => {
  it('compresses a finished match into the Analyst payload', () => {
    const runner = constantRunner({ type: 'burst', angle: Math.PI / 2, count: 8 });
    const { final } = playMatch(1, runner, 7, 900);
    const s = summarizeReplay(final);

    expect(s.seed).toBe(1);
    expect(s.strategy).toEqual(runner.meta);
    expect(s.durations.ticks).toBe(final.tick);
    expect(s.durations.seconds).toBeCloseTo(final.tick / CONSTANTS.ticksPerSecond, 2);
    expect(s.player.hpStart).toBe(E.player.hp);
    expect(s.boss.hpStart).toBe(E.boss.hp);
    expect(s.boss.damageTaken).toBe(final.damageDealt);
    expect(s.history.playerPosHeat).toHaveLength(64);
    expect(s.history.playerPosHeat.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 3);
    expect(s.history.playerDashDirs).toHaveLength(8);
    expect(s.contract.violations).toBe(final.violations);
    expect(s.timeline.length).toBeLessThanOrEqual(E.limits.timelineMax);
    expect(s.timelineTotal).toBe(final.events.length);

    // The summary must not alias the state.
    s.history.playerDashDirs[0] = 999;
    s.boss.primitives.burst = 999;
    expect(final.history.playerDashDirs[0]).not.toBe(999);
    expect(final.counts.primitives.burst).not.toBe(999);
  });

  it('accepts a frames array and uses the last frame', () => {
    const { final, frames } = replay(1, randomInputLog(5, 40), idleRunner(), { keepFrames: true });
    expect(frames).toBeDefined();
    expect(summarizeReplay(frames as never).durations.ticks).toBe(final.tick);
  });

  it('throws on an empty frames array', () => {
    expect(() => summarizeReplay([])).toThrow(/empty frames/);
  });

  it('the timeline keeps every notable event and only downsamples shots', () => {
    const events: TimelineEvent[] = [];
    for (let i = 0; i < 1000; i += 1) events.push({ tick: i, kind: 'playerShot' });
    events.push({ tick: 1000, kind: 'bossSlamHit' });
    events.push({ tick: 1001, kind: 'outcome', detail: 'playerWon' });

    const timeline = buildTimeline(events, 200);
    expect(timeline.length).toBeLessThanOrEqual(200);
    expect(timeline.some((e) => e.kind === 'bossSlamHit')).toBe(true);
    expect(timeline.some((e) => e.kind === 'outcome')).toBe(true);
    // Order is preserved.
    for (let i = 1; i < timeline.length; i += 1) {
      expect(timeline[i]!.tick).toBeGreaterThan(timeline[i - 1]!.tick);
    }
  });

  it('downsamples notable events too when they alone exceed the budget', () => {
    const events: TimelineEvent[] = [];
    for (let i = 0; i < 500; i += 1) events.push({ tick: i, kind: 'violation', detail: 'nope' });
    expect(buildTimeline(events, 200).length).toBeLessThanOrEqual(200);
  });
});

describe('nativeRunner', () => {
  const module = (decide: (view: BossView, mem: Memory) => BossAction, init: () => Memory = () => ({})): StrategyModule => ({
    meta: { name: 'test', rationale: 'test', version: 1 },
    init,
    decide,
  });

  /** A real view from a real tick, so the shape handed to `decide` is exact. */
  const view = (): BossView => {
    const runner = idleRunner();
    const state = createGame(1, runner);
    step(state, makeInput(), runner);
    return buildBossView(state);
  };

  it('threads the same memory object across ticks', () => {
    const runner = nativeRunner(
      module((_v, mem) => {
        mem.n = ((mem.n as number) ?? 0) + 1;
        return { type: 'idle' };
      }),
    );
    runner.init(1);
    const v = view();
    runner.decide(v);
    runner.decide(v);
    const result = runner.decide(v);
    expect(result.ok).toBe(true);
    expect(runner.memoryBytes()).toBeGreaterThan(2);
  });

  it('reports a load failure before init and after dispose', () => {
    const runner = nativeRunner(module(() => ({ type: 'idle' })));
    const before = runner.decide(view());
    expect(before.ok).toBe(false);
    if (!before.ok) expect(before.failure.kind).toBe('load');

    runner.init(1);
    expect(runner.decide(view()).ok).toBe(true);

    runner.dispose();
    const after = runner.decide(view());
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.failure.kind).toBe('load');
  });

  it('turns a throwing decide into a throw failure, never an exception', () => {
    const runner = nativeRunner(
      module(() => {
        throw new Error('boom');
      }),
    );
    runner.init(1);
    const result = runner.decide(view());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe('throw');
      expect(result.failure).toMatchObject({ message: 'boom' });
    }
  });

  it('turns a throwing init into a load failure', () => {
    const runner = nativeRunner(
      module(
        () => ({ type: 'idle' }),
        () => {
          throw new Error('init boom');
        },
      ),
    );
    runner.init(1);
    const result = runner.decide(view());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe('load');
  });

  it('enforces the 4 KB memory cap', () => {
    const runner = nativeRunner(
      module((_v, mem) => {
        mem.blob = 'x'.repeat(CONSTANTS.limits.memoryBytes + 100);
        return { type: 'idle' };
      }),
    );
    runner.init(1);
    const result = runner.decide(view());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe('memory');
      expect(result.failure).toMatchObject({ bytes: expect.any(Number) });
    }
  });

  it('enforces the decide budget using the injected clock', () => {
    let t = 0;
    const runner = nativeRunner(module(() => ({ type: 'idle' })), {
      now: () => {
        t += 5; // 5 ms per call boundary -> every decide is over the 2 ms budget
        return t;
      },
    });
    runner.init(1);
    const result = runner.decide(view());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe('timeout');
      expect(result.failure).toMatchObject({ ms: 5 });
    }
  });

  it('the default clock is deterministic and never trips the budget', () => {
    const runner = nativeRunner(module(() => ({ type: 'idle' })));
    runner.init(1);
    const v = view();
    const elapsed = [runner.decide(v).elapsedMs, runner.decide(v).elapsedMs, runner.decide(v).elapsedMs];
    expect(new Set(elapsed).size).toBe(1);
    expect(elapsed[0]).toBeLessThan(CONSTANTS.limits.decideBudgetMs);
  });

  it('falls back to a placeholder meta for a malformed module', () => {
    const runner = nativeRunner({ meta: undefined as never, init: () => ({}), decide: () => ({ type: 'idle' }) });
    expect(runner.meta).toEqual({ name: 'unnamed', rationale: '', version: 0 });
  });

  it('rejects an init() that does not return a plain object', () => {
    const runner = nativeRunner(module(() => ({ type: 'idle' }), () => [] as unknown as Memory));
    runner.init(1);
    const result = runner.decide(view());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe('load');
  });
});
