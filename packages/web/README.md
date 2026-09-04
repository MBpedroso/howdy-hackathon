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

## What exists today (Milestone 4)

A five-round fight, and **the interlude** (spec §2.2) between rounds: after a win, a
full-screen overlay plays the four beats — Replay, Analysis, Rewrite, Trial — from a
stream of `RewriteEvent`s, shows at least one harness rejection and the fix that
follows it, and then starts the next round against the strategy that was approved.

The interlude is driven entirely by that event stream, which means it has **three
interchangeable sources** — and the badge in the footer always says which one you are
looking at, because that is the only thing about the demo that could be dishonest:

| `?agent=` | Badge | What it is | Costs |
|---|---|---|---|
| `sse` / *(deployed default)* | `LIVE` | the server running the Analyst → Coder → harness loop **right now** | API tokens |
| `recorded` | `RECORDED RUN · <model> · <date>` | a **real** past run of the model, replayed from a committed JSON asset. Real prose, real candidate files, real harness verdicts | nothing |
| `mock` / *(localhost default)* | `MOCK` | a hand-scripted run, timed from real measurements, shipping a strategy the harness really approved | nothing |

`pnpm dev` with no server, no API key and no network plays any of the free two:

```
pnpm dev
open 'http://localhost:5173/?agent=recorded&autostart=1'   # a real run, replayed
open 'http://localhost:5173/?agent=mock&autostart=1'       # the scripted one
```

### Recorded runs — the demo video's source

`public/recorded/` holds three runs from `pnpm eval:agents` on 2026-09-03
(`gpt-5.4-mini`, round 2, 200 Gate 3 matches per candidate), listed in `index.json`:

| `?run=` | What happens | Approved | Wall |
|---|---|---|---|
| `mimic-camper` *(default)* | 3 candidates rejected by Gate 3, then approval on attempt 2 | `Warden I` | 23.5 s |
| `dodger-a` | 8 candidates rejected across 3 attempts, then approval | `Lantern III` | 35.8 s |
| `kiter-a` | 7 candidates rejected across 3 attempts, then approval | `Warden I` | 39.8 s |

All three were picked for the same reason: each is **approved after at least one Gate 3
rejection**, which is the shape spec AC 6 asks for. The terminal `done` carries the
source the harness actually approved, and the next round really loads it through
QuickJS — `e2e/recorded.spec.ts` proves that by reading the boss's name off the Round 2
HUD, which a replay cannot fake.

