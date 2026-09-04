# `@rematch/web`

The playable fight: Vite + Canvas 2D, no framework, ~60 Hz fixed-step simulation driving
the real engine, with the boss's strategy running in the real QuickJS sandbox — the same
`@rematch/sandbox` the harness uses, in the browser, so the live game and the headless
simulator agree bit for bit (spec §5.2).

```
pnpm dev                       # http://localhost:5173
pnpm build && pnpm preview     # production bundle
pnpm test                      # unit tests + the Node-side replay regression
pnpm test:e2e                  # Playwright (chromium); builds and previews first
```

## What exists today (Milestone 2)

A single boss fight against a hand-written, balance-tested strategy, five rounds deep,
with a working replay log. **No agents and no interlude yet** — beating a round shows the
"Round N cleared" screen and re-fights the same strategy on a new seed. The seam the
interlude plugs into is `createApp({ onRoundWon })`; see `src/app.ts`.

## URL parameters

| Parameter | Effect |
|---|---|
| `?seed=<n>` | Fix the session seed (decimal or `0x…`). Every round seed is derived from it, so one URL reproduces a whole session. Absent = one `crypto.getRandomValues` call, the only non-determinism in the client. |
| `?autostart=1` | Skip the start screen and begin Round 1 immediately (used by the e2e suite). |
| `?round=<1-5>` | Start at a given round number. |
| `?strategy=hound` | Load the alternate bundled strategy instead of Round 1's. `hound` is the only strategy that spends `charge`, so it is how the charge telegraph gets exercised. |

## `window.__rematch`

The debug and e2e surface (`DebugApi` in `src/app.ts`). Present in every build; read-only
except for the three driving methods.

```js
__rematch.state          // the live GameState
__rematch.inputLog       // one entry per elapsed tick — half of the replay format
__rematch.seed           // this round's seed; sessionSeed and round are there too
__rematch.hash()         // hashState(state) — the equality witness for AC 3
__rematch.summary()      // summarizeReplay(state) — what the Analyst agent will read
__rematch.stats()        // avg tick / render ms, dropped ticks
__rematch.startRound(n)  // jump to a round
await __rematch.driveWith(log)   // restart this round and replay a recorded input log
__rematch.fastForward(n)         // run n ticks synchronously, no rAF
```

## Determinism (spec AC 3)

`e2e/fixtures/inputlog-round1.json` is a full Round 1 played by the engine's scripted
pseudo-player, recorded in Node by `scripts/gen-inputlog.ts` together with the final state
hash Node computed. Two tests guard it:

- `test/replay-fixture.test.ts` (in `pnpm verify`) replays it **in Node** and asserts the
  recorded hash still holds — so a change to an engine rule or to `round1.js` fails here
  first, with instructions, instead of failing confusingly in the browser.
- `e2e/determinism.spec.ts` replays it **in the browser** through `driveWith` +
  `fastForward` and asserts the same hash.

Both sides inject the sandbox's deterministic clock (`src/game/clock.ts`). A real clock
would make replays *slightly* non-reproducible: the sandbox enforces the 2 ms `decide`
deadline against `now()`, and a GC pause can push one call over budget, which the engine
turns into `idle` + a violation. Live play keeps `performance.now`, where that deadline is
a containment control and must be real.

Regenerate after any engine or strategy change:

```
pnpm --filter @rematch/web gen:inputlog
```

## Layout

| Path | Responsibility |
|---|---|
| `src/main.ts` | Entry point; publishes `window.__rematch` |
| `src/app.ts` | Rounds, screens, outcomes, the `onRoundWon` seam |
| `src/game/loop.ts` | Fixed 60 Hz accumulator decoupled from `requestAnimationFrame`, capped at 5 catch-up steps per frame |
| `src/game/round.ts` | `{ seed, inputLog, source }` + the engine state — the replay format |
| `src/game/input.ts` | WASD/arrows, Space (8-tick buffered), mouse aim, hold-to-shoot |
| `src/game/strategy.ts` | `loadRoundStrategy(source)` — source text in, `StrategyRunner` out. The server's seam. |
| `src/game/seeds.ts` | Session seed + `roundSeed(session, round)` |
| `src/render/` | Canvas: floor, telegraphs, actors, effects, viewport maths |
| `src/ui/` | DOM chrome: HUD (HP pips, timer, boss strategy panel) and the four screens |
| `src/strategies/*.js` | Bundled strategy sources, imported with `?raw` |

## Vite and QuickJS

`@rematch/sandbox` dynamically imports `@jitl/quickjs-singlefile-cjs-release-sync`, a
~1.4 MB CommonJS file with the WASM embedded as a byte string. Vite 8 handles it unaided
in both dev and build — verified by running the e2e suite both ways (`E2E_SERVER=dev
pnpm test:e2e` against `vite dev`, and the default against `vite build` + `vite preview`),
including a test that only passes if a strategy really loaded through QuickJS.

`vite.config.ts` still names it in `optimizeDeps.include`, not as a workaround but so the
1.4 MB is pre-bundled at dev-server start instead of being discovered lazily on the first
`createSandbox()` — which would cost a re-optimize and a page reload exactly when the
player clicks Fight. `include` ids resolve from this package's root, which is why the two
quickjs packages are direct dependencies here as well as in `@rematch/sandbox`.

The build emits the variant as its own `quickjs` chunk (~730 kB raw, ~275 kB gzipped),
loaded lazily on boot. Rollup warns that `fs` was externalized for the browser: that is
the variant's unused `wasmfile` code path, and the embedded-WASM path never touches it —
which the e2e suite proves by loading a strategy in the built bundle.
