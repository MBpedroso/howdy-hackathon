/**
 * What mode the server will run in, decided from the environment alone.
 *
 * This is a small file guarding a demo-shaped failure: the banner, `/api/health`
 * and the loop each answering "which model?" separately and disagreeing. They all
 * go through `selectProvider()` in `@rematch/agents` now, and these tests pin the
 * server-shaped view of it — including that a *missing* credential is a supported
 * mode (spec AC 1) rather than an error.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL, OPENAI_DEFAULT_MODEL } from '@rematch/agents';
import { KEY_ENV, activeModel, activeVendor, hasApiKey, resolveProviders, selection } from '../src/providers.ts';

describe('provider resolution', () => {
  it('reports fallback-only mode on a fresh clone, with no key anywhere', () => {
    expect(hasApiKey({})).toBe(false);
    expect(activeVendor({})).toBeNull();
    expect(activeModel({})).toBeNull();
    expect(resolveProviders({})).toBeUndefined();
    expect(selection({}).reason).toMatch(/fallback-only/);
  });

  it('runs live on an OpenAI key, and reports the vendor and model /api/health shows', () => {
    const env = { OPENAI_API_KEY: 'test-key' };
    expect(hasApiKey(env)).toBe(true);
    expect(activeVendor(env)).toBe('openai');
    expect(activeModel(env)).toBe(OPENAI_DEFAULT_MODEL);
    const providers = resolveProviders(env);
    expect(providers?.coder.name).toBe(`openai:${OPENAI_DEFAULT_MODEL}`);
  });

  it('runs live on an Anthropic key, unchanged from before the OpenAI provider existed', () => {
    const env = { ANTHROPIC_API_KEY: 'test-key' };
    expect(activeVendor(env)).toBe('anthropic');
    expect(activeModel(env)).toBe(DEFAULT_MODEL);
    expect(resolveProviders(env)?.analyst.name).toBe(`anthropic:${DEFAULT_MODEL}`);
  });

  it('honours REMATCH_PROVIDER when both keys are present', () => {
    const both = { ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' };
    expect(activeVendor(both)).toBe('anthropic');
    expect(activeVendor({ ...both, REMATCH_PROVIDER: 'openai' })).toBe('openai');
  });

  it('reports the model the Coder will use — the one that actually ships code', () => {
    const env = { OPENAI_API_KEY: 'o', REMATCH_ANALYST_MODEL: 'gpt-5.4-nano', REMATCH_CODER_MODEL: 'gpt-5.4' };
    expect(activeModel(env)).toBe('gpt-5.4');
    expect(selection(env).models).toEqual({ analyst: 'gpt-5.4-nano', coder: 'gpt-5.4' });
  });

  it('runs live on the Claude Code CLI with no key present at all', () => {
    // The local-machine mode: the credential is the CLI's own logged-in subscription,
    // so `hasApiKey` is true in the only sense the field means — the loop can run.
    const env = { REMATCH_PROVIDER: 'claude-cli' };
    expect(hasApiKey(env)).toBe(true);
    expect(activeVendor(env)).toBe('claude-cli');
    expect(activeModel(env)).toBe('sonnet');
    expect(resolveProviders(env)?.coder.name).toBe('claude-cli:sonnet');
  });

  it('keeps REMATCH_PROVIDER=none winning over the CLI mode too', () => {
    // `none` is the off switch, and an off switch with an exception is not one.
    expect(hasApiKey({ REMATCH_PROVIDER: 'none', REMATCH_CLAUDE_BIN: '/usr/bin/claude' })).toBe(false);
    expect(activeVendor({ REMATCH_PROVIDER: 'none' })).toBeNull();
  });

  it('never selects the CLI from auto, since a binary on PATH is not a decision', () => {
    expect(activeVendor({ REMATCH_CLAUDE_BIN: '/usr/local/bin/claude' })).toBeNull();
    expect(activeVendor({ ANTHROPIC_API_KEY: 'a', REMATCH_CLAUDE_BIN: '/usr/local/bin/claude' })).toBe('anthropic');
  });

  it('lists every credential variable it looks at, for the README and the banner', () => {
    expect([...KEY_ENV]).toEqual(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY']);
  });
});
