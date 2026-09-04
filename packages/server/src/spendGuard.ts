/**
 * A hard daily ceiling on how many rewrites the server will pay for.
 *
 * ## Why this exists
 *
 * On 2026-09-03 the eval was run eleven times in one evening to tune the candidate
 * count, and it exhausted the account's credit. Nothing in the system was watching:
 * the rate limiter (`rateLimit.ts`) caps *one IP over ten minutes*, which is the right
 * control for abuse and no control at all for the operator's own enthusiasm. Six
 * rewrites per ten minutes is 864 a day, and a demo that spends 864 rewrites' worth of
 * tokens while nobody is looking is a bug even though every individual request was
 * within its limit.
 *
 * So the two controls are deliberately different shapes:
 *
 * | Control | Scope | Protects against |
 * |---|---|---|
 * | `rateLimit.ts` | per IP, 10-minute bucket | one caller hammering the endpoint |
 * | this file | **global**, per UTC day | the total bill, whoever spends it |
 *
 * ## What happens at the cap
 *
 * Not a `429`, and not an error. Going over the cap selects **fallback-only mode** —
 * the same supported mode a fresh clone with no API key runs in (spec AC 1). The
 * player still gets all four beats, a pre-approved strategy still ships, and the
 * Analysis beat says in as many words that no model ran. A demo that degrades to the
 * honest no-key path is strictly better than one that starts returning errors, and it
 * is the behaviour the interlude was already built for.
 *
 * `/api/health` reports `rewritesToday`, `dailyCap` and `spendGuard: 'ok' | 'capped'`,
 * so the state is observable before a jury discovers it mid-demo rather than after.
 *
 * ## Why per-process, and what that costs
 *
 * The counter is in memory, like the rate limiter's buckets, and for the same reason:
 * there is no datastore in this project and adding one for a spend cap would be the
 * tail wagging the dog. The cost is honest and worth stating — N server instances get
 * N counters, so the effective cap on a serverless platform is `N x cap`. For the
 * single always-on Node process this project recommends deploying (see the server
 * README's **Deploying**) it is exact. It is a *guard rail*, not an accounting system;
 * the provider's own billing dashboard is the ledger.
 */

/** `REMATCH_MAX_REWRITES_PER_DAY`. */
export const DAILY_CAP_ENV = 'REMATCH_MAX_REWRITES_PER_DAY';

/**
 * 50 rewrites a day.
 *
 * Twelve full games (rounds 2-5 is four rewrites) plus room to re-demo, which is far
 * more than a hackathon judging session needs and far less than an eval loop can burn.
 * `0` disables the loop entirely — fallback-only from the first request, which is a
 * useful setting for a public deploy that should never spend.
 */
export const DEFAULT_DAILY_CAP = 50;

export type SpendState = 'ok' | 'capped';

export type SpendGuardReport = {
  /** Rewrites that consumed the model today, UTC. */
  rewritesToday: number;
  dailyCap: number;
  spendGuard: SpendState;
  /** The UTC day the counter belongs to, `YYYY-MM-DD`. Rolls at midnight UTC. */
  day: string;
};

export type SpendGuard = {
  /**
   * Claim one rewrite's budget. `true` means the loop may run.
   *
   * Called at the moment the server commits to spending — after validation, before the
   * providers are built — so a `400` never costs a slot.
   */
  claim(): boolean;
  /** Current state, for `/api/health`. Never mutates. */
  report(): SpendGuardReport;
  readonly dailyCap: number;
};

export type SpendGuardOptions = {
  /** Defaults to `REMATCH_MAX_REWRITES_PER_DAY`, else 50. */
  cap?: number;
  /** Injected in tests. */
  now?: () => number;
  /**
   * Called once, the first time the cap is reached.
   *
   * Once and not per request: the whole point is a line in the log that a human
   * notices, and a line repeated on every request for the rest of the day is a line
   * nobody reads.
   */
  onCapped?: (report: SpendGuardReport) => void;
};

/** `YYYY-MM-DD` in UTC. UTC so the roll-over does not depend on the host's zone. */
export function utcDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/**
 * Read the cap from the environment.
 *
 * A missing variable is the default; an unparseable one is *also* the default rather
 * than an error, because a typo in an env var must not take the demo down. `0` is
 * meaningful (never spend) and negative is clamped to it.
 */
export function resolveDailyCap(env: Record<string, string | undefined> = process.env): number {
  const raw = env[DAILY_CAP_ENV];
  if (raw === undefined || raw.trim() === '') return DEFAULT_DAILY_CAP;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_DAILY_CAP;
  return Math.max(0, Math.trunc(n));
}

export function createSpendGuard(options: SpendGuardOptions = {}): SpendGuard {
  const cap = options.cap ?? resolveDailyCap();
  const now = options.now ?? ((): number => Date.now());

  let day = utcDay(now());
  let used = 0;
  let warned = false;

  const report = (): SpendGuardReport => ({
    rewritesToday: used,
    dailyCap: cap,
    spendGuard: used >= cap ? 'capped' : 'ok',
    day,
  });

  /** Reset on the first call of a new UTC day. No timer: nothing to wake up for. */
  const roll = (): void => {
    const today = utcDay(now());
    if (today === day) return;
    day = today;
    used = 0;
    warned = false;
  };

  return {
    dailyCap: cap,

    claim(): boolean {
      roll();
      if (used >= cap) {
        if (!warned) {
          warned = true;
          options.onCapped?.(report());
        }
        return false;
      }
      used += 1;
      // The log line fires when the cap is *reached*, not when the next request is
      // refused, so the operator hears about it at the moment it becomes true.
      if (used >= cap && !warned) {
        warned = true;
        options.onCapped?.(report());
      }
      return true;
    },

    report(): SpendGuardReport {
      roll();
      return report();
    },
  };
}
