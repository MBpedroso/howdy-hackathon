/**
 * The provider boundary: the mock's scripting and abort behaviour (which every
 * other test in this package leans on) and model resolution from the environment.
 */
import { describe, expect, it } from 'vitest';
import {
  AbortError,
  CLAUDE_CLI_DEFAULT_MODEL,
  DEFAULT_MODEL,
  EFFORT_OFF,
  MODEL_ENV,
  OPENAI_DEFAULT_EFFORT,
  OPENAI_DEFAULT_MODEL,
  REASONING_HEADROOM_TOKENS,
  anthropicProvider,
  collect,
  isAbortError,
  isUnsupportedParamError,
  mockProvider,
  modelFor,
  openaiError,
  openaiProvider,
  selectProvider,
  type OpenAIResponsesLike,
  type OpenAIStreamEvent,
} from '../src/index.ts';

describe('mockProvider', () => {
  it('emits deltas in chunks and a matching done event', async () => {
    const provider = mockProvider(['abcdefghij'], { chunkSize: 4 });
    const deltas: string[] = [];
    const done = await collect(provider, { system: 's', messages: [{ role: 'user', content: 'u' }], maxTokens: 10 }, (d) =>
      deltas.push(d),
    );
    expect(deltas).toEqual(['abcd', 'efgh', 'ij']);
    expect(done.text).toBe('abcdefghij');
    expect(done.usage.inputTokens).toBeGreaterThan(0);
  });

  it('walks the script and repeats the last entry', async () => {
    const provider = mockProvider(['one', 'two']);
    const req = { system: 's', messages: [{ role: 'user' as const, content: 'u' }], maxTokens: 10 };
    expect((await collect(provider, req)).text).toBe('one');
    expect((await collect(provider, req)).text).toBe('two');
    expect((await collect(provider, req)).text).toBe('two');
    expect(provider.calls).toHaveLength(3);
  });

  it('records what it was asked, so a test can assert on the prompt', async () => {
    const provider = mockProvider(['x']);
    await collect(provider, {
      system: 'SYS',
      messages: [{ role: 'user', content: 'USER' }],
      maxTokens: 42,
      model: 'override',
    });
    expect(provider.calls[0]).toMatchObject({ system: 'SYS', maxTokens: 42, model: 'override' });
    expect(provider.promptOf(0)).toBe('SYS\nUSER');
    expect(() => provider.promptOf(3)).toThrow(/no call at index 3/);
  });

  it('rejects with an AbortError when a stalling step is aborted', async () => {
    const provider = mockProvider([{ text: 'never', stall: true }]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    await expect(
      collect(provider, {
        system: 's',
        messages: [{ role: 'user', content: 'u' }],
        maxTokens: 10,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(AbortError);
  });

  it('does not start when the signal is already aborted', async () => {
    const provider = mockProvider([{ text: 'x', delayMs: 5 }]);
    await expect(
      collect(provider, {
        system: 's',
        messages: [{ role: 'user', content: 'u' }],
        maxTokens: 10,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toBeInstanceOf(AbortError);
  });
});

describe('isAbortError', () => {
  it('recognises our own error and the SDK/undici shapes', () => {
    expect(isAbortError(new AbortError())).toBe(true);
    expect(isAbortError(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(true);
    expect(isAbortError(Object.assign(new Error('x'), { name: 'APIUserAbortError' }))).toBe(true);
    expect(isAbortError(new Error('nope'))).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
  });
});

describe('modelFor', () => {
  it('defaults both agents to a Sonnet-class model, for latency', () => {
    expect(modelFor('analyst', {})).toBe(DEFAULT_MODEL);
    expect(modelFor('coder', {})).toBe(DEFAULT_MODEL);
    expect(DEFAULT_MODEL).toMatch(/sonnet/);
  });

  it('lets REMATCH_MODEL set both', () => {
    const env = { [MODEL_ENV.both]: 'claude-opus-5' };
    expect(modelFor('analyst', env)).toBe('claude-opus-5');
    expect(modelFor('coder', env)).toBe('claude-opus-5');
  });

  it('lets the per-agent variables win, so the two can be tuned apart', () => {
    const env = {
      [MODEL_ENV.both]: 'claude-sonnet-5',
      [MODEL_ENV.coder]: 'claude-opus-5',
    };
    expect(modelFor('analyst', env)).toBe('claude-sonnet-5');
    expect(modelFor('coder', env)).toBe('claude-opus-5');
  });
});

describe('anthropicProvider', () => {
  it('constructs without a key and fails only when used, so the server can fall back', async () => {
    const provider = anthropicProvider({ apiKey: '', model: 'claude-sonnet-5' });
    expect(provider.name).toBe('anthropic:claude-sonnet-5');
    expect(provider.model).toBe('claude-sonnet-5');
    // No key: the error names the fallback pool rather than throwing at import.
    delete process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_AUTH_TOKEN'];
    await expect(
      collect(anthropicProvider({ apiKey: '' }), {
        system: 's',
        messages: [{ role: 'user', content: 'u' }],
        maxTokens: 10,
      }),
    ).rejects.toThrow(/fallback pool/);
  });

  it('streams text deltas and reports usage from an injected client', async () => {
    // A minimal stand-in for `client.messages.stream` — enough to prove the
    // provider reads `content_block_delta` and `finalMessage()` correctly, without
    // a network call.
    const events = [
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'he' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'llo' } },
      { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'ignored' } },
    ];
    const fake = {
      stream() {
        return {
          async *[Symbol.asyncIterator]() {
            for (const event of events) yield event;
          },
          finalMessage() {
            return Promise.resolve({
              model: 'claude-sonnet-5',
              usage: { input_tokens: 11, output_tokens: 2, cache_read_input_tokens: 7 },
            });
          },
        };
      },
    };

    const provider = anthropicProvider({
      apiKey: 'test',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: fake as any,
    });
    const deltas: string[] = [];
    const done = await collect(
      provider,
      { system: 's', messages: [{ role: 'user', content: 'u' }], maxTokens: 10 },
      (d) => deltas.push(d),
    );

    expect(deltas).toEqual(['he', 'llo']);
    expect(done.text).toBe('hello');
    expect(done.model).toBe('claude-sonnet-5');
    expect(done.usage).toEqual({ inputTokens: 11, outputTokens: 2, cacheReadTokens: 7 });
  });

  it('caches the system prompt, which is the stable half of both agents\' context', async () => {
    let captured: unknown;
    const fake = {
      stream(body: unknown) {
        captured = body;
        return {
          async *[Symbol.asyncIterator]() {
            /* no deltas */
          },
          finalMessage: () => Promise.resolve({ model: 'm', usage: { input_tokens: 1, output_tokens: 1 } }),
        };
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const provider = anthropicProvider({ apiKey: 'test', client: fake as any });
    await collect(provider, { system: 'SYS', messages: [{ role: 'user', content: 'u' }], maxTokens: 10 });
    expect(captured).toMatchObject({
      system: [{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }],
    });
  });
});

// ------------------------------------------------------------ openai provider

/** Four lines of fake `client.responses`: the Responses stream is just events. */
function fakeResponses(
  events: OpenAIStreamEvent[],
  opts: { onBody?: (body: Record<string, unknown>) => void; failFirst?: unknown } = {},
): OpenAIResponsesLike {
  let call = 0;
  return {
    create(body: Record<string, unknown>) {
      call += 1;
      opts.onBody?.(body);
      if (call === 1 && opts.failFirst !== undefined) return Promise.reject(opts.failFirst);
      return Promise.resolve({
        async *[Symbol.asyncIterator]() {
          for (const event of events) yield event;
        },
      });
    },
  };
}

const COMPLETED: OpenAIStreamEvent = {
  type: 'response.completed',
  response: {
    model: 'gpt-5.4-mini-2026-03-17',
    usage: { input_tokens: 1234, output_tokens: 56, input_tokens_details: { cached_tokens: 1024 } },
  },
};

const REQ = { system: 'SYS', messages: [{ role: 'user' as const, content: 'USER' }], maxTokens: 100 };

/**
 * `openai`'s real abort error, reproduced faithfully in the one detail that
 * matters: it never sets `this.name`, so it arrives as `name === 'Error'` and only
 * its class identifies it.
 */
class APIUserAbortError extends Error {}


describe('openaiProvider', () => {
  it('streams output_text deltas and normalises usage onto the shared shape', async () => {
    const provider = openaiProvider({
      apiKey: 'test',
      client: fakeResponses([
        { type: 'response.created' },
        { type: 'response.output_text.delta', delta: 'he' },
        // Reasoning summary text is not the answer — the interlude must not show it.
        { type: 'response.reasoning_text.delta', delta: 'IGNORED' },
        { type: 'response.output_text.delta', delta: 'llo' },
        COMPLETED,
      ]),
    });

    const deltas: string[] = [];
    const done = await collect(provider, REQ, (d) => deltas.push(d));

    expect(deltas).toEqual(['he', 'llo']);
    expect(done.text).toBe('hello');
    // The *resolved* model id, not the alias that was asked for.
    expect(done.model).toBe('gpt-5.4-mini-2026-03-17');
    expect(done.usage).toEqual({ inputTokens: 1234, outputTokens: 56, cacheReadTokens: 1024 });
  });

  it('names the vendor and the model, like the Anthropic provider', () => {
    const provider = openaiProvider({ apiKey: 'test', model: 'gpt-5.4-mini' });
    expect(provider.name).toBe('openai:gpt-5.4-mini');
    expect(provider.model).toBe('gpt-5.4-mini');
    expect(OPENAI_DEFAULT_MODEL).toMatch(/mini/);
  });

  it('sends the Responses shape: instructions, input roles, effort, and no temperature', async () => {
    let body: Record<string, unknown> | undefined;
    const provider = openaiProvider({
      apiKey: 'test',
      model: 'gpt-5.4-mini',
      client: fakeResponses([COMPLETED], { onBody: (b) => (body = b) }),
    });
    await collect(provider, REQ);

    expect(body).toMatchObject({
      model: 'gpt-5.4-mini',
      instructions: 'SYS',
      input: [{ role: 'user', content: 'USER' }],
      stream: true,
      reasoning: { effort: OPENAI_DEFAULT_EFFORT },
    });
    // Reasoning tokens are billed against `max_output_tokens`, so the visible
    // budget the caller asked for gets headroom on top of it.
    expect(body?.['max_output_tokens']).toBe(100 + REASONING_HEADROOM_TOKENS);
    expect(body).not.toHaveProperty('temperature');
  });

  it('omits reasoning (and its headroom) for a non-reasoning model', async () => {
    let body: Record<string, unknown> | undefined;
    const provider = openaiProvider({
      apiKey: 'test',
      model: 'gpt-5.2-chat-latest',
      client: fakeResponses([COMPLETED], { onBody: (b) => (body = b) }),
    });
    await collect(provider, REQ);
    expect(body).not.toHaveProperty('reasoning');
    expect(body?.['max_output_tokens']).toBe(100);
  });

  it('retries once without the reasoning block when the model rejects it', async () => {
    const bodies: Record<string, unknown>[] = [];
    const provider = openaiProvider({
      apiKey: 'test',
      client: fakeResponses([{ type: 'response.output_text.delta', delta: 'ok' }, COMPLETED], {
        onBody: (b) => bodies.push(b),
        failFirst: Object.assign(new Error("Unsupported parameter: 'reasoning'"), { status: 400 }),
      }),
    });

    const done = await collect(provider, REQ);
    expect(done.text).toBe('ok');
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toHaveProperty('reasoning');
    expect(bodies[1]).not.toHaveProperty('reasoning');
    expect(bodies[1]?.['max_output_tokens']).toBe(100);
  });

  it('constructs without a key and fails only when used, so the server can fall back', async () => {
    const provider = openaiProvider({ apiKey: '' });
    expect(provider.model).toBe(OPENAI_DEFAULT_MODEL);
    delete process.env['OPENAI_API_KEY'];
    await expect(collect(provider, REQ)).rejects.toThrow(/fallback pool/);
  });

  it('raises an AbortError when the caller aborts, like the mock and the loop expect', async () => {
    const controller = new AbortController();
    const provider = openaiProvider({
      apiKey: 'test',
      client: {
        create(_body, options) {
          // The signal has to reach the SDK, or the loop's deadline cancels
          // nothing and the interlude keeps paying for a response it discarded.
          expect(options?.signal).toBe(controller.signal);
          controller.abort();
          return Promise.reject(new APIUserAbortError('Request was aborted.'));
        },
      },
    });
    await expect(collect(provider, { ...REQ, signal: controller.signal })).rejects.toBeInstanceOf(AbortError);
  });

  it('recognises the SDK abort class even without a signal, since it sets no name', async () => {
    const provider = openaiProvider({
      apiKey: 'test',
      client: { create: () => Promise.reject(new APIUserAbortError('Request was aborted.')) },
    });
    await expect(collect(provider, REQ)).rejects.toBeInstanceOf(AbortError);
  });

  it('turns a failed stream event into an error rather than an empty strategy', async () => {
    const provider = openaiProvider({
      apiKey: 'test',
      client: fakeResponses([{ type: 'response.failed', message: 'server had a bad day' }]),
    });
    await expect(collect(provider, REQ)).rejects.toThrow(/bad day/);
  });
});

describe('openaiError', () => {
  it('maps the statuses a demo actually hits to one actionable sentence', () => {
    const at = (status: number, message = 'boom'): string =>
      openaiError(Object.assign(new Error(message), { status }), 'gpt-5.4-mini').message;

    expect(at(401)).toMatch(/OPENAI_API_KEY was rejected/);
    expect(at(403)).toMatch(/may not use gpt-5.4-mini/);
    expect(at(404)).toMatch(/no model named gpt-5.4-mini/);
    expect(at(429, 'quota')).toMatch(/429: rate limited or out of quota/);
    expect(at(503, 'upstream')).toMatch(/503: OpenAI is failing/);
    expect(openaiError(new Error('offline'), 'm').message).toBe('openai:m — offline');
  });

  it('reports an abort as an AbortError, whichever way it arrives', () => {
    expect(openaiError(new Error('x'), 'm', AbortSignal.abort())).toBeInstanceOf(AbortError);
    expect(isUnsupportedParamError(Object.assign(new Error('Unknown parameter'), { status: 400 }))).toBe(true);
    expect(isUnsupportedParamError(Object.assign(new Error('overloaded'), { status: 500 }))).toBe(false);
  });
});

// ---------------------------------------------------------- provider selection

describe('selectProvider', () => {
  const ANTHROPIC = { ANTHROPIC_API_KEY: 'a' };
  const OPENAI = { OPENAI_API_KEY: 'o' };

  const cases: {
    what: string;
    env: Record<string, string | undefined>;
    vendor: 'anthropic' | 'openai' | 'claude-cli' | null;
    model: string | null;
  }[] = [
    { what: 'no key at all → fallback-only (spec AC 1)', env: {}, vendor: null, model: null },
    { what: 'auto with only Anthropic', env: ANTHROPIC, vendor: 'anthropic', model: DEFAULT_MODEL },
    { what: 'auto with only OpenAI', env: OPENAI, vendor: 'openai', model: OPENAI_DEFAULT_MODEL },
    {
      what: 'auto with both prefers Anthropic',
      env: { ...ANTHROPIC, ...OPENAI },
      vendor: 'anthropic',
      model: DEFAULT_MODEL,
    },
    {
      what: 'explicit openai wins over a present Anthropic key',
      env: { ...ANTHROPIC, ...OPENAI, REMATCH_PROVIDER: 'openai' },
      vendor: 'openai',
      model: OPENAI_DEFAULT_MODEL,
    },
    {
      what: 'explicit anthropic ignores the OpenAI key',
      env: { ...ANTHROPIC, ...OPENAI, REMATCH_PROVIDER: 'ANTHROPIC' },
      vendor: 'anthropic',
      model: DEFAULT_MODEL,
    },
    {
      // Never silently bill the other vendor: an explicit choice with no key is
      // a visible fallback, not a substitution.
      what: 'explicit openai with no OpenAI key → fallback-only, not Anthropic',
      env: { ...ANTHROPIC, REMATCH_PROVIDER: 'openai' },
      vendor: null,
      model: null,
    },
    {
      what: 'ANTHROPIC_AUTH_TOKEN counts as a credential',
      env: { ANTHROPIC_AUTH_TOKEN: 't' },
      vendor: 'anthropic',
      model: DEFAULT_MODEL,
    },
    { what: 'a blank key is not a key', env: { OPENAI_API_KEY: '   ' }, vendor: null, model: null },
    {
      what: 'an unreadable REMATCH_PROVIDER degrades to auto and says so',
      env: { ...OPENAI, REMATCH_PROVIDER: 'gpt' },
      vendor: 'openai',
      model: OPENAI_DEFAULT_MODEL,
    },
    {
      // The CLI carries its own credential — the developer's logged-in subscription —
      // so asking for it *is* the opt-in and there is no key to check.
      what: 'explicit claude-cli needs no key at all',
      env: { REMATCH_PROVIDER: 'claude-cli' },
      vendor: 'claude-cli',
      model: CLAUDE_CLI_DEFAULT_MODEL,
    },
    {
      what: 'explicit claude-cli ignores both API keys — it spends neither',
      env: { ...ANTHROPIC, ...OPENAI, REMATCH_PROVIDER: 'CLAUDE-CLI' },
      vendor: 'claude-cli',
      model: CLAUDE_CLI_DEFAULT_MODEL,
    },
    {
      // The one case this table exists to pin: `auto` must never spawn a subprocess.
      // A binary on PATH is not a credential and not a decision anyone made.
      what: 'auto never picks claude-cli, even with the binary installed',
      env: { REMATCH_CLAUDE_BIN: '/usr/local/bin/claude' },
      vendor: null,
      model: null,
    },
  ];

  for (const c of cases) {
    it(c.what, () => {
      const chosen = selectProvider(c.env);
      expect(chosen.vendor).toBe(c.vendor);
      expect(chosen.model).toBe(c.model);
      expect(chosen.reason).not.toBe('');
    });
  }

  it('resolves per-agent model overrides against the chosen vendor default', () => {
    const chosen = selectProvider({ OPENAI_API_KEY: 'o', REMATCH_CODER_MODEL: 'gpt-5.4' });
    expect(chosen.models).toEqual({ analyst: OPENAI_DEFAULT_MODEL, coder: 'gpt-5.4' });
    expect(chosen.model).toBe('gpt-5.4');
    const pair = chosen.create();
    expect(pair.analyst.name).toBe(`openai:${OPENAI_DEFAULT_MODEL}`);
    expect(pair.coder.name).toBe('openai:gpt-5.4');
  });

  it('builds Anthropic providers when Anthropic is chosen', () => {
    const pair = selectProvider({ ANTHROPIC_API_KEY: 'a', REMATCH_MODEL: 'claude-opus-5' }).create();
    expect(pair.analyst.name).toBe('anthropic:claude-opus-5');
    expect(pair.coder.name).toBe('anthropic:claude-opus-5');
  });

  it('refuses to build providers in fallback-only mode, with the reason attached', () => {
    const chosen = selectProvider({});
    expect(() => chosen.create()).toThrow(/fallback-only/);
  });

  it('builds a CLI provider, on a model alias rather than an API model id', () => {
    const chosen = selectProvider({ REMATCH_PROVIDER: 'claude-cli' });
    expect(chosen.requested).toBe('claude-cli');
    expect(chosen.models).toEqual({ analyst: 'sonnet', coder: 'sonnet' });
    const pair = chosen.create();
    expect(pair.analyst.name).toBe('claude-cli:sonnet');
    expect(pair.coder.name).toBe('claude-cli:sonnet');
  });

  it('lets the per-agent model overrides through to the CLI, as CLI aliases', () => {
    const chosen = selectProvider({ REMATCH_PROVIDER: 'claude-cli', REMATCH_CODER_MODEL: 'opus' });
    expect(chosen.models).toEqual({ analyst: 'sonnet', coder: 'opus' });
    expect(chosen.model).toBe('opus');
    expect(chosen.create().coder.name).toBe('claude-cli:opus');
  });

  it('names the unknown value so a typo in .env is findable', () => {
    expect(selectProvider({ OPENAI_API_KEY: 'o', REMATCH_PROVIDER: 'gpt' }).reason).toMatch(/ignoring REMATCH_PROVIDER/);
    expect(selectProvider({ OPENAI_API_KEY: 'o', REMATCH_PROVIDER: 'gpt' }).requested).toBe('auto');
    // The message has to list every accepted value, including the newest one.
    expect(selectProvider({ REMATCH_PROVIDER: 'cli' }).reason).toMatch(/anthropic, openai, claude-cli or auto/);
  });
});

describe('reasoning effort', () => {
  it('passes `none` through as a real effort value and reserves `off` for omitting', async () => {
    const bodies: Record<string, unknown>[] = [];
    const client = fakeResponses([COMPLETED], { onBody: (b) => bodies.push(b) });
    await collect(openaiProvider({ apiKey: 'k', client, reasoningEffort: 'none' }), REQ);
    await collect(openaiProvider({ apiKey: 'k', client, reasoningEffort: EFFORT_OFF }), REQ);
    expect(bodies[0]).toMatchObject({ reasoning: { effort: 'none' } });
    expect(bodies[1]).not.toHaveProperty('reasoning');
  });
});
