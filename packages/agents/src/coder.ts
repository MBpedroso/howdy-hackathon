/**
 * The Coder agent (spec §8): contract + analysis + previous file in, `strategy.js` out.
 *
 * Two decisions worth stating.
 *
 * **The code block is extracted, not trusted.** A reply can arrive with a preamble,
 * a trailing explanation, or the file split across a fenced block and a stray
 * snippet. `extractJsBlock` takes the largest fenced block that looks like a
 * strategy, because "largest" is a better heuristic than "first" when a model
 * illustrates a helper before writing the file.
 *
 * **`staticCheck` runs here, before the harness.** Gate 1 would catch the same
 * thing, but a mention of `Date` is a *typo-class* failure: it costs one of the
 * four harness attempts (spec §6.3) and produces an interlude beat that says
 * nothing interesting. So the Coder gets one immediate self-retry against
 * `staticCheck` — not counted as a harness attempt, but logged and surfaced, so the
 * evidence stays honest about how many model calls the loop actually made.
 *
 * The self-retry is a courtesy, **not a veto**. If the second file is still
 * statically invalid the Coder submits it anyway, flagged `staticInvalid`, and lets
 * Gate 1 reject it for real. Refusing to submit would replace a legible on-screen
 * rejection ("forbidden-identifier: 'Date' may not be mentioned") with an internal
 * error and a silent fallback — and the harness, not this file, is the authority on
 * what ships (spec §6.3).
 */
import { staticCheck, type Violation } from '@rematch/contract';
import type { BalanceRound } from '@rematch/harness';
import {
  coderPrompt,
  promptSize,
  type Analysis,
  type CoderBracket,
  type CoderDial,
  type CoderIncumbent,
  type CoderRejection,
} from './context/prompts.ts';
import { collect, type LLMProvider, type LLMUsage } from './provider.ts';

export type CoderInput = {
  analysis: Analysis;
  prevSource: string;
  round: BalanceRound;
  /**
   * The harness rejection this attempt is answering, verbatim — plus, for a Gate 3
   * rejection, the per-bot rates the loop read out of `GateResult.detail`.
   */
  rejection?: CoderRejection;
  /**
   * Which of the attempt's K parallel candidates this call writes. The only thing
   * that differs between the K prompts of one attempt — see `dialFor`.
   */
  dial?: CoderDial;
  /**
   * The two measured files that straddle the band. When present the prompt shows
   * both instead of `prevSource`, and the dial's `blend` says where between them
   * this candidate is aimed.
   */
  bracket?: CoderBracket;
  /** The measured player profile, already rendered. Same for every candidate of an attempt. */
  profile?: string;
  /**
   * The boss being replaced, measured against the panel and the Mimic. Sent on the
   * first attempt only — see `incumbentAnchor`.
   */
  incumbent?: CoderIncumbent;
};

export type CoderResult = {
  source: string;
  /** Provider calls made (2 means the first file failed `staticCheck`). */
  calls: number;
  usage: LLMUsage;
  promptChars: number;
  ms: number;
  /** Rendered violations from a discarded first file, for the attempt log. */
  selfRetry?: string;
  /**
   * The submitted file still fails `staticCheck` after the self-retry. It is handed
   * to the harness regardless, so Gate 1 produces the rejection the player sees.
   */
  staticInvalid?: true;
};

export type CoderOptions = {
  maxTokens?: number;
  model?: string;
  signal?: AbortSignal;
  /** Called with each text delta — the interlude's Rewrite beat. */
  onDelta?: (delta: string) => void;
  now?: () => number;
};

/**
 * A full strategy is ~100 lines and measures at ~1500 output tokens; 5120 leaves
 * room for comments without inviting an essay.
 *
 * Raised from 4096 after a ten-replay eval in which 3 of 66 candidate files arrived
 * cut off mid-expression — a truncated file costs a whole candidate and reads on
 * screen as a model that cannot write JavaScript. The budget is a ceiling, not a
 * target: nothing is billed for tokens that are not generated.
 */
export const CODER_MAX_TOKENS = 5120;

