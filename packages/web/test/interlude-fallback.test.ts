/**
 * `fallbackText` — spec AC 5's "Using a pre-approved strategy — X." sentence, and
 * the fix for a 2026-09-10 playtest bug: a run failed because the *Analyst*
 * returned nothing usable (`reason: 'error'`), and the screen said "the coder
 * failed" — true of the reason code, false of which agent actually failed. Pure,
 * so the mapping is pinned here rather than only in a screenshot, the same split
 * as `interlude-cast.test.ts`'s `fallbackHeadline` and `test/interlude-meter.test.ts`'s
 * `meterView`.
 */
import { describe, expect, it } from 'vitest';

import { fallbackText } from '../src/interlude/ui.ts';
import type { FailureReason } from '../src/interlude/events.ts';

describe('fallbackText — no message: the generic, reason-coded clause', () => {
  it('names the reason in plain words when the loop sent nothing more specific', () => {
    expect(fallbackText('max-attempts')).toBe('Using a pre-approved strategy — it ran out of attempts.');
    expect(fallbackText('deadline')).toBe('Using a pre-approved strategy — the coder timed out.');
    expect(fallbackText('error')).toBe('Using a pre-approved strategy — the coder failed.');
  });

  it('treats an empty string the same as no message — never an empty clause', () => {
    expect(fallbackText('error', '')).toBe('Using a pre-approved strategy — the coder failed.');
  });
});

describe('fallbackText — a real message overrides the generic clause', () => {
  // The exact reported bug: `reason: 'error'` is the Coder-facing code the whole
  // loop returns for "nothing got approved for a reason other than the deadline
  // or the attempt cap", but here the *Analyst* is what actually failed.
  const ANALYST_MESSAGE = 'the Analyst returned nothing usable after 2 attempts: no JSON object was found in the reply';

  it('says what actually happened instead of what the reason code implies', () => {
    const text = fallbackText('error', ANALYST_MESSAGE);
    expect(text).toBe(`Using a pre-approved strategy — ${ANALYST_MESSAGE}.`);
    expect(text).not.toContain('the coder failed');
  });

  it('a message wins regardless of which reason code it is attached to', () => {
    // The point of preferring `message` is that it is the truth and the reason
    // code is only ever a category; this must hold for all three categories, not
    // only `error`.
    for (const reason of ['max-attempts', 'deadline', 'error'] as FailureReason[]) {
      expect(fallbackText(reason, 'skipped by the player')).toBe('Using a pre-approved strategy — skipped by the player.');
    }
  });

  it('trims a trailing period so the sentence never doubles one up', () => {
    expect(fallbackText('error', 'the stream ended without a verdict.')).toBe(
      'Using a pre-approved strategy — the stream ended without a verdict.',
    );
  });

  it('trims surrounding whitespace', () => {
    expect(fallbackText('error', '  the coder threw  ')).toBe('Using a pre-approved strategy — the coder threw.');
  });

  it('does not tighten away an internal, mid-sentence period', () => {
    // Only a *trailing* period (the sentence's own) is stripped — a message that
    // legitimately has two clauses keeps both.
    const text = fallbackText('error', 'attempt 2 failed. attempt 3 was never reached');
    expect(text).toBe('Using a pre-approved strategy — attempt 2 failed. attempt 3 was never reached.');
  });
});
