/**
 * The Coder: extracting the file out of a reply, and the `staticCheck` self-retry
 * that keeps a `Date.now()` typo from spending one of the four harness attempts.
 */
import { describe, expect, it } from 'vitest';
import { staticCheck } from '@rematch/contract';
import { extractJsBlock, mockProvider, renderViolations, runCoder, type Analysis } from '../src/index.ts';
import { asCoderReply, readGood, readHarnessFixture } from './helpers.ts';

const ANALYSIS: Analysis = {
  observations: ['Camped cell 63 for 93% of the round.'],
  playerArchetype: 'camper',
  counterPlan: 'Slam the corner.',
};

describe('extractJsBlock', () => {
  const good = readGood('cornerbreaker');

  it('takes a single ```js block', () => {
    expect(extractJsBlock(asCoderReply(good))).toBe(good.trim());
  });

  it('ignores a preamble and a postamble', () => {
    const reply = `Here is the new boss.\n\n${asCoderReply(good)}\n\nIt punishes the corner.`;
    expect(extractJsBlock(reply)).toBe(good.trim());
  });

  it('prefers the block that exports decide over an illustrative snippet', () => {
    const reply = `First, the helper:\n\n\`\`\`js\nfunction dist(a, b) { return 0; }\n\`\`\`\n\nNow the file:\n\n${asCoderReply(good)}`;
    expect(extractJsBlock(reply)).toBe(good.trim());
  });

  it('accepts a javascript-tagged block', () => {
    expect(extractJsBlock(`\`\`\`javascript\n${good}\n\`\`\``)).toBe(good.trim());
  });

  it('falls back to unfenced source that looks like a module', () => {
    expect(extractJsBlock(good)).toBe(good.trim());
  });

  it('returns undefined for a reply with no code', () => {
    expect(extractJsBlock('I need more information about the arena.')).toBeUndefined();
  });
});

describe('renderViolations', () => {
  it('renders rule ids and line numbers the way a Gate 1 rejection does', () => {
    const check = staticCheck(readHarnessFixture('uses-date'));
    expect(check.ok).toBe(false);
    if (check.ok) return;
    const rendered = renderViolations(check.violations);
    expect(rendered).toContain('forbidden-identifier');
    expect(rendered).toContain('Date');
    expect(rendered).toMatch(/line \d+/);
  });
});

describe('runCoder', () => {
  const prevSource = readGood('idle');

  it('returns the file and streams deltas in one call', async () => {
    const source = readHarnessFixture('round2-candidate');
    const provider = mockProvider([asCoderReply(source)], { chunkSize: 128 });
    const deltas: string[] = [];
    const result = await runCoder({ analysis: ANALYSIS, prevSource, round: 2 }, provider, {
      onDelta: (d) => deltas.push(d),
    });

    expect(result.calls).toBe(1);
    expect(result.source).toBe(source.trim());
    expect(result.selfRetry).toBeUndefined();
    expect(deltas.length).toBeGreaterThan(1);
    expect(staticCheck(result.source).ok).toBe(true);
  });

  it('self-retries once when the first file fails staticCheck, without counting a harness attempt', async () => {
    const bad = readHarnessFixture('uses-date');
    const good = readHarnessFixture('round2-candidate');
    const provider = mockProvider([asCoderReply(bad), asCoderReply(good)]);

    const result = await runCoder({ analysis: ANALYSIS, prevSource, round: 2 }, provider);

    expect(result.calls).toBe(2);
    expect(result.source).toBe(good.trim());
    expect(result.selfRetry).toContain('forbidden-identifier');
    // The second prompt tells the Coder what was wrong, in Gate 1's vocabulary.
    const retry = provider.promptOf(1);
    expect(retry).toContain('DID NOT PASS THE STATIC CHECK');
    expect(retry).toContain('forbidden-identifier');
    expect(retry).toContain('did not count as a harness attempt');
  });

  it('asks again when the reply has no code block', async () => {
    const provider = mockProvider(['I would rather not.', asCoderReply(readGood('chaser'))]);
    const result = await runCoder({ analysis: ANALYSIS, prevSource, round: 2 }, provider);
    expect(result.calls).toBe(2);
    expect(provider.promptOf(1)).toContain('no ```js code block');
  });

  it('submits a still-invalid file after the self-retry, flagged, rather than vetoing it', async () => {
    // The harness is the authority on what ships. A Coder that refused to submit
    // would replace a legible Gate 1 rejection with an internal error.
    const bad = readHarnessFixture('uses-date');
    const provider = mockProvider([asCoderReply(bad), asCoderReply(bad)]);
    const result = await runCoder({ analysis: ANALYSIS, prevSource, round: 2 }, provider);

    expect(result.calls).toBe(2);
    expect(result.staticInvalid).toBe(true);
    expect(result.source).toBe(bad.trim());
    expect(staticCheck(result.source).ok).toBe(false);
  });

  it('throws only when neither reply contained any code at all', async () => {
    const provider = mockProvider(['no thanks', 'still no']);
    await expect(runCoder({ analysis: ANALYSIS, prevSource, round: 2 }, provider)).rejects.toThrow(
      /no strategy file in 2 passes/,
    );
  });

  it('puts the round, the band and the previous file in the prompt', async () => {
    const provider = mockProvider([asCoderReply(readHarnessFixture('round2-candidate'))]);
    await runCoder({ analysis: ANALYSIS, prevSource, round: 3 }, provider);
    const prompt = provider.promptOf(0);
    expect(prompt).toContain('# ROUND 3');
    expect(prompt).toContain('0.45–0.60');
    expect(prompt).toContain('THE STRATEGY THAT JUST LOST');
    expect(prompt).toContain(prevSource.trim().slice(0, 80));
    expect(prompt).toContain('"playerArchetype": "camper"');
  });
});
