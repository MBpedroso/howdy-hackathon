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

/**
 * Resolve the model for one agent: per-agent env → shared env → default.
 *
 * `defaultModel` exists because the default is now vendor-dependent — `selectProvider`
 * passes the chosen vendor's default so that `REMATCH_PROVIDER=openai` with no model
 * variable does not resolve to a Claude model id.
 */
export function modelFor(
  kind: AgentKind,
  env: Record<string, string | undefined> = process.env,
  defaultModel: string = DEFAULT_MODEL,
): string {
  return env[MODEL_ENV[kind]] ?? env[MODEL_ENV.both] ?? defaultModel;
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

// ------------------------------------------------------------ openai provider

/**
 * The OpenAI default is a "mini"-class GPT-5 model for exactly the reason the
 * Anthropic default is Sonnet-class and not Opus-class: the interlude has a 45 s
 * wall-clock budget (spec AC 5) covering one Analyst call, up to four Coder calls
 * and four gates, one of which simulates 200 matches. `gpt-5.4-mini` is the newest
 * mini in the installed SDK's `ChatModel` union and writes ~80 lines of contract-
 * shaped JavaScript in a few seconds. Override with `REMATCH_CODER_MODEL`.
 */
export const OPENAI_DEFAULT_MODEL = 'gpt-5.4-mini';

/**
 * Reasoning effort. `low` rather than the model's default, and this is a latency
 * decision, not a quality one: the Coder writes against a frozen contract with a
 * deterministic verifier behind it, so an extra attempt is cheaper than an extra
 * ten seconds of thinking on every attempt. `REMATCH_REASONING_EFFORT=medium`
 * trades it back; `none` asks the model not to think at all; the sentinel `off`
 * omits the block entirely, for a model that does not accept one. (`none` is a
 * real OpenAI effort value, so it is passed through rather than used as the
 * sentinel — the two mean different things and the difference is billable.)
 */
export const OPENAI_DEFAULT_EFFORT = 'low';
/** `REMATCH_REASONING_EFFORT=off` — send no `reasoning` block at all. */
export const EFFORT_OFF = 'off';
export const EFFORT_ENV = 'REMATCH_REASONING_EFFORT';

/**
 * Reasoning tokens are billed and *capped* by `max_output_tokens`, unlike
 * Anthropic's `max_tokens` which only bounds the visible reply. Handing the API
 * `CODER_MAX_TOKENS` unchanged would let a thinking model spend the whole budget
 * before writing a line and return `incomplete` — a wasted attempt that looks like
 * a bad model rather than a bad limit. So the provider adds headroom on top of
 * what the caller asked to *see*.
 */
export const REASONING_HEADROOM_TOKENS = 3072;

/** Models that take a `reasoning` block. `-chat-` variants do not. */
function isReasoningModel(model: string): boolean {
  if (/-chat/.test(model)) return false;
  return /^(gpt-5|o[1345])/.test(model);
}

/**
 * The slice of `client.responses` this provider uses, structurally — so a test can
 * hand it four lines of fake and so `openai` stays a runtime dependency rather than
 * a type dependency of every consumer.
 */
export type OpenAIResponsesLike = {
  create(
    body: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): PromiseLike<AsyncIterable<OpenAIStreamEvent>>;
};

/** The three Responses stream events this provider reads; the rest are ignored. */
export type OpenAIStreamEvent = {
  type: string;
  delta?: string;
  response?: {
    model?: string;
    status?: string;
    incomplete_details?: { reason?: string } | null;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      input_tokens_details?: { cached_tokens?: number } | null;
    } | null;
  };
  message?: string;
};

export type OpenAIProviderOptions = {
  apiKey?: string;
  model?: string;
  /** Injected in tests; defaults to a real SDK client. */
  client?: OpenAIResponsesLike;
  /** `low` by default — see `OPENAI_DEFAULT_EFFORT`. `off` omits the block. */
  reasoningEffort?: string;
  /** Per-request timeout, milliseconds. Default 60 s — the loop's deadline is tighter. */
  timeoutMs?: number;
};

