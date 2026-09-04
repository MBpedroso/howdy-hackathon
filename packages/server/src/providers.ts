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
 *
 * ## `REMATCH_PROVIDER=none` — the local-development default
 *
 * One value is handled *here* rather than in `selectProvider`: `none`, which forces
 * fallback-only mode **even when a key is present and valid**.
 *
 * `selectProvider` treats any unrecognised `REMATCH_PROVIDER` as `auto` — a sensible
 * rule for a typo, and the wrong one for an off switch, because "I set it to none and
 * it billed me anyway" is exactly the failure this project already had once (see
 * `docs/AI-DEV-LOG.md`, 2026-09-03). Deleting the key from `.env` works but is
 * destructive and easy to get wrong under time pressure; an off switch that leaves the
 * credential in place is the one a developer will actually use, so `none` is the
 * documented setting for local work and is what `.env.example` ships with.
 *
 * It is implemented in the server rather than in `@rematch/agents` because the agents
 * package's `selectProvider` is a shared contract with the eval CLI and is out of this
 * change's scope; the eval has its own, louder guard (`REMATCH_ALLOW_SPEND`).
 *
 * ## `REMATCH_PROVIDER=claude-cli` — local machines only
 *
 * A third live mode, added 2026-09-04: the loop runs on the developer's Claude Code
 * subscription by spawning the installed `claude` binary, so a playtest or a demo take
 * costs no API credit. Nothing in this file special-cases it — `selectProvider` returns
 * it like any other vendor, `hasApiKey` reports `true` (the field means "the loop can
 * run", and it can), and `/api/health` reports `provider: "claude-cli"` with the CLI
 * model alias.
 *
 * The one thing worth saying out loud is where it must **not** be set: a deployed
 * server. There is no logged-in CLI session there, so every rewrite would spawn a
 * subprocess only to fail, and the interlude would fall back four beats late instead of
 * immediately. `selectProvider`'s `auto` therefore never chooses it — it has to be asked
 * for by name, on a machine where a human has run `claude` at least once.
 */
import {
  VENDOR_KEY_ENV,
  selectProvider,
  type LLMProvider,
  type ProviderSelection,
  type ProviderVendor,
  type RewriteProviders,
} from '@rematch/agents';

/**
 * Every credential variable the selection looks at, in the order it looks.
 *
 * `claude-cli` contributes nothing here on purpose: its credential is the CLI's own
 * logged-in session, so there is no variable for the banner to mention or for an
 * operator to check.
 */
export const KEY_ENV = [...VENDOR_KEY_ENV.anthropic, ...VENDOR_KEY_ENV.openai] as const;

/** `REMATCH_PROVIDER=none` — fallback-only, whatever keys are set. */
export const PROVIDER_NONE = 'none';

/** Is the loop switched off by configuration rather than by a missing key? */
export function providerDisabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env['REMATCH_PROVIDER'] ?? '').trim().toLowerCase() === PROVIDER_NONE;
}

/**
 * A `ProviderSelection` that reports fallback-only and throws if anyone builds it.
 *
 * Shaped exactly like `selectProvider`'s own no-credential answer so that the banner,
 * `/api/health` and `resolveProviders` need no special case for `none` — the reason
 * string is the only thing that differs, and it is the thing a human reads.
 */
function disabledSelection(): ProviderSelection {
  const reason = 'REMATCH_PROVIDER=none — fallback-only by configuration (no model will be called)';
  return {
    vendor: null,
    requested: 'auto',
    reason,
    models: null,
    model: null,
    create(): never {
      throw new Error(`selectProvider: ${reason}`);
    },
  };
}

/** The one call the rest of the server makes. Cheap: it builds no client. */
export function selection(env: Record<string, string | undefined> = process.env): ProviderSelection {
  if (providerDisabled(env)) return disabledSelection();
  return selectProvider(env);
}

/** Is a usable credential present? `false` means fallback-only mode (spec AC 1). */
export function hasApiKey(env: Record<string, string | undefined> = process.env): boolean {
  return selection(env).vendor !== null;
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
  const chosen = selection(env);
  return chosen.vendor === null ? undefined : chosen.create();
}

/** One provider used for both agents — how `createServer({ provider })` injects a mock. */
export function bothFrom(provider: LLMProvider): RewriteProviders {
  return { analyst: provider, coder: provider };
}

/** What `/api/health` reports as `model`. `null` in fallback-only mode. */
export function activeModel(env: Record<string, string | undefined> = process.env): string | null {
  return selection(env).model;
}

/** What `/api/health` reports as `provider`. `null` in fallback-only mode. */
export function activeVendor(env: Record<string, string | undefined> = process.env): ProviderVendor | null {
  return selection(env).vendor;
}
