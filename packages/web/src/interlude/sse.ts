/**
 * An SSE frame parser, because the interlude's stream arrives over a **POST**.
 *
 * `EventSource` can only issue a GET with no body, and the rewrite request carries a
 * whole `ReplaySummary` (spec §5: `POST /api/rewrite (round, replay, prevStrategy)`).
 * So the client uses `fetch` and parses `text/event-stream` itself. That is the only
 * reason this file exists — the wire format is unchanged, so a curl against the same
 * endpoint is still readable by a human, and the server may be written with any SSE
 * helper.
 *
 * The format implemented is the WHATWG event-stream one, minus what we do not use:
 *
 * ```
 * event: verdict            <- optional; the parser reports it, the app ignores it
 * data: {"type":"verdict",  <- one or more `data:` lines, joined with "\n"
 * data:  "approved":false}
 *                           <- blank line dispatches the frame
 * : keep-alive              <- a comment; ignored (this is how a proxy is kept warm)
 * ```
 *
 * Two properties are load-bearing and are what `test/sse.test.ts` is about:
 *
 * 1. **Chunk boundaries are meaningless.** A `fetch` body arrives in whatever pieces
 *    the network chose; a frame, a line, or a UTF-8 character can be split across
 *    two chunks. The parser keeps a tail buffer and never dispatches on anything but
 *    a blank line, so `push('data: {"a"')` + `push('1}\n\n')` is one frame.
 * 2. **A frame with no `data` is not a frame.** Keep-alive comments and bare
 *    `event:` lines must not reach the app as empty payloads.
 */

export type SseFrame = {
  /** The `event:` field, when the server sent one. */
  event?: string;
  /** `data:` lines joined with `\n`, never empty (an empty frame is not dispatched). */
  data: string;
  id?: string;
  /** `retry:` in milliseconds, when it parsed as an integer. */
  retry?: number;
};

export type SseParser = {
  /** Feed one decoded chunk. Dispatches every complete frame it contains. */
  push(chunk: string): void;
  /**
   * End of stream. A well-formed stream ends with a blank line, but a server that
   * closes the socket right after the last `data:` line still meant to send it, so
   * the buffered frame is flushed rather than dropped.
   */
  end(): void;
};

/** Strip one optional leading space after the colon, per the spec. */
function fieldValue(raw: string): string {
  return raw.startsWith(' ') ? raw.slice(1) : raw;
}

export function createSseParser(onFrame: (frame: SseFrame) => void): SseParser {
  /** Bytes seen since the last line terminator. */
  let tail = '';
  let dataLines: string[] = [];
  let eventName: string | undefined;
  let id: string | undefined;
  let retry: number | undefined;
  /**
   * A `\r` at the very end of a chunk is ambiguous: alone it is a terminator, but
   * followed by `\n` in the *next* chunk it is half of a CRLF. Remember it and eat
   * the `\n` if it turns up.
   */
  let pendingCr = false;

  function reset(): void {
    dataLines = [];
    eventName = undefined;
    id = undefined;
    retry = undefined;
  }

  function dispatch(): void {
    // A comment-only or `event:`-only frame carries nothing to render.
    if (dataLines.length === 0) {
      reset();
      return;
    }
    const frame: SseFrame = {
      ...(eventName === undefined ? {} : { event: eventName }),
      data: dataLines.join('\n'),
      ...(id === undefined ? {} : { id }),
      ...(retry === undefined ? {} : { retry }),
    };
    reset();
    onFrame(frame);
  }

  function line(text: string): void {
    if (text === '') {
      dispatch();
      return;
    }
    // ": anything" is a comment. Used for keep-alives; never a frame.
    if (text.startsWith(':')) return;

    const colon = text.indexOf(':');
    const field = colon === -1 ? text : text.slice(0, colon);
    const value = colon === -1 ? '' : fieldValue(text.slice(colon + 1));

    switch (field) {
      case 'data':
        dataLines.push(value);
        break;
      case 'event':
        eventName = value;
        break;
      case 'id':
        // The spec forbids NUL in an id; nothing here needs one either way.
        if (!value.includes('\0')) id = value;
        break;
      case 'retry': {
        const ms = Number(value);
        if (Number.isInteger(ms) && ms >= 0) retry = ms;
        break;
      }
      default:
        // Unknown field. Ignored, per the spec — this is how the format evolves.
        break;
    }
  }

  return {
    push(chunk: string): void {
      let rest = chunk;
      if (pendingCr) {
        pendingCr = false;
        if (rest.startsWith('\n')) rest = rest.slice(1);
      }
      tail += rest;

      let start = 0;
      for (let i = 0; i < tail.length; i += 1) {
        const ch = tail[i];
        if (ch !== '\n' && ch !== '\r') continue;
        line(tail.slice(start, i));
        if (ch === '\r') {
          if (i + 1 < tail.length) {
            if (tail[i + 1] === '\n') i += 1;
          } else {
            // Last character of the chunk; the CRLF may straddle the boundary.
            pendingCr = true;
          }
        }
        start = i + 1;
      }
      tail = tail.slice(start);
    },

    end(): void {
      if (tail !== '') {
        line(tail);
        tail = '';
      }
      pendingCr = false;
      dispatch();
    },
  };
}

/**
 * Read a `fetch` response body as an event stream, calling `onFrame` per frame.
 *
 * Decoding is incremental (`TextDecoder({ stream: true })`) for the same reason the
 * parser buffers: a multi-byte character can be split across two network chunks, and
 * a per-chunk `new TextDecoder().decode()` would turn that into U+FFFD in the middle
 * of a strategy's source.
 */
export async function readEventStream(
  body: ReadableStream<Uint8Array>,
  onFrame: (frame: SseFrame) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser(onFrame);
  try {
    for (;;) {
      if (signal?.aborted === true) return;
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) parser.push(decoder.decode(value, { stream: true }));
    }
    const flushed = decoder.decode();
    if (flushed !== '') parser.push(flushed);
    parser.end();
  } finally {
    // Releasing the lock is what lets an aborted request's socket be torn down.
    reader.releaseLock();
  }
}
