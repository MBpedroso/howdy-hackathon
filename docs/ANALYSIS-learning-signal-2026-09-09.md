# How the boss could learn the player better — ranked intervention analysis

Date: 2026-09-09. Analysis only; no code was changed. Every claim below is marked
**verified** (read in the code) or **inferred**. File references are to the tree at
`fix/active-gate-and-clocks` (9f71c6c).

## What the boss learns today, verified

The brief's description checks out against the code, with two precisions worth having:

- **Between rounds.** `summarizeReplay` (`packages/engine/src/game.ts:182`) emits exactly
  the fields the brief lists. The Analyst never sees even those 200 timeline events —
  `renderSummary` trims to **30** (`packages/agents/src/context/renderSummary.ts:24`,
  `TIMELINE_BUDGET`), with shot runs collapsed. So the effective between-round signal is:
  one whole-round 8×8 heat grid, 8 dash bins, one 5-row shots-during table, ~10 scalar
  stats, and ≤30 events. No time axis anywhere except those 30 events. **Verified.**
- **Within a round.** `buildBossView` (`packages/engine/src/view.ts:49`) hands `decide`
  the same trio every non-telegraph tick, plus live kinematics (`player.x/y/vx/vy`,
  `isDashing`, `lastShotTick`, projectiles). The heat is accumulated in
  `step.ts:166-172` and **never decayed** — delta 20 confirmed at the accumulation site.
  **Verified.**
- The only cross-round memory of any kind is the Coder baking constants into the new
  `strategy.js`. `init()` takes a seed and nothing else (`contract` §4.1); `mem` dies
  with the round. The `POST /api/rewrite` body carries `{round, seed, summary,
  prevSource, prevMeta, budgetMs}` (`docs/SYSTEM.md` §2) — the input log never leaves
  the browser, though the client keeps it (`packages/web/src/app.ts:358`). **Verified.**

One doc/code mismatch found, for the §13 table: `SYSTEM.md` §3 says the cumulative
nature of `history` is "which the contract's own comment calls them" — but
`packages/contract/src/types.ts:41` says only *"8x8 grid of player dwell time,
normalized to [0,1]"*. The contract comment is silent on cumulative-vs-rolling; the
only honest statements are in `harnessHints` and delta 20. Minor, but it is the same
class of drift delta 20 itself records.

---

## 1. Ranked intervention points

Ranked by learning gained per unit of cost, with the Sep 14 deadline weighing the
ranking toward hash-safe changes. Cost/risk details are in §2.

### 1. Teach the Coder to keep its own rolling window in `mem` — synthesis (prompt only)

**What changes.** `harnessHints` (`packages/agents/src/context/prompts.ts:243`) already
warns that `playerPosHeat` is cumulative and says "aim there, then keep moving". Extend
it (and/or add ~10 lines to `contractDoc`) with the *constructive* version: maintain a
recent-position summary in `mem` — e.g. a 64-int grid of the last ~600 ticks via a small
ring buffer of cell indices, or just "the player's cell 5s ago vs now" — built from
`view.player.x/y`, which `decide` receives every non-telegraph tick.

**What it lets the boss learn that it can't today.** Where the player is *now trending*,
within the round — the exact signal whose absence froze the Round 2 boss (delta 16/20,
`SYSTEM.md` §9 item 10). A strategy that compares recent vs cumulative heat can detect
"they left their camp" and re-aim, which no field in today's view supports.

**Why worth it.** It is the only intervention that addresses the headline defect
(delta 20) with zero engine change, zero contract change, zero hash break, this week.
Budget check, verified against constants: a 64-int grid + 600-entry ring of cell bytes
serializes far under `CONSTANTS.limits.memoryBytes` (4096), and the arithmetic is
noise next to the 16–43 µs marshalling cost that dominates `decide`
(`docs/AI-DEV-LOG.md`, M1 sandbox benchmark). **Inferred** that the model will
implement it reliably — that is the open question (§5 Q2); Gate 2's fuzz and the sticky
memory cap bound the failure modes either way.

### 2. A second-pass replay observer: richer between-round features, no state change — compression

**What changes.** A pure function that re-runs the deterministic replay (the client
holds `inputLog`, `app.ts:358`; `replay()` supports frames, `game.ts:39`) and computes
features `GameState` never stored, folding them into `ReplaySummary` (or a sidecar the
Analyst prompt renders):