/**
 * The OpenAI provider: `openai`, Responses API, streaming.
 *
 * Responses rather than Chat Completions because the SDK's own README calls it
 * "the primary API for interacting with OpenAI models", and because the reasoning
 * knob this provider needs for the interlude budget lives there natively.
 *
 * Deliberately no `temperature`: the GPT-5 family rejects any value but its
 * default, and there is nothing to gain by sending one — the Coder's output is
 * judged by a deterministic harness, not by how adventurous it was.
 */
export function openaiProvider(opts: OpenAIProviderOptions = {}): LLMProvider {
  const model = opts.model ?? OPENAI_DEFAULT_MODEL;
  const apiKey = opts.apiKey ?? process.env['OPENAI_API_KEY'];
  const effort = opts.reasoningEffort ?? process.env[EFFORT_ENV] ?? OPENAI_DEFAULT_EFFORT;

  // Lazy, for the same reason the Anthropic provider is lazy: constructing a
  // provider must be free and safe, so the server can decide *before* the player
  // finishes round 1 whether the loop can run, and say "using a pre-approved
  // strategy" rather than failing mid-beat (spec AC 5).
  let responses: OpenAIResponsesLike | undefined = opts.client;
  const getResponses = async (): Promise<OpenAIResponsesLike> => {
    if (responses === undefined) {
      if (apiKey === undefined || apiKey === '') {
        throw new Error(
          'openaiProvider: no OPENAI_API_KEY — the rewrite loop cannot run; use the fallback pool',
        );
      }
      const { default: OpenAI } = await import('openai');
      responses = new OpenAI({ apiKey, timeout: opts.timeoutMs ?? 60_000 })
        .responses as unknown as OpenAIResponsesLike;
    }
    return responses;
  };

  return {
    name: `openai:${model}`,
    model,
    async *stream(req: LLMRequest): AsyncIterable<LLMEvent> {
      const target = req.model ?? model;
      const wantsReasoning = effort !== EFFORT_OFF && isReasoningModel(target);
      const body: Record<string, unknown> = {
        model: target,
        // `instructions` is the Responses API's system prompt and is also the half
        // of the context OpenAI's automatic prefix caching can hit: the Boss
        // Contract doc is ~6 KB and byte-identical across attempts.
        instructions: req.system,
        input: req.messages.map((m) => ({ role: m.role, content: m.content })),
        max_output_tokens: req.maxTokens + (wantsReasoning ? REASONING_HEADROOM_TOKENS : 0),
        stream: true,
        ...(wantsReasoning ? { reasoning: { effort } } : {}),
      };

      const client = await getResponses();
      let stream: AsyncIterable<OpenAIStreamEvent>;
      try {
        stream = await client.create(body, req.signal === undefined ? {} : { signal: req.signal });
      } catch (err) {
        // One retry without the optional block: a model that does not take
        // `reasoning` should cost a round trip, not the whole interlude.
        if (wantsReasoning && isUnsupportedParamError(err)) {
          const { reasoning: _dropped, ...rest } = body;
          rest['max_output_tokens'] = req.maxTokens;
          stream = await callOrThrow(client, rest, req.signal, target);
        } else {
          throw openaiError(err, target, req.signal);
        }
      }

      let text = '';
      let usage: LLMUsage = { inputTokens: 0, outputTokens: 0 };
      let doneModel = target;
      try {
        for await (const event of stream) {
          if (event.type === 'response.output_text.delta') {
            const delta = event.delta ?? '';
            if (delta !== '') {
              text += delta;
              yield { type: 'text', delta };
            }
            continue;
          }
          if (event.type === 'error' || event.type === 'response.failed') {
            throw new Error(`openai:${target} — stream failed: ${event.message ?? 'no message'}`);
          }
          // `response.incomplete` is the max-token stop, the same shape Anthropic
          // reports as `stop_reason: max_tokens`: keep the partial text, let the
          // caller's parser and Gate 1 judge it, but say so in the log.
          if (event.type === 'response.completed' || event.type === 'response.incomplete') {
            const done = event.response;
            doneModel = done?.model ?? target;
            usage = {
              inputTokens: done?.usage?.input_tokens ?? 0,
              outputTokens: done?.usage?.output_tokens ?? 0,
              ...(done?.usage?.input_tokens_details?.cached_tokens === undefined
                ? {}
                : { cacheReadTokens: done.usage.input_tokens_details.cached_tokens }),
            };
          }
        }
      } catch (err) {
        throw openaiError(err, target, req.signal);
      }

      yield { type: 'done', text, model: doneModel, usage };
    },
  };
}

