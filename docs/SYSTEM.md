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
player; and a **harness** of four deterministic gates (no LLM anywhere in it) decides
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
and three rolling summaries (`playerPosHeat` 8×8 summing to 1, `playerDashDirs` 8 bins,
`playerShotsDuring` per primitive). It can keep an opaque `Memory` object between ticks
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
| `limits.decideBudgetMs` | 2 ms per `decide` | sandbox interrupt handler → `{kind:'timeout'}` |
| `limits.sandboxMemoryBytes` | 67 108 864 (64 MB) heap | `runtime.setMemoryLimit` |
| `limits.sourceBytes` | 32 768 | Gate 1 |
| `limits.metaNameMaxChars` | 40 | Gate 1 |
| `limits.maxMinionsAlive` | 2 | engine |
| stack | 128 KB (`maxStackBytes`) | `runtime.setMaxStackSize` → clean in-VM `stack overflow` |

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
| 3 | `balance` | `matches` (default **200**) split half vs the Mimic, half across the four panel bots, fixed seed set. **FAIR**: panel win rate ∈ `BAND[round]`. **ADAPTED**: Mimic win rate ≥ **0.70** | seconds — worker-parallel |
| 4 | `perf` | `decide` **p99 ≤ 2 ms** over ~2000 calls: 60% from real match trajectories vs the four bots, 40% topped up from Gate 2's corpus. Measured with an 8× relaxed deadline and judged against the real one, so the reported number is honest. A memory failure is fatal regardless of timing | ~60 ms |

Gate 1 is first because it costs ~1 ms: a strategy that mentions `Date` never boots a
QuickJS runtime (spec AC 8, asserted in `packages/harness/test/runGates.test.ts` by
handing Gate 2 a sandbox that throws if it is ever used).

### The fairness band (`gates/balanceConfig.ts`)

```
ADAPTED :  win_rate(boss vs Mimic)  >= 0.70          "it countered how you played"
FAIR    :  win_rate(boss vs panel)  in BAND[round]   "…but a different approach still beats it"
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
Gate 3  ✗ 0.41 vs Mimic — didn't adapt (need >= 0.70)
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

> **Mock provider run — real API run to be inserted (AC 6).** No `ANTHROPIC_API_KEY` has
> been available in the build environment, so the *model* below is
> `mockProvider`, scripted to fail twice and then succeed. **Everything else is real**:
> the gates are the shipping gates, Gate 1 really parses the file, Gate 2 and Gate 4
> really execute it in QuickJS, and Gate 3 really simulates 62 matches across a worker
> pool and really rates the second attempt above the round 2 band. The rejection
> sentences below were produced by the harness, not written by hand. Spec AC 6 asks for a
> *recorded real run*, and that is still outstanding.
>
> <!-- TODO: replace with real run -->

Reproduced by the loop test (`packages/agents/test/loop.test.ts`, *"gets rejected by
Gate 1, then by Gate 3, then ships on attempt 3"*) — 60 matches instead of the spec's 200
to keep it inside `pnpm verify`. **Wall clock: 1 052 ms, headless. 144 events. No human
message anywhere.**

```
event: replay              round 2, summary of the round the player just won (canned: camper-a)

event: analysis.delta      "Lived in cell 63 (x=750, y=750) for 93% of the round."
event: analysis.delta      "Never dashed in 1301 ticks."
event: analysis.delta      "Fired 163 shots and took no damage."
event: analysis.done       playerArchetype: "camper"
                           counterPlan: "Put every slam on the bottom-right corner and hold
                                         mid range so the corner stops being safe."
                           calls 1 · promptChars 5128 · 1282 in / 111 out tokens

──────────────────────────────────────────────────────────────────── ATTEMPT 1
event: rewrite.delta  ×N
event: rewrite.done        attempt 1 · meta.name "Clockwork" · 398 bytes
                           (coder.calls 2 — one staticCheck self-retry, still invalid,
                            submitted anyway: staticInvalid true)
