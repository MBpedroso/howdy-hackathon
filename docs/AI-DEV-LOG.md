# AI-DEV-LOG — how REMATCH was built

Dated, factual, terse. Who decided what: **human** (Matheus), **orchestrator** (one Claude
Fable 5.1 session), **agent** (a Claude Opus 5 subagent, one per workstream, run in
parallel). Times are America/São_Paulo. Test counts and timings are from `pnpm verify` and
the harness CLI, run inline by the orchestrator.

The working method, in one line: the human owns the spec and the scope; the orchestrator
specifies, delegates, and verifies before every commit; agents implement inside
package-scoped briefs and never see more of the codebase than their brief needs. The same
context discipline the product argues for at runtime (see
[`SYSTEM.md`](SYSTEM.md) §8) was the build process.

---

## 2026-09-02 — spec approved, mode set

**Human.** `spec.md` v0.1 approved for implementation (the file now lives at [`docs/SPEC.md`](SPEC.md)). Sets the working mode explicitly:

- A Fable 5.1 session **orchestrates and decides**. It does not do token-heavy
  implementation work.
- Opus 5 **subagents implement**, one per workstream, launched in parallel.
- The human is **informed before each milestone** and on any major decision. Anything
  added to spec §3's out-of-scope list needs human approval.

**Orchestrator — four decisions taken before any code was written:**

| Decision | Rationale |
|---|---|
| Milestone 1 scope only, then re-plan | The spec's 12-day plan assumes a known velocity; there wasn't one yet |
| Arena **square 800×800** (spec §12 open decision) | `Kiter` viability, and a square arena makes the 8×8 heat map cells square too — the Analyst reasons about cells, so non-square cells would have been a permanent footnote |
| **Reference bots live in `harness`, not `contract`** | Spec §5.1's dependency table is circular (`engine` ← `contract` ← `engine`). `contract` must have zero workspace deps because all five other packages consume it |
| **No worktree** | The repo was empty; there was no parallel stream to isolate from. Revisit if two streams ever touch the same package |

---

## 2026-09-02 — Milestone 1: contract, engine, sandbox, gates 1–2

Committed as `e03cdc7` — *"Milestone 1: contract, engine, QuickJS sandbox, harness gates
1-2"*, 436 tests green.

**Agent A — scaffold + `@rematch/contract`.** 206 tests. Ran first and alone, because
everything else codes against it.

Found **7 ambiguities in spec §4** that a parallel agent would otherwise have each
resolved differently. All 7 are written down in
[`packages/contract/CHANGELOG.md`](../packages/contract/CHANGELOG.md) and
`packages/contract/README.md`, which is why that file exists and is now CI-gated. The
consequential ones:

- `move` with any magnitude → normalized to a unit vector; a **zero-length** `move` is
  accepted and canonicalized to `idle` rather than rejected ("stand still" is a legitimate
  intent and must not cost a contract violation).
- Cooldowns are checked **first**, so the rejection reason is the actionable one
  (`cooldown: burst (37 ticks)`).
- `validateAction` must be **total** — never throws, for `null`, arrays, functions,
  symbols, revoked Proxies or throwing getters — and canonicalizing, so unnamed properties
  never reach the engine.
- A malformed `view` degrades to `CONSTANTS.arena` / "ready" rather than failing the
  action: a broken engine state is never blamed on the strategy.

**Orchestrator — froze the boundary before launching B and C.** `StrategyRunner`,
`DecideResult`, `RunnerFailure` and the name of the injected PRNG (`rand()`) were settled
and committed as contract 0.1.1 *first*, specifically so the engine agent and the sandbox
agent could not each invent the interface between them. This is the single decision that
made the parallelism work.

**Agent B — `@rematch/engine`** (parallel with C). 87 tests. 750 k ticks/s on the bench.
Raised **4 game-feel questions** it correctly refused to answer itself.

**Agent C — `@rematch/sandbox` + Gates 1–2** (parallel with B). 98 sandbox + 45 harness
tests. Two findings that changed the architecture:

