/**
 * Prompt assembly for both agents — the package's context-engineering surface.
 *
 * Spec §8 is a table of what each agent gets and what it is *denied*, and this
 * file is that table made executable:
 *
 * | Agent   | Gets                                                        | Denied                          |
 * |---------|-------------------------------------------------------------|---------------------------------|
 * | Analyst | rendered `ReplaySummary`, round number, previous `meta`      | engine source, **any code**     |
 * | Coder   | Boss Contract doc, Analyst JSON, previous `strategy.js`,     | engine source, renderer, server |
 * |         | round + fairness band + the two assertions, harness rules,   |                                 |
 * |         | and on a retry the rejection reason verbatim                 |                                 |
 *
 * The Analyst denial is the interesting one. It never sees a line of code — not
 * even the strategy that just lost — because its job is to describe a *player*,
 * and handing it code invites it to write code, which is the Coder's job and the
 * Coder's contract. Splitting the two contexts is why the Coder's prompt can be
 * mostly contract: someone else already did the reading.
 *
 * `test/context.test.ts` asserts the denials by grepping the assembled prompts for
 * the engine's export names.
 */
import type { ReplaySummary } from '@rematch/engine';
import type { StrategyMeta } from '@rematch/contract';
import { ACTIVITY, ADAPTED_MIN, DEFAULT_MATCHES, bandFor, formatBand, type BalanceRound } from '@rematch/harness';
import type { GateName } from '@rematch/harness';
import { extractMeta } from '../meta.ts';
import { contractDoc } from './contractDoc.ts';
import { renderSummary } from './renderSummary.ts';

export type Prompt = {
  system: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
};

/** Total characters a prompt sends. Logged per attempt (spec §6.3's "every attempt logged"). */
export function promptSize(prompt: Prompt): number {
  return prompt.system.length + prompt.messages.reduce((n, m) => n + m.content.length, 0);
}

// ---------------------------------------------------------------- the Analyst

export const ARCHETYPES = ['camper', 'kiter', 'rusher', 'dodger', 'mixed'] as const;
export type PlayerArchetype = (typeof ARCHETYPES)[number];

export type Analysis = {
  observations: string[];
  playerArchetype: PlayerArchetype;
  counterPlan: string;
};

const ANALYST_SYSTEM = `You are the Analyst. A player has just beaten a boss in a 2D arena fight, and you
are the part of the boss that watches the tape.

You are given a compressed replay of the round: a position heat map, dash
directions, when the player shot relative to the boss's attacks, and a timeline of
notable events. You are given nothing else. You do not see code and you will not
write any.

Your output is read by a second agent that writes the boss's next strategy, so be
concrete and spatial. "Player camped the bottom-left corner and only attacked
during the slam telegraph" is useful. "Player played well" is not.

Rules:
- Ground every observation in a number from the replay. Cite the cell, the tick,
  the count, the percentage.
- The heat map is 8x8 over an 800x800 arena. Column 0 is x=0 (left), row 0 is y=0
  (top). Translate cells into arena coordinates when you name a place.
- Say what the player did, not what the boss should do — except in counterPlan.
- counterPlan is 2-4 sentences of tactics: where to put pressure, which of the
  boss's five primitives (move, burst, charge, slam, spawn) to lean on, what
  timing window to deny. It is advice, not code.
- If the evidence is thin (a very short round, few dashes), say so rather than
  inventing a pattern.

Reply in two parts, in this order, and in nothing else.

PART 1 — what you saw, as plain prose. 3 to 6 short sentences, one observation
each. No bullets, no headings, no labels, no JSON. This part is shown to the
player as it arrives, a few characters at a time, so it is the only thing you
write that a human reads directly:

    Player camped the bottom-left corner. Attacked only during my slam
    cooldown. Dashed 11 times, always left.

PART 2 — the same reading as data, for the agent that writes the counter. One
fenced JSON block, immediately after the prose, with nothing following it:

\`\`\`json
{
  "observations": ["...", "..."],       // part 1's sentences, 3 to 6 of them
  "playerArchetype": "camper" | "kiter" | "rusher" | "dodger" | "mixed",
  "counterPlan": "..."
}
\`\`\`

The prose comes first and the block comes last. Do not write anything before the
prose, between the two parts, or after the closing fence.`;

export type AnalystContext = {
  summary: ReplaySummary;
  round: number;
  /** `meta` of the strategy that just lost. */
  prevMeta?: StrategyMeta;
};

const ARCHETYPE_HINTS = `Archetype definitions (pick the closest; "mixed" if none fits):
- camper: lives in one or two cells, lets the boss come, shoots from safety
- kiter: keeps distance and keeps moving, orbits, never commits
- rusher: closes distance, trades damage, dashes into the boss
- dodger: reacts to telegraphs, high dash count, attacks only in safe windows`;

export function analystPrompt(ctx: AnalystContext, retryError?: string): Prompt {
  const content = [
    renderSummary(ctx.summary, {
      round: ctx.round,
      ...(ctx.prevMeta === undefined ? {} : { prevMeta: ctx.prevMeta }),
    }),
    '',
    ARCHETYPE_HINTS,
    '',
    `The player won round ${ctx.round}. Round ${ctx.round + 1} is being written now. Analyse this round.`,
  ].join('\n');

  const messages: Prompt['messages'] = [{ role: 'user', content }];
  if (retryError !== undefined) {
    // The failed reply is not echoed back: it was unparseable, so it is noise, and
    // showing a model its own malformed output tends to anchor the retry on it.
    messages.push({
      role: 'user',
      content: `Your previous reply could not be parsed: ${retryError}\n\nReply again in the two parts described in the instructions: the prose sentences first, then the fenced JSON block.`,
    });
  }
  return { system: ANALYST_SYSTEM, messages };
}

// ------------------------------------------------------------------ the Coder

/**
 * How the harness judges the Coder, in the Coder's own terms.
 *
 * This section is worth its ~1.5 KB because it converts the loop's back pressure
 * into something the model can plan against. Without it, a rejection reads as an
 * arbitrary "no"; with it, "0.91 vs panel — too hard" is a number the Coder knows
 * it was aiming at and can move deliberately. The example rejections are real
 * strings produced by the four gates, not paraphrases.
 */
