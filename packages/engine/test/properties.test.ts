/**
 * Spec §7, engine property layer: "Boss/player never leave arena; HP never negative;
 * cooldowns never negative" — plus the two invariants the rest of the system leans on:
 * at most 2 minions alive, and the state always JSON-round-trips to an equal hash.
 *
 * The boss is driven by a runner that emits random-but-valid actions, and separately by
 * one that emits arbitrary garbage, because a generated strategy is untrusted input.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { CONSTANTS, type DecideResult, type StrategyRunner } from '@rematch/contract';
import { ENGINE_CONSTANTS as E } from '../src/constants.ts';
import { createGame, hashState } from '../src/game.ts';
import { cloneState, type GameState } from '../src/state.ts';
import { step } from '../src/step.ts';
import type { PlayerInput } from '../src/input.ts';

const TICKS = 600;

/** A runner that cycles through a fixed list of raw actions. */
function cyclingRunner(actions: readonly unknown[]): StrategyRunner {
  let i = 0;
  return {
    meta: { name: 'fuzz', rationale: 'property test', version: 1 },
    init(): void {
      i = 0;
    },
    decide(): DecideResult {
      const action = actions[i % actions.length];
      i += 1;
      return { ok: true, action, elapsedMs: 0.01 };
    },
    memoryBytes: () => 2,
    dispose(): void {},
  };
}

/** Every non-finite number reachable from `value`, by path. */
function nonFinite(value: unknown, path = '$', out: string[] = []): string[] {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) out.push(`${path}=${String(value)}`);
    return out;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) nonFinite(value[i], `${path}[${i}]`, out);
    return out;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) nonFinite(v, `${path}.${k}`, out);
  }
  return out;
}

function invariants(state: GameState): string[] {
  const bad: string[] = [];
  const { w, h } = state.arena;
  const inBounds = (x: number, y: number, what: string): void => {
    if (x < 0 || x > w || y < 0 || y > h) bad.push(`${what} out of arena at (${x}, ${y}) on tick ${state.tick}`);
  };

  inBounds(state.player.x, state.player.y, 'player');
  inBounds(state.boss.x, state.boss.y, 'boss');
  for (const m of state.minions) inBounds(m.x, m.y, `minion ${m.id}`);
  for (const p of state.projectiles) inBounds(p.x, p.y, `projectile(${p.owner})`);

  if (state.player.hp < 0) bad.push(`player hp ${state.player.hp} < 0`);
  if (state.boss.hp < 0) bad.push(`boss hp ${state.boss.hp} < 0`);
  for (const m of state.minions) {
    if (m.hp <= 0) bad.push(`dead minion ${m.id} still alive in the array`);
  }

  for (const [name, ticks] of Object.entries(state.boss.cooldowns)) {
    if (ticks < 0) bad.push(`cooldown ${name} = ${ticks} < 0`);
    if (ticks > CONSTANTS.cooldowns[name as keyof typeof CONSTANTS.cooldowns]) {
      bad.push(`cooldown ${name} = ${ticks} above its maximum`);
    }
  }
  const p = state.player;
  for (const [name, ticks] of Object.entries({
    dashTicksLeft: p.dashTicksLeft,
    dashCooldown: p.dashCooldown,
    shotCooldown: p.shotCooldown,
    invulnTicks: p.invulnTicks,
  })) {
    if (ticks < 0) bad.push(`player.${name} = ${ticks} < 0`);
  }

  if (state.minions.length > CONSTANTS.limits.maxMinionsAlive) {
    bad.push(`${state.minions.length} minions alive, cap is ${CONSTANTS.limits.maxMinionsAlive}`);
  }
  if (state.projectiles.length > E.projectile.maxAlive) {
    bad.push(`${state.projectiles.length} projectiles alive, cap is ${E.projectile.maxAlive}`);
  }
  if (state.boss.telegraph !== null && state.boss.telegraph.ticksLeft < 0) {
    bad.push(`telegraph ticksLeft ${state.boss.telegraph.ticksLeft} < 0`);
  }
  if (state.tick > E.round.maxTicks) bad.push(`tick ${state.tick} past the cap`);

  return bad;
}

const finiteDouble = (min: number, max: number): fc.Arbitrary<number> =>
  fc.double({ min, max, noNaN: true, noDefaultInfinity: true });

