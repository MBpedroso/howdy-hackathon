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

## 2026-09-03 (evening) — the real API eval: OpenAI, K=3 candidates, and a burnt budget

**Human.** Anthropic credit was unavailable; OpenAI credit was. Decision: make the
vendor pluggable rather than swap one hardcoded client for another, because the product
should not care and the *demo* must never be able to claim one vendor while billing the
other.

**Orchestrator + agent.** `selectProvider()` becomes the single decision point for
vendor, key and per-agent model, shared by the server banner, `/api/health` and
`pnpm eval:agents` (SPEC §13 delta 11). Model: **`gpt-5.4-mini`** for both agents —
latency is the constraint inside AC 5's 45 s, not depth, and the Coder writes ~80 lines
against a frozen contract with a deterministic verifier behind it.

**First real numbers, and they were bad.** Five evals of 10 canned replays at one
candidate file per attempt: pass rates **0.3, 0.3, 0.3, 0.2, 0.0** against spec §7's
0.8 target. The failures were almost all Gate 3 — the file parsed, executed in QuickJS,
and was simply the wrong difficulty.

**The fix was more samples, not a better prompt.** The round-2 band is 0.15 wide
(0.35–0.50) and the model cannot measure its own output, so one file per attempt is
close to a coin flip. `REMATCH_CANDIDATES` (default 3) makes an attempt write three
files from one context, aimed at the low edge, the middle and the high edge, and lets
the harness keep the best. Cost: 3x the tokens and *the same wall clock*, because the
candidates stream concurrently. Result: **0.6** at eval concurrency 1 (SPEC §13 delta
12).

**What the eval measured about itself.** Of 54 candidate rejections, **52 were Gate 3**
and 2 were Gate 1 — the verifier is doing the job it exists for. And the binding
constraint is the Coder: **p50 7.7 s, p90 12.3 s** over 65 candidate calls, against a
40 s deadline. Three of the four unapproved runs ended on `deadline`, not on
`max-attempts`. Details and the excerpt: [`SYSTEM.md`](SYSTEM.md) §6.

**AC 6 and AC 7 are closed by this evening's work.** Replay `mimic-camper`: three
candidates rejected by Gate 3 (0.04 too easy, 0.62 and 0.77 too hard), then "Warden I"
approved on attempt 2 at panel 0.39 ∈ [0.35, 0.50] with **Mimic 0.99 ≥ 0.70**, in
23.5 s with no human message anywhere. Committed whole at
[`docs/evidence/eval-round2-2026-09-03.json`](evidence/eval-round2-2026-09-03.json).

### What went wrong: eleven eval runs exhausted the account's credit

**Orchestrator failure, and worth naming precisely.** Tuning the candidate count took
eleven `pnpm eval:agents` invocations in one evening. Each is up to 250 model calls
(10 replays x (1 Analyst + 4 attempts x 3 candidates x 2)). Nothing in the repo was
counting, warning, or capping — and the script's only guard was "is a credential
present", which stops being a guard the moment a key is in `.env`, i.e. always, for
anyone actually working on the agents.

The per-IP rate limiter did not help and was never going to: it caps *one caller over
ten minutes*, which is the right control for abuse and no control at all on the total
bill (6 per 10 min is 864 rewrites a day).

This was not a model failure or a code failure. It was **an orchestration failure: no
spend cap, on the one thing in the repo that spends money.** The eval was treated as a
test — something you run again when you change a parameter — when it is a purchase. The
fix is the next entry; it should have existed before the first run.

---

## 2026-09-04 — local-first: spend guards, and a recorded run for the demo

**Human.** New standing rule, effective immediately:

> **Local-first. No LLM call of any kind without explicit authorisation.** Not the
> eval, not the server with a real provider, not a "quick check". Credits are exhausted;
> every call is now a decision a human makes, not a side effect of a command.

**Orchestrator.** The rule is written into the repo rather than left as an instruction,
because an instruction an agent can forget is not a control (the same argument as §7's
deterministic controls). Three guards, all tested, none of which need configuring:

1. **`REMATCH_MAX_REWRITES_PER_DAY`** (default 50) — a *global* per-UTC-day counter in
   `packages/server/src/spendGuard.ts`. Past it the server serves **fallback-only** for
   the rest of the day, logs once, and `/api/health` reports `rewritesToday`, `dailyCap`
   and `spendGuard: "ok" | "capped"`. Not a `429`: degrading to the honest no-key path
   keeps the demo playable, which is what that path was already built for. Deliberately
   a different shape from the rate limiter — per-IP for abuse, global for the bill.
2. **`REMATCH_PROVIDER=none`** — forces fallback-only *even with a valid key present*,
   and is the value committed in the new `.env.example`. `selectProvider` treats an
   unrecognised value as `auto`, which is right for a typo and wrong for an off switch,
   so `none` is handled in the server. An off switch that requires deleting your
   credential is one nobody uses under time pressure.
3. **`REMATCH_ALLOW_SPEND=1`** — `pnpm eval:agents` refuses to run without it and prints
   the worst-case call count for *that invocation's* flags first (~250 by default), plus
   the free alternatives. Deliberately not in `.env`: a variable that must be typed at
   the call site cannot be silently inherited.

**And the demo needed to stop costing money too.** A video of the interlude was going to
mean either re-running the live loop per take (spend) or filming the mock (honest, but
it is not the model). So: a third interlude source, **recorded-run mode** —
`?agent=recorded&run=<name>` replays a real eval run from a committed JSON asset, at
zero cost, offline, forever.

Three runs are recorded from the 2026-09-03 eval — `mimic-camper` (5 rejections then
"Warden I", 23.5 s), `dodger-a` (8 rejections then "Lantern III"), `kiter-a` (7 then
"Warden I") — chosen because each is *approved after at least one Gate 3 rejection*,
which is the shape AC 6 asks for. The footer badge reads
`RECORDED RUN · gpt-5.4-mini · 2026-09-03` for the whole interlude, and Round 2 really
loads the recorded approved source through QuickJS — asserted in
`e2e/recorded.spec.ts` by reading the boss's name off the HUD, which a replay cannot
fake.

**One thing about it is reconstructed, and is labelled as such.** The eval artifact
records **no timestamp per event** — `runOne` collects the stream with
`(event) => void events.push(event)` and nothing more — so the replay's cadence is
derived from the durations the artifact *does* measure (the Analyst's beat, each
candidate's Coder call, every gate) and scaled so the total equals the run's real wall
clock. Phase boundaries are measured; spacing within a phase is interpolated. Each
recorded file says so in its own `timing.method`, and `packages/web/scripts/timeline.ts`
explains the arithmetic. The alternative — a plausible invented cadence with no note —
would have made the recorded mode a second mock wearing a real badge.

**A real bug fell out of it**, which is the argument for recording real runs rather than
trusting hand-written ones. The candidate tab strip kept its views in a *sparse* array
indexed by candidate number, and iterated it with `for…of`. The mock always finishes its
three candidates in order 0, 1, 2, so there was never a hole. `gpt-5.4-mini` finished
candidate 2 before candidate 1, and the interlude died mid-run on
`Cannot read properties of undefined (reading 'tab')`. The type now says
`Array<CandidateView | undefined>` so every read has to admit the holes exist.

**Also fixed while measuring:** the first recorded replay was *slower than the
recording* — 1 223 of 6 338 events in six seconds at `?speed=20`. One `setTimeout` per
event hits the browser's ~4 ms nested-timer clamp, so 6 000 of them take ~25 s whatever
number they are given. The replay is now scheduled against a wall clock and emits
anything already due in the current tick, which also removes accumulated drift.

**Docs.** [`SYSTEM.md`](SYSTEM.md) §6 now carries the real run and a measured pass-rate
paragraph in place of the mock-provider excerpt (the
`<!-- TODO: replace with real run -->` marker is gone); SPEC §13 gains deltas 11–14.
Remaining open: AC 4 (playtest) and AC 9 (deploy) — both below, both needing a human.

---

## 2026-09-04 — a no-API local option: the `claude-cli` provider

**Human.** Asked for a way to run the Analyst/Coder loop **without an API key at all**,
on the Claude Code subscription already installed on this machine, for local dev,
playtests and the demo video. Explicit budget for the work: at most six real CLI
invocations, and no `pnpm eval:agents`.

**Agent.** `packages/agents/src/providerClaudeCli.ts` — `claudeCliProvider()`, a fourth
`LLMProvider` that spawns one `claude -p --output-format stream-json --verbose
--include-partial-messages` subprocess per model call, prompt on stdin, and parses the
stream-json lines into the same `{text} … {done}` events the API providers emit.
`REMATCH_PROVIDER=claude-cli` selects it; `/api/health` reports it by that name rather
than as `anthropic`, because whose wallet paid is not something a demo should be vague
about.

Three decisions inside it are worth recording.

1. **No tools, and this is a correctness argument rather than hygiene.** `--tools ''`,
   `--strict-mcp-config` and `--safe-mode` give a pure text completion — the CLI's own
   `init` event confirms `"tools": []`. Without them the Coder would be handed `Read`
   and `Bash` *in the repo it is being evaluated in*, and the project's central claim is
   that the harness decides what ships. An agent that can read `packages/harness/` is
   not writing a strategy, it is reading the answer key.
2. **The API-key variables are stripped from the child's environment.** The CLI prefers
   a key over the logged-in session, so a key inherited from `.env` would silently bill
   the account this provider exists to avoid. `"apiKeySource": "none"` in the `init`
   event is the proof it worked.
3. **`auto` never picks it.** A binary on `PATH` is not a credential and not a decision
   anyone made. It is opt-in by name, on a local machine — the deployed server has no
   session logged in and would spawn a subprocess only to fail.

**What the smoke test found, which is the interesting part.** Five real CLI calls: one to
learn the event shapes, one Analyst prompt, three Coder prompts. The Analyst parsed
first try and read `mimic-camper` correctly as a `camper` in 19.4 s. The first Coder call
**hit the 60 s timeout guard** — and the second, with the guard raised, explained why:
**145.7 s, 126 s of it before the first text delta, 13 456 output tokens for a
5 486-character reply.** Almost all of that was thinking, inherited from the developer's
own Claude Code session effort setting.

So the provider passes `--effort low` by default, the same trade `OPENAI_DEFAULT_EFFORT`
makes and for the same reason: the Coder writes ~80 lines against a frozen contract with
a deterministic verifier behind it, so an extra attempt is cheap and two extra minutes of
deliberation is the one thing a 45 s interlude cannot buy. The third Coder call, at
`low`: **17.6 s, 1 549 output tokens, one fenced `js` block, 82 lines, `staticCheck`
PASS on the first try** — same result, 8x faster. Both replies passed; only the clock
differed, which is exactly the shape that makes the low setting the right default rather
than a compromise.

**The honest caveat.** Even at `low` this path is slower than the API providers, because
a CLI turn is a whole Claude Code session start (~18 s per Coder call against a 40 s
loop deadline). It is the *playtest and demo-rehearsal* provider, not the one AC 5's 45 s
was measured against — the docs say to raise `REMATCH_DEADLINE_MS` with it and to keep
`?agent=recorded` for anything that has to hit 45 s. The CLI's own five-hour rate limit
also applies and is invisible to the loop until it bites.

29 new tests in `packages/agents/test/providerClaudeCli.test.ts`, all against an injected
fake `spawn` — **`pnpm verify` still launches no CLI and spends nothing**, which on this
path matters more than before: a token here is a slice of the developer's subscription
rather than a line on an invoice. Two of the tests found real bugs while being written:
a double SIGTERM on the normal abort path (the `finally` terminating after `onAbort`
already had) and a blank `REMATCH_CLI_TIMEOUT_MS` parsing as a 0 ms timeout.

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

## 2026-09-04 — a human playtest found a frozen boss; the gate that could not see it

**Human (playtest).** *"After winning Round 1 the interlude ran and the Round 2 boss just
stood still in a corner of the screen for the whole round."*

**The bug.** `round2-candidate.js` drifted onto the centre of the player's hottest heat
cell and returned `{type:'idle'}` from then on. `history.playerPosHeat` is **cumulative
over the whole round and never decays**, so the "habit" it was guarding was a cell the
player had left twenty seconds earlier; with the player outside the slam box and outside
the burst window, every other branch declined too. Against the recorded playtest log: 219
idle ticks out of 510 and one motionless run of **263 ticks — 4.4 seconds**, with *zero*
contract violations.

**What made it interesting is that all four gates approved it, and all four were right.**

| Gate | Why it could not see it |
|---|---|
| 1 `static` | `idle` is a legal action |
| 2 `fuzz` | `idle` is always *valid*, costs no cooldown, is not a violation |
| 3 `balance` | reads only the win rate — and the frozen version measured 0.38, *inside* the 0.35–0.50 band. Partly **because** it froze: a stationary boss is easy to shoot |
| 4 `perf` | `return {type:'idle'}` is the fastest `decide` there is |

A property no gate can see is a property that ships broken. It had: **ten of the eleven
shipped strategies** ended `decide` with the same "nothing to do, return `idle`" fallback.

### The fix, in three parts

**1. Gate 3 grew a third assertion, ACTIVE** (`harness/src/sim/activity.ts`,
`ACTIVITY` in `balanceConfig.ts`). A tick is idle when the boss did not move, is not
telegraphing, is not mid-charge, and its last action was `idle` **or a `move` that
displaced nothing**. Reject when the worst run over every match exceeds 90 ticks (1.5 s)
or the p90 per-match idle fraction exceeds 0.25. Measured across both halves of the match
budget, panel *and* Mimic — the four scripted bots walk scripted paths, and the stall
needed a human, who settles in a cell, leaves, and settles elsewhere.

Three decisions worth recording:

- **Displacement, not action type.** `fallback/round3/emberline` had no `idle` branch at
  all and still froze for 169 ticks: its orbit walked the boss into the top-left corner,
  where `move` clamps at the boss's own radius. An action-type check would have passed it,
  and this clause is what caught six more of these (five `back off from the player`
  branches, one orbit).
- **Two numbers.** A max alone misses a boss that idles 80 ticks, twitches, idles 80 more;
  a mean alone hides a quarter of the matches being dead.
- **A gate, not a test.** The previous session argued the opposite — that "holding
  position" versus "crashed" is a judgement about how the game reads, not a contract — and
  wrote `activity.test.ts` instead. The playtest settled it: the file only asserted the
  one strategy that had been reported, and the other ten kept shipping.

It costs nothing: the matches were already being simulated, and the measurement is two
adds and a `hypot` per tick. Reason strings name the fix, not the symptom, and are joined
after FAIR and ADAPTED rather than replacing them:

```
boss motionless for 263 consecutive ticks (4.4 s) vs Kiter — never return idle as a
resting state; patrol, reposition or feint instead (limit 90 ticks)
```

**2. Every shipped strategy was fixed.** Resting `idle` became a patrol across the ground
the boss guards, or a strafe perpendicular to the player that holds whatever range the
branch above chose. **Straight legs of ~34 ticks, never a curve** — every reference bot
leads its shots off the boss's last-tick velocity, and a curve defeats a linear lead
permanently. (The first attempt at `round2-candidate` was a circular orbit; it went 0.38 →
0.72 against the panel. Unhittable by construction is not "harder", it is broken.)

Two more bugs fell out of the same audit, both in the two `web/` strategies: `round1.js`
and `hound.js` asked for a `spawn` whenever the cooldown was ready, and a `spawn` refused
at the two-minion cap **keeps its cooldown and costs a violation** — so with two minions
alive they asked every tick, froze, *and* (because that branch sits above the burst)
stopped shooting entirely. Both now rate-limit by tick, like the fallback pool always did.

**3. Everything was re-balanced.** The resting motion costs the panel bots real accuracy —
a shot crosses 300 px in ~27 ticks and a moving boss is harder to lead — so seven of the
eight fallbacks needed their pressure dial moved to stay in band. Final table, 200 matches
through Gate 3 (`pnpm harness <file> --round N --matches 200`):

| Strategy | Rd | Panel | Camper | Kiter | Rusher | Dodger | Band | Margin | Idle run | Dial moved |
|---|---|---|---|---|---|---|---|---|---|---|
| `web/round1` | 1 | 0.60 | 1.00 | 0.00 | 1.00 | 0.40 | *(none)* | — | 1t | `SPAWN_EVERY` added (380) |
| `web/hound` | — | 0.75 | 1.00 | 1.00 | 1.00 | 0.00 | *(none)* | — | 1t | `SPAWN_EVERY` added (380) |
| `harness/round2-candidate` | 2 | 0.45 | 0.64 | 0.52 | 0.00 | 0.64 | 0.35–0.50 | +0.050 | 17t | *(fixed 2026-09-03)* |
| `fallback/hollow` | 2 | 0.44 | 1.00 | 0.16 | 0.60 | 0.00 | 0.35–0.50 | +0.060 | 1t | `TURN_HP` 58 → 68 |
| `fallback/metronome` | 2 | 0.46 | 1.00 | 0.52 | 0.00 | 0.32 | 0.35–0.50 | +0.040 | 0t | `MARCH_LEG` 34 → 68, `SPAWN_EVERY` 440 → 900 |
| `fallback/emberline` | 3 | 0.53 | 1.00 | 0.36 | 0.00 | 0.76 | 0.45–0.60 | +0.070 | 0t | `SPAWN_EVERY` 380 → 560 |
| `fallback/nettle` | 3 | 0.50 | 1.00 | 0.00 | 1.00 | 0.00 | 0.45–0.60 | +0.050 | 1t | **none** |
| `fallback/bellringer` | 4 | 0.54 | 1.00 | 0.44 | 0.00 | 0.72 | 0.50–0.65 | +0.040 | 0t | `SPAWN_EVERY` 1000 → 1380 |
| `fallback/curfew` | 4 | 0.55 | 1.00 | 0.48 | 0.00 | 0.72 | 0.50–0.65 | +0.050 | 1t | `CONTACT` 140 → 70, `ENFORCE_CHANCE` added (0.94) |
| `fallback/crossfire` | 5 | 0.61 | 1.00 | 0.08 | 0.52 | 0.84 | 0.55–0.70 | +0.060 | 0t | `SPAWN_EVERY` 460 → 800 |
| `fallback/tollkeeper` | 5 | 0.63 | 0.52 | 1.00 | 0.00 | 1.00 | 0.55–0.70 | +0.070 | 0t | `SPAWN_EVERY` 400 → 725 |

Round means still escalate (0.45 → 0.515 → 0.545 → 0.62), which is the property
`fallback.test.ts` asserts and the reason the pool can claim "the boss gets harder".

Two of them needed more than two iterations to land:

- **`metronome`** — five. `BEAT` looked like the dial and is not: it is a *phase* against
  the cooldowns, so 84 measured 0.32 and 96 measured 0.62. `RING_RANGE` did nothing at all
  (the boss holds 285 px and never enters ring range). What actually moved it was the march
  leg length — a leg shorter than a shot's ~27-tick flight means most shots are in flight
  across a turn and miss for free — and then the minion cadence.
- **`curfew`** — six, and it needed a *new* dial. Every threshold in the file is a cliff:
  `SPAWN_EVERY` 300 → 0.55 and 460 → 0.32, `BACK_OFF` 200 → 0.56 and 140 → 0.38, because
  the four bots' rates are near-binary and a threshold either changes nothing or changes a
  whole bot. It was the only pool member with no `rand()` roll, so it got one
  (`ENFORCE_CHANCE`), which is exactly the technique `harnessHints` tells the Coder to use.

### Three smaller consequences

- **`fallback.test.ts` moved from 60 matches to 120.** At 8 seeds per bot the panel rate
  moves in steps of 0.031, so the suite's own 0.03 margin requirement is one grid point
  wide — and `curfew` and `tollkeeper` could not satisfy it at 60 *and* 200 without
  over-fitting the first eight seeds. Doubling the sample is the honest fix (~15 s → ~30 s);
  the assertion is what had to be affordable, not the number.
- **The AC 3 replay fixture was regenerated.** `round1.js` changed, so the scripted
  player's input log changed with it: `6568b87bb4974fb8` / 962 ticks →
  **`74cd659935e33202` / 909 ticks**, still `playerWon`. The hash is a recorded
  expectation, not an invariant.
- **The Coder's prompt gained the rule and stayed under 13k.** ACTIVE is now in
  `harnessRules` with its real rejection sentence, and `harnessHints` says out loud that
  `playerPosHeat` is cumulative and never decays — *aim pressure there, then keep moving;
  never park on it*, which is the sentence the frozen strategy needed. Paid for by cutting
  two duplicates from `contractDoc`: the Gate-1 rule-id list (every rejection names its own
  rule) and the README's gate-layering table (`harnessRules` says it better, with real
  rejection sentences). 12 991 → 12 881 characters.

