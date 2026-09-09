# SPEC — The Boss That Learns

> Working title: **REMATCH**. A 2D arena boss fight where, between rounds, an agent studies how you won and rewrites the boss's strategy to counter you — and a second agent refuses to ship that rewrite until it proves the fight is still fair.

Status: v0.1 — approved for implementation
Owner (human orchestrator): Matheus
Competition: Howdy Dev Day 2026 — Agentic Software Engineering Hackathon
Window: 2026-08-31 → 2026-09-14

---

## 1. Objective

Ship a small, working browser game where **the agentic system is part of the player's experience, not just the build process**. A mixed technical / non-technical jury must be able to see an agent observe, reason, write code, get rejected by a verifier, fix itself, and pass — all inside the product, in the first 90 seconds of the demo.

The product is a vehicle for one thesis: *agents are safe to give real autonomy when a deterministic harness gates their output.* The boss agent has real power (it writes executable code that changes the game). The balance harness has final say.

### Why this wins on the rubric

| Criterion | Pts | How this project earns it |
|---|---|---|
| Agentic Engineering | 25 | Separate contexts for analysis, code generation, verification; parallel workstreams (engine / agents / UI / harness); a real reason for each boundary |
| Harness + Autonomous Loops | 25 | Generated strategies pass 4 gates — Gates 1–3 reproduce byte-for-byte, Gate 4 is a wall-clock measurement (see §13, delta 18). Rejection → fix → re-verify happens with no human in the loop, live, on screen |
| Product Quality | 20 | A playable, polished 4–5 round fight. Deterministic engine, replayable, fast |
| Context Engineering | 10 | The boss coder never sees the game engine — only a typed contract and a replay summary |
| Innovation | 10 | The verifier is visible gameplay. The antagonist is an agent under back pressure |
| Reproducibility | 5 | Seeded determinism: any run, any generated boss, any rejection can be replayed byte-for-byte |
| Demo | 5 | The interlude *is* the story: replay → observations → diff → simulation meter → verdict |

---

## 2. Player experience

### 2.1 Core loop

1. **Fight** — Top-down 2D arena, ~60 seconds max. Player: WASD move, Space dash, mouse aim + click to shoot. Boss: moves and attacks using a fixed set of primitives.
2. **Player wins** → **Interlude** (the centerpiece, §2.2).
3. **Next round** starts against the rewritten boss. Repeat up to Round 5.
4. **Player loses** → Game over screen: "The boss beat you on Round N." Show the boss's final strategy in plain language. Offer replay / share.
5. Player survives Round 5 → win screen.

### 2.2 The interlude (this is the demo)

Full-screen, four beats, each visibly driven by an agent. Target duration 20–45 s. Everything shown is real output, not decoration.

| Beat | What the player sees | What actually runs |
|---|---|---|
| **Replay** | A ghost heatmap of the player's positions and a timeline of their attacks/dashes | Deterministic replay of the round from seed + input log |
| **Analysis** | Streaming text: *"Player camped the bottom-left corner. Attacked only during my slam cooldown. Dashed 11 times, always left."* | **Analyst agent** reads the compressed replay and emits structured observations + a counter-plan |
| **Rewrite** | A code diff appears: old strategy → new strategy, key lines highlighted | **Coder agent** writes a new `strategy.js` against the Boss Contract (§4) |
| **Trial** | A meter fills as simulated matches run. Verdicts appear: `✗ REJECTED — 91% boss win rate (too hard)` then `↻ rewriting…` then `✓ APPROVED — 52%` | **Harness** runs static checks, contract fuzz, and N headless matches. On failure, the rejection reason is fed back to the Coder agent automatically |

The player must be able to read every rejection. Rejections are the proof.

### 2.3 Feel

- Instant restart, no menus between rounds beyond the interlude.
- Visual style: flat, high-contrast, CSS/SVG/Canvas only. No raster art, no image generation dependency.
- Boss gets a visible "tell" for each attack primitive so the fight is fair to read.
- Sound optional; if added, generated with Tone.js, never sampled assets.

---

## 3. Scope

### In scope (Definition of Done depends on all of these)

- One arena, one boss, five rounds.
- Deterministic engine with seeded RNG and recorded inputs → perfect replays.
- Boss strategy loaded from a sandboxed JS module conforming to the Boss Contract.
- Analyst agent + Coder agent + Harness, running server-side, with the autonomous rewrite loop.
- The four-beat interlude UI with real streamed output.
- Pre-generated fallback strategies (≥ 2 per round) used if the loop times out.
- Full test harness (§7) runnable with one command.
- Deployed URL + `README.md`, `docs/SPEC.md`, `docs/SYSTEM.md`, `docs/AI-DEV-LOG.md`.

### Explicitly out of scope

