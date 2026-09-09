# SYSTEM — the agentic architecture of REMATCH

Companion to [`SPEC.md`](SPEC.md) (§8: *"full detail in SYSTEM.md"*) and
[`AI-DEV-LOG.md`](AI-DEV-LOG.md). Every number here comes from a file in this repo or
from a command whose output is quoted; where something is not yet proven, it says so.

---

## 1. Thesis

Agents are safe to give real autonomy when a deterministic harness gates their output.
REMATCH makes that claim testable by giving an agent genuine power over the product — the
boss's behaviour is executable code the agent writes at runtime, in the middle of the
player's session — and then putting a verifier with final say in front of it. Between
rounds, an **Analyst** reads a compressed replay of the round the player just won and
describes the player; a **Coder** writes a new `strategy.js` to counter that specific
player; and a **harness** of four gates (no LLM anywhere in it) decides
whether it ships. The harness's one-sentence rejection is the Coder's only feedback, it
travels verbatim, there is no human message anywhere in the loop, and the player watches
the whole exchange — rejections included — as the interlude between rounds. The
verification is not a safety appendix bolted onto the demo; it *is* the demo.

---

## 2. Architecture

Built from the code as it stands at `069be8d`, not from the spec's sketch. Package
dependency arrows are the `dependencies` fields in the seven `package.json` files.

```
┌───────────────────────────────── BROWSER (@rematch/web, Vite + Canvas 2D) ─────────────────────────────────┐
│                                                                                                            │
│   input.ts ──▶ loop.ts (fixed 60 Hz accumulator, ≤5 catch-up steps/frame)                                  │
│                    │                                                                                       │
│                    ▼                                                                                       │
│              @rematch/engine  step(state, input, runner) ──── buildBossView ───▶ @rematch/sandbox           │
│                    │            deterministic, seeded xorshift, no DOM              QuickJS WASM            │
│                    │                                          ◀── BossAction ───   strategy.js runs here   │
│                    │                                              (validateAction, engine side)             │
│                    ▼                                                                                        │
│              render/  +  ui/ (HUD: HP pips, timer, boss strategy panel = meta.name + meta.rationale)        │
│                    │                                                                                       │
│         round won  ▼                                                                                        │
│              interlude/  ◀───────────── RewriteEvent stream ─────────────┐                                  │
│                └ beat 1 Replay  (heat grid · dash rose · timeline)       │  sse.ts parses SSE frames        │
│                  beat 2 Analysis (streamed prose)                        │  mock.ts is the offline source   │
│                  beat 3 Rewrite  (unified diff, labelled meta.name)      │                                  │
│                  beat 4 Trial    (gate ticks · progress meter · verdicts)│                                  │
└──────────────────────────────────────────────────────────────────────────┼──────────────────────────────────┘
                                                                          │
                     POST /api/rewrite  { round, seed, summary, prevSource, prevMeta }
                                                                          │  text/event-stream
                                                                          │  one frame per RewriteEvent
┌──────────────────────────────── SERVER (@rematch/server, node:http) ─────┴──────────────────────────────────┐
│  http.ts  ─ CORS allow-list · 512 KB body cap · 6 rewrites/10 min per IP · 10 s keepalive comments          │
│      │      deadline 40 s + 5 s grace · client disconnect → AbortSignal → provider stream                   │
│      ▼                                                                                                      │
│  handleRewrite(body, emit, signal)   ── no `req`, no `res`, no framework ──▶ @rematch/agents rewrite()      │
│      │                                                                                                      │
│      ├─ fallback.ts   8 pre-approved strategies, 2 per round for rounds 2-5, seeded pick                   │
│      └─ log.ts        one JSON line to stdout + the full event log to artifacts/server/rewrite-<ts>.json    │
└─────────────────────────────────────────────┬───────────────────────────────────────────────────────────────┘
                                              │
┌────────────────────────── @rematch/agents (the autonomous loop, src/loop.ts) ───────────────────────────────┐
│                                              ▼                                                              │
│   runAnalyst  ──▶ Analysis { observations[], playerArchetype, counterPlan }                                  │
│      ▲ context: rendered ReplaySummary only. No code, ever.                                                 │
│      │                                                                                                      │
│      └── LLMProvider ── anthropicProvider (streaming SDK) | mockProvider (every test)                       │
│                                              │                                                              │
│   for attempt in 1..4:                       ▼                                                              │
│       runCoder ──▶ strategy.js   (staticCheck self-retry once, then submit anyway)                          │
│           ▲ context: contract doc + Analysis + prev source + band + harness rules/hints                     │
│           │                                                                                                 │
│           │        ┌──────────────── @rematch/harness (deterministic, NO LLM) ─────────────┐                │
│           │        │  Gate 1 static ─▶ Gate 2 fuzz ─▶ Gate 3 balance ─▶ Gate 4 perf        │                │
│           │        │   acorn AST      500 states +    62-202 matches     p99 vs 2 ms       │                │
│           │        │   ~1 ms          60 ticks, in    across a worker    over ~2000 calls  │                │
│           │        │                  QuickJS         pool               (real trajectories)│               │
│           │        └───────────┬──────────────────────────┬─────────────────────────────────┘               │
│           │                    │ ok                       │ !ok                                             │
│           │                    ▼                          ▼                                                 │
│           │              APPROVED → ship          GateResult.reason (one sentence)                          │
│           └───────────────────────────────────────────────┘  verbatim, nothing rewords it                   │
│                                                                                                             │
│   exhausted / deadline / error → emit `fallback` → server ships a pool entry, visibly                       │
└─────────────────────────────────────────────────────────────────────────────────────────────────────────────┘

@rematch/contract — the frozen boundary. ZERO workspace dependencies. Consumed by all six others.
                    types · CONSTANTS · validateAction · staticCheck (Gate 1) · StrategyRunner
```

Dependency edges, verbatim from the manifests:

| Package | Workspace dependencies | External |
|---|---|---|
| `contract` | *(none — deliberately)* | `acorn` |
| `engine` | `contract` | — |
| `sandbox` | `contract` | `quickjs-emscripten{,-core}`, `@jitl/quickjs-singlefile-cjs-release-sync` |
| `harness` | `contract`, `engine`, `sandbox` | — |
| `agents` | `contract`, `engine`, `harness` | `@anthropic-ai/sdk`, `acorn`, `diff` |
| `server` | `contract`, `engine`, `harness`, `agents` | — |
| `web` | `contract`, `engine`, `sandbox` | `quickjs-emscripten-core`, `@jitl/quickjs-singlefile-cjs-release-sync` |

`web` deliberately does **not** depend on `agents`: that would pull `harness` (workers,
filesystem) and the Anthropic SDK into a browser bundle. `packages/web/src/interlude/events.ts`
is a hand-maintained copy of `packages/agents/src/events.ts` for exactly that reason.

---

## 3. The Boss Contract is the boundary

The agents do not write game code. They write a *strategy*: a module that is handed a
read-only `BossView` each tick and must return one `BossAction` from a fixed menu.
Nothing dangerous is **expressible**; all the creativity is in *when* and *where*.

```ts
export const meta = { name: string, rationale: string, version: number };
export function init(): Memory;                        // once per round
export function decide(view: BossView, mem: Memory): BossAction;   // once per tick
```

### What a strategy can do

Return one of six actions. That is the entire output alphabet:

```ts
| { type: 'move';   dx, dy }              // any magnitude; normalized to a unit vector
| { type: 'burst';  angle, count: 3|5|8 } // 3 and 5 are cones; 8 is a full 2π ring
| { type: 'charge'; angle }               // telegraphed 20 ticks
| { type: 'slam';   x, y }                // telegraphed 40 ticks, must be in bounds
| { type: 'spawn';  x, y }                // one minion, max 2 alive
| { type: 'idle' }
```

Its inputs are the tick, the arena size, boss and player kinematics, live projectiles,
and three summaries (`playerPosHeat` 8×8 summing to 1, `playerDashDirs` 8 bins,
`playerShotsDuring` per primitive) — **cumulative from tick 0, not rolling**, a property
§13 delta 20 of the spec records and `harnessHints` (`packages/agents/src/context/prompts.ts`)
warns the Coder about explicitly; the contract's own type comment
(`packages/contract/src/types.ts`) is silent on cumulative-vs-rolling and should not be
read as making the claim. It can keep an opaque `Memory` object between ticks
and call a seeded `rand()`.

