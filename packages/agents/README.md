# `@rematch/agents`

The two agents and the loop that puts them under the harness's back pressure.

The **Analyst** watches the round the player just won and writes down how they won it.
The **Coder** writes the boss's next `strategy.js` to counter that specific player. The
**harness** — deterministic, no LLM — decides whether it ships, and its rejection sentence
is the only feedback the Coder gets. Four attempts, no human message anywhere (spec §6.3).

```ts
import { anthropicProvider, modelFor, rewrite } from '@rematch/agents';

const result = await rewrite(
  {
    summary,                    // summarizeReplay() of the round just won
    round: 2,
    prevSource,                 // the strategy.js that lost
    providers: {
      analyst: anthropicProvider({ model: modelFor('analyst') }),
      coder: anthropicProvider({ model: modelFor('coder') }),
    },
  },
  (event) => sse.send(event),   // the four interlude beats, as they happen
);
if (!result.approved) shipFallback(result.reason);   // 'max-attempts' | 'deadline' | 'error'
```

`rewrite` never throws for a loop failure. An exhausted attempt budget, a blown deadline
and an unexpected error all resolve as `{ approved: false, reason }` after a `fallback`
event, because the caller's job in every one of those cases is the same: ship a
pre-approved strategy and say so on screen (spec AC 5).

## Context engineering (spec §8)

| Agent | Gets | Denied |
|---|---|---|
| **Analyst** | the `ReplaySummary` rendered as text — heat map as an 8×8 digit grid, dash rose, shots-during table, duration, top-30 timeline — plus the round number and the previous strategy's `meta` | engine source, **any code at all**, the contract |
| **Coder** | the Boss Contract doc, the Analyst's JSON, the previous `strategy.js`, the round + its fairness band + both Gate 3 assertions, how the harness judges it with example rejections, and on a retry the `GateResult.reason` verbatim | engine source, renderer, server |

Both denials are **tested**, not intended: `test/context.test.ts` reads
`@rematch/engine`'s barrel file, extracts every name it exports, and asserts that none of
them appears in either assembled prompt. Add an engine export and the test starts checking
for it without anyone remembering to.

The Analyst denial is the interesting one. It never sees a line of code — not even the
strategy that just lost — because its job is to describe a *player*, and handing it code
invites it to write code. Splitting the two contexts is why the Coder's prompt can be
mostly contract: someone else already did the reading.

The Boss Contract doc is assembled at module load from `packages/contract/README.md` and
`packages/contract/src/types.ts` (`contractDoc()`). `contract` has zero workspace
dependencies and contains no engine internals by construction, so a doc built only from
those two files cannot leak an internal even by accident.

### Prompt sizes

| Prompt | Chars |
|---|---|
| Analyst — system | ~1.5 k |
| Analyst — user (rendered replay) | ~2.5–3 k |
| Coder — system (contract doc + harness rules + output rules; **byte-identical across every attempt**) | ~11.3 k |
| Coder — user, first attempt | ~2.5–3 k |
| Coder — user, retry (adds the rejection block) | +~230 |

The Coder's system prompt is stable across attempts on purpose: it is sent with
`cache_control: { type: 'ephemeral' }`, so attempts 2–4 read it from cache instead of
paying for 11 k characters again.

## The loop (spec §6.3)

```
Coder emits strategy.js
  → Gate 1 static      fail → reason → Coder      ("line 9: forbidden identifier 'Date'")
  → Gate 2 fuzz        fail → reason → Coder      ("returned an invalid action on 3.0% of states")
  → Gate 3 balance     fail → reason → Coder      ("0.91 vs panel — too hard; 0.41 vs Mimic — didn't adapt")
  → Gate 4 perf        fail → reason → Coder      ("decide() p99 = 6.2ms > 2ms")
  → APPROVED → ship
Max 4 attempts (default), 40 s deadline. Then the fallback pool.
```

Four properties are load-bearing:

1. **The rejection reason travels verbatim.** Nothing rewords, summarizes or classifies
   `GateResult.reason` on its way into the next prompt. The loop test asserts the exact
   sentence appears in the next Coder prompt.
2. **Gates are emitted one at a time.** `runGates` returns everything at once and has no
   per-gate hook, so the loop drives it one gate per call in `ALL_GATES` order and stops at
   the first failure itself — identical semantics, but `✓ Gate 1` reaches the screen while
   Gate 3 is still simulating.
3. **Gate 3 always gets `mimicSummary`.** Without it, Gate 3 silently skips ADAPTED and the
   loop would approve a boss that never learned anything — the exact failure the product
   exists to rule out.
4. **The deadline is real but not violent.** Checked before every attempt and after every
   gate, and it aborts an in-flight provider stream. It does *not* interrupt a running
   gate: a half-simulated Gate 3 has no verdict, and a verdict is the only thing worth
   having. Hence 40 s inside AC 5's 45 s.

The rejected file becomes the next attempt's baseline, not the round's opening strategy: an
attempt that missed the band by 0.06 is a far better starting point, and the diff the player
sees stays a diff of what actually changed.

### The Coder's static self-retry

`staticCheck` runs in `runCoder`, before the harness. A mention of `Date` is a typo-class
failure and shouldn't cost one of four harness attempts, so the Coder gets one immediate
self-retry with the violations — logged as `coder.calls: 2` and `coder.selfRetry`, so the
evidence stays honest about how many model calls were made.

