# @rematch/contract — CHANGELOG

All notable changes to the Boss Contract. **This file is human-gated**: CI rejects any
PR touching `packages/contract/` without a new entry here (spec §7), because this
package is the API the boss agent writes against.

## 0.1.1 — 2026-09-02

- `StrategyRunner`, `DecideResult`, `RunnerFailure` interfaces (`runner.ts`): the
  engine ↔ strategy boundary. Engine never depends on QuickJS; it receives a runner.
- Seeded PRNG name resolved: the sandbox injects a global `rand(): number` in [0, 1).

## 0.1.0 — 2026-09-02

Contract frozen from spec v0.1.

- `BossView`, `BossAction`, `PrimitiveName`, `Memory`, `StrategyMeta`,
  `StrategyModule` types, verbatim from spec §4.
- `PRIMITIVES`, `ACTION_TYPES`, `BURST_COUNTS` runtime companions.
- `CONSTANTS`: arena 800×800 (spec §12 open decision resolved to square),
  cooldowns `burst 90 / charge 150 / slam 210 / spawn 300` ticks, 60 ticks/second,
  telegraphs `charge 20 / slam 40`, limits (4 KB serialized memory, 2 ms `decide`
  budget, 64 MB sandbox heap, 32 KB source, 40-char `meta.name`, 2 minions).
- `validateAction(action, view)`: total function, never throws, normalizes `move`
  to a unit vector, canonicalizes a zero-length `move` to `idle`, rejects actions
  whose primitive is on cooldown.
- `staticCheck(source)`: Gate 1. acorn-based AST walk — forbidden identifiers and
  computed accesses, no imports, exports limited to `meta` / `init` / `decide`,
  literal `meta` shape.
- Packaging: entry point resolves to TypeScript source (`./src/index.ts`) and
  internal specifiers use `.ts` with `rewriteRelativeImportExtensions`, so the
  package loads unchanged under `tsc`, Vitest, `tsx` and bare
  `node --experimental-strip-types`. No build step, no `dist/` to drift.