**What is real and what is reconstructed.** Every event is verbatim from the eval
artifact: the Analyst's prose, the streamed candidate files, every gate result and
rejection sentence, and the approved `meta`. The one derived thing is the **per-event
cadence** — the artifact records no timestamp per event — so offsets come from the
durations it *does* measure (`analysis.done.ms`, each candidate's `coder.ms`, every
gate's `ms`) and are scaled so the replay lasts exactly as long as the real run did.
Phase boundaries are measured; spacing inside a phase is interpolated. Each file states
this in its own `timing.method`, and `scripts/timeline.ts` explains the arithmetic.

Two things the recorder strips, and nothing else: `done.result.attempts` (up to twelve
full strategy files whose bytes are already in the stream's `rewrite.done` events, and
which nothing in the client reads) and the other nine runs of the eval. Prompts and
credentials were never in the events to begin with — the recorder greps the finished
bytes for `sk-`, bearer tokens and prompt fields and refuses to write on a hit.

To record another run from an eval artifact (reads a local file; **no network, no key**):

```bash
pnpm --filter @rematch/web record:run \
  ../../artifacts/agents/eval-2026-09-03T23-53-46-645Z.json mimic-camper dodger-a kiter-a
```

It refuses any run that was not approved, or that shows no harness rejection — a run
without a rejection is not evidence of the loop.

### Demoing it in a hurry

The interlude only happens after a round is won, and winning Round 1 by hand takes
~30 s. To jump straight to it, replay the recorded round:

```js
// dev server only, in the console, on ?agent=mock&autostart=1
const f = await (await fetch('/e2e/fixtures/inputlog-round1.json')).json();
await __rematch.driveWith(f.log); __rematch.fastForward();
```

The e2e suite does exactly this; `?speed=` makes the mock run faster than real time.

## URL parameters

| Parameter | Effect |
|---|---|
| `?seed=<n>` | Fix the session seed (decimal or `0x…`). Every round seed is derived from it, so one URL reproduces a whole session. Absent = one `crypto.getRandomValues` call, the only non-determinism in the client. |
| `?autostart=1` | Skip the start screen and begin Round 1 immediately (used by the e2e suite). |
| `?round=<1-5>` | Start at a given round number. |
| `?strategy=hound` | Load the alternate bundled strategy instead of Round 1's. `hound` is the only strategy that spends `charge`, so it is how the charge telegraph gets exercised. |
| `?agent=mock` | Force the mock interlude source. Always works offline. |
| `?agent=recorded` | Replay a real recorded run (`public/recorded/`). Offline, free, badge reads `RECORDED RUN`. |
| `?run=<name>` | Which recorded run to play. Default: the first in `public/recorded/index.json`. |
| `?agent=sse` | Force the live server source, with **no** mock safety net — so a broken server is visible instead of being papered over. |
| `?speed=<n>` | Divide every mock **or recorded** delay by `n`. The mock is ~25 s at `1`, `mimic-camper` 23.5 s; the e2e suite runs at `20`. |
| `?interlude=0` | Keep the pre-interlude "Round N cleared" screen. Used by `e2e/controls.spec.ts` to test the outcome path without a 25-second overlay in the way. |
| `?autofight=0` | Do not auto-continue 3 s after the interlude finishes; wait for the FIGHT button. |
| `?deadline=<ms>` | Shorten the 45 s interlude deadline, to see the spec AC 5 fallback path on a machine where everything works. |

## The interlude

```
src/interlude/
  events.ts      the `RewriteEvent` union — a COPY of `packages/agents/src/events.ts`
  source.ts      `InterludeSource`, `sseSource`, `mockSource` selection, the wire contract
  sse.ts         SSE frame parser (the stream is a POST, so `EventSource` is unusable)
  mock.ts        the scripted ~25 s run, including one Gate 3 rejection
  recorded.ts    `recordedSource` — replays a real eval run from public/recorded/
  diff.ts        a small unified diff, for the mock only
  ui.ts          the four-beat overlay (`meterView` is the Gate 3 bar, DOM-free)
  replayViz.ts   beat 1's heat grid, dash rose and timeline strip
  index.ts       `createInterludeHandler` — the `onRoundWon` implementation
  fixtures/attempt1.js   mock data: the "too hard" first draft. Never executed.

public/recorded/    three real eval runs + index.json (see "Recorded runs" above)
scripts/record-run.ts   builds those assets from an eval artifact. No network.
scripts/timeline.ts     reconstructs per-event offsets from measured durations.
```

`events.ts` is a copy rather than an import **on purpose**: `@rematch/agents` reaches
`@rematch/harness` (workers, filesystem) and `@rematch/server` (the Anthropic SDK and
the API key), and none of that may be reachable from a browser bundle. The web
package's dependencies stay `engine`, `contract`, `sandbox`. Change one file and you
change the other in the same commit.

Beat 1 draws only what the Analyst is given — the 8×8 position heat, the 8-bin dash
rose and the downsampled timeline — so the player and the agent are looking at the
same three pictures at the same moment.

### `POST /api/rewrite` — the contract the server implements

Request body (`content-type: application/json`):

```jsonc
{
  "round":      2,          // the round being WRITTEN (the player just won round 1)
  "seed":       3221225473, // that round's seed; keeps a seeded fallback reproducible
  "summary":    { ... },    // engine `ReplaySummary` of the round just won
  "prevSource": "export const meta = ...",   // the strategy that just lost
  "prevMeta":   { "name": "Cornerbreaker", "rationale": "...", "version": 1 }
}
```

Response: `200`, `content-type: text/event-stream`, one frame per `RewriteEvent`, in
the order `rewrite()` emits them:

```
event: verdict
data: {"type":"verdict","attempt":1,"approved":false,"reason":"0.91 vs panel — too hard …"}

: keep-alive

event: done
data: {"type":"done","result":{"approved":true,"source":"…","meta":{…},"attempts":[…]}}
```

- The `event:` name must equal the payload's `type`. The client reads `type` from the
  JSON; the name is there so `curl -N` and a proxy's logs are readable.
- `analysis.delta` carries the Analyst's **prose only** — the sentences the panel types
  out. The JSON block it ends its reply with is withheld from the stream (see
  `analysisGate` in `@rematch/agents`) and arrives whole on `analysis.done.raw`, which is
  for the run log rather than the screen.
- `rewrite.done` carries `meta` — the `{ name, rationale, version }` parsed out of that
  attempt's own source. The Rewrite panel labels the diff with `meta.name`; it may be
  absent (a file whose `meta` is not a literal, which Gate 1 rejects), and the panel then
  shows the attempt number alone.
- `trial.progress` is Gate 3's real progress: `matchesDone: 0` first, carrying the total,
  then one event per batch of finished matches, then `matchesDone === matchesTotal`. The
  meter is a readout of those numbers — no duration estimate, no cap — so a stream that
  sends only the two ends leaves the bar sitting still, and one that sends a frame per
  match is 200 frames of noise.
- One JSON object per frame. Multi-line `data:` is parsed but not required.
- **The stream must end with a `done` frame, and `done` must be last.** Everything
  needed to start the next round is in `result`.
- `fallback` may precede a `done` whose `result.approved` is `false`. That pair is
  spec AC 5's visible fallback and the client renders the banner from it.
- On a non-approved `done` the server attaches its pool pick as
  `result.fallback: { name, source }` (`pickFallback(round, seed)`). The client
  **prefers it** over its own bundled last resort — a pool entry is balance-tested
  for that round — and names it in the banner. It is read structurally, so a server
  that omits it still works.
- Comment frames (`: keep-alive\n\n`) are ignored — the right way to stop a proxy
  idling the connection out.
- An unknown `type` is dropped (a newer server, an older client). A malformed frame is
  dropped without ending the stream.
- A non-2xx, a dropped connection or a body that is not an event stream is handled
  client-side and is never a hang: mid-stream it becomes a visible fallback, and
  before the first event it falls through to the mock on localhost.

### Deadlines and fallbacks (spec AC 5)

| Layer | Budget | On expiry |
|---|---|---|
| The agents loop, server-side | 40 s (`DEADLINE_MS`) | emits `fallback` + `done`, ships from the server's fallback pool |
| The interlude, client-side | 45 s (`?deadline=` to shorten) | aborts the source, shows *"Using a pre-approved strategy — the coder timed out"*, keeps the FIGHT button |
| The safety-valve `skip` button | appears at 50 s | same, on the player's command |

When the server sends a `done`, its `result.fallback` pool pick is what ships. The
client's own last resort — the bundled `hound` strategy — covers the two cases where
no pick can arrive: the server is unreachable, or the client's deadline fired before
any verdict.

## `window.__rematch.interlude`

`{ events: RewriteEvent[], state }` while an interlude is on screen, `null` otherwise.
`state` carries the phase, the attempt, every gate result, the append-only rejection
log, the approval, the fallback and the elapsed milliseconds — the interlude is the one
part of the product that cannot be asserted from the game state, so `e2e/interlude.spec.ts`
reads this.

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
__rematch.runnerStats()  // decide counters: calls, idle, failures by kind, p50/p99 ms
__rematch.startRound(n)  // jump to a round
await __rematch.driveWith(log)   // restart this round and replay a recorded input log
__rematch.fastForward(n)         // run n ticks synchronously, no rAF
```

## When the boss stands still

A playtester reported: *"after winning Round 1 the interlude ran and the Round 2 boss
just stood still in a corner of the screen for the whole round."* It really did, and the
useful part of the story is that **four different causes produce that exact picture** and
nothing on screen told them apart:

| Cause | What the engine does | What you would have seen |
|---|---|---|
| The strategy returned `{type:'idle'}` | applies it — a legal action, no cooldown, no violation | nothing |
| The strategy returned an invalid action | `idle` + a violation | nothing |
| `decide` blew its deadline | `idle` + a violation, and (after a streak) `strategyKilled` | nothing |
| The strategy ran out of memory | `idle` + a violation, sticky forever | nothing |

It was the first row: `round2-candidate.js` drifted onto the centre of the player's
hottest heat cell and idled from then on, because the heat map is cumulative and never
decays, so the "habit" was a cell the player had left. 219 idle ticks out of 510 against
the recorded playtest log, one motionless run of 263 ticks, and **zero** violations.

Two things changed so the next one is a five-second diagnosis:

1. **The HUD's diagnostics line carries the counters** (`src/ui/hud.ts`,
   `formatRunnerLine`). `d 0.03/0.11ms` is the `decide` p50/p99; then, only when they are
   worth reading, `idle 43%`, `viol 12`, `2 timeout`, `x14` (the longest run of
   *consecutive* failures) and `KILLED`. The line turns amber when any of them fires, so
   "the boss is stalling" is legible from the back of a room instead of being guessed at.
2. **`__rematch.runnerStats()`** exposes the same numbers to a test.
   `e2e/boss-activity.spec.ts` is the regression test: it replays the recorded human log
   into Round 2 and asserts the boss travels, is never motionless for more than 90 ticks,
   and is not failing quietly. (The travel assertion alone is not enough — the frozen
   version still travelled 400 px before it parked. The motionless-run bound is the one
   that catches it.)

### It is a gate now

The same `idle` fallback was in nearly every hand-written strategy in the repo, so on
2026-09-04 the property stopped being a test and became **Gate 3's third assertion,
ACTIVE**: more than 90 motionless ticks (1.5 s) against any reference bot, or a p90 idle
fraction over 0.25, and a strategy does not ship. It is defined on *displacement*, not on
the action type, which is what catches the other half of the bug — a `move` that walks
into the arena edge is accepted, moves the boss nowhere, and looks exactly as crashed.

Both files here were fixed and re-measured:

- `src/strategies/round1.js` — its resting state is now a patrol across the heat cell it
  is guarding, and its `spawn` is rate-limited by tick. (It asked for a minion whenever
  the cooldown was ready; a `spawn` refused at the two-minion cap keeps its cooldown and
  costs a violation, so with two minions alive it asked *every tick*, froze, and never
  reached its own burst branch.) 169 motionless ticks → 1. The scripted mid-range player
  still wins 1.00 of 60 seeds in 16.6 s, which is the number Round 1 is held to; the AC 3
  replay fixture was regenerated (`pnpm gen:inputlog`), because a different boss produces
  a different input log.
- `src/strategies/hound.js` — same `spawn` fix, and a strafe when it is standing on top
  of the player. 98 → 1.

Neither is byte-identical to its `@rematch/contract` reference fixture any more; the
fixtures are the harness's *calibration* corpus (`idle` is its zero point) and were left
alone deliberately. See `docs/SYSTEM.md` §9 item 10 for the whole survey and
`packages/harness/src/sim/activity.ts` for the definition.

## The `decide` deadline is not the same number in live play

`CONSTANTS.limits.decideBudgetMs` is 2 ms. That is a **harness** number: it is the frame
budget a strategy promises to keep, and Gate 4 is where the promise is judged — against
the p99, over ~2000 calls. Enforcing the same 2 ms *per call* against `performance.now`
in a live tab measures something else: whether the browser scheduled a GC or a compositor
pass inside this one call. Measured p99 in headless Chromium is 0.3 ms for every shipped
strategy (0.06 ms in Node), so there is 6x of headroom — and a single scheduling hiccup
still blows it, and the engine answers a blown deadline with an idle tick.

So `src/game/strategy.ts` multiplies the budget by `LIVE_BUDGET_FACTOR` (10x → 20 ms) for
live play. The sandbox is unchanged and a runaway `while (true)` is still stopped inside a
frame; that containment is the only thing the live deadline is for. The *deterministic*
guarantee belongs to replays and to the harness simulation, both of which run the sandbox
on the monotonic clock (`@rematch/sandbox`'s `monotonicClock`), where the budget bounds
work rather than wall time.

## Determinism (spec AC 3)

`e2e/fixtures/inputlog-round1.json` is a full Round 1 played by the engine's scripted
pseudo-player, recorded in Node by `scripts/gen-inputlog.ts` together with the final state
hash Node computed. Two tests guard it:

- `test/replay-fixture.test.ts` (in `pnpm verify`) replays it **in Node** and asserts the
  recorded hash still holds — so a change to an engine rule or to `round1.js` fails here
  first, with instructions, instead of failing confusingly in the browser.
- `e2e/determinism.spec.ts` replays it **in the browser** through `driveWith` +
  `fastForward` and asserts the same hash.

`e2e/interlude.spec.ts` uses the same log for a different reason: it is the cheapest
way to reach a *won* round, which is the only state the interlude exists in.

Both sides inject the sandbox's monotonic clock (`src/game/clock.ts`, which now re-exports
`monotonicClock` from `@rematch/sandbox` so the harness simulator can use the identical
one). A real clock would make replays *slightly* non-reproducible: the sandbox enforces the
`decide` deadline against `now()`, and a GC pause can push one call over budget, which the
engine turns into `idle` + a violation. Live play keeps `performance.now` and the relaxed
budget above, where that deadline is a containment control and must be real.

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
| `src/interlude/` | The four-beat interlude and its event sources. See above. |
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
