/**
 * The server's event vocabulary: `@rematch/agents`' `RewriteEvent`, with **one**
 * field added to the terminal `done` event.
 *
 * ## Why the wrapper exists
 *
 * `rewrite()` resolves as `{ approved: false, reason }` when the loop misses — max
 * attempts, deadline, an error, or no API key at all — and emits `fallback` then
 * `done`. That tells the client *that* a pre-approved strategy should ship but not
 * *which one*: the fallback pool lives in this package (`fallback.ts`, spec §3), the
 * pick is `pickFallback(round, seed)`, and the browser never sees the pool.
 *
 * Without the source in the `done` frame the client would have to make a second
 * request (`GET /api/fallback/:round?seed=`) at exactly the moment something has
 * already gone wrong, on a connection that may be the thing that failed. So the
 * server attaches the picked strategy to the result it already has to send, and the
 * client can start round N from the `done` frame alone. That is spec AC 5's "falls
 * back visibly … in ≤ 50 s" with no second round trip inside the budget.
 *
 * ## Why it is here and not in `@rematch/agents`
 *
 * `RewriteResult` is the *loop's* result and the loop has no fallback pool — it does
 * not read the filesystem and does not know which round has which pre-approved
 * bosses. Adding a `fallback` field there would put a field in the agents package
 * that only the server can ever populate, and would make `@rematch/agents`' type
 * lie about what the loop produces. The field is the server's, so the type is too.
 *
 * The client-side copy of these types
 * (`packages/web/src/interlude/events.ts`) does not declare `fallback`; it is an
 * extra field on a structural type, so a client that ignores it keeps working and a
 * client that wants it reads `result.fallback`. `isRewriteEvent` checks `type` only,
 * so the frame is accepted either way.
 */
import type { RewriteEvent, RewriteResult } from '@rematch/agents';
import type { FallbackStrategy } from './fallback.ts';

/**
 * A `RewriteResult` the server is sending. When `approved` is `false` the picked
 * pre-approved strategy is attached, so the client has everything it needs to start
 * the next round without a second request.
 */
export type ServerRewriteResult =
  | Extract<RewriteResult, { approved: true }>
  | (Extract<RewriteResult, { approved: false }> & {
      /** The pool entry the server chose: `pickFallback(round, seed)`. */
      fallback: FallbackStrategy;
    });

/** The terminal frame. Identical to the agents' `done` except for `result.fallback`. */
export type ServerDoneEvent = { type: 'done'; result: ServerRewriteResult };

/** Every frame the server sends: the loop's events, with the widened `done`. */
export type ServerRewriteEvent = Exclude<RewriteEvent, { type: 'done' }> | ServerDoneEvent;

export type ServerEmit = (event: ServerRewriteEvent) => void;

/** `event: <type>\ndata: <json>\n\n` — one SSE frame. See `sse.ts` for the writer. */
export function frameOf(event: ServerRewriteEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