const inputArb: fc.Arbitrary<PlayerInput> = fc.record({
  moveX: fc.constantFrom(-1, 0, 1),
  moveY: fc.constantFrom(-1, 0, 1),
  dash: fc.boolean(),
  aimX: finiteDouble(-1, 1),
  aimY: finiteDouble(-1, 1),
  shoot: fc.boolean(),
}) as fc.Arbitrary<PlayerInput>;

const validActionArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.constant({ type: 'idle' }),
  fc.record({ type: fc.constant('move'), dx: finiteDouble(-3, 3), dy: finiteDouble(-3, 3) }),
  fc.record({
    type: fc.constant('burst'),
    angle: finiteDouble(-Math.PI * 4, Math.PI * 4),
    count: fc.constantFrom(3, 5, 8),
  }),
  fc.record({ type: fc.constant('charge'), angle: finiteDouble(-Math.PI * 4, Math.PI * 4) }),
  fc.record({ type: fc.constant('slam'), x: finiteDouble(0, E.arena.w), y: finiteDouble(0, E.arena.h) }),
  fc.record({ type: fc.constant('spawn'), x: finiteDouble(0, E.arena.w), y: finiteDouble(0, E.arena.h) }),
);

function runFuzzMatch(seed: number, inputs: readonly PlayerInput[], actions: readonly unknown[]): string[] {
  const runner = cyclingRunner(actions);
  const state = createGame(seed, runner);
  const bad: string[] = [];

  for (let t = 0; t < TICKS; t += 1) {
    const input = inputs[t % inputs.length];
    if (input === undefined) break;
    step(state, input, runner);
    bad.push(...invariants(state));
    if (bad.length > 0) break;
    if (state.outcome !== 'playing') break;
  }

  bad.push(...nonFinite(state));
  if (hashState(cloneState(state)) !== hashState(state)) {
    bad.push('state does not JSON-round-trip to an equal hash');
  }
  return bad;
}

describe('engine invariants', () => {
  it('holds for random inputs against random-but-valid boss actions', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.array(inputArb, { minLength: 1, maxLength: 40 }),
        fc.array(validActionArb, { minLength: 1, maxLength: 24 }),
        (seed, inputs, actions) => {
          expect(runFuzzMatch(seed, inputs, actions)).toEqual([]);
        },
      ),
      { numRuns: 40 },
    );
  });

  it('holds when the strategy returns arbitrary garbage', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.array(inputArb, { minLength: 1, maxLength: 20 }),
        fc.array(fc.anything(), { minLength: 1, maxLength: 24 }),
        (seed, inputs, actions) => {
          expect(runFuzzMatch(seed, inputs, actions)).toEqual([]);
        },
      ),
      { numRuns: 30 },
    );
  });

  it('holds for a full-length match padded with idle input', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), fc.array(validActionArb, { minLength: 1, maxLength: 12 }), (seed, actions) => {
        const runner = cyclingRunner(actions);
        const state = createGame(seed, runner);
        const bad: string[] = [];
        for (let t = 0; t < E.round.maxTicks; t += 1) {
          step(state, { moveX: 0, moveY: 0, dash: false, aimX: 1, aimY: 0, shoot: false }, runner);
          if (state.outcome !== 'playing') break;
        }
        bad.push(...invariants(state));
        expect(bad).toEqual([]);
        expect(state.outcome).not.toBe('playing');
      }),
      { numRuns: 10 },
    );
  });

  it('never throws, whatever the runner does', () => {
    const throwers: StrategyRunner[] = [
      cyclingRunner([undefined, null, 0, '', [], () => 1, Symbol('x'), { type: 'move', dx: Number.NaN, dy: 1 }]),
      cyclingRunner([
        new Proxy(
          {},
          {
            get(): never {
              throw new Error('hostile getter');
            },
          },
        ),
      ]),
    ];
    for (const runner of throwers) {
      const state = createGame(1, runner);
      expect(() => {
        for (let t = 0; t < 200; t += 1) step(state, { moveX: 1, moveY: 0, dash: true, aimX: 1, aimY: 0, shoot: true }, runner);
      }).not.toThrow();
      expect(invariants(state)).toEqual([]);
      expect(state.violations).toBeGreaterThan(0);
    }
  });
});
