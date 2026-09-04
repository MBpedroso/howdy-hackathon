/**
 * The provider boundary: the mock's scripting and abort behaviour (which every
 * other test in this package leans on) and model resolution from the environment.
 */
import { describe, expect, it } from 'vitest';
import {
  AbortError,
  DEFAULT_MODEL,
  MODEL_ENV,
  anthropicProvider,
  collect,
  isAbortError,
  mockProvider,
  modelFor,
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