export function harnessRules(round: BalanceRound): string {
  const [lo, hi] = bandFor(round);
  // The per-bot profile a passing boss actually has, derived rather than quoted:
  // the panel rate is the mean of four bots, Camper is beaten by any pressure, so
  // the other three have to sit at whatever leaves the mean in band. Measured on
  // the approved runs in `artifacts/agents/` — a boss with two bots at 1.00 has
  // never passed.
  const rest = Math.max(0, (4 * ((lo + hi) / 2) - 1) / 3).toFixed(2);
  return `# HOW THE HARNESS JUDGES YOU

Your file is not shipped because it looks good. It runs four gates, in order, and
stops at the first failure. No LLM in the harness, no human in the loop: you get
the rejection sentence back and another attempt.

Gate 1 — static. An AST walk before anything executes. Forbidden identifiers,
  imports, wrong module shape, an oversized file.
    ✗ "forbidden-identifier: 'Date' may not be mentioned (line 14)"
    ✗ "export: 'helper' is not one of meta, init, decide"

Gate 2 — contract fuzz. Your \`decide\` is called on ~500 generated states,
  including corner cases (every cooldown ready, every cooldown blocked, the player
  in each corner, 40 shots in flight, tick 0, tick 3599). Every action is validated.
    ✗ "returned an invalid action on 3.0% of states (15/500); the most common
       problem was burst.angle must be a finite number, got NaN (12x)"

Gate 3 — balance. ${DEFAULT_MATCHES} simulated matches on a fixed seed set. Two assertions
that reject, and one goal that does not:
    ADAPTED : boss win rate vs the Mimic  >= ${ADAPTED_MIN.toFixed(2)}   (a goal — it cannot reject you)
              The Mimic is a bot rebuilt from THIS player's replay — their heat
              map, their dash bias, their shot timing. Beating it is what "you
              countered how they played" means. Aim at it; never trade FAIR for it.
    FAIR    : boss win rate vs the scripted panel  in ${formatBand(round)}   (round ${round})
              Four scripted bots that play nothing like this player: Camper,
              Kiter, Rusher, Dodger. The panel rate is the plain mean of their
              four rates, 25 matches each — and each rate is near-binary, because a
              bot either has an answer to your pressure or it has none, so the mean
              moves in steps of 0.25 and a ${(hi - lo).toFixed(2)}-wide band cannot be hit that way.
              Camper stands still and is 1.00 for free; two bots at 1.00 is already
              above the band. You need one bot at an intermediate rate, and the only
              reliable way to get one is a \`rand()\` roll per phase that fires the
              signature punish some of the time and not the rest. A round ${round} boss
              that passes looks like
                  Camper 1.00, Kiter ${rest}, Rusher ${rest}, Dodger ${rest}  ->  ${((lo + hi) / 2).toFixed(2)}
    ACTIVE  : the boss is never motionless for more than 90 ticks (1.5 s)
              \`idle\` is legal, valid and free, and it is still the one action that
              gets files rejected for how they *look*. Use it for at most a single
              tick while a cooldown turns over, never as a resting state: 1.5 s of a
              motionless boss reads to the player as a crashed game. It is measured
              on displacement, so a \`move\` that walks into a wall counts as standing
              still too. Rest by moving — patrol a line, strafe across your holding
              range, pace the ground you are guarding — with straight legs of ~34
              ticks, because a curve makes you unhittable and that fails FAIR.
    ✗ "0.91 vs panel — too hard (band ${formatBand(round)} for round ${round}; Camper 1.00, Kiter 0.96,
       Rusher 0.92, Dodger 0.76); 0.41 vs Mimic — didn't adapt"
    ✗ "boss motionless for 263 consecutive ticks (4.4 s) vs Kiter — never return idle
       as a resting state; patrol, reposition or feint instead (limit 90 ticks)"

Gate 4 — perf. \`decide\` p99 must stay inside its 2 ms budget in the sandbox.
    ✗ "decide() p99 = 6.2ms > 2ms"

What this means for how you write:
- Aim at the middle of the band (${((lo + hi) / 2).toFixed(2)}), not the top: "too hard" costs the
  player the game, and it fails exactly like "too easy". One pressure source at a
  time, a quiet window after every committed attack. A bot at 1.00 never got a turn.
- \`Rusher 1.00\` is the commonest single cause of "too hard": punishing contact
  unconditionally beats it every match. \`Kiter 0.00, Rusher 0.00\` is "too easy".
- On a retry, move magnitude, not architecture. 0.90 wants about half the
  pressure it has, not none — a rewrite is how "too hard" becomes "too easy".
- Counter the *specific* player in the analysis — that is the whole point of the
  rewrite, and what the ADAPTED number reports — but leave the counter answerable.
  Prefer punishing one habit hard over raising pressure everywhere.
- Guard every division and every \`Math.atan2\` input. A single NaN angle in one
  branch is a Gate 2 rejection even if the rest of the file is perfect.
- Keep \`decide\` straight-line, allocate nothing per tick beyond the returned
  object, and keep memory small and JSON-serializable (numbers, short arrays).`;
}

/**
 * What the harness has measured, handed to the Coder as tactics rather than as
 * engine documentation.
 *
 * Every line here is a *result*, not a mechanism: it comes from the win rates the
 * pre-approved pool was measured at (the pre-approved pool in `packages/server/fallback`, each
 * one 200 matches through Gate 3), so it tells the Coder which dial moves the
 * number it is being judged on. None of it describes how the engine works, and the
 * denial test in `test/context.test.ts` holds it to that — a hint that leaked an
 * engine identifier would fail the build.
 *
 * Was kept under 900 characters through 2026-09-04; now under 1800. It sits in the
 * cached system prompt in front of the analysis, and a page of tactics would start
 * to compete with the contract for the model's attention, so the ceiling is a
 * deliberate one, raised deliberately rather than drifted into. The heat-map line
 * grew on 2026-09-04 to say that `playerPosHeat` is *cumulative and never decays* —
 * the sentence the frozen Round 2 boss needed, since it parked on a cell the player
 * had left twenty seconds earlier — and four other lines were tightened to pay for
 * it. It grew again on 2026-09-09 (analysis item 1,
 * `docs/ANALYSIS-learning-signal-2026-09-09.md`) with the *constructive* half of
 * that same warning: a strategy that only knows the cumulative map can name the
 * player's habit but not tell a camper who is still camping from one who left ten
 * seconds ago, because nothing in the contract hands it a recent window — `mem` is
 * the only place a strategy can build one, so the hint now says how. This growth
 * was not paid for by cutting another line, unlike 09-04's: item 1 is ranked #2 of
 * seven interventions specifically because it is prompt-only, and a page of tactics
 * un-earning its keep is a worse failure mode than 400 extra cached bytes.
 *
 * A third bullet was added 2026-09-09 (later), from a playtest rather than the
 * analysis: `ADAPT_DIALS`'s `place` dial told the Coder to slam the hottest cell
 * "whether or not the player is standing in it right now", and a slam that lands
 * on ground the player could never reach in time is not pressure, it is a boss
 * that reads as broken (Matt: dashing straight at the telegraphed spot, he still
 * only closed half the distance). The bullet states the reachability arithmetic as
 * a measured fact of the engine — telegraph length, best-case travel, blast radius
 * — once, so both `place`'s instruction and the mem-window bullet's "lead it" can
 * point at it instead of restating the numbers.
 */
