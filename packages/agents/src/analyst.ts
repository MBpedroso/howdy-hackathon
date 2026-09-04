/**
 * The Analyst agent (spec §8): compressed replay in, prose and structured
 * observations out.
 *
 * ## Prose first, JSON second
 *
 * The reply has two parts (see `ANALYST_SYSTEM`): 3-6 plain sentences, then a
 * fenced JSON block. That order is a product decision, not a formatting one. Spec
 * §2.2's Analysis beat is a typewriter — *"Player camped the bottom-left corner.
 * Attacked only during my slam cooldown. Dashed 11 times, always left."* — and a
 * player watching JSON scroll past learns nothing from the one beat that is meant
 * to be about *them*. So the prose is what streams (`onDelta`), the JSON is what
 * the Coder is handed, and `analysisGate` stops the deltas at the opening fence so
 * the player never sees the machine-readable half.
 *
 * The raw reply — both halves — is kept and reported on `analysis.done`: the
 * player gets the prose, a judge reading the log gets the bytes.
 *
 * ## Parsed defensively
 *
 * The one thing the interlude cannot do is stall on a stray "Here's the analysis:".
 * A model that wraps its JSON in a fence, prefixes a sentence, or appends a summary
 * has still done the work; discarding that and burning 4 s on a retry would be a
 * worse product than tolerating the wrapper. So: prefer the fenced block, fall back
 * to the outermost balanced object, fall back to the *prose* for `observations` if
 * the block omits them, and only retry when there is genuinely nothing usable —
 * once, with the parse error appended.
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
  /** The reply in full: the streamed prose and the JSON block that was withheld. */
  raw: string;
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
  /**
   * Called with each text delta of the **prose**, and nothing after the opening
   * fence of the JSON block — the interlude's Analysis beat is a typewriter for a
   * human, not a JSON viewer. The full reply is on the result's `raw`.
   */
  onDelta?: (delta: string) => void;
  now?: () => number;
};

/**
 * 3-6 sentences plus a small JSON block measures at ~600 output tokens. 1800 is
 * headroom for a wordy reply; raised from 1200 after one eval run in which the
 * Analyst's reply was cut off before its fenced block and the whole rewrite fell
 * back for want of ~200 tokens.
 */
export const ANALYST_MAX_TOKENS = 1800;

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
      opts.onDelta === undefined ? undefined : analysisGate(opts.onDelta),
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
        raw: done.text,
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

// ------------------------------------------------------------------ streaming

/** The fence that opens the JSON half of a reply. */
const FENCE = '```';

/**
 * Wrap an `onDelta` so it forwards the prose and stops at the JSON block.
 *
 * Two details make it correct rather than approximately correct:
 *
 *  - **The fence can arrive split across deltas.** A provider is free to send
 *    `` "…left.\n\n`" `` and then `` "``json\n{" ``, so up to two trailing
 *    backticks are held back until the next delta proves what they were. Without
 *    that, a stray `` ` `` reaches the screen a moment before the gate closes.
 *  - **It closes permanently.** Everything after the opening fence is dropped,
 *    including a trailing sentence after the block — the beat is finished being
 *    typed, and re-opening it would look like a glitch.
 *
 * A reply with no fence at all (a model that answers with bare JSON) streams
 * unchanged. That is the honest failure mode: the prose is what is missing, and
 * `parseAnalysis` still gets its object.
 */
export function analysisGate(onDelta: (delta: string) => void): (delta: string) => void {
  let held = '';
  let closed = false;

  return (delta: string): void => {
    if (closed) return;
    const text = held + delta;
    const fence = text.indexOf(FENCE);
    if (fence >= 0) {
      closed = true;
      held = '';
      const head = text.slice(0, fence);
      if (head !== '') onDelta(head);
      return;
    }
    // Hold back a partial fence (one or two backticks at the very end).
    let keep = 0;
    while (keep < 2 && text.length - keep > 0 && text[text.length - 1 - keep] === '`') keep += 1;
    held = keep === 0 ? '' : text.slice(text.length - keep);
    const emit = keep === 0 ? text : text.slice(0, text.length - keep);
    if (emit !== '') onDelta(emit);
  };
}

// -------------------------------------------------------------------- parsing

export type ParseResult = { ok: true; analysis: Analysis } | { ok: false; error: string };

/**
 * The fenced JSON block of a reply, if there is one.
 *
 * Preferred over `extractJsonObject` because the prose half is now allowed to
 * contain anything a sentence can contain, braces included ("lived in cell {56}"
 * is a thing a model writes). The fence is an explicit boundary; scanning for a
 * balanced object is the fallback for a reply that skipped it.
 */
export function extractFencedJson(text: string): string | undefined {
  const match = /```(?:json|JSON)?\s*\r?\n([\s\S]*?)```/.exec(text);
  const body = match?.[1]?.trim();
  return body === undefined || body.length === 0 ? undefined : body;
}

/**
 * The prose half: everything before the first fence.
 *
 * This is what the player was shown, so it is also the right fallback for
 * `observations` — if the JSON block omits them, the sentences on screen and the
 * sentences the Coder reads are then the same sentences, which is the property that
 * makes the beat honest.
 */
export function proseSentences(text: string): string[] {
  const fence = text.indexOf(FENCE);
  const prose = (fence < 0 ? text : text.slice(0, fence)).trim();
  if (prose.length === 0) return [];
  return prose
    .split(/\n\s*\n/)
    .flatMap((paragraph) => paragraph.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/))
    .map((sentence) => sentence.trim().replace(/^[-*\u2022]\s*/, ''))
    // A bare `{` or a fragment of a JSON key is not an observation.
    .filter((sentence) => sentence.length > 2 && !sentence.startsWith('{') && !sentence.startsWith('"'))
    .slice(0, 6);
}

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
  // The fenced block first — the prose half may legitimately contain braces.
  const fenced = extractFencedJson(text);
  const json = extractJsonObject(fenced ?? text);
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
  const listed =
    Array.isArray(observations) && observations.every((o) => typeof o === 'string')
      ? (observations as string[]).map((o) => o.trim()).filter((o) => o.length > 0)
      : [];
  // The prose the player watched is the fallback, so a block that forgot
  // `observations` costs a retry only when there was no prose either. What the
  // Coder reads is then exactly what was on screen.
  const clean = listed.length > 0 ? listed : proseSentences(text);
  if (clean.length === 0) {
    return {
      ok: false,
      error:
        Array.isArray(observations) && observations.some((o) => typeof o !== 'string')
          ? 'observations must be an array of strings'
          : 'no observations: give 3 to 6 prose sentences before the JSON block, or an observations array inside it',
    };
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