### What is knowingly left broken

The three recorded runs in `packages/web/public/recorded/` are **real model output from
2026-09-03**, and the strategies they got approved use `idle` as a resting state: measured
worst runs of 155, 183 and 764 ticks. They are not re-recorded, because re-recording would
mean either spending credit the project does not have or inventing model output — and not
inventing model output is the entire point of that mode. So each file and each `index.json`
entry carries a `knownIssue`, and the interlude footer shows it on screen next to the
`RECORDED RUN` badge:

```
KNOWN ISSUE · boss idles up to 764 ticks (12.7 s); generated before the ACTIVE assertion existed
```

A viewer who can see the freeze can read why it is there. Closing it needs one authorized
eval run and `pnpm --filter @rematch/web record:run`.

**Verification.** `pnpm verify` green, `pnpm test:e2e` 16 green, `pnpm test:balance` green.
No LLM was called: every number above is the harness's, on the fixed seed set.

---

## 2026-09-04 — the same playtest, second finding: the agents had no faces

**Human (playtest, continued).** *"Today the interlude is just numbers on a screen; the
player can't connect what's happening to who is doing it."*

Every number on that screen is real, and that was the problem: four panels of measured
output with no author read as one machine talking to itself. A viewer could read `✗ Gate 3
balance — 0.91 vs panel` and still not know that a *model* wrote the file and a
*deterministic harness* threw it out — which is the entire argument of the project.

**Human decision — raster portraits.** Three PNGs generated with an image model
(`packages/web/public/agents/{analyst,coder,judge}.png`, plus `boss.png`), 1024×1024 on
`#0B0F1A`, with the accents chosen at the same time: Analyst teal `#2DD4BF`, Coder amber
`#F59E0B`, Judge red `#EF4444` / green `#22C55E`, Boss magenta `#C026D3`. This **overrides
spec §2.3's "no raster art, no image generation dependency"** and is recorded as delta 17
in [`SPEC.md`](SPEC.md) §13. The dependency it introduces is bounded to four files that
are not on any code path: `ui/portrait.ts` renders an SVG placeholder *first* and reveals
the `<img>` only on `load`, so the game is complete without them and the art is a
drop-in — which is also how the whole screen was built and screenshotted before the PNGs
existed.

**Agent — two screens.**

