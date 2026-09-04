/**
 * Gate 3 — balance. **NOT IMPLEMENTED YET.** Milestone: Sep 4–5 (spec §10).
 *
 * TODO(gate3): simulate the strategy against the reference bot panel and assert
 * the two properties from spec §6.2:
 *
 *   ADAPTED: win_rate(boss vs Mimic)  >= 0.70          "it countered how you played"
 *   FAIR:    win_rate(boss vs panel)  in band[round]   "…but a different approach still beats it"
 *
 * with `N = 200` matches per assertion on a fixed seed set, and the fairness band
 * escalating per round (2: 0.35–0.50 … 5: 0.55–0.70).
 *
 * What lands with it:
 *  - `@rematch/engine` becomes a dependency of this package. It is deliberately
 *    **not imported yet**: the engine is being built in parallel, and importing a
 *    placeholder would couple Gate 2's tests to its progress.
 *  - The reference bots (`Camper`, `Kiter`, `Rusher`, `Dodger`, `Mimic`) live in
 *    this package (see the root README's note on the spec §5.1 dependency
 *    direction), each ~50 lines and deterministic.
 *  - Worker parallelism. The sandbox costs ~16–43 µs per `decide` depending on
 *    how much is in the `BossView` (`pnpm --filter @rematch/sandbox bench`), so
 *    200 matches x 3600 ticks is 12–31 s of sandbox time alone on one thread —
 *    too slow for the interlude's 45 s budget once engine time is added.
 *
 * The reason string must stay quantitative, per spec §6.3:
 *   "0.91 vs panel — too hard; 0.41 vs Mimic — didn't adapt"
 */
import { gateFail, type GateResult } from './types.ts';

export type Gate3Options = {
  /** Which round's fairness band to check (spec §6.2). */
  round?: 2 | 3 | 4 | 5;
  /** Matches per assertion. Spec §6.2 says 200. */
  matches?: number;
  seed?: number;
  now?: () => number;
};

export function gate3Balance(_source: string, opts: Gate3Options = {}): GateResult {
  const now = opts.now ?? (() => performance.now());
  const started = now();
  return gateFail(3, now() - started, 'not implemented', { todo: 'gate3', round: opts.round ?? 2 });
}