event: trial.gate          ✗ Gate 1 static — line 9: forbidden identifier 'Date';
                                             line 13: forbidden identifier 'Date'
event: verdict             attempt 1, approved false
                           → reason travels verbatim into the attempt-2 Coder prompt
                             under "# ATTEMPT 1 WAS REJECTED BY GATE 1 (static)"
                           attempt total: 6 ms — no QuickJS runtime was ever booted (AC 8)

──────────────────────────────────────────────────────────────────── ATTEMPT 2
event: rewrite.delta  ×N
event: rewrite.done        attempt 2 · meta.name "Hound" · 1554 bytes · unified diff vs attempt 1
event: trial.gate          ✓ Gate 1 static 0ms
event: trial.gate          ✓ Gate 2 fuzz 54ms          (500 states + 60 ticks, in QuickJS)
event: trial.progress      attempt 2 · 0/62 · gate balance     ← meter on screen, total known
event: trial.progress      attempt 2 · 2/62
event: trial.progress      attempt 2 · 26/62
event: trial.progress      attempt 2 · 34/62
event: trial.progress      attempt 2 · 62/62
event: trial.gate          ✗ Gate 3 balance — 0.78 vs panel — too hard (band 0.35–0.50 for
                             round 2; Camper 1.00, Kiter 0.88, Rusher 1.00, Dodger 0.25)
                           detail: panel 0.78125 over 32 matches · Mimic 1.00 over 30
                                   · 11 workers · 3387 contract violations
event: verdict             attempt 2, approved false
                           → the sentence AND the per-bot table go into the attempt-3
                             prompt under "# ATTEMPT 2 WAS REJECTED BY GATE 3 (balance)"
                           attempt total: 488 ms

──────────────────────────────────────────────────────────────────── ATTEMPT 3
event: rewrite.delta  ×N
event: rewrite.done        attempt 3 · meta.name "Warden" · 4822 bytes · unified diff vs attempt 2
event: trial.gate          ✓ Gate 1 static 1ms
event: trial.gate          ✓ Gate 2 fuzz 28ms
event: trial.progress      attempt 3 · 0/62 → 2/62 → 26/62 → 34/62 → 62/62
event: trial.gate          ✓ Gate 3 balance 465ms
                           FAIR    panel 0.375  ∈ [0.35, 0.50]   ✓
                                   Camper 0.875 · Kiter 0.00 · Rusher 0.00 · Dodger 0.625
                           ADAPTED Mimic 0.867  ≥ 0.70           ✓   (spec AC 7)
                           1 contract violation over 62 matches