### What it cannot do

**Boss HP and damage numbers are not in the contract.** A strategy can make the boss
smarter, never tougher. Cooldowns, speed caps, arena bounds, projectile speed and damage
are engine constants; an action asked for while its primitive is on cooldown is coerced
to `idle` and counted as a contract violation.

`FORBIDDEN_IDENTIFIERS` — `packages/contract/src/staticCheck.ts`, rejected by Gate 1
before a byte executes, including as a local binding (shadowing `const Function = 1` is
rejected too: cheap and strict beats scope tracking):

```
Date  fetch  XMLHttpRequest  globalThis  window  self  global  process  require
eval  Function  setTimeout  setInterval  setImmediate  queueMicrotask  Promise
WeakRef  FinalizationRegistry  Proxy  Reflect  Atomics  SharedArrayBuffer
WebAssembly  Intl  console  document  navigator  location  localStorage
sessionStorage  indexedDB  crypto  performance  structuredClone  Worker
SharedWorker  MessageChannel  Buffer  module  exports  __dirname  __filename
Deno  Bun  importScripts
```

plus `Math.random` (named, computed, or destructured), `import` / dynamic `import()`,
`with`, `new Function`, `debugger`, top-level `this`, any export other than
`meta` / `init` / `decide`, and a non-literal `meta`. The 16 rules are enumerated in
`STATIC_RULES`.

Gate 1 rejects the **names**. `@rematch/sandbox` makes the capabilities **unreachable**
even if Gate 1 were bypassed: `Date`, `RegExp`, `Proxy` are never constructed as
intrinsics; the prelude deletes `eval`, `Function`, `Promise`, `Reflect`, `globalThis`,
`BigInt*`, `SharedArrayBuffer`, the URI functions and `Math.random` from the global
object, then freezes `Math` and `JSON`, then deletes `constructor` from every function
prototype so `(function(){}).constructor` no longer reaches `Function`. QuickJS ships no
host bindings at all, so `fetch`, `setTimeout`, `console`, `process`, `require`, `crypto`
and `performance` were never there — asserted in
`packages/sandbox/test/containment.test.ts` (11 cases, run with Gate 1 deliberately
bypassed via `loadUnchecked`).

Exactly one value type crosses the boundary: a string.
`JSON.stringify(view) → __rematch_tick(json) → JSON.parse → decide → JSON.stringify({v: action})`.
No host function is exposed to the VM.

### Runtime limits — `CONSTANTS` (`packages/contract/src/types.ts`)

| Limit | Value | Enforced by |
|---|---|---|
| `arena` | 800 × 800 px | engine |
| `ticksPerSecond` | 60 | engine |
| `cooldowns` | `move 0`, `burst 90`, `charge 150`, `slam 210`, `spawn 300` ticks | engine; `validateAction` reports |
| `telegraphs` | `charge 20`, `slam 40` ticks | engine |
| `limits.memoryBytes` | 4096 — `JSON.stringify(mem)` in UTF-8 bytes, re-measured every 60 calls, **sticky** once blown | sandbox |
| `limits.decideBudgetMs` | 2 ms per `decide` — a **harness** number (see below) | sandbox interrupt handler → `{kind:'timeout'}` |
| `limits.sandboxMemoryBytes` | 67 108 864 (64 MB) heap | `runtime.setMemoryLimit` |
| `limits.sourceBytes` | 32 768 | Gate 1 |
| `limits.metaNameMaxChars` | 40 | Gate 1 |
| `limits.maxMinionsAlive` | 2 | engine |
| stack | 128 KB (`maxStackBytes`) | `runtime.setMaxStackSize` → clean in-VM `stack overflow` |

#### `decideBudgetMs` is one constant with three jobs, and only one of them is a promise

The deadline is enforced against `SandboxOptions.now`, which decides what the budget
actually *bounds*:

| Caller | Clock | Budget | What the limit is for |
|---|---|---|---|
| Gate 2 (fuzz) | `monotonicClock()` | 2 ms of *interrupt polls* | **Containment, reproducibly.** A `while (true)` must come back as a value, fast — and since *any* single failure is a Gate 2 rejection, that verdict must not depend on the machine |
| Gate 4 (perf) | `performance.now` | 16 ms (8× slack), judged against 2 ms | **Measurement.** The p99 is the promise; measuring at the shipping deadline would report every slow strategy as exactly 2.0 ms. The one gate whose verdict is deliberately *not* reproducible |
| Gate 3 / the simulator | `monotonicClock()` | 2 ms of *interrupt polls* | **Reproducibility.** Spec §6.2 promises "fixed seed set → identical results on every machine", and wall clock breaks that promise |
| Replays (browser + Node) | `monotonicClock()` | 2 ms of polls | Reproducibility — the AC 3 hash |
| Live play (browser) | `performance.now` | 20 ms (`LIVE_BUDGET_FACTOR = 10`) | Containment only. Best-effort, never a determinism claim |

The simulator's clock is not a nicety. With wall clock, one GC pause inside one `decide`
returns `{kind:'timeout'}`, which the engine answers with an idle tick and a violation —
and from there that match differs from the same match anywhere else. Measured before the
change: **2 phantom violations per 60 matches** for a strategy that commits none, and the
same source reading **0.43 and 0.45** against the panel on back-to-back runs. On the
monotonic clock the budget bounds work instead of time (~256 interrupt polls), a runaway
loop is still caught deterministically in ~35 ms of wall clock, and Gate 2 in front of
Gate 3 is what keeps that worst case off the simulator.

**Gate 2 was on the wrong clock until 2026-09-08**, and the table above said
`performance.now` for it as a design choice when it was an oversight. The reasoning that
put the simulator on the monotonic clock applies to Gate 2 with more force, not less:
Gate 2 rejects on *any* single runner failure, so one descheduled `decide` is the entire
verdict, against a docstring promising that "(states, seed) is all you need to reproduce
a rejection". An independent review measured a strategy sitting near the budget at **0
over-budget states on an idle machine and 4 of 560 on a loaded one**
([`REVIEW-2026-09-08.md`](REVIEW-2026-09-08.md) §2). Gate 2's whole `detail` — the timing
distribution included — is now bit-identical across runs, and `p50` comes back as an
exact multiple of `MONOTONIC_STEP_MS`, which is what `test/gates.test.ts` asserts to prove
*which* clock ran. The consequence is a cleaner split than before: **Gate 2 asks whether
the strategy is correct and terminates, Gate 4 asks whether it is fast.** "Slow but
finite" is no longer a Gate 2 rejection at all.

So the harness is three reproducible gates and one measurement, not "four deterministic
gates" as §1 and the README said until 2026-09-08 (spec §13, delta 18). Gate 4 keeps the
wall clock on purpose — "fast enough to render at 60 Hz" is a question about real time,
and a monotonic step clock would make every strategy pass it — which means a strategy
whose p99 sits near 2 ms can pass on a quiet laptop and fail on a loaded CI box. That is
correct behaviour for a performance gate and it has to be *said* rather than glossed.

Live play goes the other way. Every shipped strategy's `decide` p99 is 0.3 ms in headless
Chromium and 0.06 ms in Node — 6× under the 2 ms budget — and a single scheduling hiccup
still blows it, for which the boss pays an idle frame. So the browser relaxes the budget
by 10× and keeps only the containment guarantee. Determinism is claimed for the harness
simulation and for replays, both on the monotonic clock; live play is explicitly
best-effort. (`packages/web/src/game/strategy.ts`, `packages/web/README.md`.)

#### `strategyKilled` needs a streak, not one bad tick

`timeout` is not sticky in the sandbox: the next call may well succeed. So one blown
deadline is one idle tick plus one violation, and `state.strategyKilled` is only set after
`TIMEOUT_KILL_STREAK` (30, half a second) **consecutive** timeouts — or immediately on a
`memory` failure, which the sandbox *does* make sticky. It matters because
`strategyKilled` is read back to the Analyst in its prompt ("was killed by the sandbox"),
and one hiccup on a loaded machine should not become a fact the next round is written
around.

`validateAction` is total — it never throws, for `null`, arrays, functions, symbols,
revoked Proxies or objects with throwing getters — and canonicalizing: the action it
returns is freshly built, so a property the contract does not name is never forwarded to
the engine.

