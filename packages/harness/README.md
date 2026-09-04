# `@rematch/harness`

The four deterministic gates that decide whether a generated strategy ships, and the runner
that sequences them. **No LLM is called anywhere in this package** (spec §6): a verdict is a
pure function of the strategy source and a seed, so every rejection replays byte-for-byte —
which is what makes the rejections in the interlude evidence rather than anecdote.

| Gate | Name | Status | Catches |
|---|---|---|---|
| 1 | `static` | **implemented** | forbidden names, imports, wrong module shape — before any code runs |
| 2 | `fuzz` | **implemented** | throws, timeouts, memory growth, invalid actions, ignored cooldowns |
| 3 | `balance` | stub — `not implemented` | too hard / too easy / didn't adapt (spec §6.2) |
| 4 | `perf` | stub — `not implemented` | `decide()` p99 over budget |

```ts
import { runGates } from '@rematch/harness';

const { approved, results, stoppedAt } = await runGates(source);   // gates [1, 2] by default
if (!approved) sendBackToCoder(results.at(-1)!.reason);            // one reason, verbatim
```

## CLI

```
pnpm harness <path/to/strategy.js> [--gates 1,2] [--states 500] [--seed 42] [--json]
```

```
$ pnpm harness packages/contract/test/fixtures/strategies/good/orbiter.js
✓ Gate 1 static 4ms
✓ Gate 2 fuzz 57ms

APPROVED — 2 gates passed

$ pnpm harness packages/harness/test/fixtures/nan-angle.js
✓ Gate 1 static 3ms
✗ Gate 2 fuzz — returned an invalid action on 23.9% of states (134/560, limit 2.0%);
  most common: burst.angle must be a finite number, got NaN (108 states)

REJECTED at gate 2
```

Exit code: `0` approved, `1` rejected, `2` usage or I/O error — so it works as a pre-commit
check and in CI. It runs under plain `node --experimental-strip-types`; no build step.

## The reason string is the product

