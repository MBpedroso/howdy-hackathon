# REMATCH — the boss that learns

A 2D arena boss fight where, between rounds, an agent studies how you won and rewrites the
boss's strategy to counter you. A second, deterministic verifier refuses to ship that
rewrite until it proves the fight is still fair — and you watch it happen, rejections
included.

**Status: `pnpm verify` green — 1321 tests + 38 e2e. Live: [rematch-beryl-eta.vercel.app](https://rematch-beryl-eta.vercel.app) — static web, interlude replays a real recorded run (zero-spend decision, see *Deploy*). The live loop runs locally.**

## 60-second demo

```bash
pnpm install && pnpm dev          # web on :5173, api on :8787 — one Ctrl-C stops both, and with no `?agent=` the client probes `/api/health` at boot and plays the real agents by default whenever that server answers
open 'http://localhost:5173/?agent=recorded&autostart=1'
```

**No API key needed, and nothing here spends money.** That URL replays a **real** run of
the model — `claude-cli` / `sonnet`, 2026-09-11: the Coder's counter measured 0.78 against
the panel, too hard for the round's band, and the Judge's deterministic calibration
throttled it to 0.49 in one step and approved it ("Silo I", 44 s) — from a JSON asset
committed to this repo.
Round 2 then really loads that approved strategy through QuickJS.

There are three interlude sources and the footer badge always names the one on screen, so
you never have to guess what you are watching:

| URL | Badge | What it is |
|---|---|---|
| `?agent=recorded` | `RECORDED RUN · sonnet · 2026-09-11` | **real** past model output, replayed from disk. Free, offline |
| `?agent=mock` | `MOCK` | hand-scripted, timed from real measurements. Free, offline |
| `?agent=sse` | `LIVE` | the server running the loop right now. Needs a key; spends tokens |

Five runs are recorded (`?run=silo-r2-calibrated` · `cistern-r3-calibrated` · `mimic-camper`
· `dodger-a` · `kiter-a`) so the fight is not the same twice. With no key at all, `?agent=sse` answers in fallback-only mode and says so
on screen — nothing is ever fabricated. Details in
[`packages/web/README.md`](packages/web/README.md#recorded-runs--the-demo-videos-source).

**Controls:** `WASD` / arrows to move · `Space` to dash (invulnerable, 10 ticks) · mouse to
aim · hold click to shoot. Beat the boss inside 60 s and the interlude starts.

**In a hurry?** Winning Round 1 by hand takes ~30 s. On the dev server, in the console:

```js
const f = await (await fetch('/e2e/fixtures/inputlog-round1.json')).json();
await __rematch.driveWith(f.log); __rematch.fastForward();   // → straight to the interlude
```

## The four beats

The interlude *is* the demo. Everything on screen is real output.

| Beat | What you see | What runs |
|---|---|---|
| **Replay** | your position heat map, dash rose, attack timeline | deterministic replay from seed + input log — the same three pictures the Analyst gets |
| **Analysis** | streamed prose: *"Player camped the bottom-left corner…"* | **Analyst agent** reads the compressed replay. It is shown no code, ever |
| **Rewrite** | a unified diff, old strategy → new, labelled with the boss's new name | **Coder agent** writes a `strategy.js` against the frozen Boss Contract |
| **Trial** | gates tick past, a meter fills, verdicts land: `✗ 0.78 vs panel — too hard` … `↻` … `✓ APPROVED` | **harness**, 4 gates, no LLM — three of them reproduce byte-for-byte, and Gate 4 is a wall-clock measurement by design. A rejection goes back to the Coder verbatim. Max 4 attempts, then a pre-approved fallback, visibly |

## Packages

pnpm workspaces, Node ≥ 22 (developed on 25), TypeScript strict ESM. **No build step** —
every package entry point resolves to TypeScript source.

| Package | Depends on | Responsibility |
|---|---|---|
| `@rematch/contract` | *(nothing)* | The Boss Contract: types, `CONSTANTS`, `validateAction`, `staticCheck` (Gate 1). Zero workspace deps by design — everything else consumes it |
| `@rematch/engine` | `contract` | Deterministic 60 Hz simulation, seeded xorshift PRNG, replay + state hash |
| `@rematch/sandbox` | `contract` | QuickJS containment for generated strategies: no host bindings, seeded `rand()`, 2 ms deadline, 64 MB heap. The security boundary |
| `@rematch/harness` | `contract`, `engine`, `sandbox` | The four gates + CLI. Gate 1 static, Gate 2 fuzz, Gate 3 balance (worker-parallel sim vs the bot panel + Mimic), Gate 4 perf |
| `@rematch/agents` | `contract`, `engine`, `harness` | Analyst + Coder prompts, context assembly, and the autonomous rewrite loop — four attempts under the harness's back pressure, no human message anywhere |
| `@rematch/server` | `contract`, `engine`, `harness`, `agents` | `POST /api/rewrite` over SSE, `/api/health`, `/api/fallback/:round`, the 8-strategy fallback pool, deadline + rate limit + CORS |
| `@rematch/web` | `contract`, `engine`, `sandbox` | Vite + Canvas 2D fight and the four-beat interlude. Deliberately **not** on `agents` — that would pull workers and the SDK into a browser bundle |

Two deliberate departures from the spec's package table, plus eight more, are listed in
[`docs/SPEC.md` §13](docs/SPEC.md#13-implementation-deltas).

## Commands

| Command | What it does |
|---|---|
| `pnpm install` | Install the workspace (also installs the pre-commit hook) |
| `pnpm dev` | Game + API server together; `pnpm dev:web` / `pnpm dev:server` for one half |
| `pnpm verify` | `typecheck` + `lint` + every test — the gate-all. Runs on every commit and in CI |
| `pnpm typecheck` / `pnpm lint` / `pnpm test` | The three steps on their own |
| `pnpm test:contract` / `test:engine` / `test:sandbox` / `test:harness` | Per-layer suites |
| `pnpm test:balance` | Balance regression: every pooled fallback still lands in its round's band |
| `pnpm test:e2e` | Playwright (chromium, 19 tests); builds and previews first. Screenshots → `artifacts/` |
| `pnpm harness <file.js>` | Run the gates against one strategy (`--gates 1,2`, `--seed`, `--json`). Exit 0 approved / 1 rejected / 2 usage error |
| `pnpm eval:agents` | **Spends money. Refuses to run without `REMATCH_ALLOW_SPEND=1`**, printing the worst-case call count (~250) first. The loop over 10 canned replays vs spec §7's ≥80% target |
| `pnpm --filter @rematch/web record:run <artifact> <run>…` | Rebuild the recorded demo assets from an eval artifact. Reads a local file; no network |
| `pnpm build` | Production web bundle |

## Environment

Everything is optional; with none of it set the game is playable and the server runs in
fallback-only mode.

Start from the committed template — it ships with the loop **off**, which is the
recommended setting for local work:

```bash
cp .env.example .env
```

| Variable | Effect |
|---|---|
| **`REMATCH_PROVIDER`** | `none` \| `openai` \| `anthropic` \| `claude-cli` \| `auto`. **`none` is the documented value for local dev** and forces fallback-only *even with a key present* — an off switch that does not require deleting your credential. `.env.example` sets it |
| **`REMATCH_PROVIDER=claude-cli`** | runs the real loop on **your Claude Code subscription**, by spawning the installed `claude` binary — no API key, no API bill. **Local machine only:** the deployed server has no CLI session logged in. Needs no credential variable, which is why `auto` never picks it. Slower than the API path (~18 s per Coder call), so raise `REMATCH_DEADLINE_MS` |
| `REMATCH_CLAUDE_BIN` | path to the `claude` binary, default `claude` on `PATH` |
| `REMATCH_CLI_TIMEOUT_MS` | per-call guard on the CLI subprocess, default `60000`. SIGTERM then SIGKILL 2 s later |
| `OPENAI_API_KEY` | present → the real loop runs on OpenAI (unless `REMATCH_PROVIDER=none`) |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` | same, on Anthropic. `auto` prefers Anthropic when both are set |
| **`REMATCH_MAX_REWRITES_PER_DAY`** | global cap on rewrites the server pays for, per UTC day. Default `50`; `0` = never spend. Past it: fallback-only for the rest of the day, one log line, and `/api/health` reports `spendGuard: "capped"` |
| **`REMATCH_ALLOW_SPEND`** | `pnpm eval:agents` refuses to run without `=1`, printing the worst-case model-call count first. Do **not** put this in `.env` — it is meant to be typed at the call site |
| `REMATCH_MODEL` | model for both agents. Default is the vendor's own (`gpt-5.4-mini` / `claude-sonnet-5`) |
| `REMATCH_ANALYST_MODEL` / `REMATCH_CODER_MODEL` | per agent; wins over `REMATCH_MODEL`. On `claude-cli` these are CLI model aliases (`sonnet`, `opus`) or full ids |
| `REMATCH_REASONING_EFFORT` | thinking effort. OpenAI `minimal\|low\|medium\|high\|none`, `claude-cli` `low\|medium\|high\|xhigh\|max`; `off` omits it. `low` by default on both — the same Coder prompt measured 145 s at a high effort and 17.6 s at `low`, both passing the static check first try |
| `REMATCH_CANDIDATES` | files the Coder writes per attempt, default `3` (spec §13 delta 12) |
| `REMATCH_DEADLINE_MS` | loop deadline, default `40000` |
| `REMATCH_MATCHES` | Gate 3 matches per attempt, default `200` |
| `REMATCH_WORKERS` | Gate 3 simulation threads, default `availableParallelism() - 1` |
| `REMATCH_ORIGIN` | extra allowed CORS origins, comma-separated |
| `REMATCH_ARTIFACT_DIR` | where event logs go, default `artifacts/server/` |
| `PORT` / `HOST` | default `8787`, `127.0.0.1` |

The two bold spend guards were added on 2026-09-04, after eleven eval runs in one evening
exhausted the project's API credit — the per-IP rate limit (6 per 10 min) caps one caller
and is no control at all on the total bill. The post-mortem is in
[`docs/AI-DEV-LOG.md`](docs/AI-DEV-LOG.md).

`.env` at the repo root is read by Node itself (`--env-file-if-exists`) — no `dotenv`
dependency, and a missing `.env` is a log line rather than a crash. Useful URL parameters
(`?seed=`, `?round=`, `?agent=recorded`, `?run=`, `?agent=sse`, `?speed=`, `?deadline=`,
`?debug=1`) are in `packages/web/README.md`. **`?debug=1`** is the one worth knowing for a
technical walkthrough: it puts the determinism footer back under the HUD — tick, both
seeds, tick+render ms, and the sandbox runner's call/idle/violation counts. It is off by
default as of 2026-09-08, because the numbers that read as *evidence* to one half of a
jury read as an unfinished screen to the other.

## Deploy

**What is live:** the static web app alone, on Vercel —
[rematch-beryl-eta.vercel.app](https://rematch-beryl-eta.vercel.app). Its interlude
replays a real `claude-cli`/`sonnet` run from disk and says so on screen: `RECORDED RUN ·
sonnet · 2026-09-11`, calibration strip included. No server, no key, no spend.
Verified from outside on 2026-09-14: the scripted player wins Round 1 on the published
site, the interlude opens on the recorded run, zero requests leave for any `/api/` or
external host (`artifacts/web/deployed-interlude-recorded.png`).

**How:** [`vercel.json`](vercel.json) builds `packages/web` with the build-time env
`VITE_DEFAULT_AGENT=recorded` (`src/interlude/source.ts`), which makes "no `?agent=` on
a deployed host" resolve to the recorded source. The URL still wins: `?agent=mock` and
`?agent=sse` behave as documented in the *Environment* table.

**Why not the live loop on the live URL:** the split deployment — server on Fly.io,
web on Vercel — was built, smoke-tested, deployed, and ran one real rewrite on
2026-09-10 (Analyst 9 s, Coder 3 candidates, Gates 1–2 passed) until Fly's no-card trial
stopped the machine after five minutes, mid-Gate-3
([`docs/evidence/prod-run-2026-09-10-trial-cut.json`](docs/evidence/prod-run-2026-09-10-trial-cut.json)).
Keeping it up costs about US$ 10 through the judging window; the free serverless
alternative caps Gate 3 at ~60 matches and weakens the verifier the project argues for.
The human chose zero spend and an honest recording over a weakened Judge. The paid path
stays in the repo and works: [`Dockerfile`](Dockerfile), [`fly.toml`](fly.toml)
(`fly deploy --ha=false` after `fly secrets set OPENAI_API_KEY=…`), then set
`VITE_API_BASE` on Vercel and drop `VITE_DEFAULT_AGENT`.

**The live loop, locally:** `pnpm dev` with `REMATCH_PROVIDER=claude-cli` (no key, no
bill — it drives the installed `claude` binary) is how recordings are made and how the
loop is played for the demo. `pnpm --filter @rematch/web record:run` captures a run into
`public/recorded/`.

## Docs

- **[`docs/SYSTEM.md`](docs/SYSTEM.md)** — the agentic architecture: the contract as a
  boundary, the three agents and what each is denied, the four gates and their real
  thresholds, the **Autonomous Loop Evidence** (a real `gpt-5.4-mini` run, with the
  measured pass rates), determinism, and the honest limitations.
- **[`docs/evidence/eval-round2-2026-09-03.json`](docs/evidence/)** — the event log of
  the **one** run §6 quotes: every rejection and every generated `strategy.js` in it,
  plus the eval's aggregate numbers (`approved: 6, total: 10, passRate: 0.6` — an upper
  bound, measured the day before Gate 3's ACTIVE assertion existed; see
  [`recheck-active-2026-09-08.json`](docs/evidence/) next to it). The other
  nine runs' event logs are *not* committed; the file's own `note` field says so. This
  entry claimed "all ten runs" until 2026-09-08.
- **[`docs/SPEC.md`](docs/SPEC.md)** — the spec the whole thing was measured against,
  unedited, with an **Implementation deltas** section at the end.
- **[`docs/AI-DEV-LOG.md`](docs/AI-DEV-LOG.md)** — how it was built: one orchestrator
  session, parallel package-scoped subagents, what each decided, and what went wrong.

## Show your work — where each judging criterion lives

The rulebook scores the engineering system as much as the product. One link per
criterion, so nobody has to dig through the log to find the evidence.

| Criterion | Where the evidence is |
|---|---|
| Intent + specification | [`docs/SPEC.md`](docs/SPEC.md) — requirements, constraints, architecture, ten acceptance criteria, and an *Implementation deltas* section recording where reality diverged |
| Context engineering | [`SYSTEM.md` §8.3](docs/SYSTEM.md#83-contexts-tools-and-one-worked-parallel-day) — what each role was given and denied; [`CLAUDE.md`](CLAUDE.md) for the standing rules and `.claude/settings.json` for the ones enforced as permission denials; handoff documents (`docs/HANDOFF-*.md`) as the unit of context transfer between sessions |
| Orchestration + parallel work | [`SYSTEM.md` §8](docs/SYSTEM.md#8-build-time-agent-boundaries) — the lane diagram, the two rules that made lanes safe, and a worked day with timings and zero integration conflicts |
| Harness + back pressure | this README's *Deterministic controls* below; `pnpm verify` on pre-commit; the replay-hash assertion in unit and e2e; Playwright screenshots into `artifacts/web/` as the evidence convention |
| Autonomous loops + recovery | product side: [`SYSTEM.md` §6](docs/SYSTEM.md#6-autonomous-loop-evidence), a real run rejected by Gate 3 and approved on retry with no human message. Build side: §8.3's minion loop, with its screenshot |
| Human as orchestrator | [`docs/AI-DEV-LOG.md`](docs/AI-DEV-LOG.md) — every entry attributes decisions to *Human*, *Orchestrator* or *Agent*; the open items at the end are marked *blocked: human decision* where they are |
| Reproducibility | the *Commands* and *Environment* sections above; `?agent=mock` and `?agent=recorded` run the full loop with no key; `pnpm verify` regenerates every number quoted here |

**How the harness fed the agents, not just the humans.** Every implementation subagent
was briefed with the same three commands the pre-commit hook runs, and was told to stop
only when they were green — so a failing unit test or typecheck was observed and fixed
inside the agent's own turn, not reported back for a human to diagnose. The e2e suite
writes one PNG per screen state; the orchestrator reads those images after every visual
change and the log records what they caught that assertions could not (letterboxed hero,
a scanline weight, a minion drawn as mud). The structural "costume" tests exist because
telling an agent "keep cosmetics out of the simulation" is an instruction, and a test
that fails the build is a guarantee.

## Deterministic controls

Three checks spec §7 deliberately does **not** delegate to an agent's memory. Each is a
file in the repo, not a convention: an agent cannot forget them, and reading the
instructions is not what makes them hold.

| # | Control | Where | What it stops |
|---|---|---|---|
| 1 | `pnpm verify` on every commit | [`.githooks/pre-commit`](.githooks/pre-commit) → [`scripts/verify.sh`](scripts/verify.sh) | A commit that does not typecheck, lint, and pass all 997 tests |
| 2 | Determinism lint rule | [`eslint.config.mjs`](eslint.config.mjs) | `Math.random`, `Date.now`, `new Date`, `Date()`, `performance.now` in `packages/engine/src` or `packages/contract/src` — including `Math['random']`, `const { now } = Date`, and `node:perf_hooks` |
| 3 | Contract CHANGELOG gate | [`.github/workflows/verify.yml`](.github/workflows/verify.yml) | A PR that changes `packages/contract/` without a `CHANGELOG.md` entry. The contract is the API the boss agent writes against, so its changes are human-gated |

All three run identically locally and in CI, because the hook and the workflow both call
`scripts/verify.sh` rather than each keeping its own list of steps.

Three details are what make these controls rather than suggestions. **The lint rule cannot
be waved away** — `noInlineConfig` + `reportUnusedDisableDirectives: 'error'` means an
`// eslint-disable-next-line` neither suppresses the error nor passes silently; it fails the
commit twice over. **The escape hatch is a human's** — `git commit --no-verify` is for a WIP
commit, an offline commit, an unfinished rebase; the hook's own message says *"If you are an
agent: do not use --no-verify. Fix the failure."*, and CI runs the same script on every push
anyway. **The CHANGELOG gate has no bypass**, and is its own CI job so its verdict is
readable on a PR without scrolling past a test suite.

Longer version, including why `sandbox` is exempt from control 2, in
[`docs/SYSTEM.md` §7](docs/SYSTEM.md#7-determinism-and-the-deterministic-controls).