---

## 4. The three runtime agents

Two are models. One is not, and that is the design.

| Agent | Context received | Context **denied** | Output |
|---|---|---|---|
| **Analyst** | the `ReplaySummary` rendered as text: heat map as an 8×8 digit grid, dash rose, shots-during table, duration, top-30 timeline, the round number, the previous strategy's `meta` | engine source, the contract, **any code at all** | `Analysis { observations[], playerArchetype ∈ {camper, kiter, rusher, dodger, mixed}, counterPlan }` |
| **Coder** | the Boss Contract doc, the Analyst's JSON, the previous `strategy.js`, the round + its fairness band + both Gate 3 assertions, how the harness judges it with real example rejections, measured engine hints, and on a retry the `GateResult.reason` **verbatim** plus a per-bot rate table | engine source, renderer, server | one `strategy.js` |
| **Harness** | the strategy source and a seed | — deterministic, no LLM, no network | `GateResult` — verdict + one-sentence reason |

The Analyst denial is the interesting one. It never sees a line of code, not even the
strategy that just lost, because its job is to describe a *player*, and handing it code
invites it to write code. Splitting the two contexts is why the Coder's prompt can be
mostly contract: someone else already did the reading.

**Both denials are tested, not intended** —
[`packages/agents/test/context.test.ts`](../packages/agents/test/context.test.ts):

- `describe('the Coder is denied the engine')` — reads
  [`packages/engine/src/index.ts`](../packages/engine/src/index.ts) at test time,
  extracts every name the barrel exports, and asserts none appears in the assembled
  Coder prompt. Add an engine export and the test starts checking for it without anyone
  remembering to. A second case checks the internals the spec names explicitly.
- `describe('the Analyst is denied all code')` — the same engine-export sweep over the
  Analyst prompt, plus an assertion that the prompt contains no code fence.
- `it('is tactics, not engine internals')` — the same sweep over the `harnessHints`
  section alone, so the section cannot become a leak on its own.

The Coder's contract doc is assembled at module load from `packages/contract/README.md`
and `packages/contract/src/types.ts` (`contractDoc()`). `contract` has zero workspace
dependencies and contains no engine internals by construction, so a doc built only from
those two files cannot leak an internal even by accident.

Prompt sizes (`promptSize`, asserted in `context.test.ts`): Analyst system ~1.5 k chars,
Analyst user ~2.5–3 k; Coder system ~11.3 k, byte-identical across every attempt and
sent with `cache_control: { type: 'ephemeral' }` so attempts 2–4 read it from cache;
Coder user ~2.5–3 k first attempt, +~230 chars on a retry. Measured on the run in §6:
Analyst prompt 5 128 chars, Coder prompts 13 505 / 13 524 / 14 977 chars.

The Coder also gets **one free self-retry** against `staticCheck` before the harness sees
the file: a stray mention of `Date` is a typo-class failure and shouldn't cost one of four
harness attempts. It is a courtesy, not a veto — if the second file is still invalid the
Coder submits it anyway (`staticInvalid: true`) and lets Gate 1 reject it for real,
because the harness, not the Coder, is the authority on what ships. Both facts are logged
(`coder.calls: 2`, `coder.selfRetry`) so the evidence stays honest about how many model
calls were made.

---

## 5. The four gates

`packages/harness/src/gates/`. No LLM is called anywhere in that package: a verdict is a
pure function of the source and a seed, so every rejection replays byte-for-byte — which
is what makes the rejections in the interlude evidence rather than anecdote.

| Gate | Name | Threshold | Cost |
|---|---|---|---|
| 1 | `static` | any `staticCheck` violation → reject. Names the first 3 with line numbers, counts the rest | ~1–4 ms |
| 2 | `fuzz` | 500 seeded states (corner cases first) + 60 consecutive ticks, in QuickJS. **Any** runner failure (throw / timeout / memory), even 1 in 500 → reject. Invalid-action rate > **2%** → reject. On-cooldown-action rate > **20%** → reject | ~30–60 ms |
| 3 | `balance` | `matches` (default **200**) split half vs the Mimic, half across the four panel bots, fixed seed set. **FAIR** (rejects): panel win rate ∈ `BAND[round]`. **ACTIVE** (rejects): longest motionless run ≤ **90 ticks** (1.5 s), p90 idle fraction ≤ **0.25**, and range over a match ≥ **56 px**. **ADAPTED** (reported, not enforced since 2026-09-08 — SPEC §13 delta 23): Mimic win rate ≥ **0.70** | seconds — worker-parallel |
| 4 | `perf` | `decide` **p99 ≤ 2 ms** over ~2000 calls: 60% from real match trajectories vs the four bots, 40% topped up from Gate 2's corpus. Measured with an 8× relaxed deadline and judged against the real one, so the reported number is honest. A memory failure is fatal regardless of timing | ~60 ms |

Gate 1 is first because it costs ~1 ms: a strategy that mentions `Date` never boots a
QuickJS runtime (spec AC 8, asserted in `packages/harness/test/runGates.test.ts` by
handing Gate 2 a sandbox that throws if it is ever used).

### The fairness band (`gates/balanceConfig.ts`)

```
ADAPTED :  win_rate(boss vs Mimic)  >= 0.70          reported, does not reject"
FAIR    :  win_rate(boss vs panel)  in BAND[round]   "…but a different approach still beats it"
ACTIVE  :  longest motionless run   <= 90 ticks      "…and it never looks crashed"
           boss range over a match   >= 56 px        "…and it is not stuck in one spot"
```

| Round | Band vs panel | Midpoint the Coder is told to aim at |
|---|---|---|
| 2 | 0.35 – 0.50 | 0.43 |
| 3 | 0.45 – 0.60 | 0.53 |
| 4 | 0.50 – 0.65 | 0.58 |
| 5 | 0.55 – 0.70 | 0.63 |

The panel is `Camper`, `Kiter`, `Rusher`, `Dodger` — four bots that play nothing like the
human. The **Mimic** is rebuilt from *this* player's replay: heat-map-weighted
positioning, dash-direction bias, shot timing. A boss that beats all four panel bots is
unwinnable and is rejected exactly as hard as one that beats none. Seeds come from a fixed
multiplicative-hash set (`seedsFor`, offset per assertion, so the panel and the Mimic are
never measured on the same matches) — identical verdicts on every machine.

Two engine facts make the FAIR number a total function of the outcome: a 60 s timeout
scores as a boss win (`bossWon: state.outcome !== 'playerWon'`), and `gate3Plan` rounds
the budget (`matches / 2 / 4`), so 60 requested really runs 62. The meter is labelled
with `gate3Plan().total`, not with what the caller asked for.

#### ACTIVE — the assertion a playtest bought, and the one a review bought (`sim/activity.ts`)

FAIR and ADAPTED are spec §6.2, though only FAIR rejects. ACTIVE is not in §6.2, and it exists because §6.2 cannot see the
bug a human found in ten seconds: **the boss standing perfectly still**. A tick counts as
idle when the boss did not move, is not telegraphing, is not mid-charge, and its last
action was `idle` *or* a `move` that displaced nothing; ACTIVE rejects when the worst run
of consecutive idle ticks over every match exceeds `ACTIVITY.maxIdleRunTicks` (90 = 1.5 s)
or the p90 per-match idle fraction exceeds `ACTIVITY.maxIdleFractionP90` (0.25).

Both of those are about **stalling**, and on 2026-09-08 an independent review showed that
is not the same question as "is the boss playing". Five lines:

```js
export function decide(view) {
  return { type: 'move', dx: view.tick % 2 ? 0.02 : -0.02, dy: 0 };
}
```

`validateMove` normalizes `move` to a unit vector, so the magnitude is discarded and the
boss steps its full 2.6 px *every tick*. Nothing about it is idle. It posted the best
possible numbers on both clauses above — `idle run 0t/90`, `p90 0%` — landed at panel 0.44
inside Round 2's band, scored **1.00 on ADAPTED** against the `camper` and `dodger`
replays, and was **approved for Round 2**. On screen it is a dot vibrating on one tile,
and camper and dodger are how a first-time player at a demo actually plays.

