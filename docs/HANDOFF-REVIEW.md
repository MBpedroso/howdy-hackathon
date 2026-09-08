# Handoff for an independent review — REMATCH

You are being asked for an **impartial, critical opinion** of a hackathon project. You have no stake in it. Please judge it against the brief and the rubric below, say plainly what is weak, and do not soften findings. Where you can, run the commands in §7 and look at the code yourself rather than trusting this document.

Repository: `howdy-hackathon` (local only, **not deployed, not pushed**). Prepared 2026-09-08 by the orchestrating assistant that coordinated the build, so treat this document as a *self-report* and verify claims.

**Revision, same day.** The first version of this document was reviewed, and the review — [`REVIEW-2026-09-08.md`](REVIEW-2026-09-08.md) — is committed alongside it. It scored the project 68–72 and found a five-line boss that passed all four gates while doing nothing. What followed was six commits of fixes, and a playtest that found two more bugs of the same family plus one that reframes the project's headline number. This revision folds all of that in. **§5 is now the most useful section**: it is the honest list, and it is longer and sharper than it was before the review, not shorter.

---

## 1. The brief

**Competition:** Howdy Dev Day 2026 — Agentic Software Engineering Hackathon. Window 2026-08-31 → 2026-09-14. Solo human (Matheus) acting as orchestrator; code written by Claude Code subagents.

**Rubric (100 pts):**

| Criterion | Pts |
|---|---|
| Agentic Engineering (separate contexts, parallel workstreams, reasons for boundaries) | 25 |
| Harness + Autonomous Loops (deterministic gates; rejection → fix → re-verify with no human) | 25 |
| Product Quality (playable, polished, fast) | 20 |
| Context Engineering (agents get only what they need) | 10 |
| Innovation | 10 |
| Reproducibility | 5 |
| Demo | 5 |

**Product thesis (from `docs/SPEC.md` v0.1, approved 2026-09-02):** *"agents are safe to give real autonomy when a deterministic harness gates their output."* Concretely: a 2D browser arena boss fight. When the player wins a round, an **Analyst** agent reads the replay, a **Coder** agent rewrites the boss's strategy as executable JS, and a **deterministic harness** (no LLM) runs static checks, fuzzing, 200 simulated matches and a perf check before the new boss ships. Rejections and retries happen live, on screen, in a 20–45 s "interlude". Up to 5 rounds.

**Definition of Done (spec §9, ten acceptance criteria), paraphrased:** AC1 runs from a fresh clone with no API key · AC2 `pnpm verify` green · AC3 same seed + inputs → identical state hash in browser and Node · AC4 a human beats Round 1 in <60 s in ≥3 of 5 first tries · AC5 interlude shows four beats with real streamed content in ≤45 s or falls back visibly · AC6 a recorded real run shows a Gate 3 rejection then approval with no human input · AC7 the Round 2 boss beats a "Mimic" of the human ≥70 % in sim · AC8 `Date.now()`, `fetch(`, infinite loops rejected before execution · AC9 deployed URL · AC10 README, SPEC, SYSTEM, AI-DEV-LOG exist and match.

---

## 2. What was built (19 commits, 2026-09-02 → 09-08)

pnpm monorepo, TypeScript, no build step (TS source resolved directly). Seven packages:

