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
import { ADAPTED_MIN, DEFAULT_MATCHES, bandFor, formatBand, type BalanceRound } from '@rematch/harness';
import type { GateName } from '@rematch/harness';
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
  return `# HOW THE HARNESS JUDGES YOU

Your file is not shipped because it looks good. It runs four deterministic gates,
in order, and stops at the first failure. There is no LLM in the harness and no
human in the loop: you get one rejection sentence back and one more attempt.

Gate 1 — static. An AST walk before anything executes. Forbidden identifiers,
  imports, wrong module shape, oversized source.
    ✗ "forbidden-identifier: 'Date' may not be mentioned (line 14)"
    ✗ "export: 'helper' is not one of meta, init, decide"

Gate 2 — contract fuzz. Your \`decide\` is called on ~500 generated states,
  including corner cases (every cooldown ready, every cooldown blocked, the player
  in each corner, 40 projectiles in flight, tick 0, tick 3599). Every returned
  action is validated.
    ✗ "returned an invalid action on 3.0% of states (15/500); the most common
       problem was burst.angle must be a finite number, got NaN (12x)"
    ✗ "decide() threw 'heat is not defined' on 12/500 states (first: tick 371,
       player dashing, 4 projectiles)"

Gate 3 — balance. ${DEFAULT_MATCHES} simulated matches on a fixed seed set. Two assertions:
    ADAPTED : boss win rate vs the Mimic  >= ${ADAPTED_MIN.toFixed(2)}
              The Mimic is a bot rebuilt from THIS player's replay — their heat
              map, their dash bias, their shot timing. Beating it is what "you
              countered how they played" means. This is what the analysis is for.
    FAIR    : boss win rate vs the scripted panel  in ${formatBand(round)}   (round ${round})
              The panel is four bots that play nothing like this player: Camper,
              Kiter, Rusher, Dodger. A boss that beats all four is unwinnable and
              is rejected as hard as one that beats none.
    ✗ "0.91 vs panel — too hard (band ${formatBand(round)} for round ${round}; Camper 1.00, Kiter 0.96,
       Rusher 0.92, Dodger 0.76); 0.41 vs Mimic — didn't adapt (need >= ${ADAPTED_MIN.toFixed(2)})"

Gate 4 — perf. \`decide\` p99 must stay inside its 2 ms budget in the sandbox.
    ✗ "decide() p99 = 6.2ms > 2ms"

What this means for how you write:
- Aim for the middle of the band (${((lo + hi) / 2).toFixed(2)}), not the top. Too hard fails exactly like
  too easy, and "too hard" is the failure that costs the player the game.
- Counter the *specific* player in the analysis — that is the only way ADAPTED
  passes — but leave the counter answerable. A player who changes approach must be
  able to win. Prefer punishing one habit hard over raising pressure everywhere.
- Never gate an attack on a single condition that the panel bots will not satisfy;
  a strategy that idles for 2000 ticks fails FAIR as "too easy".
- Guard every division and every \`Math.atan2\` input. A single NaN angle in one
  branch is a Gate 2 rejection even if the rest of the file is perfect.
- Keep \`decide\` straight-line and cheap: no loops over more than the projectile
  array, no allocation per tick beyond the returned object.
- Keep your memory object small and JSON-serializable (numbers and short arrays).`;
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
 * Kept under 900 characters on purpose. It sits in the cached system prompt in
 * front of the analysis, and a page of tactics would start to compete with the
 * contract for the model's attention.
 */
export function harnessHints(round: BalanceRound): string {
  const [lo, hi] = bandFor(round);
  return `# WHAT THE HARNESS HAS LEARNED ABOUT THIS ENGINE

Measured on strategies that passed Gate 3:

- \`spawn\` cadence is the strongest single lever on the panel win rate. Minions
  decide fights against a player who keeps distance or dodges everything.
- A player who rushes into contact is only punished by a \`burst\` with
  \`count: 8\` (the full ring) or a \`slam\` on the boss's own position; a cone
  at contact is a free dodge.
- Long-range cone bursts beat a kiting player. \`charge\` alone does not: closing
  the distance and winning once there are different problems.
- Roll the injected \`rand()\` per phase ("press, or reset") to tune the rate
  continuously. Fixed duty cycles give binary outcomes: 0.00 or 1.00 per bot.
- \`history.playerPosHeat\` says where the player *lives*. Aim the pressure
  there, not only where they stand this tick.
- Round ${round}'s band is ${formatBand(round)}; aim at its middle, ${((lo + hi) / 2).toFixed(2)}.`;
}