export function harnessHints(round: BalanceRound): string {
  const [lo, hi] = bandFor(round);
  return `# WHAT THE HARNESS HAS LEARNED ABOUT THIS ENGINE

Measured on strategies that passed Gate 3:

- \`spawn\` cadence is the strongest single lever on the panel rate: minions decide
  fights against a player who keeps distance or dodges everything.
- Contact is only punished by \`burst\` \`count: 8\` (the full ring) or a \`slam\` on
  the boss's own feet; a cone at contact is a free dodge.
- Long cone bursts beat a kiter; \`charge\` alone does not — closing the gap and
  winning once you are there are two problems.
- Roll the injected \`rand()\` per phase ("press, or reset") to tune continuously;
  fixed duty cycles give 0.00 or 1.00 per bot.
- \`history.playerPosHeat\` is where the player *lives*: cumulative over the round
  and never decaying, so its hottest cell may be one they left 20 s ago. Aim there,
  then keep moving — never park on it.
- A \`slam\` telegraphs for 40 ticks (~0.67s) and then hits once, at one point: even
  sprinting with a dash, a player covers at most ~220px in that time, so aiming past
  ~330px away (that travel plus the slam's own ~110px reach) is a guaranteed miss —
  slam where they can BE when it resolves, not just where they have been; \`spawn\` or
  \`burst\` to punish ground they have already left.
- \`view.player.x/y\` is live, every non-telegraph tick: keep your own recent picture
  in \`mem\` instead of trusting the lifetime map alone. Push the player's cell index
  every ~10 ticks into a ring of ~60 entries and aim slams and bursts at the ring's
  centroid — led by \`vx\`/\`vy\` across a slam's telegraph, same reason as above — not
  the lifetime peak; the lifetime map is the habit, the ring is whether they're still
  in it.
- Round ${round}'s band is ${formatBand(round)}; aim at its middle, ${((lo + hi) / 2).toFixed(2)}.`;
}

/**
 * `Camper 1.00   idle 12t` per line, with every rate that is a failure marked.
 *
 * The idle column is here because ACTIVE's rejection sentence can only name the
 * single worst run, and a boss that froze against one bot has usually frozen
 * against two — which branch is at fault is far easier to see from the spread than
 * from one number. It is omitted entirely when no rate carries one, so a Gate 3
 * `detail` from an older run still renders.
 */
export function renderBotRates(rates: BotRates): string {
  const rows: Array<{ name: string; winRate: number; maxIdleRun?: number; mimic: boolean }> = [
    ...rates.perBot.map((b) => ({ ...b, mimic: false })),
  ];
  if (rates.mimic !== undefined) rows.push({ name: 'Mimic', winRate: rates.mimic, mimic: true });
  const width = Math.max(...rows.map((r) => r.name.length), 6);
  const anyIdle = rows.some((r) => r.maxIdleRun !== undefined);
  return rows
    .map((row) => {
      const rate = row.winRate.toFixed(2);
      const note = row.mimic
        ? row.winRate < ADAPTED_MIN
          ? `  <- short of the ${ADAPTED_MIN.toFixed(2)} goal (did not reject you)`
          : ''
        : row.winRate >= 1
          ? '  <- unwinnable for that bot; this is what makes you too hard'
          : row.winRate <= 0
            ? '  <- that bot wins every match; this is what makes you too easy'
            : '';
      const idle =
        !anyIdle || row.maxIdleRun === undefined
          ? anyIdle
            ? '        '
            : ''
          : `  idle ${String(row.maxIdleRun).padStart(4)}t${
              row.maxIdleRun > ACTIVITY.maxIdleRunTicks ? ` <- over the ${ACTIVITY.maxIdleRunTicks}-tick ACTIVE limit` : ''
            }`;
      return `    ${row.name.padEnd(width)}  ${rate}${idle}${note}`;
    })
    .join('\n');
}

/**
 * How far to move, in the units the Coder controls.
 *
 * The rejection sentence says *that* the boss is at 0.88 and *that* the band tops
 * out at 0.50. It does not say that 0.88 is not a tweak away from 0.42, and the
 * measured failure mode of a retry is a boss that changes nothing that matters:
 * 0.99 -> 0.93 -> 0.96 -> 0.87, four attempts spent inside the same design. This
 * line converts the miss into a size of change, and it is arithmetic on the
 * harness's own numbers rather than advice.
 *
 * Returns `undefined` when the panel is already in band — in that case the boss
 * must change what the *Mimic* sees and nothing else, which is the opposite
 * instruction and the other way a retry is wasted.
 */
export function correctionHint(rates: BotRates, round: BalanceRound): string | undefined {
  if (rates.perBot.length === 0) return undefined;
  const [lo, hi] = bandFor(round);
  const mid = (lo + hi) / 2;
  const panel = rates.perBot.reduce((sum, b) => sum + b.winRate, 0) / rates.perBot.length;

  if (panel > hi) {
    const cut = Math.round(((panel - mid) / Math.max(panel, 0.01)) * 100);
    const unwinnable = rates.perBot.filter((b) => b.winRate >= 0.95).length;
    return [
      `You are at ${panel.toFixed(2)} and the target is ${mid.toFixed(2)}. That is not a tuning change:`,
      `remove roughly ${cut}% of your total pressure — halve how often the main attack`,
      `fires, or double the quiet window after it${
        unwinnable > 0 ? `. ${unwinnable} of the four bots cannot win a single match against you` : ''
      }.`,
      'A change smaller than that comes back with nearly the same number.',
    ].join('\n');
  }
  if (panel < lo) {
    const add = Math.round(((mid - panel) / Math.max(mid, 0.01)) * 100);
    return [
      `You are at ${panel.toFixed(2)} and the target is ${mid.toFixed(2)}. Add roughly ${add}% more`,
      'pressure — but put it back on the habit the analysis names, not everywhere.',
    ].join('\n');
  }
  if (rates.mimic !== undefined && rates.mimic < ADAPTED_MIN) {
    // Reachable only alongside another failure now that ADAPTED advises rather than
    // rejects: an in-band, active boss that merely misses the Mimic goal ships. Kept
    // because ACTIVE can still be the rejection while the Mimic rate is also low,
    // and then this is exactly the right instruction.
    return [
      `Your panel rate (${panel.toFixed(2)}) is already inside the band: change NOTHING that the`,
      'panel bots see. Sharpen the one counter to the habit in the analysis and leave',
      'every other dial exactly where it is — the Mimic rate is a goal, not the reason',
      'you were rejected.',
    ].join('\n');
  }
  return undefined;
}

