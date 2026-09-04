/**
 * The `pnpm eval:agents` spend gate.
 *
 * `eval:agents` is the only thing in this repo that spends money, and until
 * 2026-09-04 its only guard was "is a credential present" — which, once a key is in
 * `.env`, is not a guard at all. Eleven ordinary invocations in one evening exhausted
 * the account's credit. So the gate is now an explicit `REMATCH_ALLOW_SPEND=1`, and
 * this file pins the two things that make it worth having:
 *
 * 1. **It refuses by default**, and no plausible non-affirmative value reads as yes.
 * 2. **The refusal states the cost**, computed from the invocation's own flags, so the
 *    decision is made against a number.
 *
 * The guard is pure (`scripts/spendGuard.ts` imports nothing), so none of this touches
 * a network, a key, or the eval itself.
 */
import { describe, expect, it } from 'vitest';

import {
  ALLOW_SPEND_ENV,
  CALLS_PER_CANDIDATE,
  estimateCalls,
  refusalMessage,
  spendAllowed,
} from '../scripts/spendGuard.ts';

describe('spendAllowed', () => {
  it('refuses when the variable is absent — the whole point', () => {
    expect(spendAllowed({})).toBe(false);
  });

  it('accepts only affirmative values', () => {
    for (const raw of ['1', 'true', 'yes', 'TRUE', ' Yes ']) {
      expect(spendAllowed({ [ALLOW_SPEND_ENV]: raw }), raw).toBe(true);
    }
  });

  it('treats 0, false and empty as refusals, not as "the variable is set"', () => {
    // A stale `REMATCH_ALLOW_SPEND=0` in a shell must not read as consent, which is
    // the failure mode of any guard that only checks for presence.
    for (const raw of ['0', 'false', 'no', '', '   ', 'maybe']) {
      expect(spendAllowed({ [ALLOW_SPEND_ENV]: raw }), raw).toBe(false);
    }
  });
});

describe('estimateCalls', () => {
  it('is the worst case: replays x (1 Analyst + attempts x candidates x 2)', () => {
    // The default invocation — 10 canned replays, 4 attempts, 3 candidates — which is
    // the number that actually exhausted the credit.
    expect(estimateCalls({ replays: 10, attempts: 4, candidates: 3 })).toEqual({
      replays: 10,
      attempts: 4,
      candidates: 3,
      calls: 250,
    });
  });

  it('counts the Coder’s staticCheck self-retry, because some candidates take two calls', () => {
    expect(CALLS_PER_CANDIDATE).toBe(2);
    expect(estimateCalls({ replays: 1, attempts: 1, candidates: 1 }).calls).toBe(1 + 2);
  });

  it('scales down with REMATCH_EVAL_ONLY and REMATCH_CANDIDATES', () => {
    // The cheap invocation the refusal message recommends.
    expect(estimateCalls({ replays: 1, attempts: 4, candidates: 3 }).calls).toBe(25);
    expect(estimateCalls({ replays: 10, attempts: 4, candidates: 1 }).calls).toBe(90);
  });

  it('never returns a negative or fractional estimate', () => {
    expect(estimateCalls({ replays: -5, attempts: 4, candidates: 3 }).calls).toBe(0);
    expect(estimateCalls({ replays: 2.7, attempts: 1.9, candidates: 1.2 }).calls).toBe(2 * (1 + 1 * 1 * 2));
  });
});

describe('refusalMessage', () => {
  const estimate = estimateCalls({ replays: 10, attempts: 4, candidates: 3 });

  it('names the flag and the worst-case call count', () => {
    const text = refusalMessage(estimate);
    expect(text).toContain('refusing to run');
    expect(text).toContain('up to 250 model calls');
    // Both halves of the instruction: the variable, and a command to copy.
    expect(text).toContain(ALLOW_SPEND_ENV);
    expect(text).toContain(`${ALLOW_SPEND_ENV}=1 pnpm eval:agents`);
  });

  it('shows the arithmetic, so the number is checkable rather than trusted', () => {
    expect(refusalMessage(estimate)).toContain('10 replay(s) x (1 Analyst + 4 attempt(s) x 3 candidate(s) x 2 calls)');
  });

  it('names the provider it would have billed, when one is resolvable', () => {
    const text = refusalMessage(estimate, { vendor: 'openai', model: 'gpt-5.4-mini' });
    expect(text).toContain('provider openai (gpt-5.4-mini)');
  });

  it('omits the provider line entirely when there is no credential', () => {
    // Refusing on cost is the point; whether a key happens to be present is not the
    // reason, and a dangling "provider undefined" would suggest otherwise.
    // Matched on the line prefix: the word "provider" also appears in the
    // "against a mock provider" hint below, which should stay either way.
    expect(refusalMessage(estimate)).not.toMatch(/^ {2}provider /m);
    expect(refusalMessage(estimate, { vendor: 'openai' })).toMatch(/^ {2}provider openai$/m);
  });

  it('points at the free alternatives, including the recorded run', () => {
    const text = refusalMessage(estimate);
    expect(text).toContain('pnpm --filter @rematch/agents test');
    expect(text).toContain('REMATCH_EVAL_ONLY=camper-a');
    // The recorded real run needs no key at all — the cheapest path to the same
    // evidence, and the one a demo should use.
    expect(text).toContain('docs/evidence/eval-round2-2026-09-03.json');
    expect(text).toContain('?agent=recorded');
  });
});
