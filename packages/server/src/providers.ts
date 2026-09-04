/**
 * Which model the server talks to, and what it does when there is none.
 *
 * Spec AC 1 is the constraint that shapes this file: "`pnpm install && pnpm dev`
 * runs the game locally with a mock agent (fallback pool only, no API key) in under
 * 2 minutes on a fresh clone." So a missing key is not an error condition — it is a
 * supported mode, and the server has to be able to answer *before* the player
 * finishes round 1 (`GET /api/health` → `hasApiKey`) whether the rewrite loop can
 * run at all.
 *
 * `anthropicProvider()` is built lazily and throws at call time, which is the wrong
 * moment: it would fail mid-beat, after the Analysis panel has opened. So the key is
 * checked here, up front, and its absence selects fallback-only mode instead.
 */
import { anthropicProvider, modelFor, type LLMProvider, type RewriteProviders } from '@rematch/agents';

/** The two variables `anthropicProvider` itself reads, checked in the same order. */
export const KEY_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const;

/** Is a credential present? `false` means fallback-only mode (spec AC 1). */
export function hasApiKey(env: Record<string, string | undefined> = process.env): boolean {
  return KEY_ENV.some((name) => {
    const value = env[name];
    return value !== undefined && value.trim() !== '';
  });
}

/**
 * Build the two providers, or `undefined` for fallback-only mode.
 *
 * Two providers rather than one because the Analyst and the Coder are allowed
 * different models (`REMATCH_ANALYST_MODEL` / `REMATCH_CODER_MODEL`): the Analyst
 * reads ~3 KB and writes JSON, the Coder writes ~80 lines of code against a frozen
 * contract, and there is no reason those are the same trade.
 */
export function resolveProviders(
  env: Record<string, string | undefined> = process.env,
): RewriteProviders | undefined {
  if (!hasApiKey(env)) return undefined;
  return {
    analyst: anthropicProvider({ model: modelFor('analyst', env) }),
    coder: anthropicProvider({ model: modelFor('coder', env) }),
  };
}

/** One provider used for both agents — how `createServer({ provider })` injects a mock. */
export function bothFrom(provider: LLMProvider): RewriteProviders {
  return { analyst: provider, coder: provider };
}

/** What `/api/health` reports as `model`. `null` in fallback-only mode. */
export function activeModel(env: Record<string, string | undefined> = process.env): string | null {
  return hasApiKey(env) ? modelFor('coder', env) : null;
}