// ---------------------------------------------------- K candidates per attempt

/**
 * One of the K aim points an attempt is fired at simultaneously.
 *
 * The measured failure of the one-candidate loop was oscillation: the Coder was
 * handed a single point ("0.78 — too hard"), over-corrected, came back at 0.22,
 * over-corrected again, and spent all four attempts outside a band 0.15 wide
 * (`artifacts/agents/eval-*.json`, round 2, pass rate 0.2-0.3). Firing K files at
 * once from the *same* context, separated only by this one line, replaces that
 * point with an interval — and an interval that brackets the band is an
 * interpolation problem rather than a guess.
 *
 * The dial is the whole difference between the K prompts, and it lives in the
 * message rather than the system prompt so the ~13 KB cached prefix stays
 * byte-identical across every candidate of every attempt.
 */
export type CoderDial = {
  /** `conservative` / `balanced` / `aggressive`. Labels the candidate everywhere. */
  name: string;
  /** The one line that separates this candidate's prompt from its siblings'. */
  instruction: string;
  /** Which edge of the round's band this candidate is told to hit. */
  aim: 'low' | 'mid' | 'high' | 'adapt';
  /**
   * On a retry that bracketed the band: where this candidate sits between the two
   * measured files, 0 = the too-easy one, 1 = the too-hard one.
   *
   * This replaces the mechanical instruction entirely, and it is the difference
   * between a search and a loop. Measured over ten replays, the fixed dials
   * bracketed the band on the first attempt almost every time (0.03 too easy,
   * 0.81 too hard) and then *repeated themselves* on attempts 2 and 3 — because a
   * candidate still being told "ONE pressure source, no spawns" has no way to move.
   * Once two files straddle the band the question is no longer "how much pressure"
   * but "where between these two", which is arithmetic the model can do.
   */
  blend?: number;
  /** `meta.name` must end with this, so K bosses cannot collide on one name. */
  nameSuffix: string;
  /** How many candidates this attempt is running. */
  of: number;
};

/** The two measured files an attempt sits between. */
export type CoderBracket = {
  /** Below the band: the highest panel rate that was still too easy. */
  low: { label: string; panel: number; source: string };
  /** Above it: the lowest panel rate that was still too hard. */
  high: { label: string; panel: number; source: string };
};

/**
 * The aim points, low edge to high edge. Cycled if K exceeds their number.
 *
 * The instructions are *mechanical*, not adjectival, and that is the load-bearing
 * part. A first pass said only "aim low / aim middle / aim high" and the three
 * files came back at 0.71, 0.72 and 0.95 — the model cannot feel a win rate, so
 * three qualitative nudges produced two identical strategies and one outlier.
 * Naming the knobs (how many pressure sources, whether it spawns at all, how wide
 * the burst is, how long the quiet window is) is what makes the three files
 * actually different, and three genuinely different files are what turn a
 * rejection into an interval.
 */
export const DIALS: readonly { name: string; instruction: string; aim: CoderDial['aim'] }[] = [
  {
    name: 'conservative',
    aim: 'low',
    instruction: [
      'ONE pressure source and no more. Do not `spawn` at all. `burst` only at long',
      'range and only with `count: 3`. Never punish contact — when the player is close,',
      'reposition instead. Leave at least 120 quiet ticks after every committed attack.',
    ].join('\n'),
  },
  {
    name: 'balanced',
    aim: 'mid',
    instruction: [
      'TWO pressure sources. `spawn` on a slow cadence (no more often than every ~400',
      'ticks). Put the signature punish behind a `rand() < 0.5` roll so it answers about',
      'half of the approaches, and leave a quiet window after every committed attack.',
    ].join('\n'),
  },
  {
    name: 'aggressive',
    aim: 'high',
    instruction: [
      'THREE pressure sources. `spawn` whenever the cooldown allows. Punish the habit the',
      'analysis names every time it appears, with the full ring (`count: 8`) at contact —',
      'but leave exactly one approach open that still beats you, or FAIR fails.',
    ].join('\n'),
  },
];

/**
 * The aim points for an attempt whose panel rate is already inside the band.
 *
 * This is the third mode the search needs, and leaving it out was worth several
 * runs: a boss measured at 0.44 vs the panel and 0.00 vs the Mimic is *fair* and
 * has learned nothing, and telling it to move its pressure — up, down, or 40% of
 * the way towards something — breaks the half that already works. The three
 * candidates therefore hold every rate constant and differ in *where the pressure
 * is aimed*: the place, the ground, and the timing.
 *
 * Since ADAPTED stopped rejecting (2026-09-08) the file that reaches this mode was
 * refused by ACTIVE rather than by the Mimic rate, and the instruction is right for
 * that too: a frozen boss that is otherwise in band needs its pressure moved
 * somewhere, not scaled.
 *
 * `place`'s instruction was rewritten 2026-09-09 (later) after a playtest: "commit
 * it there whether or not the player is standing in it" told the Coder to slam the
 * habit cell unconditionally, and a slam telegraphs for 40 ticks and hits once, at
 * one point — a player who was never going to be within reach when it lands cannot
 * be threatened by it, so an unconditional habit-slam reads as the boss missing on
 * purpose (Matt's report: dashing straight at it, he still only closed half the
 * distance). See `harnessHints`' reachability bullet for the arithmetic; `place`
 * now spends the slam only when the player can still be caught, and leads the live
 * player otherwise. `ground` is untouched on purpose: a minion does not need the
 * player to already be near it, so denying the habit ground by occupying it has no
 * reachability problem to fix.
 */
