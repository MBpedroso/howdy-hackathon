import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  ACTION_TYPES,
  CONSTANTS,
  PRIMITIVES,
  validateAction,
  type BossAction,
  type BossView,
  type PrimitiveName,
} from '../src/index.ts';

function makeView(patch: Partial<BossView> = {}, cooldowns: Partial<Record<PrimitiveName, number>> = {}): BossView {
  return {
    tick: 120,
    arena: { w: CONSTANTS.arena.w, h: CONSTANTS.arena.h },
    boss: {
      x: 400,
      y: 400,
      hp: 100,
      facing: 0,
      cooldowns: { move: 0, burst: 0, charge: 0, slam: 0, spawn: 0, ...cooldowns },
    },
    player: { x: 120, y: 640, hp: 100, vx: 1.5, vy: -0.5, isDashing: false, lastShotTick: 118 },
    projectiles: [],
    history: {
      playerPosHeat: new Array<number>(64).fill(0),
      playerDashDirs: new Array<number>(8).fill(0),
      playerShotsDuring: { move: 0, burst: 0, charge: 0, slam: 0, spawn: 0 },
    },
    ...patch,
  };
}

const view = makeView();

describe('CONSTANTS', () => {
  it('pins the arena, cooldowns and sandbox limits the whole system shares', () => {
    expect(CONSTANTS.arena).toEqual({ w: 800, h: 800 });
    expect(CONSTANTS.ticksPerSecond).toBe(60);
    expect(CONSTANTS.cooldowns).toEqual({ move: 0, burst: 90, charge: 150, slam: 210, spawn: 300 });
    expect(CONSTANTS.limits.memoryBytes).toBe(4 * 1024);
    expect(CONSTANTS.limits.decideBudgetMs).toBe(2);
    expect(CONSTANTS.limits.sandboxMemoryBytes).toBe(64 * 1024 * 1024);
    expect(CONSTANTS.limits.metaNameMaxChars).toBe(40);
  });

  it('has a cooldown entry for every primitive', () => {
    for (const p of PRIMITIVES) {
      expect(CONSTANTS.cooldowns[p]).toBeTypeOf('number');
    }
  });
});

