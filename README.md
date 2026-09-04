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
| `@rematch/harness` | **gates 1-2** | The four gates + CLI. Gates 3 (balance) and 4 (perf) are stubs |
| `@rematch/agents` | placeholder | Analyst + Coder prompts, rewrite loop |
| `@rematch/server` | placeholder | HTTP + SSE, fallback pool |
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
| `pnpm typecheck` | `tsc` every package |
| `pnpm test` | Every package's tests |
| `pnpm test:contract` | Contract validator + static-check suites |
| `pnpm test:sandbox` | Sandbox containment, determinism and leak suites |
| `pnpm harness <file.js>` | Run the gates against one strategy file (`--gates 1,2`, `--json`) |
| `pnpm test:engine` / `test:harness` / `test:balance` | Per-layer suites (§7) |
| `pnpm verify` | `typecheck` + all tests — the gate-all from §7 |