export const ADAPT_DIALS: readonly { name: string; instruction: string }[] = [
  {
    name: 'place',
    instruction: [
      'Change only WHERE. A `slam` telegraphs for 40 ticks and then hits once, at one',
      'point — see the reachability numbers in WHAT THE HARNESS HAS LEARNED. If the',
      'player is already in (or close enough to reach) the hottest cell of',
      '`history.playerPosHeat`, commit the slam there. Otherwise the habit cell is out',
      'of reach this tick: lead the live player instead — aim at',
      '`player.x + player.vx * 40` and `player.y + player.vy * 40` — and use',
      '`spawn`/`burst` to make the habit cell itself costly, rather than slamming',
      'ground nobody can be standing on.',
    ].join('\n'),
  },
  {
    name: 'ground',
    instruction: [
      'Change only WHO holds the space. Unlike a `slam`, a minion does not need the',
      'player to already be near it when it appears: `spawn` toward the hottest cell of',
      '`history.playerPosHeat` and keep the minion between the player and it, so',
      'returning to their favourite ground costs them something every time.',
    ].join('\n'),
  },
  {
    name: 'timing',
    instruction: [
      'Change only WHEN. Read `history.playerDashDirs` for the direction this player',
      'escapes in and fire the `burst` one dash-length ahead of them in that',
      'direction, and open the window they use to shoot instead of the one they dodge.',
    ].join('\n'),
  },
];

const NAME_SUFFIXES = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'] as const;

/**
 * K counters to the Mimic, for a boss that is already fair.
 *
 * Same shape as `blendDials`: same names across attempts so the comparison table
 * stays readable, same suffix rule so the files do not collide.
 */
export function adaptDials(total: number): CoderDial[] {
  return Array.from({ length: total }, (_, i) => {
    const dial = ADAPT_DIALS[i % ADAPT_DIALS.length] as { name: string; instruction: string };
    return {
      name: dial.name,
      instruction: dial.instruction,
      aim: 'adapt' as const,
      nameSuffix: NAME_SUFFIXES[i % NAME_SUFFIXES.length] ?? String(i + 1),
      of: total,
    };
  });
}

/**
 * The dial for candidate `index` of `total`.
 *
 * `undefined` when `total <= 1`: one candidate is the legacy loop, and it must
 * send the byte-identical prompt it always sent so `REMATCH_CANDIDATES=1` really
 * is the old behaviour and not a near-miss of it.
 */
export function dialFor(index: number, total: number): CoderDial | undefined {
  if (total <= 1) return undefined;
  const dial = DIALS[index % DIALS.length];
  if (dial === undefined) return undefined;
  return {
    name: dial.name,
    instruction: dial.instruction,
    aim: dial.aim,
    nameSuffix: NAME_SUFFIXES[index % NAME_SUFFIXES.length] ?? String(index + 1),
    of: total,
  };
}

/**
 * The K aim points for a retry that has two measured files straddling the band.
 *
 * The linear estimate `f* = (mid - low) / (high - low)` says where the middle of the
 * band should sit between them. The model does not hit a requested win rate
 * exactly, so the K candidates are spread around `f*` rather than all sent to it —
 * which keeps the next attempt bracketed too, and lets the interval halve again.
 */
export function blendDials(total: number, bracket: CoderBracket, round: BalanceRound): CoderDial[] {
  const [lo, hi] = bandFor(round);
  const mid = (lo + hi) / 2;
  const span = bracket.high.panel - bracket.low.panel;
  const centre = span <= 0 ? 0.5 : Math.min(0.9, Math.max(0.1, (mid - bracket.low.panel) / span));
  const spread = 0.16;
  return Array.from({ length: total }, (_, i) => {
    const offset = total === 1 ? 0 : (i / (total - 1) - 0.5) * 2 * spread;
    const base = dialFor(i, Math.max(2, total)) as CoderDial;
    return { ...base, of: total, blend: Math.min(0.95, Math.max(0.05, centre + offset)) };
  });
}

/** What one candidate of a rejected attempt measured. Rendered as a table row. */
export type CandidateOutcome = {
  /** 0-based; the same number the events carry as `candidate`. */
  candidate: number;
  /** The dial it was aimed with. */
  dial: string;
  /** `meta.name` of the file it produced, when it had a readable one. */
  name?: string;
  /** Every gate passed. At most one candidate of an attempt has this. */
  approved: boolean;
  gate?: GateName;
  gateNumber?: number;
  /** The rejecting gate's sentence, verbatim. */
  reason?: string;
  rates?: BotRates;
  /** Panel mean, when Gate 3 measured one. `undefined` if it never got that far. */
  panel?: number;
};

const cell = (value: number | undefined): string => (value === undefined ? '  —  ' : value.toFixed(2));

/** `too hard` / `too easy` / `didn't adapt` / `gate 1` — the row's one-word verdict. */
function shortVerdict(outcome: CandidateOutcome, round: BalanceRound): string {
  if (outcome.approved) return 'PASSED';
  if (outcome.gateNumber !== undefined && outcome.gateNumber !== 3) {
    return `gate ${outcome.gateNumber} ${outcome.gate ?? ''}`.trim();
  }
  const [lo, hi] = bandFor(round);
  if (outcome.panel !== undefined && outcome.panel > hi) return 'too hard';
  if (outcome.panel !== undefined && outcome.panel < lo) return 'too easy';
  // Last, and only when nothing that rejects explains the row: ADAPTED advises now,
  // so "short of goal" is a description of a candidate that was refused for some
  // other reason — never the verdict on its own.
  if (outcome.rates?.mimic !== undefined && outcome.rates.mimic < ADAPTED_MIN) return 'short of goal';
  return 'rejected';
}

/**
 * Every candidate of one attempt, as one table.
 *
 * This is the feedback change that the parallel candidates exist to buy. One
 * rejected file says "0.78 is too hard" and leaves the size of the correction to
 * be guessed; three files aimed low, middle and high say where the band sits
 * *between* two of them, which is a bounded move rather than a guess.
 */
