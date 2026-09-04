/**
 * The CORS allow-list.
 *
 * An allow-list rather than `*`, for a reason that is specific to this endpoint:
 * `POST /api/rewrite` is not a read. It spends real API budget and saturates a
 * worker pool for tens of seconds, so any page on the internet being able to fire
 * it from a visitor's browser is a way to spend someone else's money. The rate
 * limiter caps the damage; the allow-list is what stops it being *someone else's*
 * page doing the spending.
 *
 * Three sources, all of them explicit:
 *
 * | Origin | Where it comes from |
 * |---|---|
 * | `http://localhost:5173`, `http://127.0.0.1:5173` | `pnpm dev` — Vite's dev server, both spellings, because `localhost` resolves to `::1` on an IPv6 machine and to `127.0.0.1` elsewhere |
 * | `http://localhost:4173`, `http://127.0.0.1:4173` | `vite preview`, which is what the Playwright suite serves the built bundle from |
 * | `https://$VERCEL_URL` | the deployment (spec §5.2, AC 9). Vercel injects the bare hostname; the scheme is added here |
 * | `REMATCH_ORIGIN` | comma-separated, for anything else — a custom domain, or a non-Vercel host |
 *
 * In development none of this is normally exercised: `packages/web/vite.config.ts`
 * proxies `/api` to this server, so the browser makes a **same-origin** request and
 * never sends an `Origin` header worth checking. That is the point — the proxy keeps
 * the dev path identical to the deployed one, and CORS only matters for the case
 * where the static bundle and the API are on different hosts.
 *
 * A request with no `Origin` (curl, a health check, a same-origin fetch) is allowed:
 * CORS protects browsers from other pages, and it has nothing to say about a client
 * that is not a browser.
 */

export const ORIGIN_ENV = 'REMATCH_ORIGIN';

/** Vite dev + preview, on both spellings of the loopback host. */
export const LOCAL_ORIGINS: readonly string[] = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
];

/** Build the allow-list. `extra` is the caller's (tests pass their own port). */
export function allowedOrigins(
  env: Record<string, string | undefined> = process.env,
  extra: readonly string[] = [],
): Set<string> {
  const origins = new Set<string>([...LOCAL_ORIGINS, ...extra]);

  const vercel = env['VERCEL_URL'];
  // Vercel sets the bare hostname (`rematch-abc123.vercel.app`), not a URL.
  if (vercel !== undefined && vercel.trim() !== '') {
    origins.add(vercel.startsWith('http') ? vercel : `https://${vercel}`);
  }
  // `VERCEL_PROJECT_PRODUCTION_URL` is the stable alias; the preview URL changes per
  // deploy, so the production one has to be listed separately or AC 9 only passes
  // against whichever deploy was current when the variable was read.
  const production = env['VERCEL_PROJECT_PRODUCTION_URL'];
  if (production !== undefined && production.trim() !== '') {
    origins.add(production.startsWith('http') ? production : `https://${production}`);
  }

  for (const raw of (env[ORIGIN_ENV] ?? '').split(',')) {
    const origin = raw.trim();
    if (origin !== '') origins.add(origin.replace(/\/$/, ''));
  }

  return origins;
}

export type CorsDecision =
  /** No `Origin` header, or an allowed one. `headers` may be empty. */
  | { allowed: true; headers: Record<string, string> }
  | { allowed: false; origin: string };

/**
 * Decide what to do with one request's `Origin`.
 *
 * `Vary: Origin` is always set on a CORS-relevant response: without it a shared
 * cache can hand the allow header for one origin to a request from another, which
 * is a cache poisoning bug that only appears in production.
 */
export function corsFor(origin: string | undefined, allowed: ReadonlySet<string>): CorsDecision {
  if (origin === undefined || origin === '' || origin === 'null') {
    return { allowed: true, headers: {} };
  }
  const normalized = origin.replace(/\/$/, '');
  if (!allowed.has(normalized)) return { allowed: false, origin: normalized };
  return {
    allowed: true,
    headers: {
      'access-control-allow-origin': normalized,
      vary: 'Origin',
      // No credentials are used anywhere — the API key lives on the server and
      // there are no cookies or accounts (spec §3) — so `allow-credentials` is
      // deliberately absent rather than set to `false`.
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type, accept',
      'access-control-max-age': '600',
    },
  };
}