- Multiple bosses, multiple arenas, multiplayer, accounts, leaderboards.
- Mobile controls (must not crash on mobile, need not be playable).
- Any persistence beyond the current session, except an optional local "best round" number.
- Agents modifying anything other than `strategy.js`. Ever.

---

## 4. The Boss Contract (the most important section)

The boss agent does **not** write game code. It writes a *strategy*: a pure module that, each tick, is handed a read-only view of the world and must return one action from a fixed menu. Everything dangerous is structurally impossible; everything creative is in *when* and *where*.

### 4.1 Module shape

```ts
// strategy.js — the ONLY file agents may produce
export const meta = {
  name: string,          // shown to the player, ≤ 40 chars
  rationale: string,     // one sentence, shown to the player
  version: number
};

export function init(): Memory;          // called once per round; opaque object, ≤ 4 KB serialized

export function decide(view: BossView, mem: Memory): BossAction;
```

### 4.2 Inputs — `BossView` (read-only, plain data)

```ts
type BossView = {
  tick: number;                 // 60 ticks / second
  arena: { w: number; h: number };
  boss:   { x: number; y: number; hp: number; facing: number;
            cooldowns: Record<PrimitiveName, number> };   // ticks remaining, 0 = ready
  player: { x: number; y: number; hp: number; vx: number; vy: number;
            isDashing: boolean; lastShotTick: number };
  projectiles: Array<{ x: number; y: number; vx: number; vy: number; owner: 'boss' | 'player' }>;
  history: {                    // rolling summaries, not raw logs
    playerPosHeat: number[];    // 8×8 grid, normalized
    playerDashDirs: number[];   // 8 bins
    playerShotsDuring: Record<PrimitiveName, number>;  // shots fired while each primitive was active
  };
};
```

### 4.3 Outputs — `BossAction` (validated every tick)

```ts
type PrimitiveName = 'move' | 'burst' | 'charge' | 'slam' | 'spawn';

type BossAction =
  | { type: 'move';   dx: number; dy: number }                // unit vector, clamped
  | { type: 'burst';  angle: number; count: 3 | 5 | 8 }      // radial projectiles
  | { type: 'charge'; angle: number }                          // straight dash, telegraphed 20 ticks
  | { type: 'slam';   x: number; y: number }                  // area hit at target, telegraphed 40 ticks
  | { type: 'spawn';  x: number; y: number }                  // one minion, max 2 alive
  | { type: 'idle' };
```

Engine-enforced, not strategy-enforced:

- Cooldowns per primitive (e.g. burst 90, charge 150, slam 210, spawn 300 ticks). An action on cooldown is coerced to `idle` and counted as a contract violation.
- Boss speed cap, arena bounds, projectile speed and damage — all constants owned by the engine.
- Boss HP and damage numbers are **not** in the contract. The strategy cannot make the boss tougher, only smarter.

### 4.4 Sandbox

- Strategies execute in **QuickJS via `quickjs-emscripten`** — same runtime in browser and Node, so the simulator and the live game agree bit-for-bit.
- No `import`, no globals beyond `Math`, no `Date`, no `Math.random` (replaced with a seeded PRNG injected by the engine).
- Hard limits: 64 MB memory, 2 ms per `decide` call. Exceeding either → strategy is killed and rejected.
- Deterministic control, not an instruction: forbidden identifiers are rejected by a static check *before* any code runs (§7, Gate 1).

---

## 5. Architecture

```
┌──────────────────────────── Browser ────────────────────────────┐
│  Game (Canvas 2D)  ──▶  Engine (deterministic, 60Hz, seeded)     │
│       ▲                        │ loads strategy.js via QuickJS   │
│       │                        ▼                                 │
│  Interlude UI  ◀── SSE ── replay log (seed + inputs + summary)   │
└───────────────┬──────────────────────────────────────────────────┘
                │ POST /api/rewrite   (round, replay, prevStrategy)
                ▼
┌─────────────────────────── Server (Node) ───────────────────────┐
│  Orchestrator                                                    │
│    ├─ Analyst agent   (context: replay summary + contract docs)  │
│    ├─ Coder agent     (context: contract + observations + prev)  │
│    └─ Harness         (deterministic; no LLM)                    │
│         Gate 1 static ─ Gate 2 fuzz ─ Gate 3 balance ─ Gate 4 perf│
│              └── on failure: rejection reason → Coder (max 4×)   │
│    └─ Fallback pool   (pre-approved strategies per round)        │
│  Streams every beat back over SSE                                │
└──────────────────────────────────────────────────────────────────┘
```

### 5.1 Packages (monorepo, pnpm workspaces)

