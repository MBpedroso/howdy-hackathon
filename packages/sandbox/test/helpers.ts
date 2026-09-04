import { readFileSync } from 'node:fs';
import type { BossView, PrimitiveName } from '@rematch/contract';

/** The reference strategies live in `contract`; every consumer reuses them. */
export const GOOD_FIXTURES = ['idle', 'chaser', 'orbiter', 'cornerbreaker'] as const;

export function readGoodFixture(name: (typeof GOOD_FIXTURES)[number]): string {
  return readFileSync(
    new URL(`../../contract/test/fixtures/strategies/good/${name}.js`, import.meta.url),
    'utf8',
  );
}

const ALL_READY: Record<PrimitiveName, number> = { move: 0, burst: 0, charge: 0, slam: 0, spawn: 0 };

/** A plain, valid `BossView`. Override any slice of it. */
export function makeView(overrides: Partial<BossView> = {}): BossView {
  return {
    tick: 120,
    arena: { w: 800, h: 800 },
    boss: { x: 400, y: 400, hp: 100, facing: 0, cooldowns: { ...ALL_READY }, ...overrides.boss },
    player: {
      x: 200,
      y: 620,
      hp: 100,
      vx: 1.5,
      vy: -0.5,
      isDashing: false,
      lastShotTick: 100,
      ...overrides.player,
    },
    projectiles: overrides.projectiles ?? [],
    history: {
      playerPosHeat: Array.from({ length: 64 }, (_, i) => (i === 56 ? 1 : 0.01)),
      playerDashDirs: [4, 1, 0, 0, 6, 1, 0, 0],
      playerShotsDuring: { move: 3, burst: 2, charge: 1, slam: 0, spawn: 0 },
      ...overrides.history,
    },
    ...('tick' in overrides ? { tick: overrides.tick as number } : {}),
    ...('arena' in overrides ? { arena: overrides.arena as BossView['arena'] } : {}),
  };
}

/** Minimal well-formed strategy source with a `decide` body of your choosing. */
export function strategy(decideBody: string, opts: { initBody?: string; name?: string } = {}): string {
  return [
    `export const meta = { name: ${JSON.stringify(opts.name ?? 'Test')}, rationale: 'test fixture', version: 1 };`,
    `export function init() { ${opts.initBody ?? 'return {};'} }`,
    `export function decide(view, mem) { ${decideBody} }`,
  ].join('\n');
}