export function renderCandidateTable(
  outcomes: readonly CandidateOutcome[],
  round: BalanceRound,
): string {
  const botNames: string[] = [];
  for (const outcome of outcomes) {
    for (const bot of outcome.rates?.perBot ?? []) if (!botNames.includes(bot.name)) botNames.push(bot.name);
  }
  const dialWidth = Math.max(4, ...outcomes.map((o) => o.dial.length));
  const head = [
    '    ',
    'dial'.padEnd(dialWidth),
    '  panel',
    ...botNames.map((n) => `  ${n.padStart(6)}`),
    '   Mimic',
    '  verdict',
  ].join('');
  const rows = outcomes.map((outcome) => {
    const rateOf = (name: string): number | undefined =>
      outcome.rates?.perBot.find((b) => b.name === name)?.winRate;
    return [
      '    ',
      outcome.dial.padEnd(dialWidth),
      `  ${cell(outcome.panel).padStart(5)}`,
      ...botNames.map((n) => `  ${cell(rateOf(n)).padStart(6)}`),
      `  ${cell(outcome.rates?.mimic).padStart(6)}`,
      `  ${shortVerdict(outcome, round)}`,
    ].join('');
  });
  return [head, ...rows].join('\n');
}

/**
 * The interpolation instruction, when two candidates bracket the band.
 *
 * `correctionHint` tells a single file how far to move and is what the loop used
 * to rely on; its weakness is that "remove 45% of your pressure" is still a step
 * into the dark. Two measured points either side of the band turn the same
 * question into arithmetic — the fraction of the way from the low one to the high
 * one where the middle of the band sits — and the instruction becomes "blend these
 * two files", which is a change the model can make without inventing anything.
 *
 * `undefined` when the attempt did not bracket the band; the caller then falls
 * back to `correctionHint` on its best candidate.
 */
export function bracketHint(
  outcomes: readonly CandidateOutcome[],
  round: BalanceRound,
): string | undefined {
  const [lo, hi] = bandFor(round);
  const mid = (lo + hi) / 2;
  const measured = outcomes.filter(
    (o): o is CandidateOutcome & { panel: number } => typeof o.panel === 'number',
  );
  const below = measured.filter((o) => o.panel < lo).sort((a, b) => b.panel - a.panel)[0];
  const above = measured.filter((o) => o.panel > hi).sort((a, b) => a.panel - b.panel)[0];
  if (below === undefined || above === undefined) return undefined;

  const span = above.panel - below.panel;
  const fraction = span <= 0 ? 0.5 : (mid - below.panel) / span;
  const pctOfWay = Math.round(Math.min(0.95, Math.max(0.05, fraction)) * 100);
  return [
    `The band is bracketed. "${below.dial}" measured ${below.panel.toFixed(2)} (below ${lo.toFixed(2)}) and`,
    `"${above.dial}" measured ${above.panel.toFixed(2)} (above ${hi.toFixed(2)}). The answer is BETWEEN those two`,
    `files — not outside either, and not a fourth design.`,
    '',
    `Start from the "${below.dial}" file and move every knob that differs between the two`,
    `about ${pctOfWay}% of the way towards "${above.dial}": the spawn cadence, the burst count and`,
    `the range it fires at, the hold distance, and the \`rand()\` threshold on the punish.`,
    `Change nothing else. Target ${mid.toFixed(2)}.`,
  ].join('\n');
}

/**
 * Names that appear as examples in these prompts, and are therefore burned.
 *
 * Both live runs of the loop on 2026-09-03/04 shipped a boss called **Warden II**,
 * and neither model invented it: `Warden` was the example name in the dial block
 * (`name: 'Warden ${suffix}'`) and the model copied the example, exactly as models
 * do. Two consecutive rounds of a game about a boss that *changes* both produced a
 * boss with the same name, which reads on screen as nothing having happened.
 *
 * So the example is now a placeholder (`'<your new name> II'`, which nothing would
 * copy) and the word itself is listed as taken. Anything else that ends up quoted as a sample name belongs in here too.
 */
export const RESERVED_NAMES: readonly string[] = ['Warden'];

/**
 * Every boss name this rewrite may not reuse.
 *
 * The previous round's name is read out of its own source with the same AST reader
 * the interlude uses, rather than being threaded through the loop as another field:
 * the source is already in the context (it is the file being replaced), so the
 * name is derivable from what the Coder can see, and nothing else has to know.
 *
 * `bracket` replaces `prevSource` on an interpolating retry, so its two endpoint
 * files are read as well — those are the names on screen for this round's rejected
 * candidates, and reusing one of them is the same failure a round late.
 */
export function takenNames(ctx: Pick<CoderContext, 'prevSource' | 'bracket'>): string[] {
  const sources = [ctx.prevSource, ctx.bracket?.low.source, ctx.bracket?.high.source];
  const taken: string[] = [...RESERVED_NAMES];
  for (const source of sources) {
    if (source === undefined) continue;
    const name = extractMeta(source)?.name?.trim();
    if (name === undefined || name === '') continue;
    // Bare, without the " II" the candidates carry: the *word* is what is taken.
    const stem = name.replace(/\s+[IVX]+$/, '').trim();
    for (const candidate of [name, stem]) {
      if (candidate !== '' && !taken.includes(candidate)) taken.push(candidate);
    }
  }
  return taken;
}

/**
 * The naming rule, as its own block of the message.
 *
 * In the *message* and not the system prompt on purpose: the taken list changes per
 * round and per attempt, and the ~13 KB system prefix has to stay byte-identical
 * across every candidate of every attempt for the prompt cache to hit.
 *
 * It is a named block rather than a line inside the aim point because it applies to
 * all four modes (first attempt, blend, adapt, single-candidate) and the aim-point
 * blocks are already the longest thing in the message.
 */
export function nameRule(taken: readonly string[], suffix?: string): string {
  const lines = [
    '# THE NAME',
    '',
    'Invent a NEW name for this boss. `meta.name` is what the player is shown on the',
    'HUD and in the diff, so a name they have already fought reads as a boss that did',
    'not change — which is the one thing this round is supposed to prove.',
    '',
    `TAKEN — do not use any of these, or a variation of one: ${taken.join(', ')}.`,
    '',
    'One or two words. A role, a place, a machine or an instrument — something a',
    'thing that has decided how to kill you might be called. Not a description of',
    'its tactics, not a version of a taken name, and not a word from any example in',
    'this prompt.',
  ];
  if (suffix !== undefined) {
    lines.push(
      '',
      `Then append " ${suffix}" and nothing else, so the candidates written in`,
      `parallel can be told apart on screen: \`name: '<your new name> ${suffix}'\`.`,
    );
  }
  return lines.join('\n');
}

