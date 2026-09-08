# Handoff for an independent review — REMATCH

You are being asked for an **impartial, critical opinion** of a hackathon project. You have no stake in it. Please judge it against the brief and the rubric below, say plainly what is weak, and do not soften findings. Where you can, run the commands in §6 and look at the code yourself rather than trusting this document.

Repository: `howdy-hackathon` (local only, not deployed, not pushed). Prepared 2026-09-08 by the orchestrating assistant that coordinated the build, so treat this document as a *self-report* and verify claims.

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

## 2. What was built (13 commits, 2026-09-02 → 09-04)

pnpm monorepo, TypeScript, no build step (TS source resolved directly). Seven packages:

| Package | What it is | Notes |
|---|---|---|
| `contract` | The Boss Contract: `BossView` in, `BossAction` out; action validator; acorn-based static check (forbidden identifiers, exports, size) | Zero deps by design; changes are CI-gated by a CHANGELOG rule |
| `engine` | Deterministic 60 Hz simulation, xorshift PRNG, replay, FNV state hash, replay summary for the Analyst | ~750k ticks/s in Node |
| `sandbox` | QuickJS (WASM) runner for strategies, same bytes in browser and Node; injected seeded `rand()`; time/memory limits | Security boundary; most builtins removed |
| `harness` | Gate 1 static · Gate 2 fuzz (560 synthetic states) · Gate 3 balance (worker-parallel sim vs 4 scripted bots + a Mimic of the human; FAIR band per round, ADAPTED ≥0.70, ACTIVE = boss never motionless >1.5 s) · Gate 4 perf (p99 ≤2 ms). CLI | Gate 3: 200 matches in ~0.9 s on 8 cores |
| `agents` | Analyst + Coder prompts, context assembly with **denial tests** (Coder prompt must not contain engine internals), rewrite loop emitting typed events per beat, K=3 parallel candidates per attempt with different "dials", bisection-style retry feedback, providers: Anthropic, OpenAI, **Claude Code CLI** (local subscription), mock | System prompt 12.8k chars, cached |
| `server` | `node:http` + SSE `POST /api/rewrite`; fallback pool (8 hand-written strategies, 2 per round, all in band); rate limit; daily spend cap; fallback-only mode without a key | |
| `web` | Vite + Canvas renderer, WASD/mouse, telegraphed attacks, HUD, **start screen with tutorial and agent portraits**, four-beat interlude UI (replay heatmap, streamed analysis, code diff, gate meter + verdict stamps), sources: live SSE / recorded real run / mock | Playwright e2e; browser hash == Node hash test |

Deterministic controls: pre-commit hook runs `pnpm verify` (typecheck + lint + all unit tests, ~55 s); ESLint rule forbids `Math.random`/`Date`/`performance.now` in engine and contract with inline-disable blocked; GitHub Actions workflow (never run — not pushed) with a contract-CHANGELOG gate.

