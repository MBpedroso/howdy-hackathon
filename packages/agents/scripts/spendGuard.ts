/**
 * The `pnpm eval:agents` spend guard — an explicit opt-in before anything is billed.
 *
 * ## Why a second guard, when the script was already opt-in
 *
 * It was opt-in on the *wrong* condition. `eval.ts` skipped when there was no
 * credential, which reads as caution and is not: once a key is in `.env` — the normal
 * state for anyone actually working on the agents — `pnpm eval:agents` spends money on
 * every invocation with no further ceremony, and its cost is not obvious from the
 * command. Ten canned replays x up to 4 attempts x 3 candidates x 2 calls is up to
 * **240 model calls**, and the eleven runs of 2026-09-03 exhausted the account's
 * credit exactly that way (see `docs/AI-DEV-LOG.md`).
 *
 * So the guard is no longer "is there a key" but "did a human say yes to this,
 * knowing the number". Two things it does that a comment in a README cannot:
 *
 * 1. **Refuses by default.** `REMATCH_ALLOW_SPEND=1` has to be in the command. A
 *    variable that must be typed at the call site cannot be forgotten in `.env` and
 *    then silently inherited by the next run.
 * 2. **Prints the estimate first.** The refusal message states the worst-case call
 *    count for *this* invocation's flags, so the decision is made against a number
 *    rather than a vibe.
 *
 * The estimate is deliberately the **worst case** — every replay using every attempt
 * and every candidate self-retrying once. A guard that under-promises is a guard that
 * gets ignored the first time it is wrong.
 *
 * This module is pure and has no imports, so the arithmetic and the copy are testable
 * without a network, a key, or the eval's own dependencies
 * (`packages/agents/test/spend-guard.test.ts`).
 */

/** The variable a human has to set to authorise spending. */
export const ALLOW_SPEND_ENV = 'REMATCH_ALLOW_SPEND';

/**
 * Model calls one candidate file can cost.
 *
 * Two, not one: the Coder re-prompts itself once when `staticCheck` rejects its first
 * file (`coder.calls === 2` in the logs). Only some candidates do, which is why this
 * is an upper bound.
 */
export const CALLS_PER_CANDIDATE = 2;

export type SpendEstimate = {
  replays: number;
  attempts: number;
  candidates: number;
  /** Worst case: `replays x (1 Analyst + attempts x candidates x 2)`. */
  calls: number;
};

/**
 * Worst-case model calls for one eval invocation.
 *
 * The Analyst is one call per replay (it can retry, but only on a malformed reply, and
 * counting that would double the whole estimate for a rare case). The Coder is the
 * term that matters: attempts x candidates x a possible self-retry.
 */
export function estimateCalls(input: {
  replays: number;
  attempts: number;
  candidates: number;
}): SpendEstimate {
  const replays = Math.max(0, Math.trunc(input.replays));
  const attempts = Math.max(0, Math.trunc(input.attempts));
  const candidates = Math.max(0, Math.trunc(input.candidates));
  return {
    replays,
    attempts,
    candidates,
    calls: replays * (1 + attempts * candidates * CALLS_PER_CANDIDATE),
  };
}

/** Has a human authorised spending for this invocation? */
export function spendAllowed(env: Record<string, string | undefined> = process.env): boolean {
  const raw = (env[ALLOW_SPEND_ENV] ?? '').trim().toLowerCase();
  // Only affirmative values, and `0`/`false`/`""` are all refusals — a variable left
  // set to `0` in a shell must not read as consent.
  return raw === '1' || raw === 'true' || raw === 'yes';
}

/**
 * The refusal, with the number and the flag in it.
 *
 * Written as one function so the message is testable and so the estimate cannot drift
 * from the thing that refuses.
 */
export function refusalMessage(estimate: SpendEstimate, extra: { model?: string; vendor?: string } = {}): string {
  const lines = [
    'eval:agents — refusing to run: this suite makes real, billable API calls.',
    '',
    `  up to ${estimate.calls} model calls for this invocation`,
    `  = ${estimate.replays} replay(s) x (1 Analyst + ${estimate.attempts} attempt(s)` +
      ` x ${estimate.candidates} candidate(s) x ${CALLS_PER_CANDIDATE} calls)`,
  ];
  if (extra.vendor !== undefined) {
    lines.push(`  provider ${extra.vendor}${extra.model === undefined ? '' : ` (${extra.model})`}`);
  }
  lines.push(
    '',
    `Set ${ALLOW_SPEND_ENV}=1 to authorise it:`,
    '',
    `  ${ALLOW_SPEND_ENV}=1 pnpm eval:agents`,
    '',
    'Cheaper ways to get the same signal, none of which spend anything:',
    '',
    '  pnpm --filter @rematch/agents test          # the whole loop against a mock provider',
    `  REMATCH_EVAL_ONLY=camper-a ${ALLOW_SPEND_ENV}=1 pnpm eval:agents   # one replay, not ten`,
    '',
    'A recorded real run is already committed and needs no key at all:',
    '  docs/evidence/eval-round2-2026-09-03.json, and',
    "  pnpm dev, then open '/?agent=recorded&autostart=1'",
  );
  return lines.join('\n');
}
