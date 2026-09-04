/**
 * The SSE writer: a `ServerResponse` in, a `send(event)` out.
 *
 * Spec §5.2 chose Server-Sent Events because the interlude is one-directional and
 * "survives Vercel". Surviving a proxy is the entire content of this file — the
 * format itself is two lines — and it comes down to four things, each of which has
 * been the cause of a stream that works locally and buffers in production:
 *
 * 1. **Headers are flushed before the first event.** The client's `fetch` promise
 *    does not resolve until the response head arrives, and the loop's first event
 *    (`replay`) can be milliseconds behind a request that then spends 40 seconds in
 *    the Analyst. `flushHeaders()` means the interlude opens immediately and the
 *    first beat renders when it is ready, rather than the whole UI waiting.
 * 2. **`Cache-Control: no-cache`** — an event stream that is cached is a stream
 *    that plays yesterday's fight.
 * 3. **`X-Accel-Buffering: no`** — nginx (and several CDNs that copy its
 *    conventions) buffers proxied responses by default, which turns a 40-second
 *    stream of beats into one 40-second wait followed by every beat at once. That
 *    header is the documented opt-out and costs nothing where it is not understood.
 * 4. **A keep-alive comment every 10 s.** Gate 3 can simulate for tens of seconds
 *    without emitting anything, and an idle-timeout somewhere in the middle would
 *    kill the connection at exactly the moment the harness is doing its job. `:` is
 *    an SSE comment: the client's parser drops it (see `web/src/interlude/sse.ts`)
 *    and the socket stays warm.
 *
 * `compression` is deliberately not applied anywhere: a compressor with a buffer is
 * the same failure as a proxy with a buffer.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { frameOf, type ServerRewriteEvent } from './events.ts';

/** Long enough not to be chatty, short enough for the usual 30-60 s idle timeouts. */
export const KEEPALIVE_MS = 10_000;

export type SseStream = {
  /** Write one frame. A no-op once the client has gone. */
  send(event: ServerRewriteEvent): void;
  /** Write a `: comment` frame. */
  comment(text: string): void;
  /** Stop the keep-alive and end the response. Idempotent. */
  close(): void;
  /** Aborts when the client disconnects — hand this to `handleRewrite`. */
  readonly signal: AbortSignal;
  /** True once the client has gone or `close()` has run. */
  readonly closed: boolean;
  /** Frames written. The log's `events` count. */
  readonly sent: number;
};

export type SseOptions = {
  keepaliveMs?: number;
  /** Extra response headers — CORS, in practice. */
  headers?: Record<string, string>;
};

export function startSse(
  req: IncomingMessage,
  res: ServerResponse,
  opts: SseOptions = {},
): SseStream {
  const controller = new AbortController();
  let closed = false;
  let sent = 0;

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // See the header: the one that actually decides whether the beats arrive as
    // beats behind a reverse proxy.
    'x-accel-buffering': 'no',
    ...opts.headers,
  });
  // Nagle would hold a small frame back waiting for company. Every frame here is
  // small and every one of them is the thing the player is waiting to see.
  res.socket?.setNoDelay(true);
  res.flushHeaders();

  const keepalive = setInterval(() => {
    if (closed) return;
    res.write(': keepalive\n\n');
  }, opts.keepaliveMs ?? KEEPALIVE_MS);
  // The interval must never be the reason the process stays up.
  keepalive.unref?.();

  /**
   * The client went away: a closed tab, a navigation, a lost network. This is the
   * signal that stops the loop, and stopping it is not a nicety — an abandoned run
   * would keep calling the model and keep 200 matches simulating on every core for
   * a player who is no longer there.
   */
  const onClose = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(keepalive);
    controller.abort();
  };
  req.once('close', onClose);
  res.once('close', onClose);

  return {
    signal: controller.signal,
    get closed(): boolean {
      return closed;
    },
    get sent(): number {
      return sent;
    },

    send(event: ServerRewriteEvent): void {
      if (closed || res.writableEnded) return;
      sent += 1;
      res.write(frameOf(event));
    },

    comment(text: string): void {
      if (closed || res.writableEnded) return;
      res.write(`: ${text}\n\n`);
    },

    close(): void {
      clearInterval(keepalive);
      if (closed || res.writableEnded) {
        closed = true;
        return;
      }
      closed = true;
      res.end();
    },
  };
}