So ACTIVE grew a third measurement: `minSpanPx`, the diagonal of the boss's bounding box
over a match, which may not fall below `ACTIVITY.minSpanPx` — the boss's own diameter,
56 px. Over a whole 60-second round the boss must range at least its own width. The
narrowest of the eleven shipped strategies is `fallback/round5/tollkeeper` at 155.7 px;
the jittering strategy measures 2.6 px. It is kept as `harness/test/fixtures/jitter.js`
and `test/activity.test.ts` asserts both halves of the story: that the idle clauses still
see nothing wrong with it, and that the span clause rejects it.

Five design points, each of them load-bearing:

- **It is defined on displacement, not on the action type.** `fallback/round3/emberline`
  had no `idle` branch at all and still froze for 169 ticks: its orbit walked the boss
  into a corner, where `move` clamps at the boss's own radius and moves it nowhere. An
  action-type check would have passed it.
- **Telegraphs are excluded outright**, so the 40-tick slam tell and the 20-tick charge
  tell cost nothing. 90 is therefore pure slack, not a budget shared with the tells.
- **Three numbers, because each is gameable alone.** A max alone misses a boss that
  idles 80 ticks, twitches, and idles 80 more; a mean alone hides a quarter of the matches
  being dead; and *both* miss a boss that never stalls because it is busy going nowhere.
  Max for the freeze the player reports, p90 for the general deadness, span for the
  vibration. Note that path length cannot substitute for span — the jittering strategy
  racks up 9 000 px of `travelPx` inside a 5 px box, and `sim/simulate.ts` had in fact
  been reducing a `minTravelPx` aggregate for this exact purpose that Gate 3 never read.
- **The span clause is outside the two idle clauses' `else if` chain.** A boss that
  freezes for a stretch *and* creeps around one corner for the rest has two things to
  fix, and this sentence is the whole of the Coder's feedback.
- **It is measured on both halves of the budget** — panel *and* Mimic when there is one.
  The four scripted bots all walk scripted paths; the stall needed a *human*, who settles
  in a cell, leaves, and settles elsewhere, which is what makes a cumulative heat map
  stale. The Mimic is the closest thing the gate has to that player.

A third question this section does **not** answer, and deliberately: *does the boss
attack?* A playtest on 2026-09-08 found `fallback/round3/emberline` averaging 5.0 attack
primitives per 1000 ticks against 7.9–15.7 for every other shipped strategy, and it
passed every clause above — idle run 0, span 378 px — because its win rate belonged to
its minions and the clock. That strategy was rebalanced to 12.8 at a held 0.55, and the
property is now a *test* over the eleven shipped files
(`harness/test/activity.test.ts`, floor 6.0/1000t) rather than a gate assertion. The
reason is the data: across the 58 real candidate files from the 09-03 eval the attack
rate runs 0.5–21.3 with a median of 11.4 and no gap anywhere, so a floor of 6 would
reject 20 of 58 and one of that eval's six approvals sat at 1.6. The span clause had a
60x separation to aim at; this has none, and a gate that costs a third of the pass rate
to enforce a property the model cannot reliably hit is not a gate worth having. The
incentive underneath — `timeout = boss win`, so passivity is a winning strategy — is the
real cause and is untouched.

It costs nothing: the matches are already being simulated and the measurement is two adds
and a `hypot` per tick. `reason` names the fix, not the symptom:

```
boss motionless for 263 consecutive ticks (4.4 s) vs Kiter — never return idle as a
resting state; patrol, reposition or feint instead (limit 90 ticks)
```

```
boss never left a 3 px patch of floor over a whole match vs Camper — moving back and
forth on the spot is not playing; commit to a direction for long enough to change the
range you fight at (need 56 px)
```

The two assertions that reject are reported first and ADAPTED's advice last, all joined into the one sentence —
the win rate is what the Coder was aiming at, the stall is a bug in how it rests, and
neither masks the other. `detail.activity` carries the numbers and `detail.panel.perBot[]`
breaks the worst run down per opponent, so a rejection can say *which* approach froze it.

### Reason strings — the actual formats

`GateResult.reason` is the **only** feedback the Coder gets and it is shown verbatim to
the player (spec §2.2: *"The player must be able to read every rejection"*). So each one
is one sentence, quantitative where a number exists, and names the fix rather than the
symptom. Taken from the gate implementations and from real runs:

```
Gate 1  ✗ line 9: forbidden identifier 'Date'; line 13: forbidden identifier 'Date'
Gate 1  ✗ export: 'helper' is not one of meta, init, decide

Gate 2  ✗ returned an invalid action on 23.9% of states (134/560, limit 2.0%);
          most common: burst.angle must be a finite number, got NaN (108 states)
Gate 2  ✗ decide() threw 'cannot read property 'length' of undefined' on 135/560 states
          (first at state 7: tick 600, 0 projectiles, all cooldowns ready)
Gate 2  ✗ asked for a primitive that was still on cooldown on 47.9% of states
          (268/560, limit 20.0%): burst (238 states) — check
          view.boss.cooldowns[name] === 0 before returning that action
Gate 2  ✗ strategy memory grew past the 4096-byte limit (4902 bytes) on 141/560 states
          (first at state 360: tick 3436, 6 projectiles, every primitive on cooldown)

Gate 3  ✗ 0.78 vs panel — too hard (band 0.35–0.50 for round 2; Camper 1.00, Kiter 0.88,
          Rusher 1.00, Dodger 0.25)
Gate 3  ✗ 0.91 vs panel — too hard (band 0.35–0.50 for round 2; …); 0.41 vs Mimic — aim for >= 0.70 (not blocking)
Gate 3  ✗ 0.21 vs panel — too easy (band 0.35–0.50 for round 2; …)

Gate 4  ✗ decide() p99 = 16.4ms > 2ms over 21 calls (p50 = 16.23ms, max = 16.4ms;
          21 over budget, and 21 blew the 16 ms measuring deadline)
Gate 4  ✗ strategy memory grew past the 4096-byte limit (4872 bytes) on 1187/2000 decide() calls
```

Every string above was produced by running the shipping gates: Gate 1's and Gate 3's come
from the run in §6, Gate 4's from `gate4Perf` on `slow-decide.js` and `memory-hog.js`, and
Gate 2's from its own fixture corpus (`packages/harness/test/fixtures/`, one file per way a
runtime gate can reject). Note Gate 4's 21 samples: the measurement stops once more than 1%
of the target sample count is already over budget, because from there no remaining call can
bring the p99 back under it — a necessity, not an optimisation, since one pathological match
at the relaxed deadline is 3600 × 16 ms = 57 s.

Nothing in the system *parses* a reason to make a decision — that is what `gate`, `ok`
and `detail` are for. `detail` carries the machine-readable counts behind the sentence
(per failure kind, per validator reason, per primitive, per bot).

### How a rejection feeds back into the Coder prompt

`coderPrompt` appends one block, and it is **last** in the context on purpose — the
numbers in it are the target for this attempt:

```
# ATTEMPT 2 WAS REJECTED BY GATE 3 (balance)

Your win rate against each opponent in that simulation:

    Camper  1.00  <- unwinnable for that bot; this is what makes you too hard
    Kiter   0.88
    Rusher  1.00  <- unwinnable for that bot; this is what makes you too hard
    Dodger  0.25
    Mimic   1.00

The harness said, verbatim:

    0.78 vs panel — too hard (band 0.35–0.50 for round 2; Camper 1.00, Kiter 0.88, Rusher 1.00, Dodger 0.25)

That sentence is the whole of your feedback. Fix that, change as little else as
you can, and emit the complete file again.
```

The per-bot table goes **above** the reason so the sentence stays the last thing in the
context, and it exists because the sentence says the boss is too hard while the table says
*which opponent made it so* — 1.00 against Camper and Rusher with 0.25 against Dodger is a
different bug from 0.78 spread evenly. It is read structurally out of Gate 3's `detail`
(`balanceRates` in `loop.ts`), so a `detail` shape that drifts costs the Coder a table,
not the loop an exception. Only Gate 3 produces one; the other three gates append the
reason alone.

`loop.ts` also makes the **rejected file the next attempt's baseline**, not the round's
opening strategy: an attempt that missed the band by 0.06 is a far better starting point
than the boss that already lost, and the diff the player sees stays a diff of what
actually changed.

---

## 6. Autonomous Loop Evidence