`GateResult.reason` is the **only** feedback the Coder agent gets for its next attempt, and
it is shown verbatim to the player during the interlude (spec §2.2: *"The player must be able
to read every rejection. Rejections are the proof."*). So every reason is one sentence,
quantitative where a number exists, and names the fix rather than the symptom:

```
✗ decide() threw 'cannot read property 'length' of undefined' on 135/560 states
  (first at state 7: tick 600, 0 projectiles, all cooldowns ready)

✗ asked for a primitive that was still on cooldown on 47.9% of states (268/560, limit 20.0%):
  burst (238 states) — check view.boss.cooldowns[name] === 0 before returning that action

✗ strategy memory grew past the 4096-byte limit (4902 bytes) on 141/560 states
  (first at state 360: tick 3436, 6 projectiles, every primitive on cooldown)
```

Nothing in the system *parses* a reason to make a decision — that is what `gate`, `ok` and
`detail` are for. `detail` carries the machine-readable counts behind the sentence (per
failure kind, per validator reason, per primitive), for the logs and the interlude.

## Gate 1 — static

Wraps `staticCheck` from `@rematch/contract`. Names the first three violations with line
numbers and counts the rest. Costs ~3 ms, which is why it is first: a strategy that mentions
`Date` never boots a QuickJS runtime (spec AC 8, asserted in `test/runGates.test.ts` by
handing Gate 2 a sandbox that throws if it is ever used).

## Gate 2 — fuzz

Loads the strategy in `@rematch/sandbox` and runs it over 500 seeded, diverse `BossView`s
plus 60 *consecutive* ticks, then judges three things.

**Rejects if:**

| Condition | Why that threshold |
|---|---|
| any runner failure (throw / timeout / memory), even 1 in 500 | a boss that throws on 1 state in 500 throws ~6 times a match |
| invalid-action rate > **2%** | the engine coerces an invalid action to `idle` and counts a violation; a couple of edge cases is tolerable, 3% is a bug |
| on-cooldown-action rate > **20%** | legal but wasted — the strategy has not read `view.boss.cooldowns`, and the boss visibly does nothing |

The state corpus (`src/fuzzViews.ts`) puts the **corner cases first**, before any random
state, because the states that break generated strategies are the degenerate ones, not the
average ones: tick 0 with an empty `history`, every cooldown busy (there is no legal primitive
and the strategy must still return something), a heat map that is all zeros or all in one cell
(division by a zero total), hp 0, the player standing exactly on the boss (`atan2(0,0)`, then
normalising a zero vector), 30 projectiles, `lastShotTick === -1`. The rest is drawn from the
harness's own xorshift32, so `(states, seed)` is all anyone needs to reproduce a rejection.

Two passes, deliberately:

- **Scattered states** — total coverage of the `BossView` type. Note it is *not* the engine's
  simulation: the contract is the API the boss agent codes against, so `decide` has to be
  total over the type, and an engine change must not silently narrow the fuzz corpus.
- **60 consecutive ticks** — `makeFuzzSequence` walks a plausible trajectory with cooldowns
  ticking down. Scattered states cannot catch memory that grows once per tick; 60 in a row can.

The 2 ms budget is enforced by the sandbox as a hard deadline, so an infinite loop comes back
as `{kind:'timeout'}` rather than hanging the gate — `test/gates.test.ts` asserts the whole
gate finishes in well under 5 s on `infinite-loop.js`.

## Gates 3 and 4

Stubs that reject with `not implemented`, excluded from `DEFAULT_GATES` — otherwise every
strategy would be "rejected: not implemented". Each file carries the full TODO. Two notes
worth keeping in view:

- **Gate 3 needs workers.** The sandbox costs ~16–43 µs per `decide` depending on how much is
  in the `BossView` (`pnpm --filter @rematch/sandbox bench`), so 200 matches × 3600 ticks is
  12–31 s of sandbox time alone on one thread — before any engine time. The interlude's
  budget is 45 s (spec AC 5).
- **Gate 4 needs no new instrumentation.** Every `DecideResult` from the sandbox carries
  `elapsedMs` (host stringify → VM → parse, i.e. what the engine actually pays), and Gate 2
  already accumulates the distribution — see `detail.elapsedMs` (`samples`, `p50`, `p99`,
  `max`) in `src/gates/gate2Fuzz.ts`. Gate 4's job is to run a real match trajectory and apply
  the threshold.

`@rematch/engine` is declared as a dependency but **deliberately not imported yet** — the
engine is being built in parallel, and importing a placeholder would couple Gate 2's tests to
its progress.

## Fixtures

Known-good strategies are reused from `contract` (`test/fixtures/strategies/good/`) rather
than duplicated. The rejection corpus in `test/fixtures/` is harness-specific: one file per
way a *runtime* gate can reject, each a plausible Coder-agent mistake rather than a synthetic
one.

| Fixture | Rejected at | Because |
|---|---|---|
| `uses-date.js` | Gate 1 | mentions `Date` |
| `nan-angle.js` | Gate 2 | `Math.acos` outside its domain → `angle: NaN` |
| `out-of-bounds.js` | Gate 2 | extrapolates velocity without clamping → slams outside the arena |
| `returns-string.js` | Gate 2 | returns `'burst'` instead of an action object |
| `ignores-cooldowns.js` | Gate 2 | bursts every tick, never reads `cooldowns` |
| `throws-on-corner.js` | Gate 2 | lookup table has no entry for column 0 |
| `infinite-loop.js` | Gate 2 | search loop with a zero step |
| `slow-decide.js` | Gate 2 | ~5 ms of arithmetic per tick |
| `memory-hog.js` | Gate 2 | remembers every position ever seen |

## Tests

```
pnpm test:harness
```

`gates.test.ts` — every fixture is rejected at the expected gate with a reason matching a
regex, every good fixture passes 1–2, and the same seed produces the same verdict *and the
same counts*. `runGates.test.ts` — sequencing, short-circuiting, and the CLI's exit codes.