| Package | Responsibility | Depends on |
|---|---|---|
| `engine` | Pure TS game simulation, no DOM, no rendering. Exports `step`, `createGame`, `replay` | — |
| `contract` | Types, action validator, static-check rules, reference bots | `engine` |
| `harness` | The four gates + simulator runner. CLI: `pnpm harness <strategy.js>` | `engine`, `contract` |
| `agents` | Analyst + Coder prompts, context assembly, rewrite loop | `contract`, `harness` |
| `server` | HTTP + SSE, fallback pool, rate limits | `agents` |
| `web` | Vite + Canvas renderer + interlude UI | `engine`, `contract` |

The engine is the shared truth. Everything else is a consumer.

### 5.2 Key technical decisions

| Decision | Choice | Why |
|---|---|---|
| Rendering | Canvas 2D, hand-rolled | Zero framework risk, full control of visual style, trivially deterministic |
| Simulation | Fixed timestep 60 Hz, integer-friendly math, seeded xorshift PRNG | Replays and headless sim must match the live game exactly |
| Strategy runtime | QuickJS (`quickjs-emscripten`) | Same sandbox in browser and Node; memory + time limits; no host access |
| Agent model | Claude via API, server-side only | Key never reaches the browser |
| Streaming | Server-Sent Events | One-directional, simple, survives Vercel |
| Deploy | Vercel (web + serverless server) | Live URL required by submission |
| Tests | Vitest (unit/property), Playwright (browser) | Fast; screenshots double as demo evidence |
| Balance oracle | Panel of scripted reference bots + a "mimic" bot | See §6 — the sim needs opponents that aren't the human |

---

## 6. Balance harness design

The harness decides whether a strategy ships. It never calls an LLM.

### 6.1 Reference bot panel

Scripted players the boss is simulated against. Each is ~50 lines and deterministic.

| Bot | Behavior | Tests that the boss… |
|---|---|---|
| `Camper` | Holds a corner, shoots on cooldown windows | …can flush a passive player |
| `Kiter` | Keeps max range, circles | …isn't helpless against distance |
| `Rusher` | Closes distance, dashes through attacks | …isn't trivially beaten by aggression |
| `Dodger` | Reacts perfectly to telegraphs, never attacks first | …can still deal damage to a defensive player |
| **`Mimic`** | Replays the *human's* observed pattern: heat-map-weighted positioning, dash direction bias, shot timing | …**actually learned something** |

### 6.2 Two assertions per round

```
ADAPTED :  win_rate(boss vs Mimic)  ≥ 0.70          "it countered how you played"
FAIR    :  win_rate(boss vs panel)  ∈ band[round]   "…but a different approach still beats it"
```

Fairness band escalates so the boss gets harder over rounds without ever becoming unwinnable:

| Round | Boss win-rate band vs panel |
|---|---|
| 2 | 0.35 – 0.50 |
| 3 | 0.45 – 0.60 |
| 4 | 0.50 – 0.65 |
| 5 | 0.55 – 0.70 |

`N = 200` matches per assertion (parallelized across workers), fixed seed set → identical results on every machine.

### 6.3 The autonomous loop, precisely

```
Coder emits strategy.js
  → Gate 1 static      fail → reason → Coder      (e.g. "uses Date; forbidden")
  → Gate 2 fuzz        fail → reason → Coder      (e.g. "returned angle=NaN on 3% of states")
  → Gate 3 balance     fail → reason → Coder      (e.g. "0.91 vs panel — too hard; 0.41 vs Mimic — didn't adapt")
  → Gate 4 perf        fail → reason → Coder      (e.g. "decide() p99 = 6.2ms > 2ms")
  → APPROVED → ship
Max 4 attempts. Then fallback pool. Every attempt and reason is logged and streamed to the player.
```

No human message occurs anywhere in this loop. This block, with real logs, is the Autonomous Loop Evidence for `SYSTEM.md`.

---

## 7. Test & verification plan (the harness agents build against)

| Layer | Tool | What it proves | Command |
|---|---|---|---|
| Engine unit | Vitest | Movement, collisions, cooldowns, damage; **determinism**: same seed + inputs → identical state hash | `pnpm test:engine` |
| Engine property | Vitest + fast-check | Boss/player never leave arena; HP never negative; cooldowns never negative | `pnpm test:engine` |
| Contract | Vitest | Validator rejects every malformed action; static check catches every forbidden identifier in a fixture set of bad strategies | `pnpm test:contract` |
| Harness self-test | Vitest | Known-broken fixture strategies are rejected at the expected gate; known-good fixtures pass | `pnpm test:harness` |
| Balance regression | Vitest | Each shipped fallback strategy still lands in its round's band | `pnpm test:balance` |
| Agent eval | Vitest (calls API, opt-in) | Given 10 canned replays, the loop reaches APPROVED within 4 attempts ≥ 80% of the time | `pnpm eval:agents` |
| Browser | Playwright | Game boots, a scripted player wins Round 1, interlude renders all four beats, Round 2 starts. Screenshots saved to `artifacts/` | `pnpm test:e2e` |
| Gate-all | shell | Everything above, exit non-zero on any failure. **Pre-commit hook + CI** | `pnpm verify` |

