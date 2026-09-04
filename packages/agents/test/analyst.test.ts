/**
 * The Analyst: JSON parsing that tolerates the ways a model actually replies, and
 * one retry when it does not.
 */
import { describe, expect, it } from 'vitest';
import { extractJsonObject, mockProvider, parseAnalysis, runAnalyst } from '../src/index.ts';
import { cannedSummary } from './helpers.ts';

const GOOD = {
  observations: ['Lived in cell 63 for 93% of the round.', 'Never dashed.', 'Fired 163 shots.'],
  playerArchetype: 'camper',
  counterPlan: 'Slam the bottom-right corner and hold mid range.',
};

describe('extractJsonObject', () => {
  it('takes bare JSON', () => {
    expect(extractJsonObject('{"a":1}')).toBe('{"a":1}');
  });

  it('strips a ```json fence', () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toContain('"a":1');
  });

  it('survives a preamble and a trailing paragraph', () => {
    const text = 'Here is the analysis:\n\n{"a":1}\n\nLet me know if you want more detail.';
    expect(extractJsonObject(text)).toBe('{"a":1}');
  });

  it('does not stop at a brace inside a string', () => {
    const text = '{"counterPlan":"use { and } here","a":1}';
    expect(extractJsonObject(text)).toBe(text);
  });

  it('handles nested objects and escaped quotes', () => {
    const text = '{"a":{"b":"he said \\"hi\\" }"},"c":2}';
    expect(extractJsonObject(text)).toBe(text);
  });

  it('returns undefined when there is no object at all', () => {
    expect(extractJsonObject('I could not analyse this round.')).toBeUndefined();
  });
});

describe('parseAnalysis', () => {
  it('accepts a clean reply', () => {
    const result = parseAnalysis(JSON.stringify(GOOD));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.analysis.playerArchetype).toBe('camper');
  });

  it('accepts a fenced, prefixed, suffixed reply', () => {
    const dirty = `Sure — here's what I saw.\n\n\`\`\`json\n${JSON.stringify(GOOD, null, 2)}\n\`\`\`\n\nHappy to go deeper.`;
    const result = parseAnalysis(dirty);
    expect(result.ok).toBe(true);
  });

  it('trims observations and drops empty ones', () => {
    const result = parseAnalysis(JSON.stringify({ ...GOOD, observations: ['  a  ', '', '   ', 'b'] }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.analysis.observations).toEqual(['a', 'b']);
  });

  it('rejects an unknown archetype with an actionable message', () => {
    const result = parseAnalysis(JSON.stringify({ ...GOOD, playerArchetype: 'aggressive' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('"aggressive"');
      expect(result.error).toContain('camper, kiter, rusher, dodger, mixed');
    }
  });

  it('rejects a missing counterPlan, an empty observations array, and a non-object', () => {
    expect(parseAnalysis(JSON.stringify({ ...GOOD, counterPlan: '  ' })).ok).toBe(false);
    expect(parseAnalysis(JSON.stringify({ ...GOOD, observations: [] })).ok).toBe(false);
    expect(parseAnalysis(JSON.stringify({ ...GOOD, observations: [1, 2] })).ok).toBe(false);
    expect(parseAnalysis('[1,2,3]').ok).toBe(false);
  });

  it('reports a truncated object rather than throwing', () => {
    const result = parseAnalysis('{"observations":["a"],"playerArchetype":');
    expect(result.ok).toBe(false);
  });
});

describe('runAnalyst', () => {
  const summary = cannedSummary('camper-a');

  it('parses a good first reply in one call and streams deltas', async () => {
    const provider = mockProvider([JSON.stringify(GOOD)], { chunkSize: 16 });
    const deltas: string[] = [];
    const result = await runAnalyst({ summary, round: 1 }, provider, { onDelta: (d) => deltas.push(d) });

    expect(result.calls).toBe(1);
    expect(result.playerArchetype).toBe('camper');
    expect(result.observations).toHaveLength(3);
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join('')).toBe(JSON.stringify(GOOD));
    expect(result.promptChars).toBeGreaterThan(1000);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
  });

  it('retries once with the parse error appended, then succeeds', async () => {
    const provider = mockProvider(['I think the player camped.', JSON.stringify(GOOD)]);
    const result = await runAnalyst({ summary, round: 1 }, provider);

    expect(result.calls).toBe(2);
    expect(result.parseError).toContain('no JSON object');
    // The retry says what went wrong. It does not echo the unparseable reply back.
    const retryPrompt = provider.promptOf(1);
    expect(retryPrompt).toContain('could not be parsed');
    expect(retryPrompt).not.toContain('I think the player camped.');
    expect(provider.calls[1]!.messages).toHaveLength(2);
  });

  it('gives up after two bad replies, so the loop can fall back', async () => {
    const provider = mockProvider(['nope', 'still nope']);
    await expect(runAnalyst({ summary, round: 1 }, provider)).rejects.toThrow(/after 2 attempts/);
    expect(provider.calls).toHaveLength(2);
  });

  it('reads the round that was played, not the round being written', async () => {
    const provider = mockProvider([JSON.stringify(GOOD)]);
    await runAnalyst({ summary, round: 1 }, provider);
    expect(provider.promptOf(0)).toContain('The player won round 1. Round 2 is being written now.');
  });
});