async function callOrThrow(
  client: OpenAIResponsesLike,
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
  model: string,
): Promise<AsyncIterable<OpenAIStreamEvent>> {
  try {
    return await client.create(body, signal === undefined ? {} : { signal });
  } catch (err) {
    throw openaiError(err, model, signal);
  }
}

/** A 400 that names a parameter the model does not take. */
export function isUnsupportedParamError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const status = (err as { status?: unknown }).status;
  if (status !== 400 && status !== 404) return false;
  const message = String((err as { message?: unknown }).message ?? '');
  return /unsupported|unrecognized|not supported|unknown parameter|reasoning/i.test(message);
}

/**
 * One sentence a human can act on, from whatever the SDK threw.
 *
 * Never interpolates the request: an API error message can echo a header, and the
 * only header that matters here is the one holding the key.
 */
export function openaiError(err: unknown, model: string, signal?: AbortSignal): Error {
  if (signal?.aborted === true || isAbortError(err)) return new AbortError();

  const status = typeof err === 'object' && err !== null ? (err as { status?: unknown }).status : undefined;
  const detail =
    typeof err === 'object' && err !== null && typeof (err as { message?: unknown }).message === 'string'
      ? (err as { message: string }).message
      : String(err);

  const prefix = `openai:${model} —`;
  if (status === 401) return new Error(`${prefix} 401: OPENAI_API_KEY was rejected; the rewrite loop cannot run`);
  if (status === 403) return new Error(`${prefix} 403: this key may not use ${model}`);
  if (status === 404) return new Error(`${prefix} 404: no model named ${model} for this key`);
  if (status === 429) return new Error(`${prefix} 429: rate limited or out of quota — ${detail}`);
  if (typeof status === 'number' && status >= 500) return new Error(`${prefix} ${status}: OpenAI is failing — ${detail}`);
  return new Error(`${prefix} ${detail}`);
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

/**
 * True for our `AbortError` and for both SDKs' / undici's abort shapes.
 *
 * The constructor check is not belt-and-braces: `openai`'s `APIUserAbortError`
 * never sets `this.name`, so it arrives with `name === 'Error'` and only its class
 * identifies it.
 */
export function isAbortError(err: unknown): boolean {
  if (err instanceof AbortError) return true;
  if (typeof err !== 'object' || err === null) return false;
  const name = (err as { name?: unknown }).name;
  if (name === 'AbortError' || name === 'APIUserAbortError') return true;
  return (err as { constructor?: { name?: unknown } }).constructor?.name === 'APIUserAbortError';
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

// ---------------------------------------------------------- provider selection

/**
 * Which vendor the run talks to, decided in exactly one place.
 *
 * Both the eval CLI and `@rematch/server` used to answer "is there a key, and what
 * model is it" independently, which was survivable while there was one vendor and
 * is not now: `/api/health` has to report the same answer the loop will act on, and
 * a demo that says `anthropic` in the banner while calling OpenAI is a bug the jury
 * finds before you do.
 */
export const PROVIDER_ENV = 'REMATCH_PROVIDER';

export type ProviderVendor = 'anthropic' | 'openai';

/** The env vars each vendor's provider reads, in the order it reads them. */
export const VENDOR_KEY_ENV = {
  anthropic: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
  openai: ['OPENAI_API_KEY'],
} as const satisfies Record<ProviderVendor, readonly string[]>;

export const VENDOR_DEFAULT_MODEL = {
  anthropic: DEFAULT_MODEL,
  openai: OPENAI_DEFAULT_MODEL,
} as const satisfies Record<ProviderVendor, string>;

/** `auto` prefers Anthropic when both keys are present — it is the older path. */
export const VENDOR_PREFERENCE: readonly ProviderVendor[] = ['anthropic', 'openai'];

export type ProviderPair = { analyst: LLMProvider; coder: LLMProvider };

export type ProviderSelection = {
  /** `null` is fallback-only mode: a supported mode, not an error (spec AC 1). */
  vendor: ProviderVendor | null;
  /** What `REMATCH_PROVIDER` asked for, normalised. */
  requested: 'anthropic' | 'openai' | 'auto';
  /** One sentence for the server banner, the eval header and the run log. */
  reason: string;
  /** Per-agent models, or `null` in fallback-only mode. */
  models: { analyst: string; coder: string } | null;
  /** The single model `/api/health` reports — the Coder's, the one that ships code. */
  model: string | null;
  /** Build the two providers. Throws in fallback-only mode; callers check `vendor` first. */
  create(): ProviderPair;
};

function keyPresent(vendor: ProviderVendor, env: Record<string, string | undefined>): boolean {
  return VENDOR_KEY_ENV[vendor].some((name) => (env[name] ?? '').trim() !== '');
}

function providerFor(vendor: ProviderVendor, model: string): LLMProvider {
  return vendor === 'anthropic' ? anthropicProvider({ model }) : openaiProvider({ model });
}

/**
 * `REMATCH_PROVIDER=anthropic | openai | auto` (default `auto`).
 *
 * An *explicit* vendor with no key selects fallback-only rather than silently
 * using the other one: "I told it OpenAI and it billed Anthropic" is a worse
 * failure than a visible fallback, and the reason string says which happened.
 */
export function selectProvider(env: Record<string, string | undefined> = process.env): ProviderSelection {
  const raw = (env[PROVIDER_ENV] ?? '').trim().toLowerCase();
  const known = raw === 'anthropic' || raw === 'openai';
  const requested: 'anthropic' | 'openai' | 'auto' = known ? raw : 'auto';
  const unknownNote =
    raw === '' || known ? '' : ` (ignoring ${PROVIDER_ENV}="${raw}": expected anthropic, openai or auto)`;

  const pick = (): { vendor: ProviderVendor | null; reason: string } => {
    if (known) {
      if (keyPresent(raw, env)) return { vendor: raw, reason: `${PROVIDER_ENV}=${raw}` };
      return {
        vendor: null,
        reason: `${PROVIDER_ENV}=${raw} but no ${VENDOR_KEY_ENV[raw].join(' / ')} — fallback-only`,
      };
    }
    for (const vendor of VENDOR_PREFERENCE) {
      if (keyPresent(vendor, env)) return { vendor, reason: `auto: ${VENDOR_KEY_ENV[vendor][0]} is set${unknownNote}` };
    }
    return { vendor: null, reason: `auto: no provider credential — fallback-only${unknownNote}` };
  };

  const { vendor, reason } = pick();
  if (vendor === null) {
    return {
      vendor,
      requested,
      reason,
      models: null,
      model: null,
      create(): ProviderPair {
        throw new Error(`selectProvider: ${reason}`);
      },
    };
  }

  const models = {
    analyst: modelFor('analyst', env, VENDOR_DEFAULT_MODEL[vendor]),
    coder: modelFor('coder', env, VENDOR_DEFAULT_MODEL[vendor]),
  };
  return {
    vendor,
    requested,
    reason,
    models,
    model: models.coder,
    create(): ProviderPair {
      return {
        analyst: providerFor(vendor, models.analyst),
        coder: providerFor(vendor, models.coder),
      };
    },
  };
}