**A real run. OpenAI `gpt-5.4-mini`, 2026-09-03, round 2, 200 Gate 3 matches per
candidate.** Replay `mimic-camper` from `pnpm eval:agents`. Its complete event log is
committed at
[`docs/evidence/eval-round2-2026-09-03.json`](evidence/eval-round2-2026-09-03.json),
together with the eval's aggregate numbers — **6 of 10 replays approved against spec
§7's 0.8 target**, which §9 item 1 is about. The other nine runs' event logs are not
committed; this sentence claimed they were until 2026-09-08.

**Wall clock: 23.5 s. 6 338 events. 7 model calls (1 Analyst + 6 Coder). 32 996 input /
8 576 output / 19 712 cached tokens. No human message anywhere.** Six candidate files
were written; the harness rejected five of them and approved the sixth.

You can watch this exact run in the browser, with no API key and no server:

```bash
pnpm dev
open 'http://localhost:5173/?agent=recorded&run=mimic-camper&autostart=1'
```

The interlude badge reads `RECORDED RUN · gpt-5.4-mini · 2026-09-03` throughout, and
Round 2 really loads the approved source through QuickJS — see "Recorded runs" in
[`packages/web/README.md`](../packages/web/README.md).

```
event: replay              round 2, summary of the round the player just won (canned: mimic-camper)

event: analysis.delta      "Player lived almost entirely in the bottom-left corner: cell 57
                            (x≈150, y≈750) for 33.4% and cell 56 (x≈50, y≈750) for 33.2%."
event: analysis.delta      "They also held the adjacent lower band, with cell 49 at 14.0%
                            and cell 50 at 13.8%."
event: analysis.delta      "They never dashed at all, so there's no evasive movement to read."
event: analysis.delta      "They opened damage early, landing the first hit on tick 36, then
                            kept firing steadily for 146 total shots while taking 0 damage."
event: analysis.done       playerArchetype: "camper"
                           counterPlan: "Put pressure directly into the bottom-left pocket,
                                         especially the x≈0–250, y≈650–800 band where they
                                         spent 94.4% of their time across four cells. …"
                           calls 1 · promptChars 5133 · 1638 in / 468 out / 1280 cached · 2966 ms

───────────────────────── ATTEMPT 1 — three candidate files, one context, three aim points
event: rewrite.delta  ×N   (c0, c1 and c2 stream concurrently and interleave)
event: rewrite.done        a1 c0 · conservative · meta.name "Warden I"        · 2269 bytes
event: rewrite.done        a1 c2 · aggressive   · meta.name "Warden III"      · 3179 bytes
event: rewrite.done        a1 c1 · balanced     · meta.name "Pocket Warden II" · 3148 bytes

event: trial.gate          a1 c0  ✓ Gate 1 static 0ms   ✓ Gate 2 fuzz 44ms
event: trial.progress      a1 c0  0/200 → 5 → 30 → 65 → 100 → 105 → 145 → 190 → 200/200
event: trial.gate          a1 c0  ✗ Gate 3 balance 909ms
                           — 0.04 vs panel — too easy (band 0.35–0.50 for round 2;
                             Camper 0.16, Kiter 0.00, Rusher 0.00, Dodger 0.00);
                             0.00 vs Mimic — didn't adapt (need >= 0.70)
event: verdict             a1 c0, approved false

event: trial.gate          a1 c1  ✓ Gate 1 static 0ms   ✓ Gate 2 fuzz 49ms
event: trial.gate          a1 c1  ✗ Gate 3 balance 760ms
                           — 0.62 vs panel — too hard (band 0.35–0.50 for round 2;
                             Camper 1.00, Kiter 0.04, Rusher 0.88, Dodger 0.56)
event: verdict             a1 c1, approved false

event: trial.gate          a1 c2  ✓ Gate 1 static 0ms   ✓ Gate 2 fuzz 26ms
event: trial.gate          a1 c2  ✗ Gate 3 balance 906ms
                           — 0.77 vs panel — too hard (band 0.35–0.50 for round 2;
                             Camper 0.64, Kiter 0.60, Rusher 1.00, Dodger 0.84)
event: verdict             a1 c2, approved false

event: verdict             attempt 1, approved false
                           → all three reasons AND the per-bot tables go into the
                             attempt-2 Coder prompt as a comparison table, under
                             "# ATTEMPT 1 WAS REJECTED BY GATE 3 (balance)"

───────────────────────── ATTEMPT 2 — the same three dials, aimed by what attempt 1 measured
event: rewrite.delta  ×N
event: rewrite.done        a2 c0 · conservative · meta.name "Warden I" · 3446 bytes · 8106 ms
event: trial.gate          a2 c0  ✓ Gate 1 static 0ms
event: trial.gate          a2 c0  ✓ Gate 2 fuzz 43ms      (500 states + 60 ticks, in QuickJS)
event: trial.progress      a2 c0  0/200 → 5 → 30 → 65 → 90 → 105 → 150 → 200/200
event: trial.gate          a2 c0  ✓ Gate 3 balance 840ms
                           FAIR    panel 0.39  ∈ [0.35, 0.50]   ✓
                                   Camper 0.96 · Kiter 0.16 · Rusher 0.00 · Dodger 0.44
                           ADAPTED Mimic 0.99  ≥ 0.70           ✓   ← spec AC 7
                           30 contract violations over 200 matches, 0 strategies killed
event: trial.gate          a2 c0  ✓ Gate 4 perf 56ms
event: verdict             a2 c0, approved TRUE

                           (the loop keeps measuring the rest of the band, and both
                            siblings miss it — which is the evidence that the approval
                            was a *choice* between measured files, not the first hit)
event: trial.gate          a2 c1  ✗ Gate 3 balance 670ms — 0.75 vs panel — too hard
event: trial.gate          a2 c2  ✗ Gate 3 balance 758ms — 0.51 vs panel — too hard

event: verdict             attempt 2, approved TRUE
event: done                approved · meta { name: "Warden I", version: 2, rationale:
                           "You hide in the bottom-left pocket, so I press that corner with
                            a little more force, then I still give you quiet beats to
                            answer it." }
```

**Spec AC 7, for this run: the approved candidate beats the `Mimic` bot 0.99, against
the ≥ 0.70 threshold** — a bot built from the player's own replay, so the boss adapted
to *this* player rather than getting generically harder. It is simultaneously inside the
fairness band at 0.39, which is the pair of numbers the whole verifier exists to
produce: hard enough to have learned something, fair enough to still be a game.

What this excerpt is evidence of, precisely:

1. **A rejection changed the model's next output with no human in the loop.** Attempt
   2's prompt contains attempt 1's three rejection sentences and their per-bot tables
   verbatim. The conservative dial went from 0.04 (too easy) to 0.39 (in band) — it
   moved *toward* the band it was told it had missed, and the aggressive dial, told it
   was at 0.77, came down to 0.51.
2. **The verifier really said no to strategies that ran.** All five rejected candidates
   passed Gate 1 and Gate 2 — they parse, and they execute in QuickJS for 60 ticks
   across 500 fuzzed states. They were rejected on *measured win rates*, not on a lint.
3. **Rejection is legible.** Every reason above is one sentence with the numbers in it,
   and it is the same string the player reads on the Trial beat.
4. **The gates are cheap enough to be honest.** Six candidates, 1 200 simulated matches,
   5.1 s of total gate time on 11 workers. The model, not the verifier, is the slow
   half — which is the point of §6's next paragraph.
5. **The window is bounded.** `MAX_ATTEMPTS = 4`, `DEADLINE_MS = 40_000` (inside AC 5's
   45 s, with room for one overshooting gate), and every other outcome ends in a visible
   `fallback` + `done` pair rather than a hang.

### Measured pass rate

> **Read this first: every number in this section predates Gate 3's ACTIVE assertion.**
> The evals ran on the evening of 2026-09-03; ACTIVE's two idle clauses were added on
> 09-04 and its span clause on 09-08. Re-grading all 58 gradeable candidate files from
> the K=3 eval against the harness as it stands —
> [`docs/evidence/recheck-active-2026-09-08.json`](evidence/recheck-active-2026-09-08.json),
> reproduce with `pnpm --filter @rematch/harness recheck:active` —
> **four of the six approvals fail the idle clauses today**, with idle runs of 161, 183,
> 762 and 155 ticks against the 90-tick limit and p90 idle fractions of 0.73–0.95
> against 0.25. They would not be approved on the attempt that approved them.
>
> That does **not** make the current pass rate 0.2. The loop receives the idle-run
> rejection as feedback and has four attempts; whether it recovers inside the deadline
> is unmeasured, and the deadline was already the binding constraint (see below). **The
> honest statement is that the current pass rate is unknown, and 0.6 is an upper bound
> measured against a weaker harness.** Re-measuring it means re-running `pnpm
> eval:agents` against a live key, which spends money and is a human decision — it is
> the top item in `AI-DEV-LOG.md`'s open list.
>
> The same re-grade answers the question the span clause raised, and answers it well: it
> rejects **0 of 58**. The narrowest real candidate is 86.9 px against the 56 px floor,
> and that one already fails an idle clause. A new gate clause can only lower the pass
> rate, so this was checked before it shipped rather than after.