const CODER_OUTPUT_RULES = `# YOUR OUTPUT

Reply with exactly one fenced code block, tagged \`js\`, containing the complete
\`strategy.js\`. No prose before it, no explanation after it, no second block.

\`\`\`js
export const meta = { name: '...', rationale: '...', version: 2 };
export function init() { ... }
export function decide(view, mem) { ... }
\`\`\`

The file must be self-contained and complete — it is written to disk and executed
exactly as you emit it. Helper functions are fine as long as they are not
exported. Comment the tactical decisions briefly; the diff is shown to the player.`;

const CODER_SYSTEM_HEAD = `You are the Coder. You are the part of the boss that rewrites itself between
rounds.

A player just beat the boss. An Analyst watched the replay and wrote down how they
did it. You write the boss's next strategy to counter that specific player — and
then a deterministic harness decides whether it ships. You do not see the game
engine, the renderer or the server, and you do not need to: everything you can
affect is in the contract below.`;

/**
 * The per-bot breakdown of a Gate 3 rejection, pulled out of `GateResult.detail`.
 *
 * The reason sentence names the aggregate ("0.91 vs panel — too hard") and lists
 * the panel bots inline, but it cannot say which of them is the *problem*. A boss
 * at 0.91 with Rusher at 0.00 and Camper at 1.00 has two different bugs, and only
 * one file to fix; the table names them.
 */
export type BotRates = {
  /**
   * Panel bots, in the order the simulation reported them. `maxIdleRun` is the
   * worst motionless run, in ticks, that this boss had against that bot — the
   * number ACTIVE is about, broken down per opponent, because "you froze" is only
   * actionable once the Coder knows *which* approach froze it.
   */
  perBot: readonly { name: string; winRate: number; maxIdleRun?: number }[];
  /** The Mimic's rate, when ADAPTED was measured. */
  mimic?: number;
};

export type CoderRejection = {
  gate: GateName;
  gateNumber: number;
  reason: string;
  attempt: number;
  /** Gate 3 only. Rendered as a table above the verbatim reason. */
  rates?: BotRates;
  /**
   * Every candidate the rejected attempt ran, when it ran more than one. The
   * `gate`/`reason`/`rates` above are the *best* of them — the one this retry
   * starts from — and this is the rest of the interval it was measured in.
   */
  candidates?: readonly CandidateOutcome[];
};

export type CoderContext = {
  analysis: Analysis;
  /** The strategy that just lost. The starting point, not a template to preserve. */
  prevSource: string;
  round: BalanceRound;
  /** Verbatim `GateResult.reason` from the attempt that was just rejected. */
  rejection?: CoderRejection;
  /**
   * Which of the attempt's K parallel candidates this call is writing. Absent for
   * a single-candidate attempt, which then sends the prompt it always sent.
   */
  dial?: CoderDial;
  /** Static-check violations from this same attempt, before the harness ran. */
  selfRetry?: { violations: string };
  /**
   * The two measured files that straddle the band, when some attempt has produced
   * both. Replaces `prevSource` in the prompt: the retry is an interpolation
   * between these two files, so both have to be in the context.
   */
  bracket?: CoderBracket;
  /**
   * The measured player profile (`playerProfile.ts`'s `renderPlayerProfile`),
   * already rendered — hot cells, dominant dash angle, shots-during, round length
   * — as fenced JSON. Analysis item 7: the same numbers as the Analyst's prose,
   * offered as data so the Coder embeds them rather than retyping them. Identical
   * across an attempt's K candidates (`rewrite()` computes it once), so it lives
   * here in the message and not the cached system prompt, same reason `bracket`
   * and `rejection` do.
   */
  profile?: string;
};

