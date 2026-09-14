# REMATCH — instructions for the agents that build it

This file is the repo's copy of the rules the orchestrator session works under. It is
deliberately short: anything that can be a test or a hook is one (see *Deterministic
controls* in `README.md`), and this file only carries what still needs judgment.

## Who does what

- **Human (Matheus)** owns scope, the spec, game-feel calls he has not delegated, and
  every commit. He is informed before any major decision and asked before anything
  irreversible or outward-facing (deploy, spend, force-push).
- **The main session orchestrates.** It specifies, delegates, verifies and decides. It
  does not do token-heavy reading itself: searches, lineage sweeps and doc audits go to
  read-only `Explore` subagents that return conclusions, not file dumps.
- **Implementation goes to `general-purpose` subagents** (Opus). One per workstream, each
  brief carrying: the files it owns, the public surface of what it consumes, acceptance
  criteria, the paid-for lessons from `docs/AI-DEV-LOG.md`, and what it must not run.
  Independent workstreams launch in the same message so they run in parallel.

Never delegated: the shape of the Boss Contract, business rules in the gates, the final
numbers quoted in a PR or a log entry (those run in the main session, visibly), commits,
and the answer to Matheus.

## Project boundaries

- **The simulation is sealed.** Cosmetic code (`render/`, `ui/`, `audio/`) never imports
  into `game/`; the costume tests assert it. The replay hash `74cd659935e33202` is the
  tripwire — if it moves, stop and find out why before anything else.
- **The renderer never lies about hitboxes.** Sprites are clipped to the collision circle;
  telegraph shapes match real damage areas.
- **No raster art on a code path, no image-generation dependency.** Existing PNGs sit
  behind flat placeholders; the game is complete without them. Sound is Tone.js
  synthesis, never sampled files.
- **The Judge is not an AI and must not look like one.** Hard corners, the DETERMINISTIC
  chip, the plain-language rejection sentence always readable (SPEC §2.2).

## Spend

Everything runs locally by default. `pnpm eval:agents` is denied in `.claude/settings.json`
and `REMATCH_ALLOW_SPEND=` is refused by the PreToolUse hook in `.claude/hooks/`; a real-LLM run needs Matheus's go for that specific
run and a budget. Local demos use `?agent=mock` or `?agent=recorded&run=…`.

The *deployed* product does spend — that is the point of it — bounded by the server's own
guard: `REMATCH_MAX_REWRITES_PER_DAY` (default 50, then fallback-only with a visible
banner) and the per-IP rate limiter. The rule above is about agents spending during
development, not about the product working.

## Done means

`pnpm verify` green (the pre-commit hook runs it; `--no-verify` is the human's hatch, not
an agent's), the e2e screenshots in `artifacts/web/` looked at after any visual change,
and a dated entry in `docs/AI-DEV-LOG.md` in the log's voice — decisions attributed to
Human, Orchestrator or Agent. Handoffs between sessions are files under `docs/HANDOFF-*.md`.
