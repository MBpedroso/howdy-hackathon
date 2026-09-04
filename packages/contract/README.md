# `@rematch/contract`

The Boss Contract: the single, frozen interface between the boss agents and the game.
A generated `strategy.js` is handed a read-only `BossView` each tick and must return one
`BossAction` from a fixed menu — so nothing dangerous is *expressible*, and all the
creativity lives in *when* and *where*. This package owns the three deterministic pieces
that enforce that: the types the Coder agent is shown, `validateAction` (which runs on
every tick and never throws, whatever the sandbox returns), and `staticCheck` (Gate 1 —
an acorn AST walk that rejects forbidden names, imports and malformed module shapes
*before* any generated code executes). It has **zero workspace dependencies** on purpose:
`engine`, `harness`, `agents` and `web` all consume it, so it must consume none of them.
It contains no `Math.random`, no `Date.now`, and no I/O. Changing anything here is an API
change for the boss agent, so CI requires a matching `CHANGELOG.md` entry.

## Type shapes

```ts
type PrimitiveName = 'move' | 'burst' | 'charge' | 'slam' | 'spawn';

type BossView = {
  tick: number;                 // 60 ticks / second
  arena: { w: number; h: number };
  boss:   { x: number; y: number; hp: number; facing: number;
            cooldowns: Record<PrimitiveName, number> };   // ticks remaining, 0 = ready
  player: { x: number; y: number; hp: number; vx: number; vy: number;
            isDashing: boolean; lastShotTick: number };
  projectiles: Array<{ x: number; y: number; vx: number; vy: number; owner: 'boss' | 'player' }>;
  history: {
    playerPosHeat: number[];    // 8x8 grid, row-major, normalized to [0, 1]
    playerDashDirs: number[];   // 8 bins
    playerShotsDuring: Record<PrimitiveName, number>;
  };
};

type BossAction =
  | { type: 'move';   dx: number; dy: number }   // any magnitude; normalized to a unit vector
  | { type: 'burst';  angle: number; count: 3 | 5 | 8 }
  | { type: 'charge'; angle: number }            // telegraphed 20 ticks
  | { type: 'slam';   x: number; y: number }     // telegraphed 40 ticks, must be in bounds
  | { type: 'spawn';  x: number; y: number }     // one minion, max 2 alive
  | { type: 'idle' };

type Memory = Record<string, unknown>;           // opaque, <= 4 KB serialized
type StrategyMeta = { name: string; rationale: string; version: number };

type StrategyModule = {
  meta: StrategyMeta;
  init(): Memory;                                // once per round
  decide(view: BossView, mem: Memory): BossAction;  // once per tick, <= 2 ms
};
```

## API

```ts
// Shared numeric truth. One source for engine + harness.
CONSTANTS: {
  arena: { w: 800, h: 800 };
  ticksPerSecond: 60;
  cooldowns: { move: 0; burst: 90; charge: 150; slam: 210; spawn: 300 };  // ticks
  telegraphs: { charge: 20; slam: 40 };
  limits: {
    memoryBytes: 4096; decideBudgetMs: 2; sandboxMemoryBytes: 67108864;
    sourceBytes: 32768; metaNameMaxChars: 40; maxMinionsAlive: 2;
  };
}
PRIMITIVES: readonly PrimitiveName[];
ACTION_TYPES: readonly ActionType[];   // PRIMITIVES + 'idle'
BURST_COUNTS: readonly [3, 5, 8];

validateAction(action: unknown, view: BossView):
  | { ok: true;  action: BossAction }
  | { ok: false; reason: string };

staticCheck(source: string):
  | { ok: true }
  | { ok: false; violations: Array<{ rule: StaticRule; message: string; line?: number }> };

STATIC_RULES: readonly StaticRule[];
ALLOWED_EXPORTS: readonly ['meta', 'init', 'decide'];
FORBIDDEN_IDENTIFIERS: ReadonlySet<string>;
```

### `validateAction` behaviour worth knowing

- **Total.** It never throws — not for `null`, arrays, functions, symbols, revoked
  Proxies, or objects with throwing getters. The sandbox boundary must not be able to
  crash the engine.
- **Canonicalizing.** The returned `action` is freshly built. Properties the contract
  does not name are dropped, never forwarded to the engine.
- **`move` is normalized** to a unit vector, so a strategy may return any magnitude.
  A zero-length `move` (`dx === dy === 0`, including `-0`) carries no direction, so it is
  **accepted and canonicalized to `{ type: 'idle' }`** rather than rejected — "stand still"
  is a legitimate intent and must not cost the strategy a contract violation.
- **Cooldowns are checked first**, so the rejection reason is the actionable one:
  `cooldown: burst (37 ticks)`. On `{ ok: false }` the *engine* substitutes `idle` and
  counts a contract violation; the validator only reports, so the caller can log first.
- A malformed `view` degrades to `CONSTANTS.arena` / "ready" rather than failing the
  action. A broken engine state is never blamed on the strategy.

### What Gate 1 deliberately does not do

`staticCheck` cannot detect infinite loops, `O(n!)` blowups, or a slow `decide` — those
are halting problems. They are caught at runtime by **Gate 2** (contract fuzz inside
QuickJS with the 2 ms deadline) and **Gate 4** (perf p99). Do not add loop heuristics
here: they would reject good strategies, and the runtime gates already catch the real
thing. The layering is:

| Layer | Catches |
|---|---|
| Gate 1 (`staticCheck`) | forbidden names, imports, wrong module shape — fast, legible, before execution |
| QuickJS sandbox | everything else: no host bindings exist, 64 MB heap, seeded PRNG |
| Gate 2 / Gate 4 | anything that only shows up when the code runs |

## Tests

```
pnpm test:contract
```

## Consuming it

Package entry points resolve to **TypeScript source** (`./src/index.ts`), and internal
relative imports use `.ts` specifiers with `rewriteRelativeImportExtensions`. That means
the same files load under `tsc`, Vitest/Vite, `tsx`, *and* bare `node --experimental-strip-types`
— no build step and no `dist/` to keep in sync. Import it as:

```ts
import { CONSTANTS, staticCheck, validateAction, type BossAction, type BossView } from '@rematch/contract';
```

## Reference strategies

`test/fixtures/strategies/good/*.js` are real, working strategies conforming to §4, not
stubs — `idle` (baseline), `chaser` (pure aggression), `orbiter` (mid-range control with a
lead slam), `cornerbreaker` (reads `history.playerPosHeat` to punish a camper). The engine
and harness packages should reuse these as their known-good fixtures rather than writing
new ones. `test/fixtures/strategies/bad/*.js` is the rejection corpus, one file per rule.