Deterministic controls (never delegated to an agent's memory):

- `pnpm verify` runs on every commit via hook. Agents cannot skip it.
- A lint rule forbids `Math.random` and `Date.now` in `engine/`.
- CI rejects any PR touching `contract/` without an updated `CHANGELOG` entry in that package — the contract is the API the boss agent depends on, so its changes are human-gated.

---

## 8. Agent design (summary — full detail in SYSTEM.md)

| Agent | Context it receives | Context it is denied | Output |
|---|---|---|---|
| **Analyst** | Compressed replay (heat map, timings, dash bins), round number, previous strategy `meta` | Engine source, any code | JSON: `observations[]`, `counterPlan`, `playerArchetype` |
| **Coder** | Boss Contract docs, `BossView`/`BossAction` types, Analyst JSON, previous `strategy.js`, harness rejection reason (if retrying) | Engine source, renderer, server | `strategy.js` |
| **Harness** | The strategy file | — (deterministic, no LLM) | verdict + reason |

Build-time agents (Claude Code, separate worktrees) follow the same principle: an agent working on `web/` gets the engine's public types, not its internals. Boundaries in `SYSTEM.md`.

---

## 9. Acceptance criteria (Definition of Done)

Numbered so an agent can check each one.

1. `pnpm install && pnpm dev` runs the game locally with a mock agent (fallback pool only, no API key) in under 2 minutes on a fresh clone.
2. `pnpm verify` passes on `main`.
3. Same seed + same input log produces an identical final state hash in browser and Node.
4. A human can beat Round 1 in under 60 s with WASD + mouse on first try in ≥ 3 of 5 attempts (informal playtest, logged in AI-DEV-LOG).
5. After a Round 1 win, the interlude shows all four beats with real streamed content in ≤ 45 s wall-clock, or falls back visibly ("Using a pre-approved strategy — the coder timed out") in ≤ 50 s.
6. At least one *recorded* real run in `docs/` shows a strategy rejected by Gate 3 and then approved on a subsequent attempt with no human input.
7. The Round 2 boss beats the `Mimic` bot ≥ 70% in the sim for that run. *(Measured and reported on every run, not enforced — see §13 delta 23 for the measurement that changed this.)*
8. A strategy containing `Date.now()`, `fetch(`, or an infinite loop is rejected before it executes in the game.
9. Deployed URL loads and completes AC 5 from a cold start.
10. `README.md`, `docs/SPEC.md`, `docs/SYSTEM.md`, `docs/AI-DEV-LOG.md` exist and match what was shipped.

---

## 10. Milestones (solo, 12 days)

| Days | Milestone | Parallel workstreams |
|---|---|---|
| **Sep 2–3** | Contract frozen. Engine core + determinism tests. Harness skeleton with Gate 1 & 2 | engine ‖ contract+harness |
| **Sep 4–5** | Playable fight in browser with a hand-written strategy. Reference bots. Gate 3 balance sim | web renderer ‖ bots+sim |
| **Sep 6–7** | Analyst + Coder agents against canned replays. Full loop closes headless. First real rejection logged | agents ‖ harness fixtures |
| **Sep 8–9** | Interlude UI with SSE streaming. Fallback pool generated and balance-tested | interlude ‖ fallback generation |
| **Sep 10–11** | Playwright e2e. Deploy. Polish the fight feel and boss tells. Record the autonomous-loop evidence | e2e ‖ visual polish |
| **Sep 12–13** | SYSTEM.md, AI-DEV-LOG.md, README. Demo video. Buffer | — |
| **Sep 14** | Submit | — |

Cut order if behind: Round 5 → sound → Round 4 → `Dodger` bot. Never cut: the interlude, Gate 3, determinism.

---

## 11. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| LLM latency blows the interlude past 45 s | Medium | Stream every beat as it happens so waiting *is* content; 45 s hard timeout → fallback pool; sim parallelized across workers |
| Coder never lands in the balance band | Medium | Band is a range, not a point; rejection reasons are quantitative ("0.91, too hard, reduce aggression"); 4 attempts; fallback pool |
| Browser/Node sim diverge | Low if disciplined | Single engine package; QuickJS in both; determinism test in CI from day 1 |
| Game isn't fun | Medium | Playtest AC 4 early (Sep 5). Boss tells must be readable. If not fun by Sep 8, simplify primitives, don't add |
| Generated code escapes sandbox | Low | QuickJS + static gate + no host bindings. Treat as a security boundary in review |
| Scope creep | High (it's a game) | §3 out-of-scope list is binding. Human approval required to add anything to it |

---

## 12. Open decisions (human)

- [x] Arena size and shape — **square 800×800**. Frozen in `CONSTANTS.arena` (contract CHANGELOG 0.1.0).
- [x] Whether the player sees the *previous* round's strategy name during the fight — **yes**. The HUD carries a boss strategy panel showing `meta.name` and `meta.rationale` for the whole round.
- [x] Whether to expose a "watch the sim" toggle in the interlude — **not built**. Cut as a nice-to-have; the Trial beat shows measured `trial.progress` counts and the per-bot rate breakdown inside each Gate 3 reason instead.
- [x] Final name — **still REMATCH**. The placeholder stuck; the workspace, every package scope (`@rematch/*`) and the debug surface (`window.__rematch`) all carry it.

---

*Everything the agents build is measured against this document. If the document is wrong, fix the document first.*
---

## 13. Implementation deltas

Where the shipped system differs from the spec above, and why. The spec text is left
unedited on purpose — this section is the diff, so a reader can see what the plan said
and what survived contact with the code.

| # | Spec said | Shipped | Reason |
|---|---|---|---|
| 1 | §5.1: `contract` depends on `engine`, and holds the reference bots | `contract` has **zero** workspace deps; `engine` depends on `contract`; the bots live in `harness/src/bots/` | The spec's table is circular (`engine` ← `contract` ← `engine`). The contract is types + validator + static check, consumed by all five other packages, so it must consume none of them |
| 2 | §4.4: the QuickJS sandbox sits inside the engine | `@rematch/sandbox` is a 7th package | It is the project's security boundary and has three consumers (`engine`/`web` for the live fight, `harness` for Gates 2–4, the balance simulator for Gate 3). Owning it separately keeps it dependency-free and reviewable on its own |
| 3 | §4.3: `burst.count: 3 \| 5 \| 8` widens a cone | `count` selects a **shape**: 3 and 5 are aimed cones (0.44 / 0.88 rad), **8 fires a full 2π ring** | A 1.54 rad 8-shot cone was a slightly wider 5, and a strategy had no way to ask for area denial. See `ENGINE_CONSTANTS.burst.ringCount` |
| 4 | §2.1: the round ends at ~60 s | Reaching `maxTicks` (3600) is outcome `timeout`, and the simulator scores it as a **boss win** (`bossWon: state.outcome !== 'playerWon'`) | Gate 3's win rate needs a total function of the outcome. A boss that survives the clock was not beaten, so a stalling strategy cannot farm a low panel rate by running out the timer |
| 5 | §4.2: `history.playerPosHeat` is "normalized" | Normalized so the 64 cells **sum to 1** (a share of dwell time), rounded to 1e-4 | "Normalized" was ambiguous between sum-to-1 and max-to-1. Sum-to-1 is the useful one for a strategy ("the player spends 40% of the round here") and is stable across round lengths |
| 6 | §4.4: `Math.random` is "replaced with a seeded PRNG injected by the engine" | The **sandbox** injects a non-writable global `rand()` (seeded xorshift32, implemented inside the VM); `Math.random` is deleted | The engine never imports QuickJS — it is handed a `StrategyRunner`. So the injection point is the sandbox, not the engine. In-VM rather than a host callback: no wasm boundary crossing per call, and determinism does not depend on host state. Recorded in contract CHANGELOG 0.1.1 |
| 7 | §8: the Analyst outputs JSON | The Analyst emits **3–6 plain sentences first, then a fenced JSON block**, and `analysisGate` stops the streamed deltas at the opening fence | §2.2 asks for streaming prose the player reads ("Player camped the bottom-left corner…"). The player watches sentences, never `{"observations": [`. The full reply, both halves, is kept on `analysis.done.raw` for the run log |
| 8 | §2.2: "a meter fills as simulated matches run" | `trial.progress` is **batched** — ~20 events per gate from the worker pool, throttled to one per 100 ms — and carries measured `matchesDone`/`matchesTotal`, never an estimate | 200 SSE frames for a 4-second gate is noise on the wire and a re-layout per match in the browser. The batching also means the meter's denominator is `gate3Plan().total`, which rounding makes 62 at 60 requested — a meter that started at 60 and finished at 62 would be the only dishonest number on the Trial beat |
| 9 | §5.2: "Agent model: Claude via API" | Default `claude-sonnet-5` for both agents, overridable per agent (`REMATCH_CODER_MODEL=claude-opus-5`) | Latency is the binding constraint inside AC 5's 45 s, not depth: one Analyst call, up to four Coder calls and four gates including 200 simulated matches. The Coder writes ~80 lines against a frozen contract with a deterministic verifier behind it, so a weaker answer costs one more cheap attempt rather than a wrong result |
| 10 | §5.2 / AC 9: deploy web + serverless server to Vercel | **Recommendation split**: `packages/web`'s static bundle on Vercel, `@rematch/server` as a single always-on Node process (Fly.io / Railway), browser pointed at it by `VITE_API_BASE`. **Pending decision** | Gate 3 is a CPU-bound worker pool sized from `availableParallelism()`, and a Vercel function gets 1–2 vCPU while reporting the host's core count — the single most likely way AC 5 fails on the deployed URL. All-Vercel is survivable but degraded (`REMATCH_MATCHES=60` coarsens the verifier, which is the thing the project is arguing for). Full analysis in `packages/server/README.md` § Deploying |
| 11 | §5.2 / §8: one vendor, "Claude via API" | A **pluggable provider**: `selectProvider()` reads `REMATCH_PROVIDER=anthropic \| openai \| auto` and the matching key, in one place shared by the server banner, `/api/health` and `pnpm eval:agents`. `REMATCH_PROVIDER=none` forces fallback-only even with a key present | Credits were available on OpenAI and not on Anthropic, and the choice of vendor is not something the product should care about. One decision point rather than three means the demo cannot say `anthropic` in the banner while billing OpenAI. `none` is the documented local-development setting (`.env.example`) — an off switch that does not require deleting the key |
| 12 | §6.3: the Coder writes **one** file per attempt | **K candidate files per attempt** (`REMATCH_CANDIDATES`, default 3), written from one context and aimed at the low edge, the middle and the high edge of the band; the harness gates all K and keeps the best. `candidate` / `candidates` ride on five event types and are absent when K is 1, so the single-candidate stream is byte-identical | Measured: one file per attempt approved 0.2-0.3 of the time, three approved 0.6 (`SYSTEM.md` §6). The round-2 band is 0.15 wide and the model cannot measure its own output, so a single sample is close to a coin flip. Three samples cost 3x the tokens and the *same* wall clock — the candidates stream concurrently — and wall clock is the binding constraint (Coder p50 7.7 s vs a 40 s deadline), so this is the cheap axis to spend on |
| 13 | *(not in the spec)* | A third interlude source: **recorded-run mode**, `?agent=recorded&run=<name>`, which replays a real eval run from a committed JSON asset. The badge reads `RECORDED RUN · <model> · <date>` for the whole interlude, and the approved source really loads through QuickJS for the next round | AC 6 asks for a *recorded* real run, and a demo video should not spend credit on every take or depend on conference wifi. The alternatives were both worse: the live path costs money per rehearsal, and the mock is honest but it is not the model. The one reconstructed part is the per-event cadence — the eval artifact records no timestamp per event — so it is derived from the durations it does measure and scaled onto the run's real wall clock, and each recorded file states that in its own `timing.method` |
| 14 | *(not in the spec)* | **Spend guards.** `REMATCH_MAX_REWRITES_PER_DAY` (default 50) is a global per-UTC-day cap; past it the server serves fallback-only for the rest of the day and `/api/health` reports `spendGuard: "capped"`. `pnpm eval:agents` refuses to run without `REMATCH_ALLOW_SPEND=1`, printing the worst-case model-call count (~250) first | Added after the failure, not before it: eleven eval runs in one evening exhausted the account's credit while every request sat inside the per-IP rate limit (`AI-DEV-LOG.md`, 2026-09-03). The rate limiter caps *one caller over ten minutes* and is no control at all on the total bill — 6 per 10 min is 864 a day. Two controls of different shape, because they are two different problems |
| 15 | §5.2 / §8: the agents talk to a model **over an API** | A fourth provider, `REMATCH_PROVIDER=claude-cli`, runs the loop through the installed `claude` binary on the developer's **Claude Code subscription** — no API key, no API bill. Opt-in only: `auto` never spawns a subprocess, and the deployed server must not use it | The local-first rule (`AI-DEV-LOG.md`, 2026-09-04) left the real model reachable only by spending credit the project no longer had, which made a playtest and a demo take cost money each. A developer running Claude Code is already paying for that capacity. The trade is latency: a CLI turn is a whole session start, and one Coder call measured 145 s at the session's inherited effort — so the provider passes `--effort low` (17.6 s, same first-try static-check pass) and the docs point anything needing AC 5's 45 s at `?agent=recorded` |
| 16 | §6.2: Gate 3 has **two** assertions, FAIR and ADAPTED | A third, **ACTIVE**: the boss may not be motionless for more than 90 consecutive ticks (1.5 s), and its p90 per-match idle fraction may not exceed 0.25. Measured on *displacement*, so a `move` clamped against the arena edge counts the same as `idle`; telegraphs are excluded. Thresholds in `ACTIVITY` (`harness/src/gates/balanceConfig.ts`), measurement in `harness/src/sim/activity.ts` | A human playtest (2026-09-04) found a Round 2 boss frozen in a corner for 4.4 s that **all four gates approved**, and correctly so: `idle` is a legal action (Gate 1), always valid and cooldown-free (Gate 2), the cheapest possible `decide` (Gate 4), and Gate 3 read only the win rate — which a *stationary* boss helps keep in band, because it is easy to shoot. The same `return {type:'idle'}` resting state was in ten of the eleven shipped strategies. §6.2's two assertions cannot express "the boss is playing", so the gate grew a third rather than the property staying a test nothing enforced |
| 17 | §2.3: "flat, high-contrast, CSS/SVG/Canvas only. **No raster art, no image generation dependency**" | **Raster portraits for the three agents** — `packages/web/public/agents/{analyst,coder,judge,boss}.png`, 1024×1024 on `#0B0F1A`, generated with an image model (human decision 2026-09-04). Everything else on screen is still CSS and canvas | A human playtest of the interlude: *"today it is just numbers on a screen; the player can't connect what's happening to who is doing it."* §2.2 asks for four beats "each visibly driven by an agent" and the screen could not say *who* — which is the difference between "a machine printed some numbers" and "a model wrote a file and a deterministic harness rejected it". The dependency §2.3 was avoiding is bounded to four files that are on no code path: `ui/portrait.ts` renders an SVG placeholder first and reveals the `<img>` only on `load`, so the game is complete and screenshottable without them |

| 18 | §1 / §6: the harness is **"4 deterministic gates"** | Three of them. Gates 1–3 return the same verdict for the same input on any machine — Gate 1 is a pure AST walk, and Gates 2 and 3 load the sandbox on `monotonicClock()` so their budgets bound *work* rather than time. **Gate 4 keeps the host wall clock on purpose** and its verdict is a measurement, not a proof | "Is this fast enough to render at 60 Hz" is a question about real time; a monotonic step clock would make every strategy pass it. The wording was the problem, not the design — and it was not harmless, because Gate **2** had the same wall clock by oversight while promising in its own docstring that "(states, seed) is all you need to reproduce a rejection". Since Gate 2 rejects on *any* single runner failure, one GC pause inside one `decide` was the whole verdict: an independent review measured a strategy near the 2 ms budget at 0 over-budget states on an idle machine and 4 of 560 on a loaded one (`docs/REVIEW-2026-09-08.md` §2). Gate 2 now runs on the monotonic clock and its whole detail, timing included, is bit-identical across runs; "slow but finite" is Gate 4's business, which is where it always belonged |
| 19 | §6.2 / delta 16: ACTIVE is measured as **motionless ticks** | A second measurement alongside it: `minSpanPx`, the diagonal of the boss's bounding box over a match, which may not fall below the boss's own diameter (56 px). Both are asserted, and the span clause is deliberately outside the two idle clauses' `else if` chain so a boss with both problems is told about both | Delta 16's two clauses are both about *stalling*, and a boss that oscillates never stalls. An independent review submitted five lines that alternate `move` left and `move` right every tick — `validateMove` normalizes `move` to a unit vector, so it steps a full 2.6 px each way and **no tick is idle** — and it passed all four gates: approved for Round 2 at panel 0.44 inside the band, with ACTIVE reporting `idle run 0t/90` and `p90 0%`, and ADAPTED at 1.00 against the `camper` and `dodger` replays, the two styles a first-time player actually uses. Path length could not catch it either (9 000 px of `travelPx` inside a 5 px box), and `sim/simulate.ts` had been reducing a `minTravelPx` aggregate for exactly this purpose that Gate 3 never read. Kept as `harness/test/fixtures/jitter.js` so the regression has a name |
| 20 | §4.1: `BossView.history` holds **"rolling summaries"** | They are **cumulative** — `playerPosHeat` accumulates counts from tick 0 and is never decayed or windowed (`engine/src/step.ts`); only the normalization to sum 1 is per-view (delta 5) | The contract was frozen before the behaviour was examined, and no rolling window was ever implemented. It is not cosmetic: a heat map that never decays goes *stale*, so a boss that homes on the hottest cell keeps homing on where the player used to be — which is half the story of the frozen Round 2 boss in delta 16 (`SYSTEM.md` §9 item 10). Listed here because it was missing from this table until 2026-09-08 while being described elsewhere as "documented as a delta" |

| 21 | §5.3: the interlude has a **45 s deadline** and the server a loop deadline; nothing says they must agree | The client sends its own budget as `budgetMs` on `POST /api/rewrite`, and the server clamps its loop to `min(configured, budgetMs - 2 s)` (`clampToClientBudget`) | They *could* disagree, and on the developer's machine they did: `REMATCH_DEADLINE_MS=90000` against a client that aborts at 45 s. A playtest on 2026-09-08 hit it three times out of three, always on **Round 2** — the first rewrite of a session, so the only one paying a cold prompt cache (`cacheRead: 0` against 10 448–18 057 on later rounds). Each ended at exactly ~45 034 ms with `attempts: 0`, `approved: null`, **no `fallback` event and no artifact**: the browser hung up mid-stream, so the loop's own honest ending never reached anyone and the round the product's whole thesis rests on was the one round that never worked. The clamp makes the two numbers impossible to disagree about — verified live at a 12 s budget against a 90 s server, finishing in 10 004 ms with `reason: 'deadline'`, a named fallback and an artifact on disk |
| 22 | §2.3: "flat, high-contrast, CSS/SVG/Canvas only. **No raster art**" (see delta 17) | **The two fighters wear raster art too**, and the player picks both: `public/fighters/{earth,jupiter,neptune,saturn}.png`, the four Howdy mascots, cropped to head-and-gloves and drawn inside the entity's collision circle (`render/sprites.ts`). Two `localStorage` keys, a picker on the start screen, and nothing else — the choice is **cosmetic by construction**: it lives in `ui/fighters.ts`, reaches only the renderer, and `test/fighters.test.ts` asserts structurally that no module which simulates the game imports it. The intro's first beat carries a third raster file for the same reason, `public/intro/crew.png` — the four mascots together, resized by `scripts/prepare-hero.py`, which dissolves the poster's black ground into the page so the hero does not read as a rectangle sitting on it. The falloff is keyed on brightness as well as on distance from the edge, because the characters reach close enough to the frame that any feather wide enough to hide the edge also greyed a mascot's white head | The start screen could explain the loop but the fight had no one in it: both fighters were coloured discs, so "the boss that learns" had no face to attach the learning to, and a player had no stake in which side they were. The constraint §2.3 was protecting is *dependency*, not pixels — there is no image generation on any code path, the four files are art the human already had, and `render/sprites.ts` answers `null` synchronously until a PNG decodes so the fight is playable and screenshottable with the flat discs exactly as before. The sprite is clipped to the collision circle on purpose: a costume that drew wider than the hitbox would make the fight lie about what can be hit, which is the one thing a fairness-contract renderer must not do. Placement is measured, not eyeballed — `scripts/crop-fighters.py --geometry` finds the largest circle inside each crop's opaque mask, because the crops keep an outstretched arm and centring the image put Jupiter's face left of the boss |
| 23 | §6.2 / AC 7: ADAPTED — "the Round 2 boss beats the `Mimic` bot >= 70% in the sim" — is a **blocking** Gate 3 assertion | ADAPTED is **measured and reported, and does not reject**. It is in every artifact (`detail.adapted.met`, `blocking: false`), appended to any rejection so the Coder still aims at it, and it gained a second, relative target (`ADAPTED_MARGIN`: beat the incumbent's rate against the same Mimic by 0.10). FAIR and ACTIVE still block, and still do the refusing | Two measurements, both in `docs/evidence/`. **First**: the incumbent round-1 boss beats a Mimic built from a run the human had just won *taking zero damage* **0.700** of the time (`harness/scripts/live-base.ts`). The Mimic is a far weaker player than the person it imitates, so ">= 0.70 vs Mimic" was never the difficulty claim it reads as — and against FAIR, which caps strength versus the scripted panel, it was unsatisfiable for anyone who plays well. The better the human, the more certainly every rewrite was refused, which is backwards. **Second**: re-grading the 12-attempt live run of 2026-09-08 through the current gate approves **8 of 23** candidates where it approved 0, and the first is on **attempt 1** — the run that exhausted twelve attempts and fell back would have shipped a model-written boss immediately (`regrade-live-2026-09-08.txt`, `pnpm --filter @rematch/harness regrade:live`). The remaining 15 are still rejected, every one of them by FAIR, so the back pressure the project argues for is intact and the interlude still shows real rejections. What was given up is the one assertion that depended on a bot standing in for a human, which is a research problem rather than a verification one; the relative route stays because it is sound and binds whenever the incumbent is weak, and it was measured to change nothing on the recorded eval (0 regressions, 0 unlocked — `recheck-adapted-2026-09-08.json`) |

Two things the spec asked for that are **not deltas but gaps**, tracked in
`docs/AI-DEV-LOG.md`: AC 4 (human playtest) and AC 9 (the deployed URL).

**AC 6 is closed.** A real `gpt-5.4-mini` run showing three candidates rejected by
Gate 3 and one approved on the next attempt — with the AC 7 Mimic number of 0.99
against the ≥ 0.70 threshold — is excerpted in `docs/SYSTEM.md` §6, committed as
`docs/evidence/eval-round2-2026-09-03.json` — **that file is the one quoted run, not
all ten**; its own `note` field says so, and the other nine survive only as the
aggregate `passRate: 0.6`, which is an **upper bound**: the eval ran the day before
Gate 3's ACTIVE assertion existed, and four of its six approvals fail ACTIVE today
(`docs/evidence/recheck-active-2026-09-08.json`) — and replayable in the browser with `?agent=recorded`. What remains true is that every *unit test* of an agent path runs
against a mock provider, deliberately: `pnpm verify` must never spend money.