describe('validateAction — malformed shapes', () => {
  const throwingGetter = {};
  Object.defineProperty(throwingGetter, 'type', {
    get() {
      throw new Error('nope');
    },
    enumerable: true,
  });

  const revocable = Proxy.revocable({ type: 'idle' }, {});
  revocable.revoke();

  const cases: Array<[label: string, action: unknown]> = [
    ['null', null],
    ['undefined', undefined],
    ['number', 42],
    ['string', 'idle'],
    ['boolean', true],
    ['bigint', 10n],
    ['symbol', Symbol('idle')],
    ['function', () => ({ type: 'idle' })],
    ['empty array', []],
    ['array of actions', [{ type: 'idle' }]],
    ['object with no type', {}],
    ['numeric type', { type: 42 }],
    ['null type', { type: null }],
    ['symbol type', { type: Symbol('move') }],
    ['unknown type', { type: 'nope' }],
    ['wrong case type', { type: 'MOVE' }],
    ['type as array', { type: ['move'] }],
    ['move without dx/dy', { type: 'move' }],
    ['move dx NaN', { type: 'move', dx: Number.NaN, dy: 0 }],
    ['move dx Infinity', { type: 'move', dx: Number.POSITIVE_INFINITY, dy: 0 }],
    ['move dy -Infinity', { type: 'move', dx: 0, dy: Number.NEGATIVE_INFINITY }],
    ['move dx numeric string', { type: 'move', dx: '1', dy: 0 }],
    ['move dy null', { type: 'move', dx: 1, dy: null }],
    ['move dx boolean', { type: 'move', dx: true, dy: 0 }],
    ['move dx bigint', { type: 'move', dx: 1n, dy: 0 }],
    ['burst without angle', { type: 'burst', count: 5 }],
    ['burst angle NaN', { type: 'burst', angle: Number.NaN, count: 5 }],
    ['burst angle string', { type: 'burst', angle: '0', count: 5 }],
    ['burst without count', { type: 'burst', angle: 0 }],
    ['burst count 4', { type: 'burst', angle: 0, count: 4 }],
    ['burst count 0', { type: 'burst', angle: 0, count: 0 }],
    ['burst count 3.5', { type: 'burst', angle: 0, count: 3.5 }],
    ['burst count string', { type: 'burst', angle: 0, count: '5' }],
    ['burst count 999', { type: 'burst', angle: 0, count: 999 }],
    ['charge without angle', { type: 'charge' }],
    ['charge angle NaN', { type: 'charge', angle: Number.NaN }],
    ['charge angle string', { type: 'charge', angle: '1.5' }],
    ['slam without coords', { type: 'slam' }],
    ['slam x NaN', { type: 'slam', x: Number.NaN, y: 10 }],
    ['slam x negative', { type: 'slam', x: -1, y: 10 }],
    ['slam x past arena', { type: 'slam', x: 800.5, y: 10 }],
    ['slam y past arena', { type: 'slam', x: 10, y: 1200 }],
    ['slam y negative', { type: 'slam', x: 10, y: -0.5 }],
    ['slam coords as strings', { type: 'slam', x: '400', y: '400' }],
    ['spawn without coords', { type: 'spawn' }],
    ['spawn x negative', { type: 'spawn', x: -20, y: 400 }],
    ['spawn y past arena', { type: 'spawn', x: 400, y: 801 }],
    ['spawn Infinity', { type: 'spawn', x: Number.POSITIVE_INFINITY, y: 0 }],
    ['throwing getter on type', throwingGetter],
    ['revoked proxy', revocable.proxy],
    ['Map', new Map([['type', 'idle']])],
    ['Set', new Set(['idle'])],
    ['Date instance', new Date(0)],
  ];

  it.each(cases)('rejects %s', (_label, action) => {
    const result = validateAction(action, view);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBeTypeOf('string');
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  it('explains a non-object action', () => {
    const result = validateAction(null, view);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/plain object/);
  });

  it('names the offending field', () => {
    const cooked = validateAction({ type: 'burst', angle: 0, count: 4 }, view);
    expect(cooked.ok).toBe(false);
    if (!cooked.ok) expect(cooked.reason).toContain('burst.count');

    const oob = validateAction({ type: 'slam', x: 900, y: 10 }, view);
    expect(oob.ok).toBe(false);
    if (!oob.ok) expect(oob.reason).toContain('out of arena bounds');
  });
});

describe('validateAction — accepted shapes', () => {
  const cases: Array<[label: string, action: unknown, expected: BossAction]> = [
    ['idle', { type: 'idle' }, { type: 'idle' }],
    ['burst 3', { type: 'burst', angle: 0, count: 3 }, { type: 'burst', angle: 0, count: 3 }],
    ['burst 5', { type: 'burst', angle: -1.25, count: 5 }, { type: 'burst', angle: -1.25, count: 5 }],
    ['burst 8', { type: 'burst', angle: 6.2, count: 8 }, { type: 'burst', angle: 6.2, count: 8 }],
    ['charge', { type: 'charge', angle: 3.5 }, { type: 'charge', angle: 3.5 }],
    ['slam at origin corner', { type: 'slam', x: 0, y: 0 }, { type: 'slam', x: 0, y: 0 }],
    ['slam at far corner', { type: 'slam', x: 800, y: 800 }, { type: 'slam', x: 800, y: 800 }],
    ['spawn mid arena', { type: 'spawn', x: 400, y: 250.5 }, { type: 'spawn', x: 400, y: 250.5 }],
  ];

  it.each(cases)('accepts %s', (_label, action, expected) => {
    expect(validateAction(action, view)).toEqual({ ok: true, action: expected });
  });

  it('accepts a null-prototype object', () => {
    const action = Object.create(null) as { type: string };
    action.type = 'idle';
    expect(validateAction(action, view)).toEqual({ ok: true, action: { type: 'idle' } });
  });

  it('drops properties that are not part of the contract', () => {
    const result = validateAction({ type: 'burst', angle: 1, count: 3, damage: 9999, extra: 'x' }, view);
    expect(result.ok).toBe(true);
    if (result.ok) expect(Object.keys(result.action).sort()).toEqual(['angle', 'count', 'type']);
  });

  it('never returns an action type outside the contract menu', () => {
    for (const t of ['move', 'burst', 'charge', 'slam', 'spawn', 'idle', 'garbage']) {
      const result = validateAction({ type: t, dx: 1, dy: 0, angle: 0, count: 3, x: 1, y: 1 }, view);
      if (result.ok) expect(ACTION_TYPES).toContain(result.action.type);
    }
  });
});

describe('validateAction — move normalization', () => {
  it('normalizes to a unit vector', () => {
    const result = validateAction({ type: 'move', dx: 3, dy: 4 }, view);
    expect(result).toEqual({ ok: true, action: { type: 'move', dx: 0.6, dy: 0.8 } });
  });

  it('preserves direction while discarding magnitude', () => {
    const big = validateAction({ type: 'move', dx: 300, dy: 400 }, view);
    const small = validateAction({ type: 'move', dx: 0.003, dy: 0.004 }, view);
    expect(big).toEqual(small);
  });

  it('canonicalizes a zero-length move to idle (documented behaviour, not a violation)', () => {
    expect(validateAction({ type: 'move', dx: 0, dy: 0 }, view)).toEqual({ ok: true, action: { type: 'idle' } });
    expect(validateAction({ type: 'move', dx: -0, dy: 0 }, view)).toEqual({ ok: true, action: { type: 'idle' } });
    expect(validateAction({ type: 'move', dx: -0, dy: -0 }, view)).toEqual({ ok: true, action: { type: 'idle' } });
  });

  it('does not collapse near-overflow vectors to zero', () => {
    const result = validateAction({ type: 'move', dx: 1e308, dy: 1e308 }, view);
    expect(result.ok).toBe(true);
    if (result.ok && result.action.type === 'move') {
      expect(result.action.dx).toBeCloseTo(Math.SQRT1_2, 10);
      expect(result.action.dy).toBeCloseTo(Math.SQRT1_2, 10);
    } else {
      expect.unreachable('expected a move action');
    }
  });

  it('survives subnormal magnitudes', () => {
    const result = validateAction({ type: 'move', dx: 5e-324, dy: 0 }, view);
    expect(result).toEqual({ ok: true, action: { type: 'move', dx: 1, dy: 0 } });
  });

  it('produces vectors of unit length for arbitrary finite inputs', () => {
    fc.assert(
      fc.property(
        fc.double({ noNaN: true, noDefaultInfinity: true }),
        fc.double({ noNaN: true, noDefaultInfinity: true }),
        (dx, dy) => {
          const result = validateAction({ type: 'move', dx, dy }, view);
          expect(result.ok).toBe(true);
          if (result.ok && result.action.type === 'move') {
            const mag = Math.hypot(result.action.dx, result.action.dy);
            expect(mag).toBeCloseTo(1, 6);
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('validateAction — cooldowns', () => {
  it.each(PRIMITIVES)('rejects %s while it is on cooldown', (primitive) => {
    const hot = makeView({}, { [primitive]: 37 } as Partial<Record<PrimitiveName, number>>);
    const sample: Record<PrimitiveName, unknown> = {
      move: { type: 'move', dx: 1, dy: 0 },
      burst: { type: 'burst', angle: 0, count: 5 },
      charge: { type: 'charge', angle: 0 },
      slam: { type: 'slam', x: 400, y: 400 },
      spawn: { type: 'spawn', x: 400, y: 400 },
    };
    const result = validateAction(sample[primitive], hot);
    expect(result).toEqual({ ok: false, reason: `cooldown: ${primitive} (37 ticks)` });
  });

  it('formats fractional cooldowns', () => {
    const hot = makeView({}, { slam: 12.5 });
    expect(validateAction({ type: 'slam', x: 1, y: 1 }, hot)).toEqual({
      ok: false,
      reason: 'cooldown: slam (12.50 ticks)',
    });
  });

  it('allows idle no matter what is on cooldown', () => {
    const hot = makeView({}, { move: 9, burst: 90, charge: 150, slam: 210, spawn: 300 });
    expect(validateAction({ type: 'idle' }, hot)).toEqual({ ok: true, action: { type: 'idle' } });
  });

  it('prefers the cooldown reason over a field-shape reason', () => {
    const hot = makeView({}, { burst: 5 });
    expect(validateAction({ type: 'burst', angle: Number.NaN, count: 4 }, hot)).toEqual({
      ok: false,
      reason: 'cooldown: burst (5 ticks)',
    });
  });

  it('treats a garbage cooldown value as ready rather than blaming the strategy', () => {
    for (const bogus of [Number.NaN, -5, 'lots', null, undefined, {}]) {
      const odd = makeView({}, { burst: bogus as unknown as number });
      expect(validateAction({ type: 'burst', angle: 0, count: 5 }, odd).ok).toBe(true);
    }
  });

  it('treats a missing cooldown record as ready', () => {
    const broken = { ...view, boss: { ...view.boss, cooldowns: undefined } } as unknown as BossView;
    expect(validateAction({ type: 'charge', angle: 0 }, broken).ok).toBe(true);
  });
});

describe('validateAction — arena bounds come from the view', () => {
  it('uses the view arena when it is sane', () => {
    const small = makeView({ arena: { w: 100, h: 100 } });
    expect(validateAction({ type: 'slam', x: 150, y: 10 }, small).ok).toBe(false);
    expect(validateAction({ type: 'slam', x: 99, y: 10 }, small).ok).toBe(true);
  });

  it('falls back to CONSTANTS.arena when the view arena is broken', () => {
    const broken = { ...view, arena: { w: Number.NaN, h: 'tall' } } as unknown as BossView;
    expect(validateAction({ type: 'slam', x: 799, y: 799 }, broken).ok).toBe(true);
    expect(validateAction({ type: 'slam', x: 801, y: 10 }, broken).ok).toBe(false);
  });
});

describe('validateAction — totality (property)', () => {
  const anything = () =>
    fc.anything({
      withBigInt: true,
      withDate: true,
      withMap: true,
      withSet: true,
      withNullPrototype: true,
      withObjectString: true,
      withSparseArray: true,
      withTypedArray: true,
      withUnicodeString: true,
      maxDepth: 4,
    });

  it('never throws for arbitrary values in the action slot', () => {
    fc.assert(
      fc.property(anything(), (action) => {
        const result = validateAction(action, view);
        expect(result.ok).toBeTypeOf('boolean');
        if (!result.ok) expect(result.reason).toBeTypeOf('string');
      }),
      { numRuns: 3000 },
    );
  });

  it('never throws for arbitrary values in the view slot either', () => {
    fc.assert(
      fc.property(anything(), anything(), (action, badView) => {
        const result = validateAction(action, badView as BossView);
        expect(result.ok).toBeTypeOf('boolean');
      }),
      { numRuns: 2000 },
    );
  });

  it('never throws for near-valid actions', () => {
    const scalar = fc.oneof(
      fc.double(),
      fc.integer(),
      fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0, 0),
      fc.string(),
      fc.boolean(),
      fc.constant(null),
      fc.constant(undefined),
    );
    const actionish = fc.record(
      {
        type: fc.oneof(fc.constantFrom<string>(...ACTION_TYPES), fc.string()),
        dx: scalar,
        dy: scalar,
        angle: scalar,
        count: fc.oneof(fc.constantFrom(3, 5, 8), scalar),
        x: scalar,
        y: scalar,
      },
      { requiredKeys: [] },
    );

    fc.assert(
      fc.property(actionish, (action) => {
        const result = validateAction(action, view);
        expect(result.ok).toBeTypeOf('boolean');
      }),
      { numRuns: 3000 },
    );
  });

  it('is idempotent: a validated action re-validates', () => {
    fc.assert(
      fc.property(anything(), (action) => {
        const first = validateAction(action, view);
        if (!first.ok) return;
        const second = validateAction(first.action, view);
        expect(second.ok).toBe(true);
        if (second.ok) expect(second.action.type).toBe(first.action.type);
      }),
      { numRuns: 2000 },
    );
  });
});