Across the same evening's evals, all `gpt-5.4-mini`, round 2, 200 matches:

| Configuration | Runs approved | Pass rate |
|---|---|---|
| K=1 candidate per attempt, 5 evals of 10 replays | 3, 3, 3, 2, 0 | **0.2–0.3** (one outlier at 0.0) |
| K=3 candidates, eval concurrency 1 | 6 / 10 | **0.6** |
| K=3 candidates, eval concurrency 3 | 1 / 10 | 0.1 |

Writing three files per attempt and keeping the best is the single change that moved
the number, and it moved it from ~0.25 to 0.6 — the band is narrow (0.15 wide at round
2) and one sample from a model that cannot measure its own output is close to a coin
flip, so the fix was more samples per attempt rather than a better prompt.

**Of the 54 candidate rejections in the K=3 concurrency-1 eval, 52 were Gate 3** — the
balance gate — and the other two were Gate 1 static. So the verifier is almost entirely
doing the job it exists for: not catching malformed code, but catching code that is the
wrong *difficulty*, which is the judgement no linter can make and the reason Gate 3 has
to simulate.

**The first rewrite of a session is the slow one, and it is Round 2.** Measured in a real
playtest on 2026-09-08 (`AI-DEV-LOG.md`): every Round 2 request reports `cacheRead: 0`
while rounds 3–5 read 10 448–18 057 cached tokens, and the cold round runs 5–9 s longer
for *fewer* output tokens. Round 2 is the first time the boss visibly learns, so the
demo's most important round is structurally its slowest one. Until the deadline clamp
below, it crossed the client's 45 s abort in three sessions out of three and the player
never once saw a live Round 2 rewrite.

**A client's budget now bounds the server's deadline.** `POST /api/rewrite` accepts
`budgetMs`, and `clampToClientBudget` takes `min(configured, budgetMs - 2 s)`. The two
numbers used to be able to disagree — `REMATCH_DEADLINE_MS=90000` against a client that
aborts at 45 s — and when they did, the browser hung up mid-stream: `approved: null`, no
`fallback` event, no artifact. AC 5's promise is a *visible* fallback, and a dead screen
is not one. Spec §13 delta 21.

**The binding constraint is Coder latency, not model quality.** Over 65 candidate calls:
**p50 7.7 s, p90 12.3 s** (min 5.2 s, max 15.7 s), against the loop's 40 s deadline. At
p90, three candidates plus their gates is most of one attempt's budget, and four
attempts is not reachable — which is exactly what the failures look like: **3 of the 4
runs that did not approve ended on `deadline`** (at 2 or 3 attempts used), and only one
got as far as `max-attempts`. The
concurrency-3 row above is the same effect from the other side: sharing the cores makes
Gate 3 ~2x slower per run and the deadline starts eating attempts, which is why the
honest-latency measurement is at concurrency 1.

That is also why the fallback pool is not a formality. At a 0.6 pass rate roughly two
players in five see it, so it ships a *balance-tested* strategy for that round and the
interlude says so on screen (spec AC 5's banner) rather than hiding the miss. Given the
re-grade above, plan on more than two in five: the pool is carrying more of the demo than
this section's headline number suggests, which is an argument for keeping it good rather
than for hiding the uncertainty.

Also on disk: [`artifacts/server/`](../artifacts/server/) holds two real
`POST /api/rewrite` event logs written by the server's own `log.ts` — but they are
**fallback-only mode** runs (no API key: `replay → analysis.delta… → analysis.done →
fallback → done`, 9 events, no gates). They are evidence that the no-key path produces a
well-formed four-beat stream and nothing fabricated, not evidence of the loop.
[`artifacts/web/`](../artifacts/web/) holds 14 Playwright screenshots, including
`recorded-approved.png` and `recorded-round2-boss.png` — this run's approval and the
Round 2 boss it produced, as the player sees them.

---

## 7. Determinism and the deterministic controls

### seed → hash, and browser == Node

The engine is a pure function of `(seed, inputs)`: fixed 60 Hz timestep, seeded xorshift
PRNG, every position and velocity quantized to 1e-4 after integration (`q()` in
`engine/src/constants.ts`) so `hashState` is stable across platforms and absorbs the
ULP-level disagreement `Math.cos`/`sin`/`atan2` are permitted to have. `Math.random`,
`Date.now` and `performance.now` are unreachable in `engine/` and `contract/` — see the
lint rule below.

The recorded witness is
[`packages/web/e2e/fixtures/inputlog-round1.json`](../packages/web/e2e/fixtures/inputlog-round1.json):
a full Round 1 played by the engine's scripted pseudo-player, generated in Node by
`packages/web/scripts/gen-inputlog.ts`.

```json
{ "sessionSeed": 424242, "round": 1, "seed": 1977791994, "playerSeed": 90210,
  "strategy": "round1", "ticks": 909, "outcome": "playerWon",
  "hash": "74cd659935e33202" }
```

Two tests guard it, and they fail in a deliberate order:

- [`packages/web/test/replay-fixture.test.ts`](../packages/web/test/replay-fixture.test.ts)
  — in `pnpm verify`. Replays the log **in Node** through the real QuickJS sandbox and
  asserts `hash === "74cd659935e33202"`, `ticks === 909`, `outcome === "playerWon"`; also
  asserts `roundSeed(424242, 1) === 1977791994`. Its failure message says the fixture is
  stale and names the regeneration command.
- [`packages/web/e2e/determinism.spec.ts`](../packages/web/e2e/determinism.spec.ts)
  — *"browser and Node agree on the replay hash"*. Replays the same log **in the browser**
  via `__rematch.driveWith(log)` + `fastForward()` and asserts the same
  `74cd659935e33202`, through the browser's own QuickJS instance. A second case replays
  twice in one page and asserts idempotence.

The hash is a **recorded expectation, not an invariant**: it changes whenever
`round1.js` or an engine rule does, because the scripted player reacts to the boss and a
different boss produces a different input log. It last moved on 2026-09-04, when
`round1.js` stopped returning `idle` as a resting state (§9 item 10) — from
`6568b87bb4974fb8` / 962 ticks to the pair above. The failure message on
`replay-fixture.test.ts` is what tells you which of the two happened, and
`pnpm --filter @rematch/web gen:inputlog` is what regenerates it.

Both sides inject the sandbox's monotonic clock (`monotonicClock` in
`@rematch/sandbox`, re-exported by `packages/web/src/game/clock.ts`; the harness
simulator uses the identical one). A real clock would make replays *slightly*
non-reproducible: the sandbox enforces the `decide` deadline against `now()`, and a GC
pause can push one call over budget, which the engine turns into `idle` + a violation.
Live play keeps `performance.now` and a 10× budget, where that deadline is a containment
control and must be real. See the limits section above for the full table.

Same sandbox on both sides is what makes this possible:
`@jitl/quickjs-singlefile-cjs-release-sync` — **sync** (callable straight from a 60 Hz
tick loop, and asyncify is ~2× slower), **singlefile** (the `.wasm` is embedded in the JS,
so the same bytes run in Node, Vitest and the browser bundle), **cjs** (works in Node and
any bundler), **release**.

### The §7 controls — three files, not three conventions

| # | Control | File | Stops |
|---|---|---|---|
| 1 | `pnpm verify` on every commit | [`.githooks/pre-commit`](../.githooks/pre-commit) → [`scripts/verify.sh`](../scripts/verify.sh) | A commit that does not typecheck, lint and pass all 997 tests |
| 2 | Determinism lint rule | [`eslint.config.mjs`](../eslint.config.mjs) | `Math.random`, `Date.now`, `new Date`, `Date()`, `performance.now` in `packages/engine/src` or `packages/contract/src` |
| 3 | Contract CHANGELOG gate | [`.github/workflows/verify.yml`](../.github/workflows/verify.yml) | A PR that changes `packages/contract/` without a `CHANGELOG.md` entry |

