/**
 * The Analyst agent (spec §8): compressed replay in, structured observations out.
 *
 * It is asked for JSON and the reply is parsed **defensively**, because the one
 * thing the interlude cannot do is stall on a stray "Here's the analysis:". A
 * model that wraps its JSON in a fence, prefixes a sentence, or appends a summary
 * has still done the work; discarding that and burning 4 s on a retry would be a
 * worse product than tolerating the wrapper. So: strip fences, find the outermost
 * balanced object, validate the shape, and only retry when there is genuinely
 * nothing usable — once, with the parse error appended.
 */
import type { ReplaySummary } from '@rematch/engine';
import type { StrategyMeta } from '@rematch/contract';
import { analystPrompt, promptSize, ARCHETYPES, type Analysis, type PlayerArchetype } from './context/prompts.ts';
import { collect, type LLMProvider, type LLMUsage } from './provider.ts';

export type AnalystInput = {
  summary: ReplaySummary;
  round: number;
  prevMeta?: StrategyMeta;
};

export type AnalystResult = Analysis & {
  /** How many provider calls it took (2 means the first reply was unparseable). */
  calls: number;
  usage: LLMUsage;
  promptChars: number;
  ms: number;
  /** The parse error from a discarded first reply, for the attempt log. */
  parseError?: string;
};

export type AnalystOptions = {
  maxTokens?: number;
  model?: string;
  signal?: AbortSignal;
  /** Called with each text delta — the interlude's Analysis beat. */
  onDelta?: (delta: string) => void;
  now?: () => number;
};

export const ANALYST_MAX_TOKENS = 1200;

/**
 * Run the Analyst. Resolves with a validated `Analysis`; throws only if both the
 * first reply and the retry are unusable (the loop turns that into a fallback).
 */
export async function runAnalyst(
  input: AnalystInput,
  provider: LLMProvider,
  opts: AnalystOptions = {},
): Promise<AnalystResult> {
  const now = opts.now ?? ((): number => performance.now());
  const started = now();
  const maxTokens = opts.maxTokens ?? ANALYST_MAX_TOKENS;

  let calls = 0;
  let promptChars = 0;
  const usage: LLMUsage = { inputTokens: 0, outputTokens: 0 };
  let firstError: string | undefined;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const prompt = analystPrompt(
      {
        summary: input.summary,
        round: input.round,
        ...(input.prevMeta === undefined ? {} : { prevMeta: input.prevMeta }),
      },
      firstError,
    );
    promptChars = promptSize(prompt);

    const done = await collect(
      provider,
      {
        system: prompt.system,
        messages: prompt.messages,
        maxTokens,
        ...(opts.model === undefined ? {} : { model: opts.model }),
        ...(opts.signal === undefined ? {} : { signal: opts.signal }),
      },
      opts.onDelta,
    );
    calls += 1;
    usage.inputTokens += done.usage.inputTokens;
    usage.outputTokens += done.usage.outputTokens;
    if (done.usage.cacheReadTokens !== undefined) {
      usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + done.usage.cacheReadTokens;
    }

    const parsed = parseAnalysis(done.text);
    if (parsed.ok) {
      return {
        ...parsed.analysis,
        calls,
        usage,
        promptChars,
        ms: now() - started,
        ...(firstError === undefined ? {} : { parseError: firstError }),
      };
    }
    firstError = parsed.error;
  }

  throw new Error(`the Analyst returned nothing usable after 2 attempts: ${firstError ?? 'unknown'}`);
}

// -------------------------------------------------------------------- parsing

export type ParseResult = { ok: true; analysis: Analysis } | { ok: false; error: string };

/**
 * Find the outermost balanced `{…}` in a blob of text, ignoring braces inside
 * string literals.
 *
 * A regex cannot do this: `counterPlan` routinely contains braces and quotes, and
 * a greedy `\{.*\}` would also swallow a trailing "Let me know if…" paragraph's
 * punctuation. Scanning with a depth counter and a string-literal flag is ~20
 * lines and correct.
 */
export function extractJsonObject(text: string): string | undefined {
  const stripped = text.replace(/```(?:json|JSON)?\s*/g, '').replace(/```/g, '');
  const start = stripped.indexOf('{');
  if (start < 0) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < stripped.length; i += 1) {
    const ch = stripped[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return stripped.slice(start, i + 1);
    }
  }
  return undefined;
}

function isArchetype(value: unknown): value is PlayerArchetype {
  return typeof value === 'string' && (ARCHETYPES as readonly string[]).includes(value);
}

/**
 * Parse and shape-check one Analyst reply.
 *
 * Deliberately not a schema library. The shape is three fields; the value of a
 * hand-rolled check is that every rejection message is a sentence the retry can
 * act on ("playerArchetype was 'aggressive'; it must be one of camper, kiter, …"),
 * which a generic validator's path-based errors are not.
 */
export function parseAnalysis(text: string): ParseResult {
  const json = extractJsonObject(text);
  if (json === undefined) {
    return { ok: false, error: 'no JSON object was found in the reply' };
  }

  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (err) {
    return { ok: false, error: `the JSON object did not parse: ${(err as Error).message}` };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: 'the top-level JSON value was not an object' };
  }

  const raw = value as Record<string, unknown>;
  const observations = raw['observations'];
  if (!Array.isArray(observations) || observations.some((o) => typeof o !== 'string')) {
    return { ok: false, error: 'observations must be an array of strings' };
  }
  const clean = (observations as string[]).map((o) => o.trim()).filter((o) => o.length > 0);
  if (clean.length === 0) {
    return { ok: false, error: 'observations was empty; give 3 to 6 observations' };
  }

  const archetype = raw['playerArchetype'];
  if (!isArchetype(archetype)) {
    return {
      ok: false,
      error: `playerArchetype was ${JSON.stringify(archetype)}; it must be one of ${ARCHETYPES.join(', ')}`,
    };
  }

  const counterPlan = raw['counterPlan'];
  if (typeof counterPlan !== 'string' || counterPlan.trim().length === 0) {
    return { ok: false, error: 'counterPlan must be a non-empty string' };
  }

  return {
    ok: true,
    analysis: { observations: clean, playerArchetype: archetype, counterPlan: counterPlan.trim() },
  };
}