- heat maps per third of the round (or per boss-HP phase) → movement *trend*;
- boss–player distance distribution → preferred engagement range in px;
- telegraph reactions: dashes/moves within N ticks of `bossChargeStart` /
  `bossSlamStart` (both event kinds exist in the timeline, `step.ts:289,297`) →
  "reads tells" vs "dashes on cooldown";
- shot accuracy: `bossHit` events ÷ shots → how much punishment each opening costs.

**What it teaches.** Today the Analyst cannot distinguish a dodger who reacts to tells
from one who panic-dashes, a camper who relocated mid-round from one who never moved,
or a sniper from a sprayer. Every one of those distinctions changes the right counter,
and every one is computable from data the client already has.

**Why worth it.** It is the biggest expansion of the Analyst's evidence available
without touching `GameState`, so **no hash break** — the observer is derived data, the
same trick `recheck-active` used on recorded candidates. Cost is one extra replay in
the browser (≤3600 sandboxed `decide` calls ≈ 60–150 ms, from the M1 benchmark —
**inferred**) plus rendering ~15 more prompt lines.

### 3. Calibrate the Mimic to the player's measured skill — verification

**What changes.** `makeMimic` fixes aim accuracy at 0.72 (`packages/harness/src/bots/mimic.ts:54`)
regardless of who it imitates. The summary already contains what's needed to estimate
the human: shots fired and boss damage taken give a hit rate; damage taken per boss
attack gives dodge quality. Set `accuracy` (and the survival-floor thresholds at
`mimic.ts:99-125`) from those.

**What it teaches — indirectly but centrally.** ADAPTED is the only number in the whole
system that says "the boss learned *you*", and delta 23's measurement showed the Mimic
is a much weaker player than its human (incumbent beats a Mimic of a flawless run
0.710). A calibrated Mimic tightens that number, which improves: the advisory the Coder
aims at, the `fairButBlind` ranking (`loop.ts:314`), the relative route's baseline, and
possibly — later, as a human decision — whether ADAPTED can ever block again.

**Why worth it.** The Mimic is the only *executable* model of the player the system
has, and it is currently the thinnest link: three channels sampled independently, no
skill parameter. Harness-only change, no hash break, no tokens. Risk: it changes Gate 3
verdicts on any run with a `mimicSummary`, so the free recheck scripts must be re-run
and the calibration itself validated (§5 Q3).

### 4. A cross-round dossier for the Analyst — analysis

