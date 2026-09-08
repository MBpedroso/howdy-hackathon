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

## Open — dated placeholders

Listed with what would close them, so each gap stays legible. AC 6 is kept here, struck
through, rather than deleted: what closed it and what it cost is the interesting part.

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

### Not done, and why

- **The pass rate has not been re-measured.** The only way is `pnpm eval:agents` against a
  live key, which spends money — a human decision, and the top of this list because it is
  the number a judge will ask about. Everything needed is in place: the eval, the ten canned
  replays, the spend guards, and now a free pre-check that says the span clause is not the
  thing to worry about.
- **Not pushed, so CI has still never run.** `origin/main` is still `4398e6e`, the spec
  template. This costs more than AC 9: `.githooks/pre-commit` argues its own `--no-verify`
  hatch is acceptable *because* "CI re-runs the same script on every push", and that
  sentence is currently false. Outward-facing, so it is a human call.
- **Recorded demo runs not re-recorded.** They predate the ACTIVE gate and the bosses in
  them freeze; it is disclosed on screen, in 9 px type, in the busiest corner. Re-recording
  spends API credit, so it is a human call too.
- **`timeout = boss win`** — see above.
- **No audio anywhere.** `grep -riE "audio|\.mp3|\.wav"` over `packages/web/src` returns
  nothing. Cheapest Product Quality points left on the table.

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
