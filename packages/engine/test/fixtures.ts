/**
 * Loads the reference strategies from `@rematch/contract`'s fixture corpus.
 *
 * The contract README is explicit that engine and harness should reuse
 * `test/fixtures/strategies/good/*.js` rather than inventing their own known-good
 * strategies, so this is the one place that reaches across the package boundary.
 *
 * They are `.js` data files with no type declarations, so they are loaded through a
 * runtime-computed specifier: TypeScript types a non-literal `import()` as `any` and
 * never tries to resolve a declaration file for it.
 */
import type { StrategyModule } from '@rematch/contract';

const GOOD_DIR = new URL('../../contract/test/fixtures/strategies/good/', import.meta.url);

/** Fixture names, in a fixed order so test output is stable. */
export const GOOD_FIXTURES = ['chaser', 'cornerbreaker', 'idle', 'orbiter'] as const;
export type GoodFixture = (typeof GOOD_FIXTURES)[number];

export async function loadGoodStrategy(name: string): Promise<StrategyModule> {
  const href = new URL(`${name}.js`, GOOD_DIR).href;
  const mod: unknown = await import(/* @vite-ignore */ href);
  return mod as StrategyModule;
}

export async function loadAllGoodStrategies(): Promise<Array<{ name: GoodFixture; module: StrategyModule }>> {
  const out: Array<{ name: GoodFixture; module: StrategyModule }> = [];
  for (const name of GOOD_FIXTURES) {
    out.push({ name, module: await loadGoodStrategy(name) });
  }
  return out;
}
