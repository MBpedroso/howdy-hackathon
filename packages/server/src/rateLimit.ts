/**
 * A per-IP token bucket, in memory.
 *
 * The thing being rationed is not bandwidth — it is **money and CPU**. One
 * `POST /api/rewrite` is one Analyst call, up to four Coder calls and up to 800
 * simulated matches across a worker pool. A loop over `curl` would empty an API
 * budget in a minute and saturate every core on the box while a jury is playing.
 *
 * Six per ten minutes, because that is the shape of the product: a full game is
 * four rewrites (rounds 2-5), so the limit lets a player finish a fight, lose, and
 * start again before it bites. It is deliberately not generous.
 *
 * ## Why a bucket rather than a counter
 *
 * A fixed window would let a burst of six land in one second and then refuse
 * everything for ten minutes — including the sixth *legitimate* rewrite of a game
 * that started nine minutes ago. A bucket drips back at `capacity / windowMs`, so a
 * player who is playing normally is never told no, while a script that empties it
 * gets one request per 100 seconds.
 *
 * ## Why in memory
 *
 * There is no datastore in this project and adding one for a rate limit would be
 * the tail wagging the dog. The cost is honest and worth stating: a limiter in
 * process memory is per-instance, so on a serverless platform (spec §5.2's Vercel)
 * a caller spread across N cold starts gets N buckets. For a hackathon deployment
 * behind one Node process it is exactly right; for the serverless variant it is a
 * speed bump, and the real protection there is the platform's own concurrency cap.
 */

export type RateLimitOptions = {
  /** Requests allowed in a burst. Spec-free; product-derived (see above). */
  capacity?: number;
  /** The window the bucket refills over, ms. */
  windowMs?: number;
  /** Injected in tests. */
  now?: () => number;
  /** Buckets idle for longer than this are dropped. Defaults to `windowMs * 2`. */
  idleMs?: number;
};

export type RateLimitVerdict =
  | { ok: true; remaining: number }
  | { ok: false; retryAfterMs: number; retryAfterSeconds: number };

export type RateLimiter = {
  /** Spend one token for `key`. */
  take(key: string): RateLimitVerdict;
  /** Give a token back — used when a request never reached the loop. */
  refund(key: string): void;
  /** Live bucket count. For the health endpoint and the tests. */
  size(): number;
  readonly capacity: number;
  readonly windowMs: number;
};

/** Six rewrites is a whole game (rounds 2-5) plus two retries. */
export const DEFAULT_CAPACITY = 6;
export const DEFAULT_WINDOW_MS = 10 * 60 * 1000;

type Bucket = {
  /** Fractional tokens available. */
  tokens: number;
  /** When `tokens` was last brought up to date. */
  at: number;
};

export function createRateLimiter(opts: RateLimitOptions = {}): RateLimiter {
  const capacity = Math.max(1, Math.trunc(opts.capacity ?? DEFAULT_CAPACITY));
  const windowMs = Math.max(1, Math.trunc(opts.windowMs ?? DEFAULT_WINDOW_MS));
  const now = opts.now ?? ((): number => Date.now());
  const idleMs = opts.idleMs ?? windowMs * 2;
  /** Tokens per millisecond. A full bucket refills in exactly `windowMs`. */
  const rate = capacity / windowMs;

  const buckets = new Map<string, Bucket>();

  /**
   * Drop buckets nobody has touched in a while, so a long-running server does not
   * accumulate one entry per IP that ever visited. Done on write, not on a timer —
   * a timer would keep the process alive and would run when there is no traffic,
   * which is precisely when there is nothing to clean.
   */
  function sweep(at: number): void {
    if (buckets.size < 1024) return;
    for (const [key, bucket] of buckets) {
      if (at - bucket.at > idleMs) buckets.delete(key);
    }
  }

  function refill(key: string, at: number): Bucket {
    const existing = buckets.get(key);
    if (existing === undefined) {
      const fresh: Bucket = { tokens: capacity, at };
      buckets.set(key, fresh);
      return fresh;
    }
    existing.tokens = Math.min(capacity, existing.tokens + (at - existing.at) * rate);
    existing.at = at;
    return existing;
  }

  return {
    capacity,
    windowMs,

    take(key: string): RateLimitVerdict {
      const at = now();
      sweep(at);
      const bucket = refill(key, at);
      if (bucket.tokens < 1) {
        const retryAfterMs = Math.ceil((1 - bucket.tokens) / rate);
        return { ok: false, retryAfterMs, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
      }
      bucket.tokens -= 1;
      return { ok: true, remaining: Math.floor(bucket.tokens) };
    },

    refund(key: string): void {
      const bucket = buckets.get(key);
      if (bucket === undefined) return;
      bucket.tokens = Math.min(capacity, bucket.tokens + 1);
    },

    size(): number {
      return buckets.size;
    },
  };
}
