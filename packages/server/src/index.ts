/**
 * `@rematch/server` — the Node side of the fight.
 *
 * Only the fallback pool so far (spec §3, §5): the pre-approved strategies the
 * interlude falls back to when the Analyst/Coder/harness loop misses its 45-second
 * budget. The HTTP + SSE surface lands in a later milestone; it will consume this.
 */
export {
  FALLBACK_DIR,
  FALLBACK_POOL,
  FALLBACK_ROUNDS,
  MIN_PER_ROUND,
  POOL_BYTES,
  pickFallback,
  type FallbackStrategy,
} from './fallback.ts';