**What changes.** The client accumulates each round's summary + the analysis it got +
the outcome ("Round 3's counterPlan targeted the bottom-left; the player then won from
the top-right, untouched") and sends a compact trail (~5 lines/round) on
`POST /api/rewrite`. `analystPrompt` (`prompts.ts:113`) gains a PREVIOUS ROUNDS block.

**What it teaches.** The player's *adaptation* — the one thing a per-round snapshot
structurally cannot see, and the limitation `SYSTEM.md` §9 item 8 already names ("a
player who changes tactics in Round 2 is facing a boss tuned for their Round 1 self").
An Analyst that sees "camper → kiter → camper" can say "they alternate; write a
generalist and put the specific counter behind in-round detection" — which composes
with intervention 1.

**Why worth it.** Rounds 3–5 currently learn no more than round 2 does; the session's
history is thrown away between interludes. No hash break; cost is plumbing across
web/server/agents plus a few hundred prompt chars (cheap next to the ~13 KB cached
system prompt, `SYSTEM.md` §4).

### 5. Windowed heat in the engine — the real fix for delta 20 — observation

**What changes.** Add `playerPosHeatRecent` (last ~600 ticks) to `History` and
`BossView.history`, kept as an integer ring buffer (append cell index, decrement the
cell that falls out) so cross-platform determinism holds without float decay. Keep the
cumulative grid for compatibility. Contract rev + CHANGELOG entry (CI-gated,
`SYSTEM.md` §7).

**What it teaches.** Same signal as intervention 1, but *guaranteed* — every strategy
gets it without the model having to implement a ring buffer correctly per rewrite, the
prompt hint shrinks to "recent vs lifetime", and the Mimic/summary can read it too.

**Why worth it — and its cost, said explicitly.** This is the correct long-term fix and
**it breaks the replay hash**: `History` lives in `GameState`, so `hashState` changes,
invalidating `inputlog-round1.json` (`74cd659935e33202`), the determinism e2e, and any
committed hash expectation — a documented, scripted regeneration
(`pnpm --filter @rematch/web gen:inputlog`), but a real cost the brief asks to have
named. Existing strategies ignore the new field, so panel rates and bands should not
move (**inferred**, cheap to verify); the serialized view grows by ≤64 numbers, which
nudges the marshalling that dominates `decide` (§5 Q6). Rank 5 not because it's wrong
but because 1+2 buy most of its value hash-free before Sep 14.

### 6. Ship the most-adapted approved candidate — verification/selection

**What changes.** `chooseCandidate` (`packages/agents/src/loop.ts:652`) ranks approved
candidates only by `|panel − bandMid|`. When K candidates are approved, use the Mimic
rate as a tie-break (e.g. within 0.03 of band-mid distance, prefer higher ADAPTED).

**What it teaches.** Nothing new — but the learning that already happened stops being
discarded at the last step. Today a candidate at panel 0.43 / Mimic 0.31 beats one at
0.45 / Mimic 0.88. The interlude's whole claim is "it countered you", and the selector
doesn't look at the counter-you number. **Verified** that the Mimic rate is already in
`log.gates` `detail` (read by `balanceRates`, `loop.ts:806`) — the data is at hand.

**Why worth it.** ~10 lines plus tests, free, no hash break, and measurable
retroactively on committed artifacts before deciding (§5 Q4). Risk: shipping slightly
off-mid leaves less escalation headroom for the next round — hence tie-break, not
primary key.

### 7. A structured player profile the Coder embeds as constants — synthesis

**What changes.** Alongside the Analyst JSON, hand the Coder a small machine-readable
block (hot cells as `{x, y, share}` already computed by `renderHotCells`
(`renderSummary.ts:64`), dominant dash angle in radians, punish-window primitive) with
the instruction to paste it into the file as a `const PROFILE = {...}`.

**What it teaches.** Precision. Today the Coder re-types coordinates out of prose/JSON;
a model transcribing "cell 57 ≈ x=150, y=750" into code is a NaN or an off-by-a-cell
waiting for Gate 2/FAIR to find. Data the strategy aims with should arrive as data.

**Why worth it.** Prompt-only, near-free; composes with 2 (richer features → richer
profile) and 1 (the profile is the "lifetime" half the mem-window compares against).

---

## 2. Cost and risk per item

| # | Intervention | Breaks replay hash? | Model tokens | 4 KB / 2 ms pressure | FAIR harder? | Code touched |
|---|---|---|---|---|---|---|
| 1 | mem rolling window (prompt) | **No** | ~+300 chars in cached system prompt | Yes, both — bounded well inside limits; Gate 2/4 + sticky memory cap catch failures | Indirectly: better tracking ⇒ more pressure; the K-dial bisection re-tunes it | `prompts.ts` only (+1 harness fixture to prove feasibility) |
| 2 | replay observer features | **No** (derived data, `GameState` untouched) | ~+15 prompt lines | None (runs outside the sandbox tick path) | No | engine (new pure fn), `renderSummary.ts`, web interlude plumbing |
| 3 | Mimic calibration | **No** (state hash untouched; **Gate 3 verdicts change** where a Mimic runs) | None | None | No — FAIR is panel-only; ADAPTED stays advisory | `mimic.ts`, `bots.test.ts`, re-run recheck scripts |
| 4 | cross-round dossier | **No** | ~+5 lines × rounds in Analyst prompt | None | No | web (accumulate + send), server (accept field, 512 KB cap fine), `analystPrompt` |
| 5 | engine windowed heat | **Yes** — `History` ⊂ `GameState`; regen `inputlog-round1.json`, determinism e2e re-records | None | +≤64 numbers per serialized view (marshalling is the dominant `decide` cost — measure, §5 Q6) | Not expected (bots ignore the view) — verify with `pnpm test:balance` | contract (types + CHANGELOG), `state.ts`, `step.ts`, `view.ts`, prompt docs |
| 6 | choose by ADAPTED | **No** | None | None | No (only chooses among already-FAIR candidates) | `loop.ts` + tests |
| 7 | profile-as-constants | **No** | ~+200 chars per Coder message | Negligible (constants in source; 32 KB source cap is the binding one) | No | `prompts.ts` |

Token note: nothing above adds model *calls*; items 1/4/7 grow prompts by well under
5% of the current ~13.5 KB Coder context, and item 1 sits in the cached prefix (one
cold read per session, then cached — `SYSTEM.md` §4).

## 3. The cheapest three

1. **#6 — choose by ADAPTED.** ~10 lines in `loop.ts`, no hash, no tokens, and the
   decision can be validated for free first by re-grading `artifacts/agents/` (same
   pattern as `regrade-live`).
2. **#1 — mem rolling window prompt hint.** Prompt text plus one hand-written fixture
   through the harness CLI to prove the 4 KB/2 ms fit. Attacks the project's own
   top-documented defect this week.
3. **#7 — profile as constants.** Prompt text only; `renderHotCells` already computes
   the numbers.

(#2 is near-free on risk but is real code across three packages; it's the best
next-cheapest, not one of the three.)

## 4. What I would NOT do

- **Fix `timeout = boss win` now.** The deepest distortion in the learning signal —
  passivity is rewarded, so FAIR pushes *against* aggressive adaptation — but changing
  it re-baselines every band, margin, and calibration fixture across two packages days
  before the deadline. The dev log already made this call deliberately
  (`AI-DEV-LOG.md` 2026-09-08, "not fixed... recorded rather than smoothed over").
  Post-deadline item.
- **Re-block ADAPTED or raise `ADAPTED_MIN`.** Delta 23 measured why blocking was
  backwards (unsatisfiable against FAIR for a good player). Fix the Mimic first (#3);
  re-arming the assertion is a later human decision about what the gate promises.
- **An engagement/attack-rate gate.** Already tried and measured: across 58 real
  candidates the attack rate has no gap (0.5–21.3, median 11.4); a floor of 6 rejects
  20/58 (`AI-DEV-LOG.md` 2026-09-08). It's a test over the 11 shipped files, correctly.
- **Raising `STILL_EPSILON`** or similar motion-threshold tuning — tried, changed the
  idle run of zero strategies, reverted (same entry).
- **Prompt tuning as the main lever.** Measured twice: K=3 sampling moved the pass rate
  0.25→0.6 where prompt work didn't, and adjectival dials ("aim low") produced
  near-identical files until they became mechanical (`prompts.ts:421` comment,
  `SYSTEM.md` §6). New learning signal should arrive as *data and dials*, not prose.
- **Trained weights, bandits, RL over rounds.** A 5-round session yields ~4 supervised
  events; and the project's thesis is a deterministic verifier over a model, not a
  learned player model. Anything that needs an eval to tune also spends money.
- **Sending raw input logs to the Analyst.** The denial ("rendered summary only, no
  code") is tested (`packages/agents/test/context.test.ts`) and is the context
  engineering the rubric scores; 3600 ticks of input is token blowup for less signal
  than #2's derived features.
- **Re-running `pnpm eval:agents` to measure any of this.** Spend-gated
  (`REMATCH_ALLOW_SPEND=1`) and stays that way; every measurement proposed below is
  free.

## 5. Open questions, each with a free measurement

1. **How stale is the cumulative heat in real human play, quantified?** The claim rests
   on one playtest anecdote. *Measure:* an engine-only script (same shape as the
   untracked `packages/harness/scripts/wall-hug.ts`) that replays the recorded human
   input logs and prints, per 5 s window, the distance between the cumulative hottest
   cell and the actual player cell. Quantifies the payoff of #1/#5 before any prompt
   changes.
2. **Can a strategy actually afford a rolling window in `mem`?** *Measure:* hand-write
   one fixture using the ring-buffer pattern, run `pnpm harness <file> --round 2
   --matches 200` — Gate 4's p99 and the memory ceiling answer it deterministically.
   (Whether the *model* writes it correctly is spend-gated; the fixture at least bounds
   the mechanics.)
3. **Which Mimic channel is the weak one — aim, dash, or positioning?** *Measure:*
   sweep `accuracy` 0.72→0.95 and toggle the survival floor, re-running
   `measureMimicWinRate` against the incumbent on the recorded summaries
   (`live-base.ts` pattern). Free; tells #3 what to calibrate and by how much.
4. **Would #6 have changed what shipped?** *Measure:* re-grade `artifacts/agents/`
   eval logs — every candidate's source and Gate 3 rates are recorded — and count runs
   where >1 candidate was approved and the Mimic ordering disagrees with band-mid.
5. **Is `inputLog` reliably non-null at interlude time?** `app.ts:107` types it
   `InputLog | null`. #2 depends on it. *Measure:* one Playwright run through a round
   logging `__rematch.inputLog?.length`, plus reading the null paths in `app.ts`.
6. **What does +64 numbers in the view cost `decide`?** Marshalling dominates
   (16–43 µs). *Measure:* the existing sandbox benchmark with a padded view — decides
   whether #5's `history` growth is noise or a Gate-4-relevant cost.
7. **Do the panel bands really not move under #5?** Bots ignore the view, so rates
   should be identical — but "should" is what delta 19 was about. *Measure:*
   `pnpm test:balance` on a branch with the field added and no strategy reading it;
   any diff is a bug in the reasoning above.
