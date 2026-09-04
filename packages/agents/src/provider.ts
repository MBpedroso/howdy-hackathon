/**
 * The LLM boundary.
 *
 * Everything above this file (the Analyst, the Coder, the loop) talks to a
 * `LLMProvider` and nothing else. Two consequences the whole package depends on:
 *
 *  1. The rewrite loop is fully testable with **no API key and no network** — the
 *     mock provider replays a script, including the "invalid first, valid second"
 *     shape that exercises the retry path (spec §6.3).
 *  2. The interlude is a stream. `stream()` yields text deltas as they arrive so
 *     the Analysis and Rewrite beats can start rendering within a second or two of
 *     the request; the 45 s interlude budget (spec AC 5) is mostly *waiting*, and
 *     waiting is only content if it is visibly moving.
 *
 * There is deliberately no tool use, no structured-output constraint and no
 * thinking configuration here. Both agents ask for JSON or a fenced code block in
 * plain text and the callers parse defensively — the Coder's output is code that a
 * deterministic harness will judge anyway, so a schema on the way out buys nothing
 * that Gate 1 does not already buy.
 */
import Anthropic from '@anthropic-ai/sdk';

export type LLMRole = 'user' | 'assistant';

export type LLMMessage = {
  role: LLMRole;
  content: string;
};

export type LLMRequest = {
  system: string;
  messages: readonly LLMMessage[];
  maxTokens: number;
  /** Overrides the provider's default model. */
  model?: string;
  /** Aborts the stream mid-flight — the loop's deadline uses this. */
  signal?: AbortSignal;
};

export type LLMUsage = {
  inputTokens: number;
  outputTokens: number;
  /** Cached-prefix reads, when the provider reports them. */
  cacheReadTokens?: number;
};

export type LLMEvent =
  | { type: 'text'; delta: string }
  | { type: 'done'; text: string; usage: LLMUsage; model: string };

export type LLMProvider = {
  /** A label for logs and the eval table (`anthropic:claude-sonnet-5`, `mock`). */
  readonly name: string;
  /** The model this provider will use when a request does not name one. */
  readonly model: string;
  stream(req: LLMRequest): AsyncIterable<LLMEvent>;
};

// ------------------------------------------------------------------- models

/**
 * Sonnet-class by default, not Opus-class, and this is the one place in the repo
 * where that is the right call: the interlude has a 45 s wall-clock budget (spec
 * AC 5) that has to cover an Analyst call, up to four Coder calls, and four gates
 * including 200 simulated matches. Latency is the binding constraint, not depth —
 * the Coder is writing ~80 lines against a frozen contract with a deterministic
 * verifier behind it, and a rejection costs one more cheap attempt rather than a
 * wrong answer. Override per agent when you want to trade seconds for quality.
 */
export const DEFAULT_MODEL = 'claude-sonnet-5';

/** `REMATCH_MODEL` sets both agents; the per-agent vars win over it. */
export const MODEL_ENV = {
  both: 'REMATCH_MODEL',
  analyst: 'REMATCH_ANALYST_MODEL',
  coder: 'REMATCH_CODER_MODEL',
} as const;

export type AgentKind = 'analyst' | 'coder';

/** Resolve the model for one agent: per-agent env → shared env → default. */
export function modelFor(kind: AgentKind, env: Record<string, string | undefined> = process.env): string {
  return env[MODEL_ENV[kind]] ?? env[MODEL_ENV.both] ?? DEFAULT_MODEL;
}

// --------------------------------------------------------- anthropic provider

export type AnthropicProviderOptions = {
  apiKey?: string;
  model?: string;
  /** Injected in tests; defaults to a real SDK client. */
  client?: Pick<Anthropic['messages'], 'stream'>;
  /** Per-request timeout, milliseconds. Default 60 s — the loop's deadline is tighter. */
  timeoutMs?: number;
};

/**
 * The real provider: `@anthropic-ai/sdk`, streaming.
 *
 * Streaming is not optional here. It is what makes the Analysis and Rewrite beats
 * beats instead of spinners, and it keeps a long Coder response away from the
 * SDK's non-streaming HTTP timeout.
 */
export function anthropicProvider(opts: AnthropicProviderOptions = {}): LLMProvider {
  const model = opts.model ?? DEFAULT_MODEL;
  const apiKey = opts.apiKey ?? process.env['ANTHROPIC_API_KEY'] ?? process.env['ANTHROPIC_AUTH_TOKEN'];

  // Built lazily so constructing a provider is free and safe (the server builds
  // one per process; a missing key must fail at call time, with a message about
  // the fallback pool, not at import time).
  let messages: Pick<Anthropic['messages'], 'stream'> | undefined = opts.client;
  const getMessages = (): Pick<Anthropic['messages'], 'stream'> => {
    if (messages === undefined) {
      if (apiKey === undefined || apiKey === '') {
        // Deliberately explicit rather than letting the SDK resolve an `ant auth
        // login` profile: the server has to be able to tell, *before* a player
        // finishes round 1, whether the rewrite loop can run at all — and if it
        // cannot, say "using a pre-approved strategy" instead of failing mid-beat
        // (spec AC 5). Pass `apiKey` explicitly to use a profile credential.
        throw new Error(
          'anthropicProvider: no ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN — the rewrite loop cannot run; use the fallback pool',
        );
      }
      messages = new Anthropic({ apiKey, timeout: opts.timeoutMs ?? 60_000 }).messages;
    }
    return messages;
  };

  return {
    name: `anthropic:${model}`,
    model,
    async *stream(req: LLMRequest): AsyncIterable<LLMEvent> {
      const stream = getMessages().stream(
        {
          model: req.model ?? model,
          max_tokens: req.maxTokens,
          // The system prompt is the large, stable half of both agents' context
          // (the Boss Contract doc is ~6 KB and byte-identical across attempts),
          // so it is the cache prefix. Everything that changes per attempt — the
          // analysis, the previous source, the rejection reason — is in messages.
          system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
          messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
        },
        req.signal === undefined ? {} : { signal: req.signal },
      );

      let text = '';
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          text += event.delta.text;
          yield { type: 'text', delta: event.delta.text };
        }
      }

      const final = await stream.finalMessage();
      yield {
        type: 'done',
        text,
        model: final.model,
        usage: {
          inputTokens: final.usage.input_tokens,
          outputTokens: final.usage.output_tokens,
          ...(final.usage.cache_read_input_tokens === null ||
          final.usage.cache_read_input_tokens === undefined
            ? {}
            : { cacheReadTokens: final.usage.cache_read_input_tokens }),
        },
      };
    },
  };
}