export async function runCoder(
  input: CoderInput,
  provider: LLMProvider,
  opts: CoderOptions = {},
): Promise<CoderResult> {
  const now = opts.now ?? ((): number => performance.now());
  const started = now();
  const maxTokens = opts.maxTokens ?? CODER_MAX_TOKENS;

  let calls = 0;
  let promptChars = 0;
  const usage: LLMUsage = { inputTokens: 0, outputTokens: 0 };
  let selfRetry: string | undefined;
  let lastProblem = 'the reply contained no ```js block';
  let lastSource: string | undefined;

  for (let pass = 0; pass < 2; pass += 1) {
    const prompt = coderPrompt({
      analysis: input.analysis,
      prevSource: input.prevSource,
      round: input.round,
      ...(input.rejection === undefined ? {} : { rejection: input.rejection }),
      ...(input.dial === undefined ? {} : { dial: input.dial }),
      ...(input.incumbent === undefined ? {} : { incumbent: input.incumbent }),
      ...(input.bracket === undefined ? {} : { bracket: input.bracket }),
      ...(input.profile === undefined ? {} : { profile: input.profile }),
      ...(selfRetry === undefined ? {} : { selfRetry: { violations: selfRetry } }),
    });
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

    const source = extractJsBlock(done.text);
    if (source === undefined) {
      lastProblem = 'the reply contained no ```js block';
      selfRetry = 'Your reply contained no ```js code block at all. Emit exactly one, containing the complete file.';
      continue;
    }
    lastSource = source;

    const check = staticCheck(source);
    if (check.ok) {
      return {
        source,
        calls,
        usage,
        promptChars,
        ms: now() - started,
        ...(selfRetry === undefined ? {} : { selfRetry }),
      };
    }

    lastProblem = renderViolations(check.violations);
    selfRetry = lastProblem;
  }

  // Two passes, still statically invalid — submit it and let Gate 1 say why.
  if (lastSource !== undefined) {
    return {
      source: lastSource,
      calls,
      usage,
      promptChars,
      ms: now() - started,
      staticInvalid: true,
      ...(selfRetry === undefined ? {} : { selfRetry }),
    };
  }

  // Nothing to submit at all: two replies with no code block in either.
  throw new Error(`the Coder produced no strategy file in 2 passes: ${lastProblem}`);
}

// ------------------------------------------------------------------ extraction

const FENCE = /```(?<lang>[a-zA-Z]*)\r?\n(?<body>[\s\S]*?)```/g;

/**
 * Pull the `strategy.js` out of a reply.
 *
 * Preference order: fenced blocks tagged `js`/`javascript` that export `decide`,
 * then any fenced block that exports `decide`, then — for a model that skipped the
 * fence entirely — the raw text if it looks like a module. Among equally good
 * candidates the largest wins: a reply that shows a two-line snippet and then the
 * real file should yield the real file.
 */
export function extractJsBlock(text: string): string | undefined {
  type Candidate = { body: string; rank: number };
  const candidates: Candidate[] = [];

  for (const match of text.matchAll(FENCE)) {
    const body = (match.groups?.['body'] ?? '').trim();
    if (body.length === 0) continue;
    const lang = (match.groups?.['lang'] ?? '').toLowerCase();
    const tagged = lang === 'js' || lang === 'javascript' || lang === 'mjs';
    const strategy = looksLikeStrategy(body);
    candidates.push({ body, rank: (tagged ? 2 : 0) + (strategy ? 4 : 0) });
  }

  if (candidates.length === 0) {
    const raw = text.trim();
    return looksLikeStrategy(raw) ? raw : undefined;
  }

  candidates.sort((a, b) => b.rank - a.rank || b.body.length - a.body.length);
  return candidates[0]?.body;
}

/** `export function decide` is the one thing every conforming file must contain. */
function looksLikeStrategy(source: string): boolean {
  return /export\s+(?:function|const|let|var)?\s*decide/.test(source) || /export\s*\{[^}]*\bdecide\b/.test(source);
}

/**
 * Gate 1's violations, rendered the way the harness renders a rejection: rule id
 * first, one per line, line numbers when known. The Coder therefore sees the same
 * vocabulary in a self-retry as it will see in a real Gate 1 rejection.
 */
export function renderViolations(violations: readonly Violation[]): string {
  return violations
    .map((v) => `  ${v.rule}: ${v.message}${v.line === undefined ? '' : ` (line ${v.line})`}`)
    .join('\n');
}