Docs: `README.md`, `docs/SPEC.md` (with §13 "implementation deltas", 17 rows), `docs/SYSTEM.md` (architecture, agents' context table, gates, autonomous-loop evidence, limitations), `docs/AI-DEV-LOG.md` (dated build log including failures), `docs/evidence/eval-round2-2026-09-03.json`.

---

## 3. Measured results (verify these)

- Unit tests: 990 across 7 packages (contract 206, agents 215, web 191, harness 118, sandbox 100, engine 91, server 69). Playwright e2e: 18.
- **AC3 determinism:** browser and Node produce the same hash for a 909-tick recorded input log (`packages/web/e2e/fixtures/`, hash `74cd659935e33202`). The harness simulator was found to be *non*-deterministic on 2026-09-04 (real-clock timeouts → phantom violations, 0.43 vs 0.45 on identical input) and was fixed with a monotonic clock.
- **Real autonomous-loop pass rate** (10 canned replays, round 2, OpenAI `gpt-5.4-mini`, 40 s deadline): K=1 → 0.2–0.3 over 5 runs; K=3 → **0.6** (6/10). 52 of 54 rejections were Gate 3. Binding constraint measured as Coder latency (p50 7.7 s, p90 12.3 s) against the deadline, not band width. **Spec AC target is ≥0.8 — not met.**
- **Live on the human's machine** (Claude Code CLI provider, 90 s deadline, 2 sessions on 2026-09-04): both approved on attempt 1 in 38.7 s and 42.2 s. Analyst correctly identified "kiter, zero dashes" then "mixed, 15 dashes NE/SW" after the player changed style. The conservative candidate was rejected both times (0.00 and 0.31 vs panel, "too easy"), the balanced one approved. n=2.
- **AC7:** in the recorded round-2 run used as evidence, approved candidate: panel 0.39 (band 0.35–0.50), Mimic 0.99.
- **Balance:** 11 shipped strategies each land inside their round's band with ≥0.03 margin at 200 matches; Round 1 is beaten 100 % by a scripted mid-range player (16.6 s average). Kiter and Rusher bots produce near-binary outcomes (0.00 or 1.00) for most bosses.
- **Cost:** iterating evals autonomously consumed the human's entire OpenAI credit on 2026-09-03 (~8 evals ≈ 80 interludes). Spend guards were added afterwards.

---

## 4. Known weaknesses and deviations (self-reported — please add your own)

1. **Pass rate 0.6 vs the 0.8 the spec demands**, on the OpenAI path. The live Claude CLI path looks better but n=2 and needs a 90 s deadline, double the spec's 45 s.
2. **The product's core depends on an LLM credential.** Without one it degrades to a normal boss fight with canned strategies and a visible "pre-approved strategy" banner. Locally it runs on the developer's Claude Code subscription via `claude -p`, which does not work for a deployed server.
3. **Not deployed (AC9 unmet by decision), not pushed, CI never executed.** The human chose local-only on 2026-09-04.
4. **AC4 (human playtest) never formally done.** The human played several sessions; feedback so far: Round 1 is easy (won taking 1 damage); a Round 2 boss initially "stood still in a corner" — root-caused to strategies resting on `idle` and a heat map that never decays, fixed by an ACTIVE gate and rewriting all 11 strategies. Whether the game is *fun* is unassessed.
5. **Does the boss visibly "learn"?** The harness proves adaptation statistically (Mimic ≥0.70). Whether a player *perceives* it after one round is unproven; the human's report after the first live session was "slightly harder", before the frozen-boss fix.
6. **Bots are near-binary** (Kiter 0.00/1.00, Rusher 0.00/1.00), so the panel win rate moves in 0.25 steps; the 0.15-wide bands are hard to hit. The fallback strategies rely on `rand()`-gated aggression to reach intermediate rates. This may indicate the reference bots are too strong/weak rather than the strategies.
7. **Heat map is cumulative**, not rolling, despite the contract calling it a "rolling summary". Contract is frozen; documented as a delta.
8. **Recorded demo runs** in `packages/web/public/recorded/` are real but predate the ACTIVE gate — the bosses in them freeze (flagged on screen as KNOWN ISSUE). Not re-recorded yet.
9. **Spec deviations** (all in `docs/SPEC.md` §13): contract has zero deps and bots live in harness; a 7th `sandbox` package; burst count 8 is a ring; timeout = boss win; heat normalized to sum 1; Sonnet/mini-class models for latency; pluggable provider (spec said Claude); raster portraits (spec said no raster art).
10. **Three `contract` test-fixture strategies still rest on `idle`** — kept as calibration corpus, documented.
11. **Process:** Opus subagents stalled or were killed by API errors ~8 times; work survived on disk. One agent's `$?` bug in the pre-commit script would have turned every failure into a pass — caught by its own tests. Lockfile crossfire between concurrent agents happened twice.
12. **Weight:** ~1.1 MB of TS source across 7 packages for a 12-day solo hackathon. Rubric rewards the harness/agentic axes (50 pts) but Product Quality (20) received comparatively little human attention.

---

## 5. Questions we want your honest answer to

1. Against this rubric, where does the project actually score, and where is it over-claiming?
2. Is the thesis ("deterministic harness makes agent autonomy safe") *demonstrated* or merely *asserted* by what exists? What would a skeptical technical judge poke at first?
3. Is the 0.6 live pass rate a disqualifying flaw for the demo, an acceptable engineering trade-off that the fallback pool covers, or a sign the design (bands, bots, deadline) is wrong?
4. Is the ACTIVE gate a legitimate deterministic control or a patch over a balance-design problem (bots that reward a stationary boss)?
5. Product: from the screenshots/code, would a mixed technical/non-technical jury understand what is happening in the interlude in 90 seconds?
6. What would you cut, and what would you fix, in the 6 days remaining (deadline 2026-09-14)?
7. Anything in the architecture that is unnecessary complexity for the stated goal?

---

## 6. How to inspect

```bash
pnpm install && pnpm verify          # typecheck + lint + all unit tests (~1 min)
pnpm test:e2e                        # Playwright (needs: pnpm exec playwright install chromium)
pnpm harness packages/contract/test/fixtures/strategies/good/chaser.js --round 2   # gates on a strategy
pnpm harness packages/harness/test/fixtures/infinite-loop.js                        # rejected at Gate 2
pnpm test:balance                    # all shipped strategies vs the bot panel, table printed
pnpm dev                             # http://localhost:5173  (start screen → fight → interlude)
#   ?agent=mock      scripted interlude (no LLM)      ?agent=recorded   replays a real recorded run
#   default          live if a server answers /api/health; REMATCH_PROVIDER=none → fallback-only
```

Key files to read: `docs/SPEC.md` (§1, §4, §6, §9, §13) · `docs/SYSTEM.md` · `docs/AI-DEV-LOG.md` · `packages/contract/src/{types,staticCheck,validate}.ts` · `packages/harness/src/gates/gate3Balance.ts` · `packages/agents/src/{loop.ts,context/}` · `packages/agents/test/context.test.ts` (the denial tests) · `packages/web/src/interlude/` · `artifacts/web/*.png` (screenshots) · `docs/evidence/`.

Do not run `pnpm eval:agents` — it calls a paid LLM API and is guarded behind `REMATCH_ALLOW_SPEND=1` for that reason.