| Package | What it is | Notes |
|---|---|---|
| `contract` | The Boss Contract: `BossView` in, `BossAction` out; action validator; acorn-based static check (forbidden identifiers, exports, size) | Zero deps by design; changes are CI-gated by a CHANGELOG rule |
| `engine` | Deterministic 60 Hz simulation, xorshift PRNG, replay, FNV state hash, replay summary for the Analyst | ~750k ticks/s in Node |
| `sandbox` | QuickJS (WASM) runner for strategies, same bytes in browser and Node; injected seeded `rand()`; time/memory limits | Security boundary; `Date`/`RegExp`/`Proxy` removed as *intrinsics*, `.constructor` stripped |
| `harness` | Gate 1 static · Gate 2 fuzz (560 synthetic states) · Gate 3 balance (worker-parallel sim vs 4 scripted bots + a Mimic of the human; FAIR band per round, ADAPTED ≥0.70, ACTIVE) · Gate 4 perf (p99 ≤2 ms). CLI | Gate 3: 200 matches in ~0.9 s on 8 cores |
| `agents` | Analyst + Coder prompts, context assembly with **denial tests**, rewrite loop emitting typed events per beat, K=3 parallel candidates per attempt with different "dials", bisection-style retry feedback, providers: Anthropic, OpenAI, **Claude Code CLI** (local subscription only), mock | System prompt 12.8k chars, cached |
| `server` | `node:http` + SSE `POST /api/rewrite`; fallback pool (8 hand-written strategies, 2 per round, all in band); rate limit; daily spend cap; fallback-only mode without a key | |
| `web` | Vite + Canvas renderer, WASD/mouse, telegraphed attacks, HUD, start screen with tutorial and agent portraits, four-beat interlude UI, sources: live SSE / recorded real run / mock | Playwright e2e; browser hash == Node hash test |

**Changed on 2026-09-08, after the review and the playtest** (each is one commit, `git log` for the reasoning):

- **Gate 3's ACTIVE grew a span clause.** `minSpanPx` — the diagonal of the boss's bounding box over a match — must be at least the boss's own diameter (56 px). Closes the class the review's counter-example exploited. Spec §13 delta 19.
- **Gate 2 moved to the monotonic clock.** Its whole verdict, timing distribution included, is now bit-identical across runs. Gate 4 deliberately keeps the wall clock and the docs now say so. Delta 18.
- **The client's deadline now bounds the server's.** `POST /api/rewrite` takes `budgetMs`; the server clamps to `min(configured, budget − 2 s)`. Delta 21.
- **`REMATCH_MAX_ATTEMPTS`** makes the attempt ceiling configurable, for a *training* configuration where waiting minutes for a better boss is the right trade.
- **`fallback/round3/emberline` rebalanced** from 5.0 to 12.8 attack primitives per 1000 ticks at a held win rate.
- **Docs reconciled**: test counts, the evidence file's real contents, a §6-vs-§9 contradiction inside `SYSTEM.md`, and the heat map's "rolling" vs cumulative.

Deterministic controls: pre-commit hook runs `pnpm verify` (typecheck + lint + all unit tests, ~65 s); ESLint rule forbids `Math.random`/`Date`/`performance.now` in `engine` and `contract` with inline-disable blocked; GitHub Actions workflow (**never run — not pushed**) with a contract-CHANGELOG gate.

Docs: `README.md`, `docs/SPEC.md` (§13 "implementation deltas", 21 rows), `docs/SYSTEM.md`, `docs/AI-DEV-LOG.md`, `docs/REVIEW-2026-09-08.md`, and two evidence files.

---

## 3. Measured results (verify these)