All three run the same way locally and in CI, because the hook and the workflow both call
`scripts/verify.sh` rather than each maintaining its own list of steps. `pnpm install`
installs the hook via the root `prepare` script (`git config core.hooksPath .githooks`) —
no husky, no generated files to drift.

Three design details are what make these controls rather than suggestions:

- **The lint rule cannot be waved away.** The scoped config sets `noInlineConfig` with
  `reportUnusedDisableDirectives: 'error'`, so an `// eslint-disable-next-line` does not
  suppress the error *and* is itself reported — writing one fails the commit twice over.
  It also catches the spellings a naive check misses: `Math['random']`,
  `const { now } = Date`, `new Date()`, bare `Date()`, and
  `import … from 'node:perf_hooks' | 'node:crypto'`. Scope is deliberately just the two
  packages that must be bit-identical in the browser and in Node; `sandbox` legitimately
  uses `performance.now()` as the host clock for the 2 ms deadline and sits outside the
  globs, so the exemption needs no inline disable.
- **The escape hatch is documented as a human's.** `git commit --no-verify` exists for a
  WIP commit, an offline commit, an unfinished rebase. The hook's own failure message says
  *"If you are an agent: do not use --no-verify. Fix the failure."* — and it only buys
  minutes, since CI runs the identical script on every push and PR.
- **The CHANGELOG gate has no bypass and its own job.** It diffs against the merge base
  (`git diff --name-only origin/<base>...HEAD`, so commits that landed on `main` after you
  branched don't count as yours) and annotates the PR with `::error::`. Adding the entry
  *is* the work: a change to `BossView`, `BossAction`, `validateAction` or the static check
  changes what every generated strategy and every pre-approved fallback is allowed to do.

`pnpm verify` as of 2026-09-08: `✓ verify passed (64s — typecheck lint test)`, **997
tests** across 7 packages — contract 206, agents 215, web 194, harness 122, sandbox 100,
engine 91, server 69 — plus **19 Playwright e2e** in `pnpm test:e2e`.

This paragraph carried 897 / 14 until 2026-09-08, having been written on 09-04 and not
re-run after the ACTIVE-gate, recorded-run and provider work landed. It is a count, so
it goes stale silently; if it disagrees with `pnpm verify` again, `pnpm verify` is
right.

**No test in the repo makes a network call**, and none launches the `claude` CLI —
`claudeCliProvider`'s 29 tests inject a fake `spawn`, which matters more than the API
providers' injected clients do: a token spent there is a slice of the developer's own
subscription rather than a line on an invoice. The only thing that spends money is
`pnpm eval:agents`, and since 2026-09-04 it refuses to run without
`REMATCH_ALLOW_SPEND=1`, printing the worst-case model-call count first — being merely
"opt-in on the presence of a key" was how the project's credit got exhausted (see
[`AI-DEV-LOG.md`](AI-DEV-LOG.md)). The server has a matching global cap,
`REMATCH_MAX_REWRITES_PER_DAY` (default 50), and `REMATCH_PROVIDER=none` forces
fallback-only with a key left in place.

---

## 8. Build-time agent boundaries

The codebase was built by the same principle it demonstrates: bounded contexts, an
authority that decides, and verification the workers cannot skip. Full timeline in
[`AI-DEV-LOG.md`](AI-DEV-LOG.md).

```
Human (Matheus) — owns the spec, the scope, and anything added to §3's out-of-scope list
      │  informed before each milestone and on every major decision
      ▼
Orchestrator (one Claude Fable 5.1 session) — decides, specifies, delegates, verifies
      │  froze the contract before launching any implementation agent
      │  ran `pnpm verify` + the harness CLI itself before every commit
      │  never delegated: scope, the contract's shape, game-feel calls, commit decisions
      ▼
Implementation agents (Claude Opus 5 subagents, one per workstream, run in parallel)
      A: scaffold + contract          ‖   B: engine          ‖   C: sandbox + gates 1-2
      D: web renderer                 ‖   E: bots + gates 3-4
      F: agents package               ‖   G: fallback pool
      H: interlude UI                 ‖   I: server
      J: §7 controls                  ‖   K: event polish + Coder hints
```

Two rules held throughout:

1. **Package-scoped ownership.** Each agent owned specific directories and was given the
   *public types* of what it consumed, not the internals — an agent working on `web/` got
   the engine's exported surface, never a tour of `step.ts`. This is the same denial the
   Coder agent lives under at runtime, and it is why the dependency graph in §2 has no
   cycles: nobody could reach for an internal that was not in their brief.
2. **The contract was frozen first.** `StrategyRunner`, `DecideResult`, `RunnerFailure`
   and the seeded `rand()` name were settled and committed *before* the engine and sandbox
   agents were launched, precisely so two parallel agents could not each invent the
   boundary between them. That freeze is recorded in
   [`packages/contract/CHANGELOG.md`](../packages/contract/CHANGELOG.md) 0.1.1 — the same
   human-gated file CI now defends.

Where parallelism actually paid: the engine and the sandbox were built simultaneously
against a contract neither could change; the web renderer and the balance simulator were
built simultaneously against an engine neither owned; the sandbox agent's own benchmark
(16–43 µs per sandboxed `decide`) is what forced Gate 3 onto a worker pool before Gate 3
was written. Where it cost: two concurrent agents editing `pnpm-lock.yaml`, and one agent
stalling with finished work sitting on disk. Both are in the log.

### 8.1 What the history can and cannot prove

The lane diagram above is a description, not evidence, and it is worth being exact about
why. **The development timeline is not recoverable from this repository.** History was
squashed to one commit per milestone, so `679c8c3` through `c67c324` — six lanes' work —
all carry the timestamp `09-04 09:55`, and their file sets overlap by package rather than
partitioning cleanly. A reader can see *that* the lanes were integrated together; they
cannot reconstruct when each ran. The narrative in [`AI-DEV-LOG.md`](AI-DEV-LOG.md) is the
only record of the ordering, and it is testimony.

One thing the history *does* prove, and it is the load-bearing one: the contract was
frozen before the lanes that depended on it. [`packages/contract/CHANGELOG.md`](../packages/contract/CHANGELOG.md)
0.1.1 is the freeze, and the pre-commit hook plus CI defend that file to this day — which
is why two agents building the engine and the sandbox at the same time could not each
invent the boundary between them.

### 8.2 Parallelism that is still running, measured

The other half is not historical at all: the shipped loop is parallel in two places, and
both are measurable on demand. `pnpm --filter @rematch/harness evidence:parallel`
produces [`evidence/parallel-2026-09-09.txt`](evidence/parallel-2026-09-09.txt):

| Gate 3, 200 matches | wall clock | workers |
|---|---|---|
| inline (`workers = 1`) | 2 997 ms | 1 |
| worker pool (default) | **623 ms** | 11 |

**4.81x on 12 cores.** That is not a micro-optimisation, it is what makes the interlude
possible: Gate 3 is the loop's only CPU-bound stage, and at three candidates per attempt
the serial cost is **9.0 s per attempt against 1.9 s** — inside a 45 s budget that also
has to fit an Analyst call and three Coder calls.

The second place is the **K = 3 candidates per attempt** (`agents/src/loop.ts`): three
Coder calls issued concurrently, each measured by Gate 3 as its own reply lands, with a
straggler cut so one slow generation cannot spend the whole attempt. A live artifact shows
it working — `rewrite-2026-09-08T15-07-33-331Z.json` carries 23 candidates across 12
attempts, two or three per attempt, each with its own Gate 3 verdict. And the choice
between them is not "first past the post": the loop keeps the candidate nearest the middle
of the round's band, which is only a meaningful choice because several were measured.

---

## 9. Known limitations

Honest list, reconciled with §6 on 2026-09-08. It previously carried the marker "at
`069be8d`" and item 1 below still said no real API run existed — written on 09-03,
before the eval in §6 ran that evening, and never updated. Two sections of the same
file contradicted each other on the project's most load-bearing claim for eleven days.
The marker is gone because a dated list nobody re-dates is worse than no marker.