event: trial.gate          ✓ Gate 4 perf 58ms
event: verdict             attempt 3, approved TRUE
event: done                approved · meta { name: "Warden", rationale: "I hold the middle
                           and put everything where you live, not where you are.", version: 1 }
```

What this excerpt is evidence of, precisely:

1. **A rejection changed the model's next output with no human in the loop.** The
   attempt-3 prompt contains attempt 2's rejection sentence *verbatim* — asserted, not
   assumed: `expect(coder.promptOf(3)).toContain(secondReason)`.
2. **The verifier really said no to a strategy that ran.** Attempt 2 (`chaser`) passed
   Gates 1 and 2 and was rejected on measured win rates, not on a lint.
3. **Rejection is legible.** Every reason above is one sentence with the numbers in it,
   and it is the same string the player reads on the Trial beat.
4. **The gates are cheap enough to be honest.** Four gates and 124 simulated matches in
   ~1.05 s of wall clock on a laptop with 11 workers. At the spec's 200 matches Gate 3 is
   seconds, which is why `trial.progress` exists.
5. **The window is bounded.** `MAX_ATTEMPTS = 4`, `DEADLINE_MS = 40_000` (inside AC 5's
   45 s, with room for one overshooting gate), and every other outcome ends in a visible
   `fallback` + `done` pair rather than a hang.

Also on disk: [`artifacts/server/`](../artifacts/server/) holds two real
`POST /api/rewrite` event logs written by the server's own `log.ts` — but they are
**fallback-only mode** runs (no API key: `replay → analysis.delta… → analysis.done →
fallback → done`, 9 events, no gates). They are evidence that the no-key path produces a
well-formed four-beat stream and nothing fabricated, not evidence of the loop.
[`artifacts/web/`](../artifacts/web/) holds 11 Playwright screenshots, including
`interlude-5-rejected.png` and `interlude-approved.png` — the rejection and the approval
as the player sees them.

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
  "strategy": "round1", "ticks": 962, "outcome": "playerWon",
  "hash": "362eab563d1066c7" }
```

Two tests guard it, and they fail in a deliberate order:

- [`packages/web/test/replay-fixture.test.ts`](../packages/web/test/replay-fixture.test.ts)
  — in `pnpm verify`. Replays the log **in Node** through the real QuickJS sandbox and
  asserts `hash === "362eab563d1066c7"`, `ticks === 962`, `outcome === "playerWon"`; also
  asserts `roundSeed(424242, 1) === 1977791994`. Its failure message says the fixture is
  stale and names the regeneration command.
- [`packages/web/e2e/determinism.spec.ts`](../packages/web/e2e/determinism.spec.ts)
  — *"browser and Node agree on the replay hash"*. Replays the same log **in the browser**
  via `__rematch.driveWith(log)` + `fastForward()` and asserts the same
  `362eab563d1066c7`, through the browser's own QuickJS instance. A second case replays
  twice in one page and asserts idempotence.

Both sides inject the sandbox's deterministic clock (`src/game/clock.ts`). A real clock
would make replays *slightly* non-reproducible: the sandbox enforces the 2 ms `decide`
deadline against `now()`, and a GC pause can push one call over budget, which the engine
turns into `idle` + a violation. Live play keeps `performance.now`, where that deadline is
a containment control and must be real.

Same sandbox on both sides is what makes this possible:
`@jitl/quickjs-singlefile-cjs-release-sync` — **sync** (callable straight from a 60 Hz
tick loop, and asyncify is ~2× slower), **singlefile** (the `.wasm` is embedded in the JS,
so the same bytes run in Node, Vitest and the browser bundle), **cjs** (works in Node and
any bundler), **release**.

### The §7 controls — three files, not three conventions

| # | Control | File | Stops |
|---|---|---|---|
| 1 | `pnpm verify` on every commit | [`.githooks/pre-commit`](../.githooks/pre-commit) → [`scripts/verify.sh`](../scripts/verify.sh) | A commit that does not typecheck, lint and pass all 749 tests |
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

`pnpm verify` at `069be8d`: `✓ verify passed (41s — typecheck lint test)`, **749 tests**
across 7 packages — contract 206, agents 118, harness 102, web 100, sandbox 98, engine 89,
server 36. No test in the repo makes a network call; the only thing that spends money is
`pnpm eval:agents`, which is opt-in and exits 0 with a message when no key is set.

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

---

## 9. Known limitations

Honest list, at `069be8d`.

1. **No real API run has been recorded (AC 6).** No `ANTHROPIC_API_KEY` has been
   available in the build environment. Every agent path — provider, Analyst, Coder, loop,
   eval aggregation — is built and tested against `mockProvider`, which means the *loop* is
   proven and the *model's* behaviour on this task is not. `pnpm eval:agents` exists to
   produce the evidence (10 canned replays, spec §7's ≥80% target, writes every event to
   `artifacts/agents/`) and has never been run against a live key. §6 is labelled
   accordingly.
2. **No human playtest (AC 4).** Whether Round 1 is beatable in under 60 s on a first try
   is unmeasured. The e2e suite proves a *scripted* player wins it in 962 ticks (~16 s),
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
10. **`pnpm verify` is ~41 s and grows.** It is on every commit by design. Gate 3's real
    200-match budget is deliberately *not* in it (the harness suite runs reduced match
    counts); the full-budget balance regression is `pnpm test:balance`.
