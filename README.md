# REMATCH — the boss that learns

A 2D arena boss fight where, between rounds, an agent studies how you won and rewrites the
boss's strategy to counter you. A second, deterministic verifier refuses to ship that
rewrite until it proves the fight is still fair — and you watch it happen, rejections
included.

**Status: `pnpm verify` green — 749 tests. Deployed URL: pending.**

## 60-second demo

```bash
pnpm install && pnpm dev          # web on :5173, api on :8787 — one Ctrl-C stops both
open 'http://localhost:5173/?agent=mock&autostart=1'
```

No API key needed. `?agent=mock` plays the whole four-beat interlude offline; without a key
the real server answers in fallback-only mode and says so on screen — nothing is fabricated.

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
| **Trial** | gates tick past, a meter fills, verdicts land: `✗ 0.78 vs panel — too hard` … `↻` … `✓ APPROVED` | **harness**, 4 deterministic gates, no LLM. A rejection goes back to the Coder verbatim. Max 4 attempts, then a pre-approved fallback, visibly |

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
| `pnpm test:e2e` | Playwright (chromium, 12 tests); builds and previews first. Screenshots → `artifacts/` |
| `pnpm harness <file.js>` | Run the gates against one strategy (`--gates 1,2`, `--seed`, `--json`). Exit 0 approved / 1 rejected / 2 usage error |
| `pnpm eval:agents` | **Opt-in, spends money.** The loop over 10 canned replays vs spec §7's ≥80% target. Exits 0 with a message if no key is set |
| `pnpm build` | Production web bundle |

## Environment

Everything is optional; with none of it set the game is playable and the server runs in
fallback-only mode.

| Variable | Effect |
|---|---|
| `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` | present → the real rewrite loop runs; absent → fallback-only |
| `REMATCH_MODEL` | model for both agents. Default `claude-sonnet-5` |
| `REMATCH_ANALYST_MODEL` / `REMATCH_CODER_MODEL` | per agent; wins over `REMATCH_MODEL` |
| `REMATCH_DEADLINE_MS` | loop deadline, default `40000` |
| `REMATCH_MATCHES` | Gate 3 matches per attempt, default `200` |
| `REMATCH_WORKERS` | Gate 3 simulation threads, default `availableParallelism() - 1` |
| `REMATCH_ORIGIN` | extra allowed CORS origins, comma-separated |
| `REMATCH_ARTIFACT_DIR` | where event logs go, default `artifacts/server/` |
| `PORT` / `HOST` | default `8787`, `127.0.0.1` |

`.env` at the repo root is read by Node itself (`--env-file-if-exists`) — no `dotenv`
dependency, and a missing `.env` is a log line rather than a crash. Useful URL parameters
(`?seed=`, `?round=`, `?agent=sse`, `?speed=`, `?deadline=`) are in
`packages/web/README.md`.

## Docs

- **[`docs/SYSTEM.md`](docs/SYSTEM.md)** — the agentic architecture: the contract as a
  boundary, the three agents and what each is denied, the four gates and their real
  thresholds, the **Autonomous Loop Evidence**, determinism, and the honest limitations.
- **[`docs/SPEC.md`](docs/SPEC.md)** — the spec the whole thing was measured against,
  unedited, with an **Implementation deltas** section at the end.
- **[`docs/AI-DEV-LOG.md`](docs/AI-DEV-LOG.md)** — how it was built: one orchestrator
  session, parallel package-scoped subagents, what each decided, and what went wrong.

## Deterministic controls

Three checks spec §7 deliberately does **not** delegate to an agent's memory. Each is a
file in the repo, not a convention: an agent cannot forget them, and reading the
instructions is not what makes them hold.

| # | Control | Where | What it stops |
|---|---|---|---|
| 1 | `pnpm verify` on every commit | [`.githooks/pre-commit`](.githooks/pre-commit) → [`scripts/verify.sh`](scripts/verify.sh) | A commit that does not typecheck, lint, and pass all 749 tests |
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