1. **The loop's pass rate is unknown, and every number on record is stale in a
   different direction.** A real run *has* been recorded — §6 is it, and `pnpm eval:agents`
   has been run against a live key (11 times on 2026-09-03; see `docs/AI-DEV-LOG.md`).
   Three things about that evidence, and the third replaced this item's own diagnosis.

   First: **it predates Gate 3's ACTIVE assertion**, and re-grading its candidates against
   today's harness fails four of the six approvals on the idle clauses
   ([`evidence/recheck-active-2026-09-08.json`](evidence/recheck-active-2026-09-08.json)),
   so the quoted 0.6 is an upper bound.

   Second: **it also predates ADAPTED becoming advisory** (SPEC §13 delta 23), which moves
   the rate the other way — and by more. Re-grading the 12-attempt live run of 2026-09-08
   through the current gate approves **8 of 23 candidates where it approved 0**, with the
   first on attempt 1 ([`evidence/regrade-live-2026-09-08.txt`](evidence/regrade-live-2026-09-08.txt)).

   Third, and this is what this item used to get wrong: it said "the binding constraint is
   Coder latency against the clock". That was inferred from three of four failures ending
   on the deadline — with a 40 s deadline and 4 attempts. Unlock both (`REMATCH_DEADLINE_MS`,
   `REMATCH_MAX_ATTEMPTS`) and latency stops binding; what appeared instead was the Mimic,
   and delta 23 is the measurement that identified it. **The current rate has never been
   measured** and doing so spends money — item 1 of the open list in `AI-DEV-LOG.md`. Only
   the quoted run's event log is committed; the other nine survive as the aggregate. Every
   *unit test* of an agent path still runs against `mockProvider`, deliberately —
   `pnpm verify` must never spend money.
2. **No human playtest (AC 4).** Whether Round 1 is beatable in under 60 s on a first try
   is unmeasured. The e2e suite proves a *scripted* player wins it in 909 ticks (~15 s),
   which says the fight is winnable, not that it is fun or readable. The renderer agent's
   own finding sharpens the risk: ~100% of player damage comes from un-telegraphed
   bullets, so the boss's two telegraphs are honest but are not where the difficulty lives.
3. **Not deployed (AC 9).** The recommendation is a split deployment (static web on
   Vercel, server as an always-on Node process) and it is a pending human decision, not
   code. All-Vercel is survivable but degrades Gate 3 to ~60 matches — which weakens the
   *verifier*, the thing the project is arguing for.
4. **Round 2 is the only round with real loop evidence.** Rounds 3–5 have bands, bots and
   a balance-tested fallback pair each, but no recorded rewrite. `BalanceRound` is typed
   `2 | 3 | 4 | 5`, so this is coverage, not capability.
5. **Gate 3's cost is the product's binding constraint.** 200 matches × 3600 ticks is
   12–31 s of pure sandbox time on one thread. Everything about the interlude's design —
   streaming beats, batched progress, the 40 s deadline, the fallback pool — exists to
   absorb that. On a 1–2 vCPU host it does not fit, and the honest response is fewer
   matches with the same assertions, said out loud.
6. **`packages/web/src/interlude/events.ts` is a hand-maintained copy** of
   `packages/agents/src/events.ts`. The reason is sound (no `harness`, no SDK, no API key
   in a browser bundle) but nothing enforces the copy: the convention is "change one, change
   the other in the same commit", and no test compares them.
7. **The rate limiter is per-process and in-memory.** 6 rewrites / 10 min per IP, which
   never bites on honest play (four rewrites is a whole game) but gives a caller spread
   across instances one bucket each.
8. **The `Mimic` is a model of a player, not the player.** ADAPTED at ≥0.70 against a bot
   rebuilt from heat map, dash bias and shot timing is the best available proxy for "it
   countered *you*", and it is still a proxy. A player who changes tactics in Round 2 is
   facing a boss tuned for their Round 1 self — arguably correct, and untested against a
   human.
9. **`Eval` and `Promise` remain QuickJS intrinsics** because the host's `JS_Eval` and ES
   module evaluation both go through them; with either removed, no strategy can be loaded
   at all. The `eval` and `Promise` *globals* are deleted, the internal pointers are not
   reachable from JS, and Gate 1 keeps both names on its denylist. Documented rather than
   hidden, and the reason both belts exist.
10. **~~Nine of the eleven player-facing strategies can freeze mid-fight.~~ FIXED
    2026-09-04, and it became a gate.** Every hand-written strategy in the repo used to
    end its `decide` with "nothing to do, return `{type:'idle'}`", and `idle` is a legal,
    cooldown-free, violation-free action — so no gate could see it and, until the HUD
    counters landed, neither could a human. A playtester found it in Round 2
    (`round2-candidate.js` parked on a *stale* hottest heat cell and idled for 263
    consecutive ticks).

    The resolution was to stop treating it as a property of one file. Gate 3 grew a third
    assertion, **ACTIVE** (see the gates section above and `harness/src/sim/activity.ts`),
    every strategy below got a moving resting state, and every one was re-balanced against
    its own band afterwards. Worst motionless run against the four reference bots, in
    ticks, before → after:

    | Strategy | Before | After | | Strategy | Before | After |
    |---|---|---|---|---|---|---|
    | `harness/round2-candidate` | 263 | **17** | | `server/fallback/round3/emberline` | 169 | **0** |
    | `web/src/strategies/round1` | 169 | **1** | | `server/fallback/round3/nettle` | 89 | **1** |
    | `web/src/strategies/hound` | 98 | **1** | | `server/fallback/round4/bellringer` | 630 | **0** |
    | `server/fallback/round2/hollow` | 391 | **1** | | `server/fallback/round4/curfew` | 89 | **1** |
    | `server/fallback/round2/metronome` | 143 | **0** | | `server/fallback/round5/crossfire` | 485 | **0** |
    | | | | | `server/fallback/round5/tollkeeper` | 343 | **0** |

    (The "before" column is re-measured with the ACTIVE definition, which is why it
    differs from the numbers this item used to carry: the old survey counted *positional*
    stillness only, so it over-counted telegraphs and under-counted a `move` clamped
    against a wall.)

    Two causes, not one, and only the first was the reported bug:

    - **`idle` as a resting state** — eight strategies. Replaced with a patrol across the
      ground the boss was guarding, or a strafe perpendicular to the player that holds
      whatever range the branch above chose. Straight legs of ~34 ticks, never a curve:
      every reference bot leads its shots off the boss's last-tick velocity, and a curve
      defeats a linear lead permanently. (The first fix for `round2-candidate` *was* a
      circular orbit and it went from 0.38 to 0.72 against the panel — unhittable by
      construction is not "harder", it is broken.)
    - **A `move` the arena clamped** — `emberline`'s orbit and five `back off from the
      player` branches, all of which could grind into a wall and stand still without ever
      returning `idle`. Fixed with a wall lookahead: reverse the orbit, or slide along
      the wall instead of into it.

    Two more bugs fell out of the same audit, both in the two `web/` strategies:
    `round1.js` and `hound.js` asked for a `spawn` whenever its cooldown was ready, and a
    `spawn` refused at the two-minion cap keeps its cooldown *and* costs a violation — so
    with two minions alive they asked every tick, froze, and (because that branch sits
    above the burst) stopped shooting entirely. Both now rate-limit by tick like the
    fallback pool does.

    Every strategy was then re-balanced. The resting motion costs the panel bots real
    accuracy — a boss that keeps moving is harder to lead — so seven of the eight
    fallbacks needed their pressure dial moved to stay in band; the table is in
    `docs/AI-DEV-LOG.md` (2026-09-04). Round 1 has no band and is held to the scripted
    mid-range player instead: still 1.00 player wins over 60 seeds, 16.6 s average.

    Pinned by `packages/harness/test/activity.test.ts` (now the whole shipped set, plus
    the recorded human replay and a `move`-into-a-wall counter-example),
    `packages/server/test/fallback.test.ts`, `packages/harness/test/balance.test.ts` and
    `packages/web/e2e/boss-activity.spec.ts`.

11. **`pnpm verify` is ~41 s and grows.** It is on every commit by design. Gate 3's real
    200-match budget is deliberately *not* in it (the harness suite runs reduced match
    counts); the full-budget balance regression is `pnpm test:balance`.