It is a courtesy, **not a veto**. If the second file is still invalid the Coder submits it
anyway (`staticInvalid: true`) and lets Gate 1 reject it for real. Refusing to submit would
replace a legible on-screen rejection with an internal error and a silent fallback — and
the harness, not the Coder, is the authority on what ships.

## Events

`rewrite(input, emit)` emits these, in beat order. The server turns each into one SSE frame;
all of them are JSON-serializable.

| Event | Payload | Beat |
|---|---|---|
| `replay` | `summary`, `round` | 1 |
| `analysis.delta` | `delta` | 2 |
| `analysis.done` | `analysis`, `calls`, `promptChars`, `usage`, `ms` | 2 |
| `rewrite.delta` | `attempt`, `delta` | 3 |
| `rewrite.done` | `attempt`, `source`, `diff` (unified) | 3 |
| `trial.progress` | `attempt`, `matchesDone`, `matchesTotal`, `gate` | 4 |
| `trial.gate` | `attempt`, `gate: GateResult` | 4 |
| `verdict` | `attempt`, `approved`, `reason?` | 4 |
| `fallback` | `reason: 'max-attempts' \| 'deadline' \| 'error'`, `message?` | — |
| `done` | `result: RewriteResult` | — |

`trial.progress` fires exactly **twice** per attempt that reaches Gate 3 — `matchesDone: 0`
when the matches start, `matchesDone === matchesTotal` when they finish. `simulate()` has no
per-match progress hook, so there is nothing finer to report; it is enough for the meter to
animate over a known duration rather than tick per match.

## Providers

`LLMProvider` is the only LLM boundary in the package. Two implementations:

- `anthropicProvider()` — the official `@anthropic-ai/sdk`, streaming, reads
  `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`). It is constructed lazily and fails at
  *call* time with a message naming the fallback pool, so the server can decide before the
  player finishes round 1 whether the loop can run at all.
- `mockProvider(script)` — scripted responses, deltas in chunks, `stall: true` for the
  deadline test. Every test in this package runs on it: **no test makes a network call.**

### Models

Sonnet-class by default, and this is the one place in the repo where that is the right
call. The interlude has 45 s (AC 5) to cover an Analyst call, up to four Coder calls, and
four gates including 200 simulated matches. Latency is the binding constraint, not depth —
the Coder writes ~80 lines against a frozen contract with a deterministic verifier behind
it, so a weaker answer costs one more cheap attempt rather than a wrong result.

| Variable | Effect |
|---|---|
| `REMATCH_MODEL` | sets both agents |
| `REMATCH_ANALYST_MODEL` | Analyst only; wins over `REMATCH_MODEL` |
| `REMATCH_CODER_MODEL` | Coder only; wins over `REMATCH_MODEL` |

Default: `claude-sonnet-5`. Raise the Coder to `claude-opus-5` when you want to trade
seconds for quality (`REMATCH_CODER_MODEL=claude-opus-5`).

## The canned replays

`canned/*.json` — ten real rounds, regenerate with:

```
pnpm --filter @rematch/agents gen-canned
```

Each is a reference bot playing as the *human* against a reference strategy, through the
real engine and the real QuickJS sandbox, compressed with `summarizeReplay`. Fixed seeds, so
they only change when the engine's rules change — and then they should. Every one is a round
the **player won**, because that is the only round that reaches the interlude, which is why
each archetype is paired with a strategy it can actually beat.

## Tests

```
pnpm --filter @rematch/agents test      # 88 tests, ~5 s, no network
```

| File | Covers |
|---|---|
| `provider.test.ts` | mock scripting, chunked deltas, abort, model resolution, the SDK call shape via an injected client |
| `context.test.ts` | the two denial tests, prompt sizes, the cacheable system prompt, verbatim rejection placement, every renderer |
| `analyst.test.ts` | balanced-brace JSON extraction, fenced/prefixed/suffixed replies, shape errors with actionable messages, the one retry |
| `coder.test.ts` | code-block extraction and preference order, the `staticCheck` self-retry, submit-anyway |
| `loop.test.ts` | **the loop**: Gate 1 rejection → Gate 3 rejection → approved on attempt 3, with real gates; the rejection reaching the next prompt verbatim; deadline and abort paths |
| `canned.test.ts` | the ten replays are real, are player wins, and still describe distinguishable players |
| `eval.test.ts` | the eval's aggregation, table and artifact, on mock providers |

## The eval (spec §7, AC 6)

```
pnpm eval:agents            # opt-in: exits 0 with a message if no API key is set
```

Runs the loop on all ten canned replays for round 2, prints a table (approved, attempts,
gates rejected, wall time, tokens, model calls) and the pass rate against spec §7's 80%
target, and writes every event of every run to
`artifacts/agents/eval-<timestamp>.json` — the raw material for AC 6 and SYSTEM.md's
Autonomous Loop Evidence.

| Variable | Effect |
|---|---|
| `REMATCH_EVAL_MATCHES` | Gate 3 matches per attempt (default 200, spec §6.2) |
| `REMATCH_EVAL_ONLY` | comma-separated canned replay names |
| `REMATCH_EVAL_DEADLINE_MS` | per-run deadline (default 40 000) |

It is the only thing in the repo that spends money, so it never runs in `pnpm verify`.
Everything it measures — including its own aggregation — is covered against the mock
provider by the test suite.