- **Unit tests: 1020** across 7 packages (contract 206, agents 215, web 194, harness 134, sandbox 100, engine 91, server 80). **Playwright e2e: 19.** `pnpm verify` green in ~65 s.
- **AC3 determinism:** browser and Node produce the same hash for a 909-tick recorded input log (`packages/web/e2e/fixtures/`, hash `74cd659935e33202`). Asserted by `e2e/determinism.spec.ts`.
- **AC1:** verified from a fresh `git clone` with no key — the server boots fallback-only and says so in one line.
- **Gate reproducibility:** Gates 1–3 return the same verdict on the same input; three identical `pnpm harness` runs produced byte-identical output. **Gate 4 is a wall-clock measurement and is not reproducible, by design.**
- **Gate 1 + sandbox under attack:** eight bypass attempts written and run (computed global access, `Function`, indirect `eval`, dynamic `import`, prototype-chain to `Function`, NaN/Infinity actions, a throwing getter, a mid-match throw). All rejected. The prototype-chain one passed Gate 1 and died in the sandbox, which is the layering working.
- **Balance:** all 8 fallback strategies land inside their round's band with ≥0.03 margin (`pnpm --filter @rematch/server exec vitest run fallback`, 120 matches; 200 checked by hand). Round 1 is beaten 100 % by a scripted mid-range player in 16.6 s average.
- **Loop pass rate — read this carefully.** The number on record is **0.6** (6/10 canned replays, K=3, OpenAI `gpt-5.4-mini`, 2026-09-03) against spec §7's ≥0.8. **It is an upper bound measured against a harness that no longer exists**: that eval ran the day before Gate 3 grew ACTIVE, and re-grading its candidates against the current harness fails four of the six approvals on the idle clauses ([`recheck-active-2026-09-08.json`](evidence/recheck-active-2026-09-08.json)). The current rate has never been measured; doing so costs money.
- **Live on the human's machine, `claude-cli` provider, 2026-09-08** — the first real end-to-end playtest, and the most informative data the project has. With the attempt ceiling raised: **three rounds approved live on attempt 3, in 105–113 s**. One round ran **12 attempts over 455 s without approving** — see §4.
- **Cost:** iterating evals autonomously consumed the human's entire OpenAI credit on 2026-09-03 (~8 evals ≈ 80 interludes). Spend guards were added afterwards.

---

## 4. The finding a reviewer should start from

The playtest produced a result that contradicts what every other document in this repo says about why the loop fails. Please attack it.

One round took 12 attempts and 23 candidates and never approved. The docs blame **Coder latency** for the pass rate. That is not what happened here — with attempts unlocked, latency stopped being the constraint and this appeared:

```
8 of 23 candidates landed INSIDE the fairness band and were rejected by the Mimic alone
best Mimic score across all 23 candidates: 0.60     (ADAPTED requires >= 0.70)
```

Not one candidate in 23 reached the ADAPTED threshold. And the direction is wrong: making the boss harder did not help — panel 0.73 scored 0.58 against the Mimic, panel 0.66 scored 0.41.

The cause is in the player's own replay for that round: **0 damage taken, 5/5 hp, 1 dash.** The Mimic is built from that replay, so it is a model of a player who never gets hit. Beating it 70 % of the time needs a boss that would crush the player — and such a boss exceeds FAIR's 0.35–0.50.

**So FAIR and ADAPTED are in direct conflict, and the conflict gets worse the better the player is.** FAIR says "a different approach still beats it"; ADAPTED says "it countered how *you* played". Those are compatible only while the Mimic is weaker than the scripted panel. For a skilled player it is stronger, and then no boss satisfies both. The 2026-09-03 eval never saw this because its ten replays were recordings of *bots*, not of a skilled human.

The proposed fix — **not yet implemented, and worth a second opinion before it is** — is to make ADAPTED *relative*: the new boss must beat the Mimic more than the boss that just lost did. "It learned" is a comparison, not an absolute level, and a relative test self-calibrates to player skill and removes the contradiction. `prevSource` is already in the request, so the baseline is computable. The low-risk form keeps both and approves if either passes, so nothing that passes today stops passing. Costs an extra half-Gate-3 of simulation per round and needs a guard for when the previous boss already beats the Mimic ~1.0.

---

## 5. Known weaknesses and deviations (self-reported — please add your own)

### Fixed since the review, with evidence

