# howdy-hackathon

Ver [spec.md](spec.md).

## Workspace

pnpm workspaces, Node >= 22 (developed on 25), TypeScript strict ESM. No build step:
packages resolve to TypeScript source.

| Package | Status | Responsibility |
|---|---|---|
| `@rematch/contract` | **implemented** | Boss Contract types, action validator, Gate 1 static check. Zero workspace deps. |
| `@rematch/sandbox` | **implemented** | QuickJS containment for generated strategies: no host bindings, seeded `rand`, 2 ms deadline, 64 MB heap |
| `@rematch/engine` | in progress | Deterministic 60 Hz simulation, seeded PRNG |
| `@rematch/harness` | **implemented** | The four gates + CLI. Gate 1 static, Gate 2 fuzz, Gate 3 balance (worker-parallel sim vs bot panel + Mimic), Gate 4 perf |
| `@rematch/agents` | **implemented** | Analyst + Coder prompts, context assembly, and the autonomous rewrite loop: four attempts under the harness's back pressure, no human message anywhere (§6.3) |
| `@rematch/server` | **implemented** | `POST /api/rewrite` over SSE, `/api/health`, `/api/fallback/:round`, the pre-approved fallback pool, deadline + rate limit + CORS |
| `@rematch/web` | placeholder | Vite + Canvas renderer + interlude UI |

Dependency direction differs from spec §5.1 on one point, deliberately: `contract` has
**no** workspace dependencies (it is types + validator + static check only) and `engine`
depends on `contract`, not the reverse. The spec's table would make the two circular. The
reference bots §5.1 places in `contract` will live in `harness`; the reference *strategies*
live in `packages/contract/test/fixtures/strategies/good/`.

`@rematch/sandbox` is not in the spec's package table either: §4.4 places the QuickJS sandbox
inside the engine. It is its own package because three consumers need it (`engine` for the
live fight, `harness` for Gates 2-4, and the balance simulator) and none of them should own
it — and because it is the project's security boundary, which is easier to review, test and
keep dependency-free on its own.

### Commands