/** `Camper 1.00` per line, with the two rates that are failures marked. */
export function renderBotRates(rates: BotRates): string {
  const rows = [...rates.perBot.map((b) => ({ ...b, mimic: false }))];
  if (rates.mimic !== undefined) rows.push({ name: 'Mimic', winRate: rates.mimic, mimic: true });
  const width = Math.max(...rows.map((r) => r.name.length), 6);
  return rows
    .map((row) => {
      const rate = row.winRate.toFixed(2);
      const note = row.mimic
        ? row.winRate < ADAPTED_MIN
          ? `  <- ADAPTED needs >= ${ADAPTED_MIN.toFixed(2)}`
          : ''
        : row.winRate >= 1
          ? '  <- unwinnable for that bot; this is what makes you too hard'
          : row.winRate <= 0
            ? '  <- that bot wins every match; this is what makes you too easy'
            : '';
      return `    ${row.name.padEnd(width)}  ${rate}${note}`;
    })
    .join('\n');
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
  /** Panel bots, in the order the simulation reported them. */
  perBot: readonly { name: string; winRate: number }[];
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
};

export type CoderContext = {
  analysis: Analysis;
  /** The strategy that just lost. The starting point, not a template to preserve. */
  prevSource: string;
  round: BalanceRound;
  /** Verbatim `GateResult.reason` from the attempt that was just rejected. */
  rejection?: CoderRejection;
  /** Static-check violations from this same attempt, before the harness ran. */
  selfRetry?: { violations: string };
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
    `panel, and it must beat the Mimic of this player at least ${ADAPTED_MIN.toFixed(2)} of the time.`,
    '',
    '# THE ANALYST ON THIS PLAYER',
    '',
    '```json',
    JSON.stringify(ctx.analysis, null, 2),
    '```',
    '',
    '# THE STRATEGY THAT JUST LOST',
    '',
    'This is the file you are replacing. Reuse what worked; do not feel bound by its',
    'shape.',
    '',
    '```js',
    ctx.prevSource.trim(),
    '```',
  ];

  if (ctx.selfRetry !== undefined) {
    parts.push(
      '',
      '# YOUR LAST FILE DID NOT PASS THE STATIC CHECK',
      '',
      'This did not count as a harness attempt, but fix it before anything else:',
      '',
      ctx.selfRetry.violations,
      '',
      'Emit the complete corrected file.',
    );
  }

  if (ctx.rejection !== undefined) {
    // Verbatim, quoted, and last. Spec §6.3: the rejection reason is the only
    // feedback the Coder gets, so it is the final thing in the context and it is
    // not reworded — the numbers in it are the target for this attempt.
    parts.push(
      '',
      `# ATTEMPT ${ctx.rejection.attempt} WAS REJECTED BY GATE ${ctx.rejection.gateNumber} (${ctx.rejection.gate})`,
      '',
    );
    if (ctx.rejection.rates !== undefined && ctx.rejection.rates.perBot.length > 0) {
      // Above the reason, not below it: the sentence stays the last thing in the
      // context (spec §6.3), and this is the lookup table for reading it.
      parts.push(
        'Your win rate against each opponent in that simulation:',
        '',
        renderBotRates(ctx.rejection.rates),
        '',
      );
    }
    parts.push(
      'The harness said, verbatim:',
      '',
      `    ${ctx.rejection.reason}`,
      '',
      'That sentence is the whole of your feedback. Fix that, change as little else as',
      'you can, and emit the complete file again.',
    );
  }

  return { system, messages: [{ role: 'user', content: parts.join('\n') }] };
}