1. **A five-line boss passed all four gates.** It oscillated 0.02 px on the spot, never attacked, and was approved for Round 2 at panel 0.44 with ACTIVE reporting `idle run 0t/90` and ADAPTED **1.00** against two of the four recorded replays. Kept as `packages/harness/test/fixtures/jitter.js`. Fixed by the span clause. The first hypothesis (that it was sneaking under `STILL_EPSILON`) was **wrong** — `validateMove` normalizes `move` to a unit vector, so it moved at full speed; the recorded correction is in `AI-DEV-LOG.md`.
2. **Gate 2 was not reproducible** while promising in its own docstring that it was. A strategy near the 2 ms budget measured 0 over-budget states idle and 4 of 560 loaded.
3. **Round 2 never once completed live, in any session.** The client aborted at 45 s while the server ran to 90 s, so the browser hung up mid-stream: `approved: null`, no `fallback` event, **no artifact**. Always Round 2 because it is the first rewrite of a session and the only one paying a cold prompt cache. The round the thesis rests on was the one that never worked, and nothing in the repo would have said so.
4. **Docs drift**: README claimed 897 tests (1020); `SYSTEM.md` §6 claimed the evidence file held ten runs (it holds one and its own `note` says so); `SYSTEM.md` §9 item 1 claimed no real API run existed, contradicting §6 in the same file for eleven days.
5. **The Round 3 boss barely attacked** — 5.0 attack primitives per 1000 ticks against 7.9–15.7 for the rest, and every gate passed it. Rebalanced to 12.8 at a held win rate.

### Open, and the reasons

6. **`timeout = boss win`** (`sim/runMatch.ts`). Running out the clock counts as a boss win, so passivity is a winning strategy and the fairness band actively rewards a boss that does not act. **This is the root cause of items 1, 5 and arguably 4 in the list below** — three separate player-visible bugs. Not fixed: changing it re-baselines every band, margin and calibration fixture in two packages, six days out. The span clause is a floor under the symptom.
7. **The current pass rate is unknown.** See §3. Re-measuring needs a live key.
8. **Not deployed (AC9), not pushed, CI never executed.** This costs more than AC9: `.githooks/pre-commit` argues its own `--no-verify` hatch is acceptable *because* "CI re-runs the same script on every push", and that sentence is currently false. `git rev-parse origin/main` is still the spec template.
9. **AC4 never formally done.** The human has now played several full sessions, but the specific five-timed-attempts protocol has not been run.
10. **The strafe resting state reads as "busy but not fighting".** 8 of 10 shipped strategies strafe while waiting on cooldowns — added on 09-04 to satisfy ACTIVE. It replaced "looks crashed" with "looks aimless", which is an improvement in appearance and not in play. The player noticed it unprompted.
11. **The pool hits its bands by not fighting part of the time.** `rand()`-gated aggression: `bellringer` 0.45, `crossfire` 0.5, `hollow` and `tollkeeper` 0.62. A narrow band plus a timeout that favours the boss makes passivity the cheapest dial. Same root cause as item 6.
12. **An engagement gate was measured and rejected.** Across the 58 real candidate files, attack rate runs 0.5–21.3 with a median of 11.4 and **no gap**: a floor of 6 would reject 20 of 58, and one historical approval sat at 1.6. Held as a test over the eleven shipped files instead. Contrast with the span clause, which had a 60× separation to aim at — the difference is worth a reviewer's attention, because it is the difference between a gate and a wish.
13. **`claude-cli` cannot serve AC 5.** Every call is a whole Claude Code session start; a live approval takes 3 attempts ≈ 110 s. It is excluded from `auto` provider selection and cannot run on a deployed server.
14. **Bots are near-binary.** In the fallback table, Camper is 1.00 for 7 of 8 strategies and Rusher 0.00 for 5 of 8 — the panel's discriminating power comes from two bots, not four, against bands 0.15 wide.
15. **Heat map is cumulative**, not rolling, despite the contract calling it a "rolling summary" (spec §13 delta 20).
16. **Server hardening is demo-grade.** `/api/rewrite` has no auth; the rate limit trusts the first `x-forwarded-for` entry; the daily spend cap is an in-memory counter that resets on restart; player-controlled `prevSource` (64 kB) reaches the Coder prompt verbatim. Fine for localhost, and the reason AC 9 is not a switch to flip.
17. **No audio anywhere.** Cheapest Product Quality points on the table.
18. **K=3 "parallel candidates" is best-of-N**, not parallel workstreams: one agent, byte-identical system prompt, one instruction line different. Honest in the code comments; a stretch in a rubric framing.
19. **Only Round 2 has recorded loop evidence.** Rounds 3–5 have bands, bots and a balance-tested fallback pair each, but no recorded rewrite.
20. **Recorded demo runs predate the ACTIVE gate** — the bosses in them freeze. Disclosed on screen, in ~9 px type, in the busiest corner. Not re-recorded (costs credit).
21. **Process:** Opus subagents stalled or were killed by API errors ~8 times. One agent's `$?` bug in the pre-commit script would have turned every failure into a pass — caught by its own tests. Also found on 09-08: `REMATCH_PROVIDER=openai` was exported in the developer's shell, and Node's `--env-file-if-exists` does not override an already-set variable, so the `claude-cli` in `.env` had never taken effect from that shell. Most likely how the OpenAI credits went.
22. **Weight:** ~1.1 MB of TS source across 7 packages for a 12-day solo hackathon, with Product Quality (20 pts) getting comparatively little human attention against the harness axes (50 pts).