- Benchmarked the full `decide` round trip at **16–43 µs** depending on `BossView` size
  (marshalling dominates; the strategy's own logic is noise next to `JSON.parse`). 200
  matches × 3600 ticks is therefore 12–31 s of sandbox time **on one thread** — inside a
  45 s interlude budget. → **Gate 3 must be worker-parallel**, decided here, before Gate 3
  existed.
- `Eval` and `Promise` cannot be removed as QuickJS intrinsics (the host's `JS_Eval` and ES
  module evaluation go through them; with either off, no strategy loads at all). The
  *globals* are deleted instead and Gate 1 keeps both names denylisted.

**Human — delegated the 4 game-feel calls to the orchestrator**, who decided:

| Question | Decision |
|---|---|
| What does `burst.count: 8` mean? | `count` selects a **shape**, not a width: 3 and 5 are aimed cones, **8 fires a full 2π ring**. A 1.54 rad 8-shot cone was just a wider 5, and a strategy had no way to ask for area denial |
| Player HP 5? | **Kept.** Five hits is legible as pips and short enough to restart instantly |
| Boss slower than the player? | **Kept** (2.6 vs 3.6 px/tick). Kiting must work; `charge` is the answer to it |
| Commit granularity | **One commit per milestone**, each verified inline by the orchestrator before committing |

---

## 2026-09-02 → 09-03 — Milestone 2: playable fight, bots, Gates 3–4

Committed as `a729afa` — two agents in parallel.

**Agent D — `@rematch/web` renderer.**

- **AC 3 proven**: browser hash == Node hash == `362eab563d1066c7`, over a recorded 962-tick
  Round 1, through the browser's own QuickJS instance
  (`packages/web/e2e/determinism.spec.ts`, and the Node half in
  `packages/web/test/replay-fixture.test.ts`, which runs in `pnpm verify`).
- **Finding, unprompted and important**: instrumenting damage showed **~100% of player
  damage comes from un-telegraphed bullets**. The two telegraphs (charge 20 ticks, slam 40
  ticks) are readable and fair — they are just not where the difficulty lives. Logged as a
  playtest risk rather than fixed; changing it is a game-design decision, not a bug.

**Agent E — reference bots + Gate 3 + Gate 4** (parallel with D).

- `Camper` / `Kiter` / `Rusher` / `Dodger` / `Mimic`, the worker-parallel simulator, the
  fairness bands, Gate 4's perf measurement.
- **Stalled once**, after ~40 minutes. The work was already on disk; the orchestrator
  inspected the tree, confirmed it, and continued from there rather than restarting the
  agent.
- Proved the **Round 2 band is reachable** by hand-writing
  `packages/harness/test/fixtures/round2-candidate.js` and landing it inside 0.35–0.50.
  This mattered: if no human could hit the band, asking a model to was unfair, and the whole
  Gate 3 design would have needed re-tuning before the Coder agent existed.
- **200 matches in 0.9 s** with workers — the worker decision from M1 paid off immediately.

---

## 2026-09-03 — Milestone 3: the agents package and the fallback pool

Committed as `882f0aa` — two agents in parallel.

**Agent F — `@rematch/agents`.** 88 tests, no network in any of them.

- Analyst, Coder, context assembly with the two **denial tests**, the rewrite loop, 10
  canned replays, the opt-in `eval:agents`.
- **The loop closes headless in 1.1 s** (measured 1 052 ms): Gate 1 rejection → Gate 3
  rejection → approved on attempt 3, with the real gates. That sequence is
  [`SYSTEM.md`](SYSTEM.md) §6.
- Interrupted **three times by `529 Overloaded`** from the API during its own session;
  resumed each time and lost no work.
- **Sonnet-class default** (`claude-sonnet-5`), per-agent overridable. Orchestrator's call:
  latency is the binding constraint inside AC 5's 45 s, and with a deterministic verifier
  behind the Coder a weaker answer costs one more cheap attempt rather than a wrong result.

**Agent G — the fallback pool** (parallel with F). 8 strategies, 2 per round for rounds
2–5, every one balance-tested into its round's band (`packages/server/test/fallback.test.ts`).
Three findings, now written into the Coder's prompt as measured `harnessHints`:

- `spawn` **cadence is the strongest single lever** on the panel win rate.
- `Rusher` is **near-unbeatable** without a `burst` at `count: 8` (the full ring) or a
  `slam` on the boss's own position; a cone at contact is a free dodge.
- Fixed duty cycles give **binary** per-bot outcomes (0.00 or 1.00). Rolling the injected
  `rand()` per phase is what makes a band **tunable** continuously — which is also the
  clearest justification for `rand()` existing at all.

**Blocker, recorded here rather than worked around: no `ANTHROPIC_API_KEY` in the
environment.** Everything from M3 on is built and tested against `mockProvider`. The loop
is proven; the model's behaviour on this task is not. AC 6 stays open.

---

## 2026-09-03 — Milestone 4: interlude UI, server, then the §7 controls

Two commits, four agents, two pairs in parallel.

**Agent H — the interlude UI** (parallel with I). Four beats driven entirely by the
`RewriteEvent` stream, a mock source and an SSE source selected by `?agent=`, plus 3 new
Playwright specs — the e2e suite reaches **12 tests** across 5 spec files.
The mock is what makes `pnpm dev` a complete demo with no server, no key and no network.

**Agent I — `@rematch/server`** (parallel with H). `POST /api/rewrite` streaming
`RewriteEvent`s as SSE over `node:http`, fallback-only mode without a key, rate limit, CORS,
artifact event logs. Split `handleRewrite(body, emit, signal)` from the Node framing so the
endpoint has no `req`/`res` — which is also what lets the tests drive the real handler with
only the model mocked.

Produced a **Vercel risk assessment** the orchestrator turned into a recommendation:
`resolveWorkers()` sizes Gate 3's pool from `availableParallelism()`, which on a serverless
function reports the *host's* cores while the function gets 1–2 vCPU — the single most
likely way AC 5 fails on the deployed URL. → **split deployment recommended** (static web
on Vercel, server as one always-on Node process). Human decision pending; full analysis in
`packages/server/README.md` § Deploying.

Committed as `bf6534c`.

**Agent J — the §7 deterministic controls** (parallel with K). Pre-commit hook running
`scripts/verify.sh`, the determinism ESLint rule with `noInlineConfig`, the CI workflow with
the contract CHANGELOG gate.

**Agent K — event-stream polish + Coder harness hints** (parallel with J). Gate 3 progress
batched, `meta` on `rewrite.done`, the Analyst streaming prose before its JSON, and the
per-bot rate table on a Gate 3 rejection.

Committed as `069be8d`. **`pnpm verify`: 749 tests, 41 s, green** — contract 206, agents
118, harness 102, web 100, sandbox 98, engine 89, server 36.

Every milestone was verified inline by the orchestrator with `pnpm verify` **and** the
harness CLI against real fixtures before the commit was made. No agent committed anything.

---

## What went wrong

Kept because the failures are the interesting part of a parallel-agent build.

1. **An agent stalled** (M2, bots + gates, ~40 min in). Its work was on disk and complete
   enough to continue from. The lesson is the cheap one: inspect the tree before restarting
   an agent — a stall is not a rollback.
2. **Three `529 Overloaded` interruptions** during the M3 agents session. Resumed each time
   with no lost work. Worth noting because it is the same failure mode the *product* has to
   survive at runtime, and it is why the loop's deadline aborts provider streams and ends in
   a visible fallback rather than a hang.
3. **One flaky sandbox test under `pnpm -r` parallelism.** A timing assertion that held when
   the package ran alone and not when seven suites shared the machine. Fixed in the test, not
   by loosening the sandbox: the 2 ms deadline is a containment control and must stay real.
   (This is also why both determinism replays inject a deterministic clock — a GC pause
   pushing one `decide` over budget turns into `idle` + a violation, and replays would drift.)
4. **Lockfile crossfire.** Two concurrent agents both added dependencies and both wrote
   `pnpm-lock.yaml`. Resolved by the orchestrator re-resolving once at the end of the
   milestone. The rule going forward: dependency additions are serialized through the
   orchestrator, not done in parallel.
5. **A `$?` bug in the pre-commit script — caught by the agent's own testing.** An
   `if <verify>; then …` with no `else` leaves `$?` at 0, which would have turned **every**
   verify failure into a passing commit. The hook now captures the status explicitly
   (`status=0; "$ROOT/scripts/verify.sh" || status=$?`) and there is a comment in
   `.githooks/pre-commit` saying why. A control that silently passes is worse than no
   control, and this one nearly shipped.

---

## Open — dated placeholders

These are not done. They are listed with what would close them, so the gap is legible.

### `[ ] 2026-09-0? — human playtest (AC 4)`

*Can a human beat Round 1 in under 60 s with WASD + mouse on a first try, in ≥3 of 5
attempts?* Unmeasured. Run `pnpm dev`, open
`http://localhost:5173/?agent=mock&autostart=1`, five fresh attempts, log the outcomes and
times here. The scripted player wins in 962 ticks (~16 s), which says winnable, not fun.
Watch specifically for the renderer agent's finding: ~100% of damage comes from
un-telegraphed bullets, so a first-time player may find the fight unreadable even though
both telegraphs are honest. Spec §11's mitigation applies — *if not fun, simplify
primitives, don't add.*

### `[ ] 2026-09-0? — real API eval + AC 6 evidence (blocked: no API key)`

*At least one recorded real run showing a strategy rejected by Gate 3 and then approved on a
subsequent attempt with no human input.* Blocked on an `ANTHROPIC_API_KEY` being available.
To close: set the key, run `pnpm eval:agents` (10 canned replays, round 2, spec §7's ≥80%
target; writes every event of every run to `artifacts/agents/eval-<ts>.json`), pick a run
that shows a Gate 3 rejection followed by an approval, copy it into `docs/`, and replace
[`SYSTEM.md`](SYSTEM.md) §6 — the section carries a
`<!-- TODO: replace with real run -->` marker and is labelled *"mock provider run"* until
then. Also record the AC 7 number for that run (Round 2 boss vs `Mimic` ≥ 0.70) and the
observed pass rate against the 80% target.

### `[ ] 2026-09-0? — deploy (AC 9, blocked: human decision)`

*Deployed URL loads and completes AC 5 from a cold start.* The recommendation is the split
deployment; the alternative is all-Vercel with `maxDuration: 60`, `REMATCH_WORKERS=2`,
`REMATCH_MATCHES=60`, `REMATCH_ARTIFACT_DIR=/tmp` and `includeFiles` for the fallback pool.
The trade is explicit and worth stating to a jury rather than hiding: 60 matches moves the
panel rate in steps of ~0.03, so a strategy near a band edge becomes a coin flip — that
weakens the **verifier**, which is the thing this project is arguing for. Once decided:
deploy, update the root `README.md` status line (currently *"Deployed URL: pending"*), and
record the cold-start interlude wall-clock here.