// -------------------------------------------------------------- mock provider

export type MockStep = {
  /** The full response text this call returns. */
  text: string;
  /** Milliseconds to wait before the first delta. Used by the deadline test. */
  delayMs?: number;
  /** Never resolve — a hung provider. The loop must abort it via `signal`. */
  stall?: boolean;
  usage?: Partial<LLMUsage>;
};

export type MockScript = readonly (MockStep | string)[];

export type MockCall = {
  system: string;
  messages: LLMMessage[];
  maxTokens: number;
  model: string;
};

export type MockProvider = LLMProvider & {
  /** Every request the provider was handed, in order. The tests assert on these. */
  readonly calls: readonly MockCall[];
  /** The prompt text of call `i`: system + every message, as the model saw it. */
  promptOf(index: number): string;
};

/**
 * A scripted provider. One entry per expected call, in order; the last entry
 * repeats if the caller asks for more.
 *
 * The point is not to avoid the network — it is that the loop's interesting
 * behaviour *is* the sequence of bad-then-good responses, so the tests have to be
 * able to state that sequence exactly:
 *
 * ```ts
 * mockProvider([usesDateSource, tooHardSource, goodSource])
 * ```
 */
export function mockProvider(script: MockScript, opts: { model?: string; chunkSize?: number } = {}): MockProvider {
  const model = opts.model ?? 'mock-model';
  const chunk = Math.max(1, opts.chunkSize ?? 64);
  const steps: MockStep[] = script.map((s) => (typeof s === 'string' ? { text: s } : s));
  const calls: MockCall[] = [];
  let index = 0;

  return {
    name: 'mock',
    model,
    calls,
    promptOf(i: number): string {
      const call = calls[i];
      if (call === undefined) throw new Error(`mockProvider: no call at index ${i} (${calls.length} recorded)`);
      return [call.system, ...call.messages.map((m) => m.content)].join('\n');
    },
    async *stream(req: LLMRequest): AsyncIterable<LLMEvent> {
      calls.push({
        system: req.system,
        messages: req.messages.map((m) => ({ ...m })),
        maxTokens: req.maxTokens,
        model: req.model ?? model,
      });
      const step = steps[Math.min(index, steps.length - 1)] ?? { text: '' };
      index += 1;

      if (step.delayMs !== undefined) await sleep(step.delayMs, req.signal);
      if (step.stall === true) {
        // Hang until aborted. `sleep` rejects on abort, which is exactly what a
        // real provider does when the loop cancels it at the deadline.
        await sleep(Number.MAX_SAFE_INTEGER, req.signal);
      }
      throwIfAborted(req.signal);

      // Deltas in chunks, like a real stream — the interlude's delta handlers are
      // then exercised by the tests rather than only by production.
      for (let i = 0; i < step.text.length; i += chunk) {
        throwIfAborted(req.signal);
        yield { type: 'text', delta: step.text.slice(i, i + chunk) };
      }

      yield {
        type: 'done',
        text: step.text,
        model: req.model ?? model,
        usage: {
          inputTokens: step.usage?.inputTokens ?? estimateTokens(req),
          outputTokens: step.usage?.outputTokens ?? Math.ceil(step.text.length / 4),
          ...(step.usage?.cacheReadTokens === undefined ? {} : { cacheReadTokens: step.usage.cacheReadTokens }),
        },
      };
    },
  };
}

/** ~4 chars per token. Good enough for a mock's usage numbers; never billed. */
function estimateTokens(req: LLMRequest): number {
  const chars = req.system.length + req.messages.reduce((n, m) => n + m.content.length, 0);
  return Math.ceil(chars / 4);
}

export class AbortError extends Error {
  override readonly name = 'AbortError';
  constructor(message = 'the provider stream was aborted') {
    super(message);
  }
}

/** True for both our `AbortError` and the SDK's / undici's abort shapes. */
export function isAbortError(err: unknown): boolean {
  if (err instanceof AbortError) return true;
  if (typeof err !== 'object' || err === null) return false;
  const name = (err as { name?: unknown }).name;
  return name === 'AbortError' || name === 'APIUserAbortError';
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new AbortError();
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new AbortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.min(ms, 2 ** 31 - 1));
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new AbortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Drain a stream to its `done` event. Used wherever deltas are not needed. */
export async function collect(
  provider: LLMProvider,
  req: LLMRequest,
  onDelta?: (delta: string) => void,
): Promise<{ text: string; usage: LLMUsage; model: string }> {
  let done: { text: string; usage: LLMUsage; model: string } | undefined;
  for await (const event of provider.stream(req)) {
    if (event.type === 'text') onDelta?.(event.delta);
    else done = { text: event.text, usage: event.usage, model: event.model };
  }
  if (done === undefined) throw new Error(`${provider.name}: stream ended without a done event`);
  return done;
}