---

## 6. Questions we want your honest answer to

1. Is the §4 finding right, and is the relative-ADAPTED fix the correct response — or does making the gate relative weaken the claim the project is making?
2. Three player-visible bugs have now traced back to `timeout = boss win` (§5 item 6). Is leaving it unfixed six days out the right call, or is it the one thing worth breaking the calibration for?
3. The harness has been patched twice after something got past it. Does that read as a harness that works (found, measured, closed, with the counter-example kept as a fixture) or as one whose assertions are reactive rather than derived?
4. Against the rubric, where does the project actually score, and where is it still over-claiming?
5. Product: from the code and screenshots, would a mixed technical/non-technical jury understand the interlude in 90 seconds?
6. What would you cut, and what would you fix, in the days remaining (deadline 2026-09-14)?
7. Anything in the architecture that is unnecessary complexity for the stated goal?

---

## 7. How to inspect

```bash
pnpm install && pnpm verify          # typecheck + lint + 1020 unit tests (~65 s)
pnpm test:e2e                        # Playwright, 19 tests (needs: pnpm exec playwright install chromium)

# The gates, on a strategy
pnpm harness packages/contract/test/fixtures/strategies/good/chaser.js --round 2   # rejected: too hard + idle
pnpm harness packages/harness/test/fixtures/infinite-loop.js                       # rejected at Gate 2
pnpm harness packages/harness/test/fixtures/jitter.js --round 2 \
  --summary packages/harness/test/fixtures/summaries/camper-round1.json            # the review's counter-example
pnpm test:balance                                                                   # the calibration corpus
pnpm --filter @rematch/server exec vitest run fallback                              # the 8-strategy band table

# The two claims worth checking yourself
pnpm --filter @rematch/harness recheck:active   # 58 real candidates re-graded; free, no model call
grep -rn minSpanPx packages/harness/src         # the aggregate Gate 3 used to compute and never read

# Play it
pnpm dev                             # http://localhost:5173
#   ?agent=mock       scripted interlude, no LLM        ?agent=recorded  a real recorded run
#   ?debug=1          the determinism footer (tick, seeds, runner stats)
#   REMATCH_PROVIDER=none            fallback-only, free — note this removes the agents entirely
```

Key files: `docs/REVIEW-2026-09-08.md` (read first) · `docs/SPEC.md` §13 · `docs/SYSTEM.md` · `docs/AI-DEV-LOG.md` (2026-09-08 entry is the day's findings) · `packages/harness/src/sim/activity.ts` · `packages/harness/src/gates/{gate3Balance,balanceConfig}.ts` · `packages/server/src/handleRewrite.ts` (`clampToClientBudget`) · `packages/agents/src/{loop.ts,context/}` · `packages/agents/test/context.test.ts` · `artifacts/server/rewrite-2026-09-08T15-07-*.json` (the 12-attempt run behind §4).

Do not run `pnpm eval:agents` — it calls a paid LLM API and is guarded behind `REMATCH_ALLOW_SPEND=1` for that reason.