1. **A start screen** in place of "Click to fight" (`ui/screens.ts`, full-viewport, fits
   1280×800 with no scroll): the cast as three cards with a one-line plain-language role
   each, one round explained in four steps, and the controls — including the dash and both
   telegraph tells, which no screen had ever taught. The **Judge's card is deliberately
   built differently** (hard corners, a dashed rule, a `DETERMINISTIC` chip, and "Not an
   AI" as the first three words of its role), because the one thing a viewer must not
   conclude is that a model marks its own homework. A remembered "skip this intro next
   time" box (`ui/intro.ts`, `localStorage`, `try`/`catch` on both sides); `?autostart=1`
   still bypasses it first in precedence, `?intro=1` forces it back.
2. **The interlude, attributed** (`interlude/castStatus.ts` + `ui.ts`). Each beat's panel
   gets a portrait, an agent name and a one-line status that moves with the events —
   *"watching your replay…"* → *"found 4 patterns · you play like a dodger"*; *"writing
   candidate 2 of 3…"* → *"3 strategies written"*; *"running 200 simulated fights…"* →
   *"✗ rejected Warden III — too hard to be fair"*. The acting agent's panel glows in its
   own accent and the others dim, so *who* is working is legible at a glance and in a
   still frame. The Analyst's prose became a speech bubble, the Coder's diff got a byline
   with the boss's new name, and verdicts became **Judge stamps**: the mark, the reason in
   plain words, and the harness's own quantitative sentence in monospace underneath —
   never instead of it (spec §2.2: every rejection stays readable). The AC 5 fallback
   wears the same stamp, because "nothing was approved, so something that already was
   ships" is a verdict too.

The status mapping is a **pure reducer over the event stream** (`reduceCast` /
`castStatus`), for the same reason `meterView` is: the mapping is where the bugs are, and
**38 new unit tests** (plus 6 for the prompt fix below) assert the whole table in Node
with no browser.

**Two things this turned up.**

- `[hidden]` stopped hiding. The UA sheet's `display: none` for `[hidden]` loses to *any*
  author `display` rule, so the moment the fallback banner became a flex row it was
  permanently visible — caught by the existing `toBeHidden()` assertion, fixed with one
  `#interlude [hidden] { display: none !important }` for the whole overlay.
- The start screen's 140 ms fade made the first `start-screen.png` look like a layering
  bug: a capture inside the animation window is semi-transparent, and the arena and HUD
  skeleton show faintly through it. The artifact now waits for the animation.

**Agent — one prompt fix, from the same session's other observation.** Both live runs of
the loop shipped a boss called **"Warden II"**, and neither model invented it: `Warden`
was the example name in the Coder's dial block (`name: 'Warden ${suffix}'`) and the model
copied the example, as models do. Two consecutive rounds of a game about a boss that
*changes* both produced a boss with the same name. The example is now
`'<your new name> II'`, and the Coder's message carries a `# THE NAME` block listing the
taken names — `Warden` permanently, plus the previous round's name read out of its own
source with the same AST reader the interlude uses, plus both endpoint files on an
interpolating retry. It is in the *message*, not the ~13 KB cached system prefix, so the
prompt cache still hits across every candidate of every attempt.

**Verification.** `pnpm verify` green (`typecheck`, `lint`, `test`), `pnpm test:e2e` **18**
green (two new: the cast on the start screen, and the remembered skip box), no LLM call
anywhere — the interlude work was done entirely against `?agent=mock` and `?agent=recorded`.
New artifacts: `artifacts/web/start-screen.png`, `interlude-cast-{analyst,coder,judge}.png`.

---

## 2026-09-08 — an independent review, and the boss that passed every gate by vibrating

An outside reviewer was handed the repo and `docs/HANDOFF-REVIEW.md` and asked to be
hostile. The full report is [`REVIEW-2026-09-08.md`](REVIEW-2026-09-08.md); it scores the
project 68–72 and the reason is one finding, which is worth writing down in full because
it is the second time the same class of bug has shipped.

### The finding

Five lines, now `packages/harness/test/fixtures/jitter.js`:

```js
export function decide(view) {
  return { type: 'move', dx: view.tick % 2 ? 0.02 : -0.02, dy: 0 };
}
```

It never attacks, never approaches, never spends a cooldown. It **passed all four
gates** — approved for Round 2, panel 0.44 inside the 0.35–0.50 band, ACTIVE reporting
`idle run 0t/90` and `p90 0%`, and **ADAPTED at 1.00** against the `camper` and `dodger`
replay summaries. Those two are how a nervous first-time player at a demo booth actually
plays, so this was not a corner case; it was the modal path. On screen it is a dot
vibrating on one tile, and the interlude stamps APPROVED over it.

The `0.02` is not the trick, and the first hypothesis — that it was sneaking under
`STILL_EPSILON` (0.01 px) — was **wrong**, which is worth recording because it cost an
hour. `validateMove` normalizes `move` to a unit vector, so the magnitude is discarded
and the boss steps its full 2.6 px every single tick. It is genuinely moving at top
speed. Raising `STILL_EPSILON` to a fraction of boss speed was tried, measured to change
the idle run of **none** of the eleven shipped strategies, and reverted: `move` is either
full-speed or wall-clamped to nothing, so there is no middle band for a bigger threshold
to catch, and shipping an inert behaviour change alongside a real fix only muddies both.

The actual defect is that ACTIVE's two clauses are both about **stalling**, and a boss
that oscillates never stalls. Worse, `sim/simulate.ts` had been reducing a `minTravelPx`
aggregate — commented "a boss that never moved at all is 0" — for exactly this purpose
since the gate was written, and Gate 3 never read it. `grep -rn minTravelPx` returned five
writes and zero reads. The signal was computed and thrown away.

And path length would not have worked anyway: the jittering boss racks up ~9 000 px of
`travelPx` inside a 5 px box. What was missing is *displacement*, so the measurement is
now `spanPx`, the diagonal of the boss's bounding box over a match.

### Why the band accepted it

`runMatch.ts` defines `bossWon: state.outcome !== 'playerWon'` — running out the 60-second
clock is a boss win. So a boss that never attacks beats any bot that fails to kill it in
time, which is why a do-nothing boss measured Camper 0.76 and Dodger 1.00. Passivity is
*rewarded* by the panel.

That is the deeper problem and it is **not fixed**. Changing it re-baselines every band,
every margin and every calibration fixture in two packages, six days from the deadline —
so the span clause is a floor under the symptom, and the incentive stays. It is recorded
here rather than smoothed over: a reviewer asking "is ACTIVE a real control or a patch?"
is right to ask, and the honest answer is that it is a floor, deliberately.

### The threshold, and why it is not a percentile

`ACTIVITY.minSpanPx` is the boss's own diameter, `ENGINE_CONSTANTS.boss.radius * 2` = 56
px: over a whole round the boss must range at least its own width. Measured across the
eleven shipped strategies, the narrowest is `fallback/round5/tollkeeper` at **155.7 px**
(2.8× of headroom) and the attack measures **2.6 px** (21× below the line). Anything in
that two-order-of-magnitude gap would work, and a game quantity is the one choice that
does not need to appeal to a sample of eleven.

The span clause sits *outside* the two idle clauses' `else if` chain, so a boss that
freezes for a stretch and creeps around a corner for the rest is told about both — that
sentence is the whole of the Coder's feedback.

### The second finding: Gate 2 was on the wrong clock

`monotonicClock()` reached only the Gate 3 simulator in the 09-04 fix. Gate 2 and Gate 4
still loaded the sandbox on `performance.now()`. For Gate 4 that is correct and deliberate.
For Gate 2 it was an oversight against that gate's own docstring, and a bad one, because
Gate 2 rejects on *any single* runner failure. Measured at the budget edge — a `decide`
doing N iterations of arithmetic:

```
  N = 20 000   pass          N = 40 000   REJECTED, 4 of 560 states over budget
  N = 30 000   pass, 5x      N = 80 000   REJECTED, 543 of 560
```

Anything in that band was decided by how loaded the machine was. After the fix all three
pass Gate 2 — deterministically, four runs under three-way CPU load — and slowness is
Gate 4's business, which is where it belonged. Gate 2's whole `detail` is now bit-identical
across runs including the timing distribution, and `p50` comes back as an exact multiple of
`MONOTONIC_STEP_MS`; `test/gates.test.ts` asserts that, because it is what proves *which*
clock ran. AC 8 still holds: the infinite-loop fixture is still rejected at Gate 2.

So the harness is **three reproducible gates and one measurement**. The docs said "four
deterministic gates" (spec §13, delta 18).

### The third finding: the docs had drifted

Not a bug, and the most likely thing to actually cost points, because it takes a judge
ninety seconds to find:

- README's banner said **897 tests + 14 e2e**; `pnpm verify` says 994 + 18. A count nobody
  re-runs goes stale silently, so the paragraph in `SYSTEM.md` §8 now says which one wins.
- `SYSTEM.md` §6 said the evidence file held "this and the nine other runs"; it holds one,
  and its own `note` field says so. README said "all ten runs". Both corrected.
- `SYSTEM.md` §9 item 1 still read *"No real API run has been recorded (AC 6) … has never
  been run against a live key"* — written 09-03, before the eval ran that evening, and never
  updated. Two sections of the same file contradicted each other on the project's most
  load-bearing claim for eleven days. The `at 069be8d` marker did not save it; the marker
  is gone, because a dated list nobody re-dates is worse than none.
- `BossView.history` is described as "rolling" in the contract and was cumulative all
  along. It was being described elsewhere as "documented as a delta" while missing from
  the deltas table. Now delta 20.

### The check that had to come next, and what it turned up

A new gate clause can only *lower* the loop's pass rate. The eleven shipped strategies
clear the span floor by 2.8x, but they were hand-written to clear it — the distribution
that matters is what the model actually writes. That corpus is on disk: `artifacts/agents/`
holds the untrimmed 10-run eval, and `rewrite.done` events carry every candidate's source.
So all 60 were replayed through the current Gate 3 before anything was called finished.
It costs nothing — no model call, no network — which is the whole argument for doing it
first: `packages/harness/scripts/recheck-active.ts` (`pnpm --filter @rematch/harness recheck:active`), results committed at
`docs/evidence/recheck-active-2026-09-08.json`.

**The span clause rejects 0 of 58.** (Two of the 60 are truncated model output that Gate 1
rejects.) The narrowest real candidate is 86.9 px against the 56 px floor, and that one
already fails an idle clause. The clause is free on this distribution — which is the
result to want, and was not guaranteed.

**But four of the eval's six approvals fail the *idle* clauses today** — `r1-a1-c1`,
`r2-a3-c0`, `r6-a3-c2`, `r8-a2-c0`, with idle runs of 161, 183, 762 and 155 ticks against
the 90-tick limit and p90 idle fractions of 0.73–0.95 against 0.25. Nothing to do with the
span clause. The eval ran on the evening of 09-03; ACTIVE was added on 09-04. **So the 0.6
pass rate quoted in the README, the spec and `SYSTEM.md` §6 was measured against a harness
that no longer exists.**

This is the same mistake as the "897 tests" banner, one level up: a number that was true
when written, quoted ever since, and never re-derived after the thing it measures changed.
The difference is that this one is the project's headline claim.

What it does *not* mean is that the rate is now 0.2. The loop gets the idle-run rejection
as feedback — a specific, actionable sentence naming the bot and the tick count — and it
has four attempts. Whether it recovers inside the deadline is unmeasured, and the deadline
was already the binding constraint (Coder p50 7.7 s, p90 12.3 s against 40 s). The honest
statement, now in all four docs, is that **the current pass rate is unknown and 0.6 is an
upper bound**. The practical consequence: the fallback pool is carrying more of the demo
than the docs implied, which is an argument for keeping it good, not for hiding it.

### The playtest, finally — and Round 2 never worked

Matt played the game end to end on 2026-09-08, twice. The session is on disk
(`artifacts/server/rewrite-2026-09-08T13-*.json`) and it is the first real AC 4-shaped
evidence the project has.

**The first session does not count, and that is on the orchestration.** It was started
with `REMATCH_PROVIDER=none` out of caution about spend, which is fallback-only — no
model runs at all. Matt played four rounds against pre-written strategies and reported,
correctly, that the boss "didn't learn anything" and was "bugged and weird". Nothing was
wrong with the game; the mode had the product removed from it. Lesson recorded because
the same caution nearly hid the actual bug: **being conservative about spend is not free
if it makes the artifact unrepresentative.**

Also found while fixing that: `REMATCH_PROVIDER=openai` was **exported in the shell
environment**, and Node's `--env-file-if-exists` does not override an already-set
variable — so the `REMATCH_PROVIDER=claude-cli` in `.env` had never once taken effect
from that shell. That is the most likely explanation for the OpenAI credits burning on
09-03.

**The second session found the real bug, and it is the worst-placed one yet.** Server
log, three Round 2 requests across two sessions:

```
round 2   ms 45267   attempts 0   approved null   (no artifact)
round 2   ms 45034   attempts 0   approved null   (no artifact)
round 3   ms 45008   attempts 0   approved null   (no artifact)
round 3   ms 39912   attempts 1   approved true   cacheRead 15672
round 4   ms 36181   attempts 1   approved true   cacheRead 10448
round 5   ms 37052   attempts 1   approved true   cacheRead 10448
```

Every failure sits at **~45 000 ms exactly**, which is `INTERLUDE_DEADLINE_MS` — the
client aborting. The server's deadline was `REMATCH_DEADLINE_MS=90000`, so the loop was
still working when the browser hung up: `approved: null`, no `fallback` event, and **no
artifact written**. The case most worth debugging was the only one with no evidence.

Why always Round 2: it is the *first* rewrite of a session, so it is the only one paying
a cold prompt cache. `cacheRead: 0` on every round-2 row against 10 448–18 057 later.
Cold is slower, slower crosses 45 s, and Round 2 is the round the entire product thesis
rests on — the first time the boss visibly learns. **It never worked, in any session, and
nothing in the repo would have told us.**

The fix is not a bigger number on either side. It is that the two numbers were allowed to
disagree: the client now sends `budgetMs` and the server clamps to
`min(configured, budgetMs - 2 s)` (`clampToClientBudget`). A larger `REMATCH_DEADLINE_MS`
is still legitimate for a caller with no browser attached — the eval — it just cannot
exceed what the caller will wait for. Verified live: 12 s budget against a 90 s server
finished in **10 004 ms** with `reason: 'deadline'`, a named fallback (`emberline`) and an
artifact on disk. The player gets AC 5's visible fallback on time instead of a dead
screen, and the run leaves evidence either way. `budgetMs` is recorded in the artifact
for the same reason.

**What the boss actually learned, when it got to run.** Rounds 3–5 of the second session,
all approved on attempt 1, and it tracked Matt changing style between rounds:

| Round | It read him as | The boss it wrote | Its own line |
|---|---|---|---|
| 3 | `mixed` | Cistern II | *"You never hold a cell for long, so half the time you settle, the floor already knows."* |
| 4 | `dodger` | Ferrule II | *"You live in the same band and never touch the edges, so that is exactly where I send the next wave."* |
| 5 | `camper` | Culvert II | *"You never leave the left wall, so the spawns and the follow-up both land there now."* |

The Analyst's observations are specific and checkable — *"0 of 5 damage across 1222
ticks"*, *"49 shots/use during spawn versus 0.1 during plain movement"*, *"only 14 dashes,
skewed East and South, used for repositioning rather than evasion"*. And the harness did
its job on both: in each round the conservative candidate was rejected ("too easy", 0.00
vs Mimic) and the balanced one approved inside the band. That is the thesis working, on a
real human, for the first time.

### "Barely shot" was right, and it is the same root cause a third time

Matt's other complaint from the fallback-only session was that the Round 3 boss barely
attacked. Measured across four full matches against the reference panel, attack
primitives (`burst`, `charge`, `slam`, `spawn`) per 1000 ticks:

```
  r3/emberline    5.0   <-- outlier
  r2/hollow       7.9        r2/metronome   12.4
  r5/tollkeeper   8.3        web/round1     15.4
  r4/bellringer   9.1        r3/nettle      15.6
  r5/crossfire   10.4        web/hound      15.7
  r4/curfew      11.8
```

16 attacks in four whole rounds, 5 of them bursts. Every gate passed it and every gate
was right to: **nothing in Gate 3 asserts that the boss attacks.** FAIR reads the win
rate, and this boss's win rate belonged to its minions and the clock. Third instance of
the pattern, after the frozen boss and the jitter: the harness measures *outcome*, and a
boss can produce the right outcome while doing nothing a player recognises as fighting.

**The dial that looked like the fix was not, and the measurement is the interesting
part.** Raising `PRESSURE_CHANCE` alone barely moves engagement — 0.10 → 0.55 took the
rate from 5.0 to only 7.6, because what limits attacks is cooldowns, not the roll — and
it leaves the band on the *high* side immediately (0.25 measured 0.62 against a 0.60
ceiling). What worked was trading the minions away for the boss acting itself, and the
exchange rate is brutal: at `SPAWN_EVERY` 2400 the boss reached 12.8 attacks/1000t and
its win rate collapsed to **0.35**, far under the 0.45 floor. Its own attacks are worth a
fraction of its minions.

That is `timeout = boss win` again. Standing back and letting the clock run is a winning
strategy, so the band actively rewards a boss that does not act, and any boss that starts
acting has to be *given* the difficulty back somewhere.

Shipped: `PRESSURE_CHANCE` 0.10 → 0.80, paid for by `SPAWN_EVERY` 560 → 1300. **12.8
attacks/1000t at panel 0.55**, margin +0.050 — three times the engagement at a held win
rate, not a harder boss. Verified at 200 matches across the neighbourhood (pressure
0.75–0.85, spawn 1200–1400): every combination lands 0.50–0.55 with 12.8–13.5
attacks/1000t, so it is not a knife edge. 0.80 rather than 1.0 keeps the one-in-five
walking breath the design is built on.

**And this one does *not* become a gate.** The obvious move was a fifth ACTIVE clause,
and the data said no. Re-graded across the 58 real candidate files from the 09-03 eval,
the attack rate runs 0.5 → 21.3, median 11.4, **with no gap anywhere**: a floor of 6
would reject 20 of 58, and one of that eval's six approvals sat at 1.6. Nothing like the
span clause, where the attack measured 2.6 px against a shipped minimum of 155.7 and the
60x separation made the threshold obvious. An engagement gate would trade a third of the
loop's pass rate for a property the model cannot reliably hit — six days out, that is a
bad trade. So the eleven files we control are held to 6.0/1000t in
`harness/test/activity.test.ts`, where the range is known, with a walking-only boss as
the counter-example. The incentive underneath stays broken and stays documented.

**Still open from this playtest:** AC 4 proper — five *timed* Round 1 attempts — was not
run.

### Not done, and why

- **The pass rate has not been re-measured.** The only way is `pnpm eval:agents` against a
  live key, which spends money — a human decision, and the top of this list because it is
  the number a judge will ask about. Everything needed is in place: the eval, the ten canned
  replays, the spend guards, and now a free pre-check that says the span clause is not the
  thing to worry about.
- ~~**Not pushed, so CI has still never run.**~~ **Fixed 2026-09-09**: 19 commits went to
  `origin/main` (`4398e6e..6407ce3`), so `.githooks/pre-commit`'s claim that "CI re-runs the
  same script on every push" now has a workflow behind it. Not verified from this machine —
  the repository is private and the `gh` account this session is logged into cannot read it,
  so whether `verify.yml` went green on GitHub is a thing to check in a browser, not a thing
  this log gets to assert.
- **Recorded demo runs not re-recorded.** They predate the ACTIVE gate and the bosses in
  them freeze; it is disclosed on screen, in 9 px type, in the busiest corner. Re-recording
  spends API credit, so it is a human call too.
- **`timeout = boss win`** — see above.
- **No audio anywhere.** `grep -riE "audio|\.mp3|\.wav"` over `packages/web/src` returns
  nothing. Cheapest Product Quality points left on the table.

## 2026-09-09 — the intro stopped being a wall of text

The start screen had grown into the whole pitch on one card: three "why" blocks, four
pipeline steps, the fighter picker, the controls and both boss tells — eleven things to
read before the first button. Every one of them was true, which is exactly why it kept
growing. A brief that morning asked for the opposite shape: an arcade attract sequence
where each screen is understandable in three to five seconds and the primary action is
never in doubt.

Same content, four beats (`ui/introSequence.ts` for the shape, `ui/screens.ts` for the DOM):

1. **hook** — `A BOSS THAT LEARNS`, the four mascots, seven words of promise, `START`.
2. **concept** — the loop in three steps, plus `YOU → REPLAY → NEW BOSS`.
3. **agents** — who runs it: Analyst → Coder → Judge, the Judge wearing DETERMINISTIC.
4. **arena** — the promise, pick your fighter, the controls, `ENTER THE ARENA`.

Enter/Space advances, Escape skips and is remembered, `?intro=1` brings it back. The
sequence's *shape* is data in one module and unit-tested (`test/intro-sequence.test.ts`):
the order, and the fact that Enter always means continue. An intro where Enter sometimes
skips is worse than no intro, and that bug does not show up in a screenshot.

### Three things the screenshots caught that the tests could not

The e2e suite writes one PNG per beat (`e2e/boot.spec.ts`, `intro-1-hook.png` …
`intro-4-arena.png`) and every assertion about them passed while all three of these were
on screen:

- **The title rendered at 30 px.** `.card h1` is specificity (0,1,1) and `.hook-title` is
  (0,1,0), so the generic card rule won. Fixed by prefixing `.card.start` on all three
  intro headings — the fix is one selector, but the lesson is that a `.card h1` in a
  shared stylesheet outranks every bare class anyone writes later.
- **`START` overlapped the dots and `SKIP INTRO`.** A margin, not a bug in anything.
- **The hero's edge feather greyed Saturn's white head.** `scripts/prepare-hero.py`
  dissolves the artwork's black ground into the page with a smoothstep on the alpha;
  at `FEATHER = 0.14` the falloff reached inside the top mascot. Dropped to 0.07,
  which turned out to be the other horn of the same dilemma — see the next entry.

A "beat is visible and fits" assertion cannot see any of those. Looking at the four files
is still the check that finds them, and it took one minute against a suite that takes 38 s.

### The copy the Judge gets

`cast.ts`'s Judge line was `"Not an AI. Runs 200 simulated fights…"`. "Not an AI" moved to
the DETERMINISTIC chip on the same card, because the card was making the same claim twice
while being the shortest thing on screen that has to land.

## 2026-09-09 (later) — the same four screens, composed instead of centred

A layout brief on the finished sequence: the direction is right, the proportions are
not. Every beat centred its own content in the viewport, which is how a web page is
built and not how a game screen is — the dots and the button landed wherever the
content happened to end, so they moved between beats, and a beat with three sentences
in it left a third of the screen empty above them. "It should not feel like a website
with four centered informational sections."

**Every beat is the same three-band grid now**: a title band, a content band that
takes what is left, and an action band pinned to the bottom (`introFoot` in
`ui/screens.ts`, `.intro-head` / `.intro-body` / `.intro-foot` in `styles.css`).
Roughly 15/70/15 at 1440x900, and the outer bands are `clamp`ed against `vh` so they
give their padding back before the content is squeezed. The consequence worth having
is that START, NEXT and ENTER THE ARENA are the same component in the same place on
all four screens, so the primary action is never looked for.

Then the proportions inside the bands: the title gave room back to the artwork
(`6.4vw` to `4.6vw`) and the artwork became the hero at ~52vh, the concept and agent
rows went from ~69% to ~78% of the viewport width with body copy up from 12.5 px to
15 px, and the arena's promise lost a third of its height so the fighter picker —
the only interactive thing on the screen — could be the largest.

### The artwork was letterboxing itself

`.hook-art-img` was `width: 100%` with a `max-height`, which gives a 3:2 picture a
1000x468 box to sit in: `object-fit: contain` then rendered it ~700 px wide with dead
space either side. The art looked small on a screen that was mostly empty *because*
the CSS was sizing the box and not the image. `width: auto` against two maxima fixed
it in one line, and is the reason the enlargement was free.

### The feather dilemma, resolved by keying it on brightness

Enlarging the hero made its black ground's edge obvious — a visible rectangle on the
page, the exact thing the feather exists to prevent. But the feather could not simply
be widened: 0.14 had already been rejected for greying the top mascot's head. There
is no width that avoids both, because the characters reach much closer to the frame
than they look.

So the ramp is combined with a brightness gate: anything that is not the black ground
stays fully opaque whatever its distance from the edge, which frees the feather to be
wide enough to actually dissolve (`FEATHER = 0.22`). Sound because the ground is
(0, 0, 0) and the page is #07080c — once the edge is gone, nobody can tell where the
art ends. Two byproducts: the first regeneration used the wrong file out of
`~/Downloads` and produced a square hero, which is why the script now prints its
output dimensions; and the alpha channel costs ~40 KB (897 -> 938 KB).

### What "give the panels height" cost before it worked

Three passes. `min-height: 40vh` on the concept row with the number pinned top and
the sentence pinned bottom moved the emptiness from around the card to *inside* it,
where it reads as a loading state. Centring the content in a 40vh card was no better.
27vh with centred content is the version that ships: enough to read as a panel row,
not enough to look hollow. Three sentences on a 1280x800 screen leave air somewhere,
and above and below the row is the least bad place for it.

Also fixed on the way through: `display: flex` on the agent cards stretched the
DETERMINISTIC chip to the full card width, which turned a label on the Judge's name
into a banner over its sentence (`align-self: flex-start`), and the picker CSS block
was in the file twice — the second copy was the live one.

### A second viewport in the suite

The brief asked for balance at 1440x900 and the suite only knew about the 1280x800
projector. The bands are sized in `vh`, so the two genuinely disagree: a taller
viewport gives the content band its room back, and a beat that fits one can be wrong
on the other. `e2e/boot.spec.ts` now walks the beats at both and keeps a screenshot
per beat per size — `intro-N-<beat>.png` and `intro-wide-N-<beat>.png` — because the
last three defects here were all things an assertion passed and a picture did not.

## 2026-09-09 — a playtest finding: RETRY handed you the Round 1 boss

Reported from play, on the third round: *"ele estava realmente bem difícil. Depois que
eu perdi uma vez e iniciei de novo, parece que ele voltou pro nível mais fácil
possível."* It had. `startRound` reads "no source supplied" as "use the bundled
file", and the defeat screen's RETRY passed the round index alone:

```ts
onRetry: () => { void startRound(finished.index); }   // app.ts, until today
```

So dying on Round 3 and pressing RETRY restarted Round 3 against **Cornerbreaker**,
the Round 1 boss and the easiest strategy that ships, while the HUD still said Round
3. One line, and it quietly undid the loop the whole project argues for: the boss the
agents wrote for you survived exactly one attempt and then evaporated — and it
evaporated at the moment a player is most likely to be paying attention to how hard
the boss is, having just been beaten by it.

The fix passes what the round actually ran (`finished.source`) plus the provenance
captured at defeat, so the retry is the same fight: same seed (`roundSeed` is a
function of the session seed and the round index), same strategy, same "written for
you" chip. `driveWith` had been doing exactly this since the AC 3 replay hook landed,
three lines away, which is the annoying part.

### The test, and why it is a timeout rather than a death

`e2e/controls.spec.ts` now starts Round 3 against a probe boss that paces and never
attacks, runs it to the tick limit, and asserts the strategy's name across the defeat
screen and the retry. A timeout is `outcome !== 'playerWon'`, so it reaches the same
screen a real death does without needing to lose a fight by hand. Checked against the
bug before committing: the assertion reads `Cornerbreaker` where it should read
`Retry Probe`.

Which is also a note on the deferred `timeout = boss win` item — the outcome is
already a loss for the player everywhere except in Gate 3's bookkeeping, and that
asymmetry is what makes this test cheap to write.

## 2026-09-09 (later still) — three items off the learning-signal analysis

`docs/ANALYSIS-learning-signal-2026-09-09.md` ranked seven ways to teach the boss
about the player better; three of the cheapest three shipped today (items 6, 1, 7),
all hash-safe, none touching `state.ts` / `step.ts` / `view.ts` and none an LLM
call.

### #6 — `chooseCandidate` stops discarding the Mimic number

`chooseCandidate` (`loop.ts`) ranked approved candidates by `|panel − bandMid|`
alone, so a candidate at panel 0.43 / Mimic 0.31 beat one at 0.45 / Mimic 0.88 for
no reason but array order — both are equally fair and the selector was throwing
away the only number that says "it countered you". The band-mid distance is now
quantized to 0.03 buckets first (the panel rate's own noise floor: near-binary
per-bot rates over 25 matches mean the panel mean moves in steps of
0.25/8 ≈ 0.03, per `harnessRules`' arithmetic), and Mimic rate (descending) breaks
ties inside a bucket. K=1 is untouched — a single log has nothing to rank against.
Four cases covered in `test/chooseCandidate.test.ts` (new file; the function had
no dedicated test before): approved beats rejected regardless of Mimic, same
bucket picks the higher Mimic, different buckets pick the nearer band-mid even
against a lower Mimic, and an unmeasured Mimic (`-1`) never beats a measured one.

**Measured against history, honestly**: a parallel audit
(`packages/harness/scripts/choice-audit.ts`, run against all 39 committed
artifacts — 130 runs, 118 multi-candidate attempts) found the tie-break's
precondition — two *approved* candidates in the same attempt — **never occurred**
in the corpus: 94 attempts approved zero candidates, 24 approved exactly one, none
approved two or more. So the rule changed zero historical choices; it is not that
it agreed with the old one, it never had anything to compare. Among the 24
singular approvals, Mimic ranged 0.71–1.00 (median 0.97) — consistent with
candidates rarely landing close enough in band-mid distance *and* both passing for
the tie-break to ever fire, at least under the fixed low/mid/high dial spread that
produced this corpus. It is kept anyway: the cost is near zero, `blendDials`'
bisection mode can put two candidates in-band together in a way the fixed spread
mostly didn't, and the corpus predates the rule so it cannot rule that case out.
Reproduce with `node --experimental-strip-types scripts/choice-audit.ts` from
`packages/harness/`.

### #1 — the Coder is told how to keep a recent window, not just that it should

`harnessHints` already warned that `playerPosHeat` is cumulative and never
decays (2026-09-04, the frozen-boss fix). It never said what to do about it
beyond "keep moving". The new bullet is mechanical, per the file's own rule about
adjectival dials producing near-identical files (`prompts.ts`, `DIALS`'s
comment): push the player's cell index every ~10 ticks into a ~60-entry ring
(600 ticks = 10 s at 60 ticks/s) and aim at the ring's centroid instead of the
lifetime peak. `harnessHints` grew from 894 to 1256 characters (budget raised
900 → 1300 in its own doc comment and in `context.test.ts`, on purpose rather
than by drift); the Coder's system prompt grew to 13233 characters (bound raised
13000 → 13500 in the same two places). Both stay well inside the ~13.5 KB cached
prefix and the growth is paid for explicitly, not by cutting another line —
see the function's doc comment for why that trade was made this time.

This is the prompt half of open question Q2. The free half — can a strategy
*afford* the pattern at all — is `packages/harness/test/fixtures/rolling-window.js`,
a hand-written strategy that actually runs the ring buffer (fixed-length, `head`
wraps rather than growing) and aims `slam`/`burst` at the centroid while patrolling
(never `idle`-resting, straight-legged, same reasoning as `round2-candidate.js`'s
note 5). It is not tuned to any fairness band on purpose — `test/rollingWindow.test.ts`
asserts only Gates 1, 2 and 4, plus a direct memory reading:

```
$ pnpm harness packages/harness/test/fixtures/rolling-window.js --gates 1,2,4
✓ Gate 1 static 5ms
✓ Gate 2 fuzz 67ms
✓ Gate 4 perf 91ms       (p99 = 0.064 ms, budget 2 ms — 31x headroom)
APPROVED — 3 gates passed
```

(`--round 2 --matches 60` alone stops at Gate 3 — FAIR 0.00, too easy, as
expected and as the analysis said it might — because `runGates` stops at the
first failure by design, so Gate 4 needs its own `--gates` list to be seen in
the same invocation; both runs are in the record.) Gate 2's own sequence pass
measured the serialized memory at 210 bytes against the 4096-byte cap — 60
small integers and two counters, nowhere near it. Whether a *model* writes this
pattern reliably is still the open half of Q2 and stays spend-gated; this only
bounds the mechanics.

### #7 — the Coder gets a machine-readable player profile, not just prose to retype

Analysis item 7: the Coder previously re-typed coordinates out of the Analyst's
JSON ("cell 57 ≈ x=150, y=750" becomes a constant by hand), and a transcription
slip there is a NaN or an off-by-a-cell waiting for Gate 2 or FAIR to find.
`packages/agents/src/context/playerProfile.ts` (new file) renders a compact JSON
block — top ~4 hot cells as `{x, y, share}`, dash `{total, dominantAngleRad,
dominantShare}` (bin 0 = +x, counter-clockwise, TAU/8 per bin — `engine.dirBin`'s
convention), `playerShotsDuring`, and `durations.ticks` — reusing `rankHotCells`
(factored out of `renderSummary.ts`'s `renderHotCells` today, so the Analyst's
prose and the Coder's JSON can never disagree about which cell is "hottest").
`rewrite()` computes it once per call from `input.summary` and passes the
identical string to every one of an attempt's K candidates — cache-safe, and
consistent with the ~13.5 KB system prompt staying byte-identical.
`coderPrompt` renders it as "# PLAYER PROFILE" right after "# THE ANALYST ON THIS
PLAYER" and before the previous-source / bracket blocks; the rejection block is
still the last thing in the message (spec §6.3), confirmed by test. A typical
profile renders at ~540 characters; the Coder's user message grew from ~3.5 KB
to ~4.1–4.4 KB across a first attempt and a retry — comfortably inside the same
13.5 KB-per-part bound.

### Verification

`pnpm verify` — green. See the handoff for the exact count; the two harness gate
suites (`gates.test.ts`, `rollingWindow.test.ts`) and the full `agents` suite
(230 tests, up from 221) all pass, and the denial test in `context.test.ts` was
extended to run with the profile block actually present rather than only proving
the denial for a prompt shape the loop no longer sends.

## 2026-09-09 (yet again) — the learning is real; the fight didn't say so

Reported from play: *"não sinto que ele aprendeu"* — I don't feel that it learned.
The rewrite the whole project argues for (Analyst → Coder, between rounds) is real,
and it already produces the single most honest artifact the product has: a boss
with a new name and a `meta.rationale` written about *this* player's habits
("You never leave the left wall, so the spawns land there now"). None of that was
wrong. What was wrong is where it lived — entirely in the interlude, a 25-second
screen the player watches once and then leaves behind. The fight itself, the part
being played, showed the same sentence in one small HUD panel (`hud-strategy`,
bottom-left, ~11px italic) that nothing on screen ever points at. The claim was
true and unfelt.

Two presentation changes, `packages/web` only — no engine, contract, sandbox,
harness, agents or server file touched, so nothing here can move the replay hash
or a fairness gate by a pixel. `test/*.test.ts`'s "read-only presentation" checks
(the `fighters.test.ts` pattern) now cover both new modules by inspecting
`game/round.ts`, `game/strategy.ts`, `game/loop.ts` and `game/seeds.ts` for the
import and finding nothing.

**The round-start banner.** When a round starts against a strategy the loop
actually wrote (`provenance === 'approved'` — the same test `originLabel` in
`ui/hud.ts` already makes for the "written for you" chip), a banner opens over the
live arena for ~4 s and then collapses toward the HUD panel that keeps saying the
same thing: the boss's new name, and its `rationale`, verbatim. `ui/roundBanner.ts`
is a pure timing reducer — `armed → visible → leaving → hidden`, ticks not
milliseconds, in `interlude/castStatus.ts`'s `reduceCast` style — so the whole
sequence is asserted in Node with no DOM; `ui/roundBannerView.ts` is the thin DOM
half. `pointer-events: none` throughout: the fight is live under it, and
`e2e/interlude.spec.ts` now asserts the fight is still ticking with the banner on
screen rather than merely that the banner exists. It says nothing for Round 1's
bundled boss or a pre-approved fallback pick, same as the chip — a banner over a
strategy nobody wrote for this session would be the one place the product lies.

One bug caught by writing the reducer's own test, not by playing: a single large
tick jump (`app.ts`'s `fastForward`, used by the replay/e2e hooks, renders once
after simulating many ticks synchronously) could land the state in `leaving` and
never advance to `hidden`, because the first version stepped one phase per call.
Fixed by computing the phase directly from elapsed ticks instead of from the
current phase — order-independent, so one call covering the whole window lands in
the right place regardless of how many ticks it skipped.

**"It knows your ground."** The app already holds the previous round's
`ReplaySummary` — it is exactly what `context.summary` hands the interlude for the
rewrite request, so `app.ts` forwards that same object into the next
`startRound()` call and nowhere else. `render/habitCells.ts` ranks that summary's
`playerPosHeat` into the top 3 cells the player actually lived in last round,
mirroring `rankHotCells`/`cellCentre` in
`packages/agents/src/context/renderSummary.ts` by hand (`web` cannot import
`@rematch/agents`) rather than by sharing code. `render/habitHighlight.ts` tails
`state.events` the same way `render/effects.ts` already does, and the moment a
`bossSlamStart` telegraph or a `bossSpawn` lands inside one of those cells, the
renderer pulses a subtle outline over that floor cell in the boss's accent for
about a second, with a small DOM "YOUR HABIT" caption positioned over it
(`ui/habitCaption.ts` — text is DOM, not canvas, for the same crispness reason the
HUD is). Retries and Round 1 pass `null` for the previous summary on purpose
(`startRound`'s new parameter is omitted there, not defaulted around), so the
feature is silent exactly where there is nothing honest to say — no previous round
to have read.

### What this deliberately does not do

No gameplay changed: the boss's decisions, the fairness gates and the replay hash
are all unaware either feature exists. No new claim was invented — both features
surface data the loop already produces (`meta.rationale`, the position heat map)
rather than adding narration on top of it. The habit highlight never triggers on
a charge telegraph (only slam and spawn have a single target point that can sit
inside a cell), and it only ever shows the *previous* round's habit, never
re-reading the live one — showing a player's current position back at them in
real time would be a different, noisier feature.

### Matt playtested it, liked it, and found two more things

Two adjustments, same day, same file set (`packages/web` only, still no sim
touched):

**1. The interlude was still moving on by itself.** The FIGHT button existed, but
`createInterludeHandler`'s `autoFightMs` defaulted to `undefined`, which
`interlude/ui.ts`'s `createInterludeUi` reads as its own `AUTO_FIGHT_MS` (3 s):
after `done`, the screen counted down and continued on its own whether or not
anyone had read the verdict. Every automated flow already passed
`?autofight=0` explicitly (the whole e2e suite, the mock and recorded demo paths),
which is what made the fix a one-line default flip rather than a feature to build:
`interlude/index.ts` now resolves no-param to `0` (disabled) instead of
`undefined`, so a human player always gets the button and nothing in this
codebase's own automated flows needed to change to keep working. `?autofight=<n>`
still opts back in for whoever wants the old countdown.

**2. The banner was in the wrong place.** Matt, in his own words: *"Ao clicar,
coloque na tela aquele quadrado que mostra o que o boss aprendeu, por uns 3-4
segundos. Depois feche e comece o jogo."* — on click, put the box that shows what
the boss learned on screen for 3-4 seconds, then close it and start the fight.
Not an overlay on a live round any more; a pre-fight interstitial the player
closes into the fight. That moved the reducer's clock from ticks to wall time —
while the interstitial is up the round has not taken a single tick, so there is no
tick clock yet to measure against, the same category of timing the interlude's own
`setTimeout` deadlines already use. `roundBanner.ts`'s phases collapsed from
`visible → leaving` (over live ticks) to one `holding` phase timed by `nowMs`
(`BANNER_HOLD_MS = 3500`); `app.ts` gates `loop.start()` on `banner.isHolding()`
and runs a small dedicated `requestAnimationFrame` ticker to drive `banner.update`
while nothing else is producing frames yet — cancelled in `teardown()` so a round
torn down mid-hold (a retry, `driveWith`, a fast reopen) cannot leave a stale
callback pointed at a `loop` a *later* round now owns. `round.state.tick` is 0
throughout the hold and the eventual `loop.start()` still begins at tick 0 like
every other round, so nothing about determinism moved.

Auditing "does anything assume stepping starts immediately on round entry" (the
brief's own ask) turned up two real edges, both fixed before either shipped:

- **Retrying an approved boss must not reopen the reveal.** `roundProvenance`
  alone used to decide both the HUD's "written for you" chip *and* whether the
  banner armed — correct for the chip (a retry should still say so) and wrong for
  the banner (a retry replays the fight the player just lost, not a new one the
  loop wrote; reopening a 3.5 s reveal every death would turn it into friction, not
  a moment). `startRound` gained `showLearnedBanner`, passed `true` only from the
  interlude's own `next()` — the one call site that is always a genuine win→next
  transition — so a retry keeps the chip without the interstitial.
- **`fastForward` (the debug/e2e "skip to the end" hook) must skip the
  interstitial too**, not race it: it simulates synchronously regardless of
  whether `loop.start()` was ever called, so calling it while a round was still
  holding would run the fight to its outcome behind a banner that was still on
  screen, with the hold ticker left dangling into the next screen. It now cancels
  the ticker and force-dismisses the banner first — "skip to the end" already
  means past this too.

Both were caught by reasoning through the call sites before playing, and the
second one is now `e2e/interlude.spec.ts`'s "retrying a round the interstitial
already opened for does not reopen it".

### What this still deliberately does not do

Everything the first cut promised, unchanged: no gameplay moved, no new claim
invented, the habit highlight still only ever shows the previous round's pattern.
Added by this pass: the interstitial's hold is real wall-clock time, spent before
the round's *own* clock starts rather than borrowed from it — a slow machine gets
the same ~3.5 s pause and then the same fair fight, not a shorter fight to make up
the difference.

### 2026-09-10 — a wrong prediction: the highlight fired on transit ground

Playtest finding, with data: Matt was camping the top of the map; "YOUR HABIT"
labelled a cell at the base. Read as a wrong prediction — the feature's whole
credibility is "the boss aimed at where you used to live", and this looked like
it aimed at where he never was. Root cause, verified against
`artifacts/server/rewrite-2026-09-10T16-41-46-470Z.json`: his previous round's
heat map was **flat**. Top cell **0.081** share — barely above the 1/64 ≈ 0.016
a uniform, no-pattern spread would produce — and three of the top four were
row-6 *transit* ground, cells a player crosses on the way somewhere rather than
lives in. `habitCellsFromSummary` took the top 3 cells regardless of how hot they
actually were, so 7-8% transit ground got the same "YOUR HABIT" label a real camp
(the same artifact set measures one at **~0.33**) would have earned honestly.
`rankHotCells` was never wrong here — top-3-by-share is exactly what it promises,
and exactly what the Analyst's identical prose ranking wants (it should say where
the player *actually was*, thin pattern and all). What was missing was a second
question this feature needs and the Analyst's does not: not just "where was the
player", but "was there enough of a pattern to call it a habit at all".

`render/habitCells.ts` gained `MIN_HABIT_SHARE = 0.10`, applied as a filter in
`habitCellsFromSummary` (not `rankHotCells`, which stays the unmodified mirror of
the Analyst's own ranking — see its doc for why the split lands there). `0.10` is
picked to sit strictly between the two measured cases — comfortably above the
flat round's 0.081, comfortably below a real camp's ~0.33 — and reads in English
as roughly 6 seconds of a 60-second round spent in one cell: long enough to be
"lived there," short of which it is "passed through." Below the floor,
`habitCellsFromSummary` returns `[]` and the feature stays silent — the same
"nothing to say" silence it already keeps for Round 1 and a retry, now covering a
third honest case: a round where the player simply moved the whole time.
`test/habit-cells.test.ts` reproduces the reported round's actual shape (not a
rounder stand-in) so it would have failed against the original bug, plus a
real-camp case, the inclusive boundary at exactly `MIN_HABIT_SHARE`, and a mixed
heat map to confirm the filter drops only the cells that miss it.

### What this still deliberately does not do

Everything the first cut promised, unchanged: no gameplay moved, no new claim
invented, the habit highlight still only ever shows the previous round's pattern.
Added by the interstitial pass: the hold is real wall-clock time, spent before
the round's *own* clock starts rather than borrowed from it — a slow machine gets
the same ~3.5 s pause and then the same fair fight, not a shorter fight to make up
the difference. Added by this pass: the feature still never invents a habit — it
now has a second way to correctly report that there isn't one.

### 2026-09-10 (later) — the fallback banner blamed the wrong agent

A different honesty bug, same interlude, caught from a live run rather than a
playtest quote this time: `artifacts/server/rewrite-2026-09-10T16-53-53-446Z.json`
recorded a fallback with `reason: 'error'` and `message: "the Analyst returned
nothing usable after 2 attempts: no JSON object was found in the reply"`. The
Analyst failed; the Coder never ran. The interlude's fallback banner and the
Judge's own stamp both read **"Using a pre-approved strategy — the coder
failed."** — true of the reason *code* `'error'` maps to by default, false of
which agent the run actually blames, and stated as settled fact to whoever is
reading the demo (spec §2.2: every rejection stays readable *and honest*, and
this is the Judge's own stamp saying something the Judge never said).

The event already carried the truth — `RewriteEvent`'s `fallback` and `done`
events both have an optional `message`, and it reached the DOM in exactly one
place: a parenthetical `(the Analyst returned…)` appended in small type after the
wrong headline in the banner, and nowhere at all in the Judge's verdict stamp
(`setVerdict(...)` was never passed `message` to begin with). `interlude/ui.ts`'s
`fallbackText(reason)` was the actual source of the wrong sentence: it mapped
`reason` straight to one of three fixed, agent-attributing phrases
(`'it ran out of attempts'` / `'the coder timed out'` / **`'the coder failed'`**)
with no way to say anything else.

Fixed at the source rather than by adding another line for the truth to lose to:
`fallbackText(reason, message)` now uses `message` — tightened only by trimming a
trailing period/whitespace so the sentence's own period is the only one — as the
clause after the dash whenever the loop sent one, falling back to the generic,
reason-coded phrase only when it did not (round 1's non-issue; a client-side
deadline abort and a player-initiated skip still carry no `message`, so they keep
their existing, accurate generic wording). `showFallback` now threads `message`
into *both* call sites — the banner and, for the first time, the Judge's own
`setVerdict(...)` stamp — and the now-redundant small-print parenthetical was
dropped: the true explanation is the sentence now, not a footnote next to a wrong
one. Checked against the mock and recorded sources, whose own fallback path (the
client-side AC 5 deadline) has always sent no `message`: unaffected, same generic
"the coder timed out" wording as before — `e2e/interlude.spec.ts`'s 45 s-deadline
test needed no change.

One case deliberately left alone: once a server fallback-pool pick exists,
`interlude/index.ts` re-calls `showFallback` a second time with `message:
"shipping <name>"` so the banner names what is actually running — a `message` in
a different sense (*what*, not *why*) that this fix lets take over the sentence
the same as a real failure explanation would, replacing "the coder failed" with
"shipping Warden" rather than composing the two. That is a loss of detail, not a
false claim — "shipping Warden" misattributes nothing — so it was left as-is
rather than growing this into a two-field merge the report never asked for.

`test/interlude-fallback.test.ts` (new) pins the mapping directly: the three
generic clauses with no message, the reported Analyst message overriding
`'error'`'s default (and explicitly asserting the wrong copy is gone, not just
that new copy is present), a message overriding all three reason codes alike,
trailing-period trimming without eating a legitimate mid-sentence period, and
whitespace trimming. No existing e2e spec asserted the wrong "the coder failed"
copy, so none needed adapting.

### Verification

`pnpm --filter @rematch/web` typecheck and test are green: **311 web unit tests**
(seven new in `test/interlude-fallback.test.ts` for this pass, on top of the five
from the habit-cells fix above; the total also includes an unrelated audio
feature's tests, mid-flight in this package from a concurrent session — not this
entry's and not described here). The full Playwright suite is green — **30
specs**, up from 27 earlier in this entry; the difference is the concurrent audio
feature's own spec, not this fix, which needed no e2e changes (see above: no
existing spec asserted the wrong copy). `pnpm verify`
(contract/engine/sandbox/web/harness/agents/server, all seven) is green.

## 2026-09-09 (and again) — a slam is not a threat where the player cannot be

Reported from play, on a round that reached ADAPT mode: the boss slammed the
player's habit cell while the player was on the other side of the arena — Matt's
report, verbatim: *"even dashing toward it he'd only get halfway there."* The
instruction that produced this was `ADAPT_DIALS`'s `place` dial
(`packages/agents/src/context/prompts.ts`): *"Put every `slam` on the hottest cell
… and commit it there whether or not the player is standing in it right now."*
Unconditionally, on purpose — that line shipped 2026-09-09 (later still), the same
day, to fix the *opposite* problem (a boss that wouldn't touch the habit cell at
all). It overcorrected: a `slam` telegraphs once and hits once, at one point, and a
telegraph aimed somewhere the player structurally cannot reach before it resolves
is not pressure, it is the boss missing on purpose, and the Mimic (which keeps
walking back into its own hot cells) rewarded exactly that while a real human
punished it for free.

**The arithmetic, verified against the engine rather than trusted from the report**
(`packages/engine/src/constants.ts`, `packages/contract/src/types.ts`): a slam's
telegraph is `CONSTANTS.telegraphs.slam` = 40 ticks = 0.667 s. In that window a
player's best-case straight-line travel is one dash (`dashSpeed` 11 px/tick x
`dashTicks` 10 = 110 px, matching the constant's own "~110 px of travel" comment)
plus the remaining 30 ticks at `speed` 3.6 px/tick (108 px) = **218 px**, and a slam
resolves against `d <= E.slam.radius` — no player-radius padding
(`step.ts`, the `'slam'` case) — where `E.slam.radius` = **110 px**. So **218 + 110
= 328 px** (rounded to ~220 px / ~330 px in the prompt) is the honest "cannot
possibly land" line: nobody, however skilled, can be hit by a slam aimed farther
than that from where they currently stand, because the best case already falls
short.

**The fix, three places, `packages/agents` only:**

- `ADAPT_DIALS`'s `place` now gates the habit-cell slam on reach — in it, or close
  enough to still be there when it resolves — and leads the *live* player
  otherwise (`player.x + player.vx * 40`, `player.y + player.vy * 40`, the same
  formula `orbiter.js` already uses for its own slam lead), spending `spawn`/
  `burst` to make the habit ground costly instead of slamming it empty. `ground`
  needed no equivalent fix and now says why: a minion has no telegraph-then-resolve
  gap to be caught out of reach by.
- `harnessHints` gained the reachability arithmetic above as a measured game fact —
  numbers only, no engine identifier, so the denial test holds it to the same
  standard as every other line. Budget raised 1300 → 1800 characters (system prompt
  ~13.7 KB), the same "pay for it, don't drift into it" rule as every earlier raise.
- The mem rolling-window bullet (2026-09-09, later still) picked up one clause:
  lead the ring's centroid by the player's live velocity across a slam's telegraph,
  for the same reason — a recent-position target is still just a point in space
  until something says how far ahead of it to aim.

### Verification

`pnpm --filter @rematch/agents test` — 235 tests, all green (up from 230: four new
`ADAPT_DIALS`/`harnessHints` assertions plus the reachability numbers pinned in
`context.test.ts`, in a new describe block named for the playtest). `pnpm --filter
@rematch/agents exec tsc -p tsconfig.json --noEmit` — clean. `pnpm verify` —
green, 79 s, 1113 tests across all seven packages (contract 206, engine 91,
sandbox 100, web 262, harness 139, agents 235, server 80); lint clean.

While this was in flight, two other streams landed unrelated work in the same
checkout — a `REMATCH_STRAGGLER_MS` env override in `loop.ts` for the `claude-cli`
provider's slower healthy-call tail, and the round-banner / habit-highlight
features logged just above — neither touches a line this entry changed, and both
are reflected in the test counts above. This entry also restores the "## Open —
dated placeholders" heading immediately below, which one of those edits dropped
while inserting its own entry ahead of it — a markdown slip, not a decision to
close the section; its placeholders are unchanged.

### 2026-09-10 — the fix above still fenced a player who never settled anywhere

Reported from play the next day (`artifacts/server/rewrite-2026-09-10T16-41-46-470Z.json`):
a spread-out player, hottest cell **0.081** share, with four more cells within a
point of it (0.071, 0.058, 0.054, 0.054 — a corridor, not a corner), and the ADAPT
`place`/`ground` coaching above was still building counters on that cell as if it
were a habit. It reached because "reachable" and "a habit worth fencing" are two
different questions and the previous fix only answered the first one — a boss that
correctly leads a *nonexistent* habit is still wrong, just wrong in a new way.

Verified against the same week's actual camper for scale, not asserted:
`artifacts/server/rewrite-2026-09-09T18-03-48-701Z.json` (already on record above,
the first live `claude-cli` smoke run) — a real camper's hottest cell measured
**0.334** share (two adjacent cells splitting 66.6% of the round almost evenly,
0.334 and 0.332), over **4x** the spread player's peak. That gap is where a
threshold belongs: ~0.10 sits well under the real camper's 0.33 and well over the
flat player's 0.08, with the next runner-up cells at 0.07-0.09 in between showing
there is room either side of it in real recorded data, not just in the sketch.

**The fix is one clause**, added to `harnessHints`'s existing cumulative-heat
bullet rather than a new bullet or a change to `ADAPT_DIALS` — the PLAYER PROFILE
block (analysis item 7, 2026-09-09) already carries `share` per hot cell, so the
Coder has the number in hand the moment it reads the profile; the bullet just says
what to do with it below ~0.10: aim at the live player and pick pressure by
`playerArchetype` (already in the Analyst's JSON) instead of fencing a cell nobody
lives in. `ADAPT_DIALS`'s `place`/`ground` needed no separate edit — both already
read `history.playerPosHeat`'s hottest cell through the same lens this clause now
qualifies, so the fix composes rather than duplicating the number in three places.
Budget: `harnessHints` grew 1975 → (stated ceiling 1800 → 2100, paid for
explicitly again); the full Coder system prompt is 13952 chars, still under its
own 14000 bound with no change needed there.

### Verification

`pnpm --filter @rematch/agents test` — 236 tests, green (up from 235: one new
`harnessHints` assertion pinning the ~0.10 threshold and both recorded shares).
`pnpm --filter @rematch/agents exec tsc -p tsconfig.json --noEmit` — clean.
`pnpm verify` — green, 82 s, 1160 tests across all seven packages (contract 206,
engine 91, sandbox 100, web 304, harness 143, agents 236, server 80) — both web
and harness grew again between this edit and the last (other streams, still
unrelated to anything this section changed); lint clean.

## 2026-09-10 (later) — the Analyst can finish the thought without finishing the JSON

A different live failure this time, not a coaching one:
`artifacts/server/rewrite-2026-09-10T16-53-53-446Z.json` (claude-cli, sonnet,
effort low). The Analyst streamed 1909 characters of clean, on-topic prose —
"Player never dashed once in 1149 ticks…", "Cell 44 (x=450, y=550) alone
accounted for 19.1% of the round…", ending cleanly on a real observation about a
whiffed slam — and then simply stopped. No fence, no JSON, nothing. The retry
failed the identical way, and the whole run fell back: *"the Analyst returned
nothing usable after 2 attempts: no JSON object was found in the reply"*. The
Coder never ran, and the player's win bought nothing.

The retry design (2026-09-03) deliberately does not echo a failed reply back —
*"a model handed its own malformed output tends to anchor the retry on it"* — and
that reasoning is sound for a reply whose JSON block existed and was wrong. It is
backwards for this failure: there was no JSON to have gotten wrong, and the prose
that *was* there is not a mistake to correct, it is unfinished work. Sending back
"could not be parsed" and the full replay a second time asks the model to
re-derive an analysis it had already written correctly once, and — on this
evidence — the exact same well-formed prose, missing its fence, twice in a row.

**The fix distinguishes the two failure modes at the source.** `parseAnalysis`
(`analyst.ts`) now returns a `kind`: `'no-json'` when neither the fence nor the
balanced-brace fallback finds anything at all (prose may still be real), `'invalid'`
for every other rejection — a JSON blob was found and failed to parse, or parsed
into the wrong shape (noise, not echoed, as before). `runAnalyst` threads that
through as an `AnalystRetryContext` instead of a bare error string.
`analystPrompt`'s retry branch (`context/prompts.ts`) now has two shapes:

- **`kind: 'invalid'`** (unchanged): the failed reply is not echoed, the full
  `renderSummary` is re-sent, and the message says what parse error to fix.
- **`kind: 'no-json'`** (new): the previous reply's raw text — not the deltas,
  which `analysisGate` would have capped at a fence that never arrived, so the
  raw text already *is* the whole prose — is included verbatim, and the model is
  asked for *only* the fenced JSON block extracted from what it already wrote.
  **The replay summary is not re-sent.** The prose already encodes everything in
  it; re-sending gives the model a second chance to derive a *different* reading
  than the one already on screen, which is a risk with no upside once the prose
  is trusted, and the shorter prompt is also the faster retry — the one thing an
  Analyst failure has already cost the player once.

`ADAPT_DIALS`/`harnessHints` (the previous two sections) needed no change; this
is a parsing/retry fix with no effect on what the Coder is told.

### Verification

New tests, both retry modes, mock provider (`test/analyst.test.ts`): a reply with
a balanced-but-unparseable fenced block retries with the old no-echo, full-summary
behaviour; a reply with no JSON at all retries as a single-message extraction that
echoes the prose and omits `PLAYER POSITION HEAT MAP` (proof the summary was
skipped). Four direct `parseAnalysis` tests pin `kind` for each shape, including
the fact that a bare JSON *array* reply reads as `'no-json'` rather than
`'invalid'` — `extractJsonObject` only ever looks for `{`, so there is nothing to
call malformed. Three `analystPrompt` tests in `context.test.ts` check the two
message shapes directly and confirm the extraction retry is denied the engine
exactly like every other Analyst prompt.

`pnpm --filter @rematch/agents test` — 244 tests, green (up from 236: two
retry-mode tests replacing the old single one, four `kind` tests, three
`analystPrompt` retry-shape tests). `pnpm --filter @rematch/agents exec tsc -p
tsconfig.json --noEmit` — clean. `pnpm verify` — green, 83 s, 1175 tests across
all seven packages (contract 206, engine 91, sandbox 100, web 311, harness 143,
agents 244, server 80); lint clean.

## 2026-09-10 — calibrating the Mimic to the player it imitates

Analysis item 3 (`docs/ANALYSIS-learning-signal-2026-09-09.md`): `makeMimic` fixed
aim `accuracy` at 0.72 for every replay, regardless of how well that player
actually shot. That flatness is part of why delta 23's measurement reads the way
it does — the incumbent beating a Mimic of a *flawless, zero-damage* human run
0.710 of the time (`balanceConfig.ts`, `ADAPTED_MARGIN`) says more about a Mimic
that was too weak than about the incumbent being too strong. `packages/harness`
only; no contract, engine, sandbox, agents or web file touched, so nothing here
can move the replay hash.

### The mapping, and the one that didn't work

The summary carries what is needed: `boss.damageTaken` is hit count times the
fixed per-hit damage (`ENGINE_CONSTANTS.projectile.player.damage`, read rather
than assumed), and `player.shots` is every shot fired — so their ratio is the
player's real hit rate. `accuracyFromSummary` (`bots/mimic.ts`, new, exported)
turns that into the aimer's `accuracy` parameter, and `makeMimic` now defaults to
it (`opts.accuracy ?? accuracyFromSummary(summary)`) — an explicit `accuracy`
still overrides it, so Gate 3's `measureMimicWinRate` accuracy-sweep probe and
every existing caller keep working unchanged.

The first version inverted `makeAimer`'s own geometry literally: `accuracy`
degrades an aimed shot by a uniform angular error, a shot lands when that error
falls inside the boss's angular half-width at some reference range, so hit rate
is `min(1, halfAngle / spread)` — precisely what `types.ts`'s `BASE_AIM_ERROR`
comment already says in prose (0.85 → "effectively perfect", 0.7 → "roughly half
wide" at ~300 px). Inverting that for `accuracy` is analytically clean, and it
broke the harness: `camper-round1.json`'s real hit rate (0.355, genuine long-range
corner-camp data) inverts to an accuracy low enough that, replayed against
`idle.js` — a boss that never attacks — the Mimic **timed out 95% of the time**
(measured, `gate3Balance`, 40 matches). The inversion has a pole as hit rate → 0,
and a camper who loses to a target that does nothing is not a weaker player, it
is a bug wearing the shape of one — the same failure mode this file's own comment
already names for the dodge channel (below). The shipped version is a straight
line through the same two anchor points instead (`accuracy = 0.7 + 0.3 ×
(hitRate − 0.5)`, clamped to `[0.55, 0.85]` — the line's own range at hit rate 0
and 1, so the clamp restates the formula rather than rescuing it). Cruder far
from the anchors, but bounded: no pole, so no repeat of the timeout. `shots === 0`
falls back to the old fixed 0.72 (no evidence either way); a summary edited so
`damageTaken` implies more hits than `shots` (a real fixture in `bots.test.ts`,
built to isolate trigger discipline) clamps to a hit rate of 1 rather than
dividing into something above 1.

**Dodge quality — deliberately not a second channel.** The obvious companion
(`player.damageTaken` vs. how much the boss attacked) has no clean denominator:
`boss.primitives` counts primitive *uses*, not projectiles, and a `burst` can be a
3-shot cone or an 8-shot ring, a `slam` either lands or misses outright, and
minion contact damage folds into the same total. Two equally good dodgers would
score differently here purely because one fought a burst-heavy boss and the other
a slam-heavy one — the ratio measures the boss, not the player. Skipped, and
said so in `mimic.ts`'s own comment, per the brief's own rule: a wrong
calibration is worse than the fixed floor.

### Verification (§5 Q3, all free — no model call, no network)

**`scripts/mimic-calibration.ts`** (new): scans every committed `ReplaySummary`
under `packages/agents/canned`, `packages/web/public/recorded` and
`docs/evidence` (10 unique after de-duplication — the last has none embedded raw,
the recorded set repeats three of the canned files verbatim), prints each one's
measured hit rate and derived accuracy next to the old fixed 0.72, and re-measures
`round1.js` (the round 2 incumbent) against a Mimic of each — before (accuracy
pinned to 0.72) and after (derived) — via `measureMimicWinRate`'s own `accuracy`
override, at 100 matches each:

```
summary                                                   hitRate  accOld  accNew   before   after   Δ
camper-a.json                                               0.613    0.72   0.734    0.900   0.900   0.000
camper-b.json                                                0.541    0.72   0.712    0.880   0.880   0.000
dodger-a.json                                                0.870    0.72   0.811    0.720   0.740   0.020
dodger-b.json                                                0.800    0.72   0.790    0.720   0.660  -0.060
kiter-a.json                                                 0.758    0.72   0.777    0.580   0.540  -0.040
kiter-b.json                                                 0.565    0.72   0.719    0.580   0.580   0.000
mimic-camper.json ("Statue", 0 damage taken)                 0.685    0.72   0.755    0.980   1.000   0.020
mimic-rusher.json                                            1.000    0.72   0.850    0.960   0.900  -0.060
rusher-a.json                                                1.000    0.72   0.850    1.000   1.000   0.000
rusher-b.json                                                1.000    0.72   0.850    0.900   0.840  -0.060

mean: 0.822 -> 0.804
```

Honest reading of the headline number: no committed file is the exact 12-attempt
live run delta 23 measured (it was a browser session, never saved to disk) —
`mimic-camper.json` (rationale "I do nothing, so you can measure everything else
against me", `player.damageTaken: 0`) is the closest analogue in the repo, zero
damage taken like the run the comment describes. It did **not** drop
(0.980 → 1.000). Sweeping `accuracy` 0.3 → 0.85 against it directly holds the win
rate at 0.96–1.00 throughout: for this specific replay, aim was never the
bottleneck — its heat map is one static corner cell, so `round1.js` wins on
positioning regardless of how well the Mimic shoots. That is the honest answer to
analysis §5 Q3 ("which Mimic channel is the weak one") for *this* replay: not
aim. Across the wider corpus the mean did move in the predicted direction (0.822
→ 0.804), so the calibration is doing real, if modest, work on the population
that actually has variance in it — a fixed accuracy of 0.72 sat close to the
middle of this corpus's real skill range (0.54–1.00 hit rate) to begin with.
`balanceConfig.ts`'s `ADAPTED_MARGIN` comment now notes the 0.710 baseline
predates this change.

**`pnpm recheck:active`** — unaffected, exactly: the script never builds a Mimic.
Same numbers as `docs/evidence/recheck-active-2026-09-08.json` (span clause
rejects 0/58, 6 previously-approved candidates, 4 now fail an idle clause, 0 fail
the span clause).

**`pnpm recheck:adapted`** — one number moved, and it is legible. `graded 58`,
`passedAbsolute 42 → 41`, `adaptedOnly 7 → 8`, `regressions 0` (unchanged — this
is the metric the script itself defines as "passed absolute AND NOT relative",
and it stayed 0 both before and after). The one candidate that crossed a line:
`r2-a3-c0` ("Warden I", `kiter-a` replay) scored `mimic 0.72` before (passing
ADAPTED's absolute 0.70) and `mimic 0.60` after — `kiter-a`'s derived accuracy
(0.777) is *higher* than the old fixed 0.72, so its Mimic got harder to beat, not
easier. `panel` for that candidate is 0.40 (in the round 2 FAIR band), so its
Gate 3 verdict is unaffected either way: ADAPTED is advisory
(`gate3Balance.ts`'s `adapted.blocking: false`, since 2026-09-08), and this run
confirms nothing here flips a blocking verdict — it only changes what the
advisory reports.

**`pnpm --filter @rematch/harness test`** — 143 tests (up from 139): four new
cases in a `describe('accuracy calibration', …)` block in `bots.test.ts` —
derives a sharper accuracy from a higher measured hit rate, never returns a
blind-or-laser accuracy from two different degenerate summaries, falls back to
the old fixed 0.72 when a summary carries no shots, and confirms an explicit
`opts.accuracy` still overrides the derived value. No existing assertion needed
changing: nothing in the suite had hard-coded the specific value 0.72 (only its
own doc comment mentioned it), and the file's core claim — a camper summary and a
rusher summary must still produce visibly different play — was unaffected because
accuracy governs aim only, not the position/dash/trigger channels that test
measures.

**`pnpm --filter @rematch/harness typecheck`** — clean. **`pnpm verify`** —
green, 79 s, 1138 tests across all seven packages (contract 206, engine 91,
sandbox 100, web 283, harness 143, agents 235, server 80); lint clean.

## 2026-09-10 — sound, and the cheapest Product Quality points left on the table

`grep -riE "audio" packages/web/src` returned nothing until today. Spec §2.3's binding
constraint on it: *"Sound optional; if added, generated with Tone.js, never sampled
assets."* `packages/web` only — no engine, contract, harness, agents or server file
touched, so nothing here can move the replay hash or touch a gate. `tone@15.1.22` is
the one new dependency, `packages/web/package.json` and the lockfile only. Fourteen
cues, all synthesized: a shot tick, a boss-shot tick, a dash whoosh, a harsh player
hit, a soft boss hit, two distinct telegraph risers (charge sharp and quick, slam low
and slow — same distinction `renderer.ts` already draws visually), a slam impact
thud, minion spawn/down blips, a Judge verdict stamp (approved bright, rejected
heavier — "the demo's beat"), and round win/lose stingers. No generative ambient
drone: tried it mentally, decided it was the soundtrack the brief said not to build,
skipped.

**The reducer, not a new event source.** `render/effects.ts` already tails
`state.events` to turn engine events into transient visuals without the renderer
touching sim state; `audio/tracker.ts` is its sibling, tailing the same log the same
way to turn events into SFX triggers instead. `audio/sfx.ts` is the pure mapping
underneath both — `EventKind → SfxDescriptor | null` — and it is a `never`-exhaustive
switch, so a future engine event that nobody decided the sound of fails typecheck
rather than shipping silent by accident. Two kinds stay silent on purpose and say
why in the switch's own comment: `bossChargeHit`/`bossSlamMiss` because `playerHit`
already fires on the same tick for every source of player damage
(`step.ts`'s `damagePlayer`), and `violation`/`outcome` because they carry no stake
for the player watching.

**The chain.** One `Tone.Volume` (the master fader, and where mute lives) into one
`Tone.Limiter` into the destination — every voice connects there, so overlapping
cues (a slam hit fires `playerHit` and `bossSlamHit` on the same tick, deliberately)
cannot clip. Per-cue loudness is a `Decibels` offset applied at trigger time, not a
second gain stage. Shots are the loudest single fact about the mix by how quiet they
are: they fire up to ~5/s, so `GAIN.shot` sits under every once-per-round stinger by
more than 4×, asserted in `test/audio-sfx.test.ts` rather than only tuned by ear.

**The autoplay policy, and a fight the frame budget nearly lost.** Tone/`AudioContext`
cannot start before a real user gesture, so `audio/engine.ts` never imports `tone`
until `init()` runs. The first version armed `init()` off one global
`pointerdown`/`keydown` listener — "first interaction," literally — and it passed
every test once, then failed `e2e/controls.spec.ts`'s frame-budget assertion on a
rerun: `droppedTicks` 1–2 instead of 0. Bisected by disabling the listener alone
(everything else unchanged): dropped ticks went to 0 every time it was off, and back
to 1–2 every time it was on. The WASD test drives `?autostart=1`, which skips every
screen, so its *first* gesture is the first movement key — the same keydown that
arms `init()` was landing on the one moment `game/loop.ts`'s fixed-step accumulator
has a real, small catch-up budget (`MAX_CATCHUP_STEPS`) to spend, and fetching +
parsing the `tone` chunk plus building fourteen instrument graphs competed with it
for exactly the frame or two the test has zero tolerance for. A `requestIdleCallback`
deferral did not fix it — Chromium still ran the build well inside the test's ~2 s
window. The fix was narrower than "first interaction": `init()` is now called from a
handful of deliberate, discrete gestures instead of a global listener — a screen's
primary button (`ui/screens.ts`), the interlude's FIGHT button (`interlude/ui.ts`),
and the mute toggle (`ui/audioToggle.ts`) — none of which a fight in progress ever
triggers, so the collision cannot happen structurally rather than by timing luck. The
one flow that gets no sound at all as a result: a returning player with "skip intro"
remembered who never touches a screen before Round 1 begins — audio stays off for
them until their first menu interaction (round-won, the interlude, or the toggle
itself), which is judged the right trade against a flaky frame-budget test over
initializing audio one keystroke sooner. `e2e/determinism.spec.ts` and
`gen-inputlog.ts` never dispatch a real gesture at all (the former drives the sandbox
through `page.evaluate()`, the latter never opens a browser), so `tone` is never
fetched in either — verified by running both, not inferred.

**Mute, and the one thing visible headless.** One `localStorage` key
(`rematch.audio.muted`), same `try`/`catch`-both-sides discipline `ui/intro.ts`
established for "skip intro" — a tab with site data blocked must still boot. The
toggle (`ui/audioToggle.ts`) is inline SVG, mounted once into `document.body`
independent of `#hud`/`#screen` so it survives every round teardown, `z-index: 50`
above the interlude overlay. `e2e/audio.spec.ts` asserts what a headless browser can
actually prove: the toggle is visible before and after the start screen and through
a live round, clicking it flips `aria-pressed`/`data-muted` and the storage key, and
the preference survives a reload. It does not and cannot assert that a sound played —
there is no way to observe `AudioContext` output from outside the page — so the test
file's own comment says so rather than pretending otherwise.

**Structural test, same shape as `fighters.test.ts`.** `test/audio-costume.test.ts`
reads the source of `game/round.ts`, `game/strategy.ts`, `game/loop.ts` and
`game/seeds.ts` and asserts none of them import anything under `audio/` — the sim
side of the boundary a fighter skin already had to respect, and a harder one to
violate silently: `AudioContext` does not exist in Node at all, so a stray import
would not desync a replay quietly, it would throw the moment the harness or
`gen-inputlog.ts` tried to load that module. `audio/sfx.ts` and `audio/tracker.ts`
*do* import `@rematch/engine`'s types (`EventKind`, `GameState`) — same as
`render/effects.ts`, which this folder is modelled on — so the test also pins the
inverse for the one module that actually touches Tone: `audio/engine.ts` imports
none of `@rematch/engine`, `@rematch/contract` or `@rematch/sandbox`.

**Kept out, deliberately.** No sampled or recorded audio of any kind — every cue is
an oscillator, a noise source, or an envelope, per spec §2.3. No user-facing volume
slider — one master fader exists internally (where mute lives), but the only control
surface is on/off; a mixing panel is not what "polish, not a soundtrack" asked for.
~~No sound during the interlude's streaming text.~~ **Reversed same day, on
playtest — see the addendum below.** No ambient drone *during the fight* — considered,
decided it was the soundtrack the brief said not to build, skipped; the intro's own
music (also below) is a different thing in a different place and does not reopen
that call.

### Same day, addendum — Matt's playtest: music and a typing sound

Two more additions, same session, after a playtest. Still `packages/web` only, still
Tone-only, still no `init()` off raw gameplay input — both new pieces are held to
the same three constraints as everything above.

**Music, on the intro only.** A short loop over `Tone.Transport`/`Tone.Sequence` —
two bars of eighth-note arpeggio (A minor into G major, square-wave, chiptune-ish)
over a two-bar bass ostinato (triangle, one note per bar) — starts on the first
menu-level gesture *while the start screen is showing* and stops unconditionally the
moment a round begins. "Generative" is read as *composed in code*, not randomized:
the loop is a fixed pattern, deliberately, because the interesting property here is
that it sounds the same every session rather than different — the pure decision of
*when* it should be on lives in `audio/musicState.ts` (`reduceMusicState`, gated on
`ui/screens.ts`'s own screen name, `'start'`), and `audio/engine.ts`'s
`noteMenuGesture`/`stopIntroMusic` are its thin, untestable-without-Tone other half.
Both new voices connect to the same master `Volume`→`Limiter` chain every SFX cue
does, at roughly `-27`/`-28` dB (`MUSIC_ARP_GAIN` 0.045, `MUSIC_BASS_GAIN` 0.04) —
quieter than the quietest SFX cue (`shot`, `GAIN` 0.05, `-26` dB) on purpose, so it
reads as room tone under the attract sequence rather than as a second thing
competing with it. `app.ts`'s `startRound` is the one call site for "the fight
begins," reached by every path into it (ENTER THE ARENA, SKIP INTRO, a retry,
`?autostart=1`), so the loop cannot bleed into gameplay regardless of which door was
used to get there.

**Typing, and the reversal.** Matt: *"barulho de typing no momento em que os robôs
estão trabalhando, só no momento em que o typing tá acontecendo na tela."* This
morning's own "kept out" list said the opposite — no sound during streaming text,
reasoning from spec §2.2's "nothing during streaming text" read as a blanket rule
about the *whole* interlude. Matt's ask is narrower and is the actual product
instinct that line was reaching for: the streaming *characters* are exactly the
moment three agents are visibly doing something, and a silent typewriter under
visible typing reads as broken, not restrained. Overridden, on the record, here.

The tick is driven from the same two places `interlude/ui.ts` already appends
streamed text — `analysis.delta` and `rewrite.delta`, immediately after
`stream.append`/`view.code +=` — never from `trial.progress` or a `verdict`, so it
is structurally incapable of sounding over the Gate 3 meter or the Judge's stamp;
nothing routes those events anywhere near it. `audio/typing.ts`'s `reduceTyping` is
the pure throttle: a stream arrives in bursts of a few dozen characters, not one at
a time, so it rate-limits to at most one tick per 55 ms of the interlude's own clock
(`options.now`) rather than firing once per character. One gate, shared by the
Analyst's prose and the Coder's code (including all K candidates streaming at once)
— sharing it was the deliberate call: three candidates each keeping their own
throttle would still be a burst, just a three-times-denser one, and the brief asked
for restraint. "Silent the instant the stream pauses" needed no code of its own: a
tick only exists as the direct result of a delta that already arrived, so a gap
between deltas is a gap with nothing scheduled in it, not a sound being explicitly
stopped. The voice itself (`typingTick`, `engine.ts`) is the one place in this
feature that uses `Math.random()` on purpose — a note picked from four options a
fourth apart, and ±6 ms of schedule jitter — because Matt asked for it explicitly
("slightly randomized in pitch/timing so it reads as typing, not a metronome"),
which is a different ask from the music loop's deliberately *fixed* pattern above.

**Verification.** `test/audio-sfx.test.ts` (the reducer, including the
"shots quieter than every stinger" balance rule and, now, `sfxForTyping` and the
typewriter cue's own gain), `test/audio-tracker.test.ts` (the event-tailing,
including a round boundary replaying from tick 0 the same way `effects.ts` detects
one), `test/audio-mute.test.ts` (the storage round-trip, and degrading to unmuted
when storage throws or is absent), `test/audio-typing.test.ts` (the throttle: first
delta always ticks, a burst of twenty same-instant deltas costs exactly one, a
steady stream one interval apart ticks every time, a custom interval is respected),
`test/audio-music.test.ts` (`reduceMusicState`: a gesture on `'start'` turns music
on, a gesture anywhere else is a no-op, `fightStarted` always turns it off and is
idempotent), `test/audio-costume.test.ts` (the structural boundary, unchanged in
shape — its regex already covered the two new files without naming them) — 38 new
tests total for the day (262 → 300 in `packages/web`; 21 from the morning's session,
17 from this addendum), all DOM-free and Tone-free. `pnpm --filter @rematch/web
test` — 24 files, 300 tests, green. `pnpm --filter @rematch/web typecheck` — clean.
`pnpm --filter @rematch/web run test:e2e` — all 30 specs green, chromium, including
`e2e/determinism.spec.ts` (both cases, untouched by any of this — neither the music
gesture hooks nor the typing hooks live anywhere near it) and the frame-budget
assertion in `e2e/controls.spec.ts` (`droppedTicks: 0`, confirmed stable over
several reruns both before and after this addendum's changes — the music loop
building two extra voices and a `Transport`/`Sequence` pair on the same gesture
path as the morning's fix was the specific risk, and it did not reopen the
collision because `noteMenuGesture` never runs off gameplay input either). `pnpm
verify` — green, 75 s, 1155 tests across all seven packages (contract 206, engine
91, sandbox 100, web 300, harness 143, agents 235, server 80); lint clean.

### Same day, second addendum — Matt's playtest: music must start on intro mount, not just on START

Feedback on the addendum above, same day: the loop must start *when the intro
screen appears*, not only after clicking START. The autoplay policy makes literal
on-load playback conditional rather than guaranteed — Chrome's media-engagement
heuristics let a returning visitor's page start audio with zero gesture; a
first-time one still needs one — so the brief this time was explicit about the
honest shape: attempt it on mount, fail silently, fall back to a broader gesture.
`packages/web` only, still. `init()` still never runs off raw gameplay input — that
distinction gets sharper this round, not weaker (below).

**The reducer grew a second bit.** `musicState.ts`'s `MusicState` gained
`introOver: boolean`, latched permanently by `fightStarted` and checked by both
`gesture` and the new `autoplaySucceeded`. The reason is a real race, not
defensiveness for its own sake: `attemptAutoStart()`'s promise (dynamic `import`,
then up to `AUTOPLAY_TIMEOUT_MS` waiting on the context) can resolve *after* the
player has already SKIP INTRO'd into the fight — a slow `tone` chunk fetch racing a
fast click. Without the latch, that late resolution would read the stale
"not playing" state, see `autoplaySucceeded`, and reopen the loop mid-fight. With
it, "never during the fight" is an invariant the state machine enforces, not a
timing hope — and it is exactly the scenario `test/audio-music.test.ts`'s "never
during the fight" block exists to pin down, alongside the two new event branches
themselves (`autoplaySucceeded` turns music on from a stopped, not-yet-over state;
`autoplayFailed` changes nothing, on purpose, as its own named branch rather than a
silent absence).

**The attempt, and why `build()` cannot wait on it.** `Tone.start()`/context
`.resume()` does not reliably *reject* when the browser blocks it — some engines
just leave the promise pending forever — so `attemptResume` races it against a
500 ms timeout (`AUTOPLAY_TIMEOUT_MS`) and proceeds regardless. That bound applies
to every call into `init()`, not only the mount-time one, which is a free
robustness fix for a theoretical hang the gesture-triggered path could have had all
along. The chain itself — all fifteen SFX voices, the music loop's `Sequence`s —
is built either way, whether or not the context actually resumed: none of that
construction needs an audible, running context, only *sound* does, and
`contextRunning()` (reading `Tone.getContext().state` after the attempt settles)
is what tells `attemptAutoStart()` whether to actually start the loop or report
`autoplayFailed` and leave it silent.

**The fallback, widened.** "First user gesture ANYWHERE while an intro screen is
visible" is broader than the existing menu-button/Enter/Space handlers already
covered — a stray click on the fighter grid, an arbitrary keypress `introKeyAction`
doesn't recognise, none of which previously called `noteMenuGesture` at all. New in
`ui/screens.ts`: `armIntroFallback()` attaches a `document`-level
`pointerdown`/`keydown` listener the instant `start()` mounts the intro, calling
`initAudio()` + `noteMenuGesture('start')` once and then removing itself.

This is precisely the shape the frame-budget lesson two addenda ago warned
against — a listener on `document` that could also catch live gameplay's own
`pointerdown`/`keydown` — and it is safe here for a reason specific to *when* it
exists: it is armed only while an intro screen is showing, and no simulation is
running yet at that point, so there is no frame budget for it to compete with. It
still has to be torn down before the fight begins, and torn down *early*: `app.ts`'s
`startRound` calls `screens.loading()` (a genuine screen transition, but not
`screens.hide()`) well before the sandbox finishes loading and `screens.hide()`
finally runs, and a stray click during that loading spinner would otherwise still
be live. So disarming happens in a new `leaveIntro()` wrapper — called by both
`skip()` and `advance()`'s `to === 'fight'` branch, *before* `onFight()` runs at
all — with `hide()`'s own `disarmIntroFallback()` call kept as a second, cheap,
idempotent safety net for any path that reaches it a different way. The existing
button/Enter/Space handlers keep their own `noteMenuGesture` calls too (unchanged)
— they still matter for every *other* screen's general SFX `initAudio()`, which the
intro-only fallback does not cover.

**Verification.** `test/audio-music.test.ts` — the two-bit reducer, extended:
`autoplaySucceeded`/`autoplayFailed` each get their own describe block (success
turns music on from idle and is a same-reference no-op once already playing;
failure is a same-reference no-op, full stop), and a new "never during the fight —
introOver latches permanently" block pins the exact race above: a `gesture` after
`fightStarted` is a no-op, a late `autoplaySucceeded` after `fightStarted` is a
no-op, `autoplayFailed` after `fightStarted` is (still, trivially) a no-op — plus
two whole-session walks, one where autoplay is blocked and a gesture is what
starts it, one where autoplay succeeds outright and no gesture is ever needed.
16 cases now (was 8) — +8 for the day's running total. `e2e/audio.spec.ts` gained
three cases: the mount-time attempt produces zero console errors with **no gesture
dispatched at all** (waits past `AUTOPLAY_TIMEOUT_MS` to prove the failure path
resolves cleanly rather than hanging); a keypress the intro does not recognise
(`KeyQ`) neither navigates nor errors, and a second one after the fallback has
already disarmed itself is still harmless; and a full session — a non-navigating
keypress, then SKIP INTRO, then real gameplay input (`KeyD`, a mouse click) —
produces zero console errors, which is the closest headless proxy for "the
fallback truly stopped existing before gameplay could reach it." None of these can
observe whether a sound actually played (no reliable way to from outside the page,
and Playwright's default launch has no media-engagement history for this origin,
so the mount-time attempt is expected to fail every run in this suite) — each
test's own comment says so.

`pnpm --filter @rematch/web test` — 25 files, 319 tests, green (the file/test count
also reflects an unrelated, concurrent stream's work landing in `packages/web` in
the same window — `render/habitCells.ts`, `test/habit-cells.test.ts`,
`test/interlude-fallback.test.ts` — none of which this entry touched or is
reporting on; noting it for the same reason delta 21's neighbour-stream note in
this log exists). `pnpm --filter @rematch/web typecheck` — clean. `pnpm --filter
@rematch/web run test:e2e` — all 33 specs green, chromium (30 + this addendum's 3
new cases in `e2e/audio.spec.ts`), including the frame-budget assertion in
`e2e/controls.spec.ts` (`droppedTicks: 0`,
reconfirmed stable over several reruns after this round's changes — the specific
risk being that a `document`-level listener, however scoped, is exactly the shape
that bit once already) and `e2e/determinism.spec.ts` (both cases — `?autostart=1`
skips the intro screen outright, so `screens.start()`, `attemptAutoStart()` and
`armIntroFallback()` never run in that path at all). `pnpm verify` — green, 77 s,
1183 tests across all seven packages (contract 206, engine 91, sandbox 100, web
319, harness 143, agents 244, server 80 — agents' count moved too, also not this
entry's work); lint clean.

## 2026-09-10 (evening) — the '90s pass: a restyle, not a rebuild

Four days to the 2026-09-14 submission is not runway enough to redraw a game, so
`docs/HANDOFF-REDESIGN.md` scoped this as a restyle: change how the surfaces look,
change nothing about what they are. `packages/web` only — no engine, contract,
harness, agents or server file opened — and the check that this held is the replay
hash, still `74cd659935e33202` on the `replay-fixture` test and `e2e/determinism`.

### Stream A — the CSS

The display font is bundled, not fetched: `@fontsource/press-start-2p` (OFL) through
Vite, so the page still boots offline and the only face that loads is the 12.5 kB latin
woff2. The monospace fallback behind it is load-bearing rather than defensive — the
latin subset has no `→`, `✓` or `✗`, so those fall back per glyph. It is applied to
display text only: intro headings, the primary button, the HUD round and timer, the
banner name and kicker, the interlude title and chips, the Judge stamp's mark. Body,
code, diff and rationale text keep the old face — a pixel font at paragraph length is
the legibility failure §2.2 warns about. Restyled text also shrank to roughly 60% of
its old size (hook title `clamp(30px,4.6vw,52px)` → `clamp(18px,2.8vw,31px)`, stamp
21 → 13 px), letter-spacing 0, which the face bakes in already.

The CRT layer is CSS only — `body::before`/`::after`, 1px/3px black scanlines at 12%
and a 35% corner vignette — gated on `html[data-crt='on']`, with `?crt=0` turning it
off through the new `src/ui/crt.ts`. No flicker keyframe at all: an animated overlay
over a 60 Hz canvas is a frame-budget risk for nothing a screenshot can show.
`test/crt-costume.test.ts` mirrors `test/audio-costume.test.ts` — the sim modules must
not import it. Chunky elsewhere: 2px edges, hard `4px 4px 0 #000` offsets, radius 0,
phosphor `text-shadow` on display accents only, the acting interlude panel casting its
shadow in its own accent. The Judge's surfaces stay hard-cornered and its DETERMINISTIC
chip stays monospace — the one label whose job is to read as a machine's, not an
arcade's.

Three details that were care, not taste. The INSERT-COIN blink is a `steps(1)`
box-shadow halo on the intro primary button and never on its text — e2e reads that
button by name, and pseudo-element `content` enters the accessible name. The trial
meter grew 9 → 11 px with twenty notches drawn on the track so the inline-width fill
reads as blocks, and the HP pips got a 1px inset bevel for the same reason. The Judge
stamp's `-3deg` rotation is on `.il-stamp-mark` alone: rotating the wrapper would tilt
the contractual plain-language sentence with it.

One specificity fight, and it is 09-09's `.card h1` lesson again — `.card.start .btn`
already owned the button's size, so the display rules are keyed on
`[data-testid='primary']` and placed after it, and the `≤520px` media query needed a
matching twin, because an override only wins where it exists.

### Stream B — the canvas

The constraint that shaped every effect in `render/effects.ts` and `render/renderer.ts`
is that they stay a pure function of the event log: `Effect` gained a `seed` set from
the event index, and the structural test asserts no `Math.random`, `Date.now` or
`performance.now` appears in the render modules at all.

`sparks(seed)` draws 5–8 radial 2px lines, 6–14 px, white alternating with slam-yellow
for hits taken and player-teal for hits landed, on `bossHit`, `playerHit`, `chargeHit`
and `minionDown`. `flashAlpha` ramps 0.85 → 0 over four ticks as a near-white fill
clipped to the collision circle — §13 delta 22 is explicit that nothing leaves the
hitbox, and telegraph geometry is untouched. The dash trail is now ≤3 ghost circles at
full player radius with stepped alpha (.35/.2/.1) instead of a taper, and the
full-canvas red hit flash turned from a 14-tick ramp into a two-frame hard step,
0.16 → 0.22 to keep its weight in half the time. `palette.ts` did not change.

### Process, and verification

Two Opus implementers ran the briefs in parallel on disjoint files; e2e ran once
afterwards in the main session, because two Playwright servers on one port is a failure
mode with nothing to teach. Screenshots were reviewed at 1280x800, 1440x900 and phone
width, and the only correction made was scanline opacity, trimmed after the first
screenshots — over the intro hero art the first value read as damage, not as a CRT.

`pnpm --filter @rematch/web test` — 319 → 346, green (22 new in `test/effects.test.ts`,
5 in `test/crt-costume.test.ts`). `pnpm --filter @rematch/web run test:e2e` — 33/33,
chromium. `pnpm verify` — green, 74 s, 1210 tests across all seven packages (contract 206, engine 91, sandbox 100, web 346, harness 143, agents 244, server 80); typecheck and lint clean.

Three things this does not prove. No screenshot catches a live hit frame, so the sparks
and the flash are unit-tested and eyeballed in dev and nothing more — no artifact in
`artifacts/web` shows the loudest part of the change. The scanlines are visible on the
hero PNG, which is a taste call, reversible in one line. And the intro sub-headings
deliberately stayed monospace: 09-09's wall-of-text call, applied to a font.

### Later the same evening — the minions are the boss's litter

Matheus's note after playing: the violet thing that follows you should be a small clone
of the boss, and it should change with the boss you picked. It does now. `drawMinions`
draws `fighters.boss`'s face through the same `drawFace` the boss uses, clipped to the
minion's 10 px collision circle, over the violet disc and under a violet ring — pick
Earth for the boss and the litter is Earths. The first cut also laid a violet wash over
the face; at that radius it turned Jupiter's stripes to mud, so the wash went and the
ring got heavier (0.9 alpha, 2.5 px) as the one "not the boss" tell. Arming minions stay
ghosted at 0.35 as before. A fourth screenshot spec steps the round-1 replay until a
minion is armed and writes `fight-minions.png`; the 4× crop is what settled the wash
question. Web unit 346 green, typecheck and lint clean; `pnpm verify` not re-run for this
six-line renderer change — the pre-commit hook will.

### Later still — the rulebook arrives, and the docs get audited against it

Human — pasted the full competition rules and asked whether the project complies.
Orchestrator — sent one Explore subagent to audit README, SPEC, SYSTEM and this log
against the required artifacts and return conclusions with anchors. Verdict: SPEC, the
human-decision trail, the deterministic controls and secrets hygiene were covered; three
gaps were not. SYSTEM.md §8 named the parallel lanes but never said what context and
tools each role had; every build-side autonomous loop was narrated, none shown with an
artifact; and the README described the hooks as guards without saying how they fed the
agents. All three closed the same evening: §8.3 in SYSTEM.md (role table, the worked
parallel day with timings, the minion loop with its screenshot), and a "Show your work"
table plus a feedback-loop paragraph in the README. Human decision the audit surfaced: the
repo carried no `CLAUDE.md` or `.claude/` — the delegation policy and memory that steer
the orchestrator lived in the engineer's home directory, outside the submission. Matheus
said copy them in, keeping only what this project needs. So `CLAUDE.md` is fifty lines —
who decides what, the sealed simulation, spend, what done means — and nothing about the
dbt repos the global policy also serves. `.claude/settings.json` turns the rules that should never
depend on memory into harness refusals: a prefix deny for `pnpm eval:agents`, and — because
permission rules cannot see a flag mid-command, which a docs subagent checked against the
official reference before we wrote it — a PreToolUse hook for `--no-verify`, force-push
and `REMATCH_ALLOW_SPEND=` (the credits burned on 09-03). The hook was exercised with
twelve fake tool calls, six blocked and six allowed, before it went in.

### Later still — the deploy starts, and the spend rule gets its second half

Human — "let's start the deploy; what is the first step?" then, on being told the
rulebook needs a live product: "we have to spend here, otherwise it isn't an AI", and
"switch to OpenAI, I'll add credits". Three decisions in three sentences: the product
spends, the provider is OpenAI, the money is his.
Orchestrator — the local `.env` moved from `claude-cli` to `openai` and the server pair
was restarted; `/api/health` answered `provider: openai, hasApiKey: true, dailyCap: 40`.
`CLAUDE.md`'s spend section gained the sentence it was missing: the rule is about agents
spending during development, not about the product working — the deployed server spends,
bounded by `REMATCH_MAX_REWRITES_PER_DAY` and the per-IP limiter, both of which already
existed in `packages/server`.
Then the split deployment the log has recommended since 09-03, prepared without a login
to anything: one Explore subagent mapped what the server needs at runtime (Node ≥ 22.9
for `--env-file-if-exists`, `HOST=0.0.0.0`, the fallback pool and the contract README
read from disk, `worker.ts` spawned by relative URL, CORS via `REMATCH_ORIGIN`,
`VITE_API_BASE` baked at web build time). From that: a `Dockerfile` that ships the source
tree of the six server-side packages under Node 24 — there is no build step to ship — a
`fly.toml` on `performance-2x` in `gru` that never scales to zero (a cold start inside a
45 s interlude budget is a bug, and a 1-vCPU box makes the verifier the bottleneck), and a
`vercel.json` for the static web. Verified locally with no spend: image built, container
booted fallback-only, `/api/health` and `/api/fallback/2` answered, sandbox and harness
imported inside the image, web build with `VITE_API_BASE` set had the URL in its bundle.
What is left needs Matheus's hands, and is listed under README "Deploy": Fly and Vercel
logins, the OpenAI secret, the two-step CORS origin.

### Later still — it is live

Human — did the three logins, then set a rule that outranks every other one in this
entry: Fly and Vercel run on his personal account, never the employer's account and never
inside an employer project. Recorded as standing memory before the first `fly` command;
`fly auth whoami` and the org list were checked against it (one org, `personal`), and the
only Vercel scope on the account is his own team. Then the loop the rulebook likes, three
times over: `fly deploy` → refused, *performance machines not allowed without a payment
method* → `shared-cpu-4x` → refused, *2 cores per machine* → `shared-cpu-2x`, and
`--ha=false` added on the way because the deploy wanted two machines and the daily spend
cap is per process — two machines would be two caps. Web deployed from the working tree
with `VITE_API_BASE` as a build env; the Vercel CLI vanished from `PATH` mid-session (it
was reinstalling itself under the human's still-open `vercel login`) and came back a
version newer. Verified from outside: health answers, the preflight from the Vercel origin
gets `access-control-allow-origin`, the served bundle contains the Fly hostname.
`hasApiKey: false` until Matheus sets the secret himself — the key does not pass through
an agent. Screenshot of the live start screen in `artifacts/web/deployed-start.png`.

### Later still — the first real run in production, and what cut it

Human — set the secret himself; health went `hasApiKey: true`. Then: "yes, run it".
Orchestrator — one Playwright spec outside the repo, pointed at the Vercel URL with no
`?agent=` override, replaying the recorded Round 1 so the interlude opens against the Fly
server for real. What happened, from the client's own event log
([`evidence/prod-run-2026-09-10-trial-cut.json`](evidence/prod-run-2026-09-10-trial-cut.json)):
`LIVE`; Analyst done at 9.0 s, 629 tokens, archetype *mixed*; Coder streamed three
candidates, 9.9 kB, "Ballista I · conservative"; Gate 1 in 6 ms, Gate 2 in 309 ms; Gate 3
at 35 of 200 matches at 23.1 s — and then `ERR_HTTP2_PROTOCOL_ERROR`, and the screen said
*✗ the rewrite failed — using a pre-approved strategy — the rewrite stream broke*. Round 2
started anyway, on the fallback pool. Every word of that was true, which is the part that
was designed.
The cause is one line in `fly logs`: *Trial machine stopping. To run for longer than
5m0s, add a credit card.* An org without a card gets five minutes of uptime per start;
the machine had been up since 20:46:43 and was SIGINTed at 20:51:43, mid-simulation. The
proxy lost the body, the browser saw a broken h2 stream, the interlude did what AC 5 says.
Not a bug in anything we wrote; not something we can fix from here. The machine now sits
`stopped` and will start on the next request — and stop again five minutes later.
Human decision, open: add a card at fly.io/trial, which also lifts the 2-core and
no-performance-machine limits hit earlier. Then the same spec runs again.
Screenshots: `artifacts/web/prod-interlude-start.png`, `prod-interlude-done.png`.

## 2026-09-11 — zero spend: the live URL plays a recording, the loop stays local

Human — asked the question that should have come first: *does the rulebook require this
whole structure?* It does not; it requires a live, accessible URL. Then three decisions
in a row: no money on hosting; the published site plays the recorded run; locally the
loop keeps running for real on `claude-cli`, which is how the recordings and the demo get
made. The serverless-on-Vercel alternative was laid out (Gate 3 at ~60 matches, a spend
cap that lives and dies with each function, 3–6 h of work three days out) and declined.
Orchestrator — Fly scaled to zero machines and left in place; `VITE_API_BASE` removed from
Vercel. One Opus subagent added the build-time default: `VITE_DEFAULT_AGENT=recorded`
makes the "deployed host, no `?agent=`" row resolve to the recorded source, the URL always
wins, `localDefaultApplies` and `resolveSource` still agree (11 new tests, web 346 → 357).
Redeployed with the env set; a Playwright spec against the published URL won Round 1 and
found the interlude on `RECORDED RUN · gpt-5.4-mini · 2026-09-03`, approved, with zero
requests to any `/api/` or external host. `pnpm verify` green — 1221 tests.
Found along the way, and worth its own line: the local server had been running on OpenAI
all evening while `.env` said `claude-cli`, because this Claude Code session's shell
snapshot exports `REMATCH_PROVIDER=openai` and Node's `--env-file` never overrides a
variable already in the environment. A clean login shell has no such export, so the
human's own terminal was never affected — but every `pnpm dev` the orchestrator launched
was. Fixed by passing the provider explicitly; recorded in memory so the next session does
not rediscover it. README "Deploy" rewritten around the decision; `Dockerfile`, `fly.toml`
and SYSTEM.md §9 say plainly that the paid path exists, works, and is not the one live.
One small thing the production screenshot caught that the mock never had room to show:
the header badge — `MOCK` is short, `RECORDED RUN · gpt-5.4-mini · 2026-09-03` is not —
sat under the fixed mute toggle. `.il-head` now pads 44 px on the right, the interlude
screenshots were regenerated, and the site redeployed with it.

### Same day — harder rounds, but only the kind of hard that comes from learning

Human — "can the boss get much harder as the rounds go up, using only what we built?"
Then, before anything moved: "not the boss spamming everything with no chance for the
player — it has to actually learn from how the player moves." Then: "round 5 can be
unfair, as long as the unfairness is the robot's learning."
Orchestrator — that constraint picks the lever. Raising FAIR alone would reward exactly
the spammer: the boss that fires on every cooldown scores highest against the scripted
panel. What measures *learned from you* is ADAPTED — the boss's win rate against the
Mimic built from the player's own replay — which delta 23 had demoted to advisory on
2026-09-08 because the Mimic was then a much weaker player than the human. The Mimic was
calibrated on 09-10; nobody had re-measured it blocking. So the rule, decided here and
handed to one Opus implementer: round 2 untouched (the published recording and SYSTEM.md
§6 quote its numbers); FAIR moves to 0.50–0.65 / 0.60–0.75 / 0.65–0.95 for rounds 3–5,
the ceiling still there so "a different approach beats it" stays true below round 5; and
ADAPTED blocks from round 3 at 0.75 / 0.85 / 0.95, the relative route (+0.10 over the
incumbent) kept as the alternative. Round 5 at 0.95 vs your own Mimic is the sanctioned
unfairness.
The implementer stalled once with the work on disk (the 09-03 lesson, applied: check the
tree before relaunching) and was resumed with a list of what remained. What shipped:
`balanceConfig.ts` gained `ADAPTED_MIN` and `ADAPTED_BLOCKS`, `gate3Balance.ts` rejects
with a reason as concrete as FAIR's — *0.62 vs Mimic — didn't adapt (need >= 0.85 for
round 4, or >= 0.81 = incumbent 0.71 + 0.10)* — because the Coder gets that sentence
verbatim on retry. The six pooled fallbacks for rounds 3–5 were re-tuned to the new bands
by positioning and prediction, not cadence: no cooldown roll was raised anywhere. Nettle
now walks to where the player is going instead of chasing a faster target it could never
catch; Crossfire leads its cone by the player's velocity; Curfew's contact radius became
the slam's own radius, which is why a Rusher at 95 px finally gets hit. Panel rates moved
r3 0.53→0.57 / 0.50→0.60, r4 0.58→0.70 / 0.60→0.70, r5 0.63→0.75 / 0.65→0.73, all inside
band with ≥ 0.03 margin at both 120 and 200 matches. The Coder briefing is round-aware
now; the web already rendered "didn't adapt" as *it didn't counter you*.
Proof that round 2 did not move: `regrade:live` on the 09-08 twelve-attempt run approves
the same 8 of 23, first on `a1c1`, every rate and reason identical; `recheck:adapted`
reports 0 regressions and 0 newly approved. The honest gap, stated in delta 24 and in the
config's own comment: there is no recorded eval for rounds 3–5 — every committed run is a
round 2 — so 0.75 / 0.85 / 0.95 are argued from the round-2 corpus (incumbent vs Mimic
0.54–1.00, mean 0.804), not calibrated. The first real round-5 run will be the measurement.
`pnpm verify` — green, 80 s, 1226 tests (harness 143 → 147, agents 244 → 245); a loop
test that read 715 s mid-afternoon was CPU contention with the implementer's own runs,
not a regression — it is 80 s for the whole repo now.

### Same day — "three rounds, three rejections, what is this for?"

Human — played three rounds on the local stack, saw REJECTED three times, fought three
fallback bosses, and said so: *what is the point then, this is horrible.* The right
reaction; the verifier that never lets anything through is indistinguishable from a
product that does not work.
Orchestrator — read the three server logs before touching anything
(`artifacts/server/rewrite-2026-09-11T16-18-39…`, `…16-20-25…`, `…16-21-33…`). Same shape
each time: Analyst ≈ 14 s, **one** of three candidates judged, that one self-described
"conservative" and measuring 0.26 / 0.20 / 0.00 against the panel — a boss that never
wins a match — then `fallback: deadline` at ≈ 43 s of a 45 000 ms budget. Two problems,
two subagents on disjoint packages.
The web one was what it looked like: the client's fixed 45 s (AC 5) is what the server
clamps to, so a server configured for 90 s never got them. The interlude now adopts the
deadline `/api/health` advertises when the local probe ran — explicit `?deadline=` wins,
advertised must exceed the default, capped at 180 s — and sends that as `budgetMs`. The
recorded and `VITE_API_BASE` paths never see a probe, so the deployed site is unchanged
(SPEC §13 delta 25; web 357 → 370).
The agents one was not what it looked like. The claude-cli provider *was* concurrent —
three child processes, deltas interleaving from the first second. What killed candidates
1 and 2 was `STRAGGLER_GRACE_MS = 6000`: every attempt ended 6 000 ms after the first
reply landed, to within 3 ms across all three logs, with ~17 s of budget unspent — a
grace sized for an 8 s API call, applied to a 20 s CLI call. Grace is now
`max(6 s, 0.6 × first call)`; gates run in completion order instead of index order; the
dial order became balanced → aggressive → conservative because every failure on this
provider is an undershoot; the `conservative` instruction was rewritten (four stacked
subtractions ending in "120 quiet ticks" is how a boss measures 0.00); and the first
attempt now gets the incumbent's measured panel and Mimic rates as an anchor, computed
behind the Analyst so it costs no wall clock. Agents 245 → 256, both regression tests
shown failing on the old code first.
Then the measurement, same stack, same scripted Round 1, one Playwright spec
([`evidence/local-live-2026-09-11.json`](evidence/local-live-2026-09-11.json)):
budget sent 90 000; two attempts; **five** candidates reached Gate 3 (0.00 too easy,
0.78 too hard, 0.56, 0.54 too hard) and the fifth — "Cistern I", balanced — **approved
at 0.45 vs panel, 0.78 vs the Mimic**, 80.5 s wall clock, no fallback. The boss's own
line on the way out: *"You have not left that wall in three rounds, so sometimes I make
you regret staying."* That is the product; three hours earlier it was unreachable from
this provider.
Honest caveats: 80 s is a long interlude, and the skip button still appears at 50 s, so
a player who clicks it gets the fallback anyway; one run is one run; the deployed site
still plays the 09-03 recording. What changed is that the loop can now be *played*, which
is what the human was asking for.
`pnpm verify` — green, 97 s, 1250 tests (web 370, agents 256, the rest unchanged).

### Same evening — three more rejections, the music that never came back, and the knob the Judge now owns

Human — played three more rounds on the fixed stack, all three fell back again, and put
three things on the table at once: the typing sound should say *thinking*, not typing;
the game's music "is not working — it must never stop, only get quieter while it
thinks"; and "it NEVER passes the training, always rejected. If it is rejected, should it
not think again? It cannot just reject and that's it, otherwise what are the agents
for?" Then, while the fixes were running: the pre-approved fallback strategy "should
not exist" if the point is to show the three agents.
Orchestrator — three server logs first (`artifacts/server/rewrite-2026-09-11T17-46…`,
`…17-48…`, `…17-50…`). The loop *does* think again — two attempts each time — but the
time goes where no prompt can get it back: Analyst 14–27 s, one Coder call 20–37 s (three
in parallel, so an attempt is ~32 s), every gate together ≈ 1 s. And the numbers the
Coder produced for a 0.35–0.50 band were 0.56, 0.00, 0.84, 0.57, 0.65, plus one file cut
unjudged; round 3 (0.50–0.65) got 0.86, 0.78, 0.07, 0.90. Every file a plausible counter
to that player; not one of them at the right temperature. The humans tuned the fallback
pool by changing one cadence constant and re-reading Gate 3 — the metronome's header
says "700 measures 0.46, 1600 measures 0.36" — and that is a one-second operation the
harness can do itself. Two subagents on disjoint packages, an Explore map of the audio
first.
Audio (web) — the intro music stopping at the first FIGHT and never returning was the
design, pinned by twelve tests; the human's request overrides it. Music is one
continuous bed now, started by the intro's autoplay attempt or any deliberate gesture
anywhere, never stopped, ducked 11 dB over 0.6 s while the interlude is open
(`interludeOpened` / `interludeClosed` in the reducer, restore on every teardown path).
The typewriter click became a low AM-synth pulse — C3 → E♭3 → G3, one every 800 ms,
0.15 s attack — that runs while deltas arrive and dies 700 ms after the last one. One
judgment call worth recording: building the Tone chain on a mid-fight gesture dropped
frames in `e2e/controls.spec.ts`, so the page-level gesture only *records* consent and
the chain is built at the next moment that can afford a long task; a player who skips
the intro and touches nothing but the arena hears the bed from the first interlude.
Web 366 → 374; e2e audio 6 → 7; nothing by ear, only by the human.
Calibration (agents), first version — the Coder was told to declare a `PRESSURE`
constant and wire it monotonically; the Judge bisected it. Live, on the human's own
replay: the model scaled slam and charge odds by it, the kills came from burst and
minions, and the panel measured 0.86 → 0.90 → 0.84 across 1.0 / 0.5 / 0.25
([`evidence/local-live-2026-09-11-coder-knob-flat.json`](evidence/local-live-2026-09-11-coder-knob-flat.json)).
The non-monotone stop fired exactly as designed; the run fell back. A knob wired by a
language model is a suggestion.
Second version, shipped — the knob is the harness's. `agents/src/calibrate.ts` appends a
marked block that renames the Coder's `init`/`decide` and wraps them with a
`THROTTLE ∈ [0.1, 1]`: hold `round((1/THROTTLE − 1) × 45)` ticks after each attack,
march straight legs while held (the orbit in the first sketch made the boss *harder* to
hit — 0.46 → 0.53 — and was measured out), re-run all four gates per value, bracket ×0.5
then bisect, six steps at most, downward only, triggered only by FAIR-too-hard with
ACTIVE clean and ADAPTED not blocking. Monotone by construction on the fixture
(0.75 → 0.41 → 0.00). The Coder prompt lost the PRESSURE block again and is 81 chars
*shorter* than this morning. Then, because the round-3 run judged two siblings and ran
four more steps after candidate 0 had already passed, an approval now ends its attempt
(`skippedReason: 'approved-sibling'`). Agents 256 → 289. SPEC §13 delta 26; SYSTEM §5.
Measured, same provider, the human's own round-1 and round-2 replays posted straight to
`/api/rewrite`: **round 2 approved on attempt 1 in 44 s** — "Silo I", 0.78 too hard,
one step to throttle 0.5, **0.49 vs panel**
([`evidence/local-live-2026-09-11-r2-throttle.json`](evidence/local-live-2026-09-11-r2-throttle.json));
**round 3 approved on attempt 1 in 57 s** — "Cistern I", 0.77, four steps to 0.771,
**0.60 vs panel with ADAPTED met** at the blocking round
([`evidence/local-live-2026-09-11-r3-throttle.json`](evidence/local-live-2026-09-11-r3-throttle.json)).
Its line: *"You always dig into the same corner of the pool, so half the time I fill it
before you climb out."*
Interlude (web) — the calibration is on screen in the Judge's voice, nothing that looks
like a model: a `CALIBRATED · throttle 1.00 → 0.50 → 0.71 · shipped at 0.71 (2 steps)`
strip inside the candidate's gate group, one row per step with the panel rate and the
plain reason, and the stamp quotes the *shipped* rate — `✓ APPROVED — 44%`, "0.44 vs
panel after the Judge throttled the boss to 0.71 (2 steps)" — never the failing number
sitting `✗` above it, and no Mimic rate, because calibration steps do not measure one. A
second diff, `as the coder wrote it → shipped — calibrated by the judge`, opens on the
appended block so the player sees exactly what the Judge added. The mock and the three
recordings emit no calibration events, so the browser test serves a self-declared stub
through the recorded source's fetch; the screen labels it as synthetic. Web 374 → 395,
interlude e2e 4 → 5; the first screenshot pass had the strip's second row clipped by the
gate list's fixed height, sent back and fixed: the strip has its own block now. Web 396 in the end.
`pnpm verify` — green, 1309 tests (contract 206, sandbox 100, engine 91, web 396, harness
147, agents 289, server 80); replay hash unmoved.
Open, and the human's to decide: whether the deadline fallback should exist at all. The
orchestrator's proposal is fallback for provider errors only, a clock that counts up, and
the attempt cap raised — the risk being a bad interlude of three to four minutes on this
provider.

## 2026-09-14 — submission day: the live site gets the real calibrated run

Human — "let's do it with no cost, then." And before any deploy: the playable local
build, hard boss, one last time — and *at the menu*, not in the fight (the remembered
"skip intro" box was honouring an old choice; `?intro=1` overrides it).
Orchestrator — the zero-spend site is only worth publishing if it shows what changed
since 09-10, so the recording had to come first. `scripts/record-run.ts` (web) gained a
`--server` mode that reads a server rewrite artifact instead of an eval one; the two
real claude-cli runs from 09-11 became `public/recorded/silo-r2-calibrated.json` (162 kB,
now the default) and `cistern-r3-calibrated.json` (225 kB). Cadence is reconstructed as
before from the measured durations, with a flat 1 000 ms charged to each calibration step
because the stream does not time one — the file says so in `timing.method`, and counts
those pins separately as `timing.assumed`. No `knownIssue` on either: both rest under the
Judge's straight-leg march, no `idle`. The browser test that matters: with no `?run=`,
Round 2 loads the shipped throttled file through QuickJS — `THROTTLE = 0.5`, the appended
block, the `__initRaw`/`__decideRaw` renames — and the boss travels 606 px in 300 ticks
with zero runner failures over 236 `decide` calls. Web 396 → 408, recorded e2e 2 → 4.
The READMEs that still called `mimic-camper` the default were corrected.
Human — "is there a bug in the sound? I can't hear anything." There was, and the
09-11 tests could not have caught it: Playwright's Chromium allows autoplay, a real
Chrome does not. The intro's mount-time attempt built the whole graph while the
`AudioContext` was still suspended by the autoplay policy, and `Tone.start()` lived only
inside that build — every later gesture found the chain built, returned early, and the
context stayed suspended for the session: Transport running, voices scheduling, nothing
audible, SFX included. Orchestrator — `resumeContext()` (`audio/engine.ts`): a cheap
resume on every gesture path — `noteGesture`, the page-level fallback (a resume is not
the long task a build is, so a fight's keypress may do it), and the early return of
`init()` that the mute toggle and the interlude buttons hit. Web 408 green, audio +
controls e2e 10/10; audible only to the human, again.

## Open — dated placeholders

Listed with what would close them, so each gap stays legible. AC 6 is kept here, struck
through, rather than deleted: what closed it and what it cost is the interesting part.

### `[ ] 2026-09-0? — human playtest (AC 4)`

*Can a human beat Round 1 in under 60 s with WASD + mouse on a first try, in ≥3 of 5
attempts?* Still unmeasured as a *timed five-attempt run* — but a human did play it on
2026-09-04 and the session found the frozen-boss bug (entry above), which is the single
most valuable thing this placeholder has produced so far. Run `pnpm dev`, open
`http://localhost:5173/?agent=mock&autostart=1`, five fresh attempts, log the outcomes and
times here. The scripted player wins in 909 ticks (~15 s), which says winnable, not fun.
Watch specifically for the renderer agent's finding: ~100% of damage comes from
un-telegraphed bullets, so a first-time player may find the fight unreadable even though
both telegraphs are honest. Spec §11's mitigation applies — *if not fun, simplify
primitives, don't add.*

### `[x] 2026-09-03 — real API eval + AC 6 evidence` — **closed**

*At least one recorded real run showing a strategy rejected by Gate 3 and then approved
on a subsequent attempt with no human input.* Done, on OpenAI `gpt-5.4-mini` rather than
Anthropic (credits). Replay `mimic-camper`: three candidates rejected by Gate 3, then
"Warden I" approved on attempt 2 — panel 0.39 ∈ [0.35, 0.50], **AC 7's Mimic number
0.99 ≥ 0.70** — in 23.5 s, 7 model calls, no human message anywhere.

- Excerpt and analysis: [`SYSTEM.md`](SYSTEM.md) §6.
- Event log of *this* run: [`docs/evidence/eval-round2-2026-09-03.json`](evidence/eval-round2-2026-09-03.json).
  This bullet said "all ten runs" until 2026-09-08; the committed file is the one quoted
  run plus the eval's aggregate numbers, and its own `note` field says so.
- Watchable: `pnpm dev`, then `/?agent=recorded&run=mimic-camper&autostart=1` — no key.
- Observed pass rate **0.6** against the 0.8 target, so §7's threshold is **not** met.
  **And 0.6 is an upper bound**, established on 2026-09-08: this eval ran the evening
  *before* Gate 3 grew its ACTIVE assertion, and re-grading its candidates against the
  current harness fails four of the six approvals on the idle clauses
  ([`evidence/recheck-active-2026-09-08.json`](evidence/recheck-active-2026-09-08.json)).
  The current rate has never been measured.
  That is recorded rather than smoothed over: the cause is measured (Coder p50 7.7 s /
  p90 12.3 s against a 40 s deadline, so the fourth attempt is usually unreachable) and
  the fallback pool covers the rest visibly. Closing the gap means a faster Coder or a
  longer budget, not a better prompt.

### `[ ] 2026-09-0? — deploy (AC 9, blocked: human decision)`

*Deployed URL loads and completes AC 5 from a cold start.* The recommendation is the split
deployment; the alternative is all-Vercel with `maxDuration: 60`, `REMATCH_WORKERS=2`,
`REMATCH_MATCHES=60`, `REMATCH_ARTIFACT_DIR=/tmp` and `includeFiles` for the fallback pool.
The trade is explicit and worth stating to a jury rather than hiding: 60 matches moves the
panel rate in steps of ~0.03, so a strategy near a band edge becomes a coin flip — that
weakens the **verifier**, which is the thing this project is arguing for. Once decided:
deploy, update the root `README.md` status line (currently *"Deployed URL: pending"*), and
record the cold-start interlude wall-clock here.