| Command | What it does |
|---|---|
| `pnpm install` | Install the workspace |
| `pnpm dev` | The game (Vite, 5173) and the API server (8787) together; one Ctrl-C stops both |
| `pnpm dev:web` / `pnpm dev:server` | One half of `pnpm dev` on its own |
| `pnpm typecheck` | `tsc` every package |
| `pnpm lint` | The determinism lint rule — see [Deterministic controls](#deterministic-controls). Nothing else; no style rules |
| `pnpm test` | Every package's tests |
| `pnpm test:contract` | Contract validator + static-check suites |
| `pnpm test:sandbox` | Sandbox containment, determinism and leak suites |
| `pnpm harness <file.js>` | Run the gates against one strategy file (`--gates 1,2`, `--json`) |
| `pnpm test:engine` / `test:harness` / `test:balance` | Per-layer suites (§7) |
| `pnpm verify` | `typecheck` + `lint` + all tests — the gate-all from §7. Runs on every commit and in CI |

## Deterministic controls

Three checks that spec §7 deliberately does **not** delegate to an agent's memory. Each
one is a file in the repo, not a convention: an agent cannot forget them, and reading the
instructions is not what makes them hold.

| # | Control | Where it lives | What it stops |
|---|---|---|---|
| 1 | **`pnpm verify` on every commit** | [`.githooks/pre-commit`](.githooks/pre-commit) → [`scripts/verify.sh`](scripts/verify.sh) | A commit that does not typecheck, lint, and pass all ~700 tests |
| 2 | **Determinism lint rule** | [`eslint.config.mjs`](eslint.config.mjs) | `Math.random`, `Date.now`, `new Date`, `performance.now` in `packages/engine/src` or `packages/contract/src` |
| 3 | **Contract CHANGELOG gate** | [`.github/workflows/verify.yml`](.github/workflows/verify.yml) | A PR that changes `packages/contract/` without a `CHANGELOG.md` entry |

All three run the same way locally and in CI, because the hook and the workflow both
call `scripts/verify.sh` rather than each maintaining its own list of steps.

### 1. The pre-commit hook

`pnpm install` runs the root `prepare` script, which does `git config core.hooksPath
.githooks`. That is the whole installation — the hook is a committed, reviewable shell
script, with no husky dependency and no generated files to drift out of date.

It runs `scripts/verify.sh` against the working tree: `typecheck`, then `lint`, then every
package's tests, stopping at the first failure and re-printing the last 40 lines of it
(under `git commit` the useful output otherwise scrolls away). ~45 s when green.

It deliberately skips itself in two cases where a failure would be someone else's: when
nothing is staged, and mid-`merge` / `rebase` / `cherry-pick` / `revert`. CI still covers
both.

**Bypassing it — the human escape hatch:**

```
git commit --no-verify
```

That is for a human with a reason: a WIP commit on a scratch branch, an offline commit, a
rebase you want to finish before fixing anything. It is **not** an agent's hatch — an
agent reaching for `--no-verify` is working around the one control that keeps `main`
green, and a reviewer should read it that way. It also only buys minutes: the `verify`
workflow runs the identical script on every push and PR, and cannot be skipped.

### 2. The determinism lint rule

Spec §7: *"A lint rule forbids `Math.random` and `Date.now` in `engine/`."*

`pnpm lint` is ESLint with a flat config and **no style rules at all** — only these
restrictions, over `packages/engine/src/**` and `packages/contract/src/**`:

| Forbidden | Why |
|---|---|
| `Math.random()` | Unseeded entropy. Use the seeded PRNG in `packages/engine/src/prng.ts` |
| `Date.now()`, `new Date()`, `Date()` | Wall-clock. Replays would diverge run to run |
| `performance.now()` | Still a clock, and it does not exist inside QuickJS |
| `Math['random']`, `const { now } = Date` | The same things spelled to dodge a naive check |
| `import … from 'node:perf_hooks' \| 'node:crypto'` | Node clocks and entropy have no business in a pure simulation |

Scope is those two packages only, because they are the ones that must produce identical
results in the browser and in Node (AC 3). The rest of the workspace legitimately needs
clocks and is not linted — notably `packages/sandbox/src/loadStrategy.ts`, which uses
`performance.now()` as the default clock for the 2 ms `decide()` deadline (§4.4). That is
the host measuring untrusted guest code, never an input to the simulation, and it sits
outside the rule's globs, so the exemption needs no inline disable.

Which matters, because **inline disables do not work here**. The scoped config sets
`noInlineConfig` with `reportUnusedDisableDirectives: 'error'`, so an
`// eslint-disable-next-line no-restricted-properties` does not suppress the error *and*
is itself reported — writing one fails the commit twice over. If an engine file genuinely
needs a clock, that is a design conversation (pass the value in from the caller and keep
the simulation a pure function of `(seed, inputs)`), not a comment.

### 3. The contract CHANGELOG gate

Spec §7: *"CI rejects any PR touching `contract/` without an updated `CHANGELOG` entry in
that package — the contract is the API the boss agent depends on, so its changes are
human-gated."*

A separate `contract-changelog-gate` job on every PR to `main`. It diffs against the merge
base (`git diff --name-only origin/<base>...HEAD`, so commits that landed on `main` after
you branched don't count as yours) and fails if anything under `packages/contract/`
changed while `packages/contract/CHANGELOG.md` did not. Editing only the CHANGELOG does
not trip it.

There is no bypass. Adding the entry *is* the work: a change to `BossView`,
`BossAction`, `validateAction` or the static check changes what every generated strategy
and every pre-approved fallback is allowed to do, and that needs to be written down where
a human will read it.

### CI

[`.github/workflows/verify.yml`](.github/workflows/verify.yml), on push and PR to `main`:

- **`verify + e2e`** — pnpm (pinned by the root `packageManager` field) + Node 25 with a
  pnpm store cache, `pnpm install --frozen-lockfile`, `pnpm verify`, then
  `playwright install --with-deps chromium` and `pnpm test:e2e`. Uploads `artifacts/`
  (screenshots, traces — the §7 browser evidence, and demo material) on pass *or* fail.
- **`contract CHANGELOG gate`** — control 3 above. Its own job, so its verdict is
  readable on the PR without scrolling past a test suite.
