/**
 * Which model the server talks to, and what it does when there is none.
 *
 * Spec AC 1 is the constraint that shapes this file: "`pnpm install && pnpm dev`
 * runs the game locally with a mock agent (fallback pool only, no API key) in under
 * 2 minutes on a fresh clone." So a missing key is not an error condition — it is a
 * supported mode, and the server has to be able to answer *before* the player
 * finishes round 1 (`GET /api/health` → `hasApiKey`, `provider`, `model`) whether
 * the rewrite loop can run at all.
 *
 * The decision itself is **not** made here. `selectProvider()` in `@rematch/agents`
 * is the single place that reads `REMATCH_PROVIDER` and the vendor keys, so the
 * server's banner, `/api/health` and `pnpm eval:agents` cannot drift apart and claim
 * different models. This file is the thin server-shaped view of that answer: a
 * provider is built lazily and throws at call time, which is the wrong moment — it
 * would fail mid-beat, after the Analysis panel has opened — so the credential is
 * checked up front and its absence selects fallback-only mode instead.
 */
import {
  VENDOR_KEY_ENV,
  selectProvider,
  type LLMProvider,
  type ProviderSelection,
  type ProviderVendor,
  type RewriteProviders,
} from '@rematch/agents';

/** Every credential variable the selection looks at, in the order it looks. */
export const KEY_ENV = [...VENDOR_KEY_ENV.anthropic, ...VENDOR_KEY_ENV.openai] as const;

/** The one call the rest of the server makes. Cheap: it builds no client. */
export function selection(env: Record<string, string | undefined> = process.env): ProviderSelection {
  return selectProvider(env);
}

/** Is a usable credential present? `false` means fallback-only mode (spec AC 1). */
export function hasApiKey(env: Record<string, string | undefined> = process.env): boolean {
  return selectProvider(env).vendor !== null;
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
  const chosen = selectProvider(env);
  return chosen.vendor === null ? undefined : chosen.create();
}

/** One provider used for both agents — how `createServer({ provider })` injects a mock. */
export function bothFrom(provider: LLMProvider): RewriteProviders {
  return { analyst: provider, coder: provider };
}

/** What `/api/health` reports as `model`. `null` in fallback-only mode. */
export function activeModel(env: Record<string, string | undefined> = process.env): string | null {
  return selectProvider(env).model;
}

/** What `/api/health` reports as `provider`. `null` in fallback-only mode. */
export function activeVendor(env: Record<string, string | undefined> = process.env): ProviderVendor | null {
  return selectProvider(env).vendor;
}
