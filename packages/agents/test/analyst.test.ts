/**
 * The Analyst: JSON parsing that tolerates the ways a model actually replies, and
 * one retry when it does not.
 */
import { describe, expect, it } from 'vitest';
import {
  analysisGate,
  extractFencedJson,
  extractJsonObject,
  mockProvider,
  parseAnalysis,
  proseSentences,
  runAnalyst,
} from '../src/index.ts';
import { asAnalystReply, cannedSummary } from './helpers.ts';

/** The reply the prompt actually asks for: prose, then a fenced JSON block. */
const PROSE = 'Player camped the bottom-left corner. Attacked only during my slam cooldown. Dashed 11 times, always left.';

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

  it('accepts the two-part reply the prompt asks for', () => {
    const result = parseAnalysis(asAnalystReply(GOOD));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.analysis.observations).toEqual(GOOD.observations);
      expect(result.analysis.playerArchetype).toBe('camper');
    }
  });

  it('falls back to the prose when the JSON block omits observations', () => {
    // The player already watched these sentences; the Coder should read the same
    // ones rather than the loop spending 4 s on a retry for a missing key.
    const reply = `${PROSE}\n\n\`\`\`json\n{"playerArchetype":"camper","counterPlan":"Slam the corner."}\n\`\`\``;
    const result = parseAnalysis(reply);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.analysis.observations).toEqual([
        'Player camped the bottom-left corner.',
        'Attacked only during my slam cooldown.',
        'Dashed 11 times, always left.',
      ]);
    }
  });

  it('prefers the block\'s observations over the prose when it has both', () => {
    const reply = `Some looser prose about the round.\n\n\`\`\`json\n${JSON.stringify(GOOD)}\n\`\`\``;
    const result = parseAnalysis(reply);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.analysis.observations).toEqual(GOOD.observations);
  });

  it('fails only when there is neither prose nor observations', () => {
    const bare = `\`\`\`json\n{"playerArchetype":"camper","counterPlan":"x"}\n\`\`\``;
    const result = parseAnalysis(bare);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('no observations');
  });
});

describe('the prose half', () => {
  it('splits the streamed prose into sentences', () => {
    expect(proseSentences(PROSE)).toEqual([
      'Player camped the bottom-left corner.',
      'Attacked only during my slam cooldown.',
      'Dashed 11 times, always left.',
    ]);
  });

  it('stops at the fence, so the JSON never becomes an observation', () => {
    const reply = `${PROSE}\n\n\`\`\`json\n{"playerArchetype":"camper"}\n\`\`\`\n`;
    const sentences = proseSentences(reply);
    expect(sentences).toHaveLength(3);
    expect(sentences.join(' ')).not.toContain('playerArchetype');
  });

  it('caps at 6 sentences and drops fragments', () => {
    const many = Array.from({ length: 9 }, (_, i) => `Sentence ${i}.`).join(' ');
    expect(proseSentences(many)).toHaveLength(6);
    expect(proseSentences('')).toEqual([]);
    expect(proseSentences('   \n  ')).toEqual([]);
    // A bulleted list is prose too; the marker is not part of the observation.
    expect(proseSentences('- Camped the corner.')).toEqual(['Camped the corner.']);
  });

  it('prefers the fenced block over a brace in the prose', () => {
    const reply = `Lived in cell {56} for 93% of the round.\n\n\`\`\`json\n{"a":1}\n\`\`\``;
    expect(extractFencedJson(reply)).toBe('{"a":1}');
    expect(extractFencedJson('no fence here {"a":1}')).toBeUndefined();
  });
});

describe('analysisGate', () => {
  const collect = (chunks: readonly string[]): string => {
    const out: string[] = [];
    const gate = analysisGate((delta) => void out.push(delta));
    for (const chunk of chunks) gate(chunk);
    return out.join('');
  };

  it('forwards the prose and drops everything from the fence on', () => {
    expect(collect([`${PROSE}\n\n\`\`\`json\n{"a":1}\n\`\`\`\n`])).toBe(`${PROSE}\n\n`);
  });

  it('holds back a fence that arrives split across deltas', () => {
    // The failure this prevents: a lone backtick flashing on screen a moment
    // before the gate closes.
    expect(collect(['Camped. ', 'Dashed.\n\n`', '``json\n{"a":1}'])).toBe('Camped. Dashed.\n\n');
    expect(collect(['Camped.', '`', '`', '`json\n{}'])).toBe('Camped.');
  });

  it('stays closed, so a trailing sentence after the block is not typed out', () => {
    expect(collect([`Camped.\n\`\`\`json\n{}\n\`\`\`\n`, 'Let me know if you want more.'])).toBe('Camped.\n');
  });

  it('passes a fenceless reply through unchanged', () => {
    // A model that answers with bare JSON is a degraded case, not a broken one:
    // the player sees the JSON, and `parseAnalysis` still gets its object.
    const json = '{"observations":["a"],"playerArchetype":"camper","counterPlan":"x"}';
    expect(collect([json])).toBe(json);
    // A backtick in the prose is not a fence.
    expect(collect(['Camped in `cell 56`. Done.'])).toBe('Camped in `cell 56`. Done.');
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

  it('streams the prose, withholds the JSON block, and keeps the whole reply', async () => {
    const reply = asAnalystReply(GOOD);
    const provider = mockProvider([reply], { chunkSize: 12 });
    const deltas: string[] = [];
    const result = await runAnalyst({ summary, round: 1 }, provider, { onDelta: (d) => deltas.push(d) });

    const streamed = deltas.join('');
    // What the player sees: sentences, no fence, no field names.
    expect(streamed).toContain(GOOD.observations[0]);
    expect(streamed).not.toContain('```');
    expect(streamed).not.toContain('"counterPlan"');
    // What the judges get: the reply, whole.
    expect(result.raw).toBe(reply);
    expect(result.raw).toContain('```json');
    expect(result.observations).toEqual(GOOD.observations);
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