export function coderPrompt(ctx: CoderContext): Prompt {
  const system = [
    CODER_SYSTEM_HEAD,
    '',
    contractDoc(),
    '',
    harnessRules(ctx.round),
    '',
    harnessHints(ctx.round),
    '',
    CODER_OUTPUT_RULES,
  ].join('\n');

  const parts = [
    `# ROUND ${ctx.round}`,
    '',
    `You are writing the boss for round ${ctx.round}. Its fairness band is ${formatBand(ctx.round)} against the`,
    `panel — that is the hard requirement. Beating the Mimic of this player ${ADAPTED_MIN.toFixed(2)} of the`,
    'time is the goal to aim at, and it is reported rather than enforced.',
    '',
  ];

  if (ctx.dial !== undefined) {
    // Before the analysis, not after the rejection: the rejection sentence has to
    // stay the last thing in the context (spec §6.3), and this is an aim point
    // rather than feedback — it belongs with the round it is aiming inside.
    const [lo, hi] = bandFor(ctx.round);
    const mid = (lo + hi) / 2;
    const bracket = ctx.bracket;
    if (ctx.dial.aim === 'adapt') {
      parts.push(
        `# YOUR AIM POINT: THE MIMIC — YOUR PANEL RATE IS ALREADY IN BAND (${formatBand(ctx.round)})`,
        '',
        'The file below is FAIR and the harness will not argue with its rates. It fails on',
        'the other assertion: it has not countered *this* player. So the one thing you must',
        'not do is change how much pressure it applies — every cooldown check, every',
        '`rand()` threshold, every cadence stays exactly as it is, or the panel rate moves',
        'and you lose the half that already works.',
        '',
        `${ctx.dial.of} counters are being written in parallel. Yours is the "${ctx.dial.name}" one:`,
        '',
        ctx.dial.instruction,
        '',
        `Your \`meta.name\` must be new (see THE NAME, below) and must end with`,
        `" ${ctx.dial.nameSuffix}" so the candidates can be told apart on screen.`,
        '',
      );
    } else if (ctx.dial.blend !== undefined && bracket !== undefined) {
      const pct = Math.round(ctx.dial.blend * 100);
      parts.push(
        `# YOUR AIM POINT: ${pct}% OF THE WAY FROM TOO EASY TO TOO HARD`,
        '',
        'Two files have already been measured and the band is between them. This attempt',
        'is a bisection, not a rewrite — three files are being written in parallel at',
        'different points along the same line, and the harness keeps whichever lands',
        `closest to ${mid.toFixed(2)}.`,
        '',
        `    A — "${bracket.low.label}" measured ${bracket.low.panel.toFixed(2)} vs the panel   (too easy)`,
        `    B — "${bracket.high.label}" measured ${bracket.high.panel.toFixed(2)} vs the panel   (too hard)`,
        '',
        `Both files are below. Write the one that sits ${pct}% of the way from A to B.`,
        'Concretely: start from A, and for every knob where B does more — spawn cadence,',
        `burst \`count\` and the range it fires at, hold distance, how often the signature`,
        `punish fires — move A's value ${pct}% of the way to B's. Where B has a rule A does`,
        `not, take it but gate it behind \`rand() < ${(ctx.dial.blend).toFixed(2)}\`. Change nothing else.`,
        '',
        `Your \`meta.name\` must end with " ${ctx.dial.nameSuffix}", and it must be a NEW`,
        'name — see THE NAME, below. Keeping the bracketed files\' name is not part of',
        'blending them.',
        '',
      );
    } else {
      const target = ctx.dial.aim === 'low' ? lo : ctx.dial.aim === 'high' ? hi : mid;
      const posture = ctx.dial.aim === 'low' ? 'restrained' : ctx.dial.aim === 'high' ? 'forceful' : 'measured';
      parts.push(
        `# YOUR AIM POINT: ${ctx.dial.name.toUpperCase()} — TARGET ${target.toFixed(2)} VS THE PANEL`,
        '',
        `${ctx.dial.of} candidate files are being written from this same brief right now, in`,
        'parallel, and the harness keeps whichever one lands closest to the middle of the',
        `band. Yours is the ${ctx.dial.name} one, and it must be recognisably more`,
        `${posture} than the other two:`,
        '',
        ctx.dial.instruction,
        '',
        `Your \`meta.name\` must end with " ${ctx.dial.nameSuffix}" so the candidates can be`,
        'told apart on screen, and the name itself must be new — see THE NAME, below.',
        'Everything else is yours.',
        '',
      );
    }
  }

  // Before the analysis and well before the rejection: the rejection sentence has to
  // stay the last thing in the context (spec §6.3), and a naming rule buried under a
  // quantitative correction is a naming rule that gets ignored.
  parts.push(nameRule(takenNames(ctx), ctx.dial?.nameSuffix), '');

  parts.push('# THE ANALYST ON THIS PLAYER', '', '```json', JSON.stringify(ctx.analysis, null, 2), '```', '');

  if (ctx.profile !== undefined) {
    // Right after the Analyst's reading and before the code, same as the Analyst
    // block above: both are *evidence*, and the rejection sentence still has to
    // stay the last thing in the context (spec §6.3).
    parts.push(
      '# PLAYER PROFILE (measured — embed the numbers you aim with as constants, do not retype them from prose)',
      '',
      '```json',
      ctx.profile,
      '```',
      '',
    );
  }

  if (ctx.bracket !== undefined) {
    // Both endpoints, not just the better one: an interpolation needs two points,
    // and the file that was too *easy* is half the information.
    parts.push(
      '# FILE A — TOO EASY',
      '',
      `"${ctx.bracket.low.label}" measured ${ctx.bracket.low.panel.toFixed(2)} against the panel.`,
      '',
      '```js',
      ctx.bracket.low.source.trim(),
      '```',
      '',
      '# FILE B — TOO HARD',
      '',
      `"${ctx.bracket.high.label}" measured ${ctx.bracket.high.panel.toFixed(2)} against the panel.`,
      '',
      '```js',
      ctx.bracket.high.source.trim(),
      '```',
    );
  } else {
    parts.push(
      '# THE STRATEGY THAT JUST LOST',
      '',
      'This is the file you are replacing. Reuse what worked; do not feel bound by its',
      'shape.',
      '',
      '```js',
      ctx.prevSource.trim(),
      '```',
    );
  }

  if (ctx.selfRetry !== undefined) {
    parts.push(
      '',
      '# YOUR LAST FILE DID NOT PASS THE STATIC CHECK',
      '',
      'This did not count as a harness attempt, but fix it before anything else:',
      '',
      ctx.selfRetry.violations,
      '',
      'Emit the COMPLETE corrected file — all three exports, `meta` then `init` then',
      '`decide` — inside ONE ```js block with its closing fence. Stopping part-way',
      'through the file is the commonest cause of this message; if the file is getting',
      'long, cut a tactic rather than cut it off.',
    );
  }

  if (ctx.rejection !== undefined) {
    // Verbatim, quoted, and last. Spec §6.3: the rejection reason is the only
    // feedback the Coder gets, so it is the final thing in the context and it is
    // not reworded — the numbers in it are the target for this attempt.
    const all = ctx.rejection.candidates ?? [];
    parts.push(
      '',
      all.length > 1
        ? `# ATTEMPT ${ctx.rejection.attempt}: ALL ${all.length} CANDIDATES WERE REJECTED`
        : `# ATTEMPT ${ctx.rejection.attempt} WAS REJECTED BY GATE ${ctx.rejection.gateNumber} (${ctx.rejection.gate})`,
      '',
    );
    // The interval, then where inside it to aim. Two candidates either side of the
    // band turn "you are too hard" into an interpolation, which is the whole point
    // of running K of them; `correctionHint`'s single-point correction is the
    // fallback for an attempt that did not bracket.
    let bracketed = false;
    if (all.length > 1) {
      parts.push('Each aim point measured this against the panel and the Mimic:', '', renderCandidateTable(all, ctx.round), '');
      const generic = ctx.dial?.blend === undefined ? bracketHint(all, ctx.round) : undefined;
      if (generic !== undefined) {
        bracketed = true;
        parts.push(generic, '');
      }
      if (ctx.dial?.blend !== undefined) bracketed = true;
      if (ctx.bracket === undefined) {
        parts.push('THE STRATEGY THAT JUST LOST, above, is the best of them: it is what you edit.', '');
      }
    }
    if (ctx.rejection.rates !== undefined && ctx.rejection.rates.perBot.length > 0) {
      // Above the reason, not below it: the sentence stays the last thing in the
      // context (spec §6.3), and this is the lookup table for reading it.
      parts.push(
        `Your win rate against each opponent, in the ${all.length > 1 ? 'best' : 'rejected'} file's simulation:`,
        '',
        renderBotRates(ctx.rejection.rates),
        '',
      );
      // Suppressed when the candidates bracketed the band: "remove 45% of your
      // pressure" and "move 38% of the way towards aggressive" are two different
      // instructions, and the measured one wins.
      const correction = bracketed ? undefined : correctionHint(ctx.rejection.rates, ctx.round);
      if (correction !== undefined) parts.push(correction, '');
    }
    parts.push(
      'The harness said of it, verbatim:',
      '',
      `    ${ctx.rejection.reason}`,
      '',
      'That sentence is the whole of your feedback. Fix that, change as little else as',
      'you can, and emit the complete file again.',
    );
  }

  return { system, messages: [{ role: 'user', content: parts.join('\n') }] };
}
