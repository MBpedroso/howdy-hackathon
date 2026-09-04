/**
 * The SSE frame parser. This is the one piece of the interlude's transport that is
 * hand-rolled (because the stream arrives over a POST — see `src/interlude/sse.ts`),
 * so it is the one piece that has to be tested against the format rather than
 * against a friendly server.
 *
 * The tests are organized around the two ways a real stream breaks a naive parser:
 * chunk boundaries land wherever the network decided, and a frame is not a line.
 */
import { describe, expect, it } from 'vitest';

import { createSseParser, readEventStream, type SseFrame } from '../src/interlude/sse.ts';

function collect(chunks: readonly string[], flush = true): SseFrame[] {
  const frames: SseFrame[] = [];
  const parser = createSseParser((f) => void frames.push(f));
  for (const chunk of chunks) parser.push(chunk);
  if (flush) parser.end();
  return frames;
}

describe('createSseParser', () => {
  it('parses a single well-formed frame', () => {
    expect(collect(['event: verdict\ndata: {"type":"verdict"}\n\n'])).toEqual([
      { event: 'verdict', data: '{"type":"verdict"}' },
    ]);
  });

  it('parses several frames in one chunk', () => {
    const frames = collect(['event: a\ndata: 1\n\nevent: b\ndata: 2\n\n']);
    expect(frames).toEqual([
      { event: 'a', data: '1' },
      { event: 'b', data: '2' },
    ]);
  });

  it('does not dispatch until the blank line arrives', () => {
    const frames: SseFrame[] = [];
    const parser = createSseParser((f) => void frames.push(f));
    parser.push('event: verdict\ndata: {"a":1}\n');
    expect(frames).toEqual([]);
    parser.push('\n');
    expect(frames).toEqual([{ event: 'verdict', data: '{"a":1}' }]);
  });

  // The property that matters most: a `fetch` body is chunked by the network, and
  // every one of these splits happens in practice on a slow connection.
  it.each([1, 2, 3, 5, 7, 13, 29])('is invariant to a chunk size of %i bytes', (size) => {
    const stream = 'event: rewrite.done\ndata: {"type":"rewrite.done","attempt":2}\n\nevent: done\ndata: {"type":"done"}\n\n';
    const chunks: string[] = [];
    for (let i = 0; i < stream.length; i += size) chunks.push(stream.slice(i, i + size));

    expect(collect(chunks)).toEqual([
      { event: 'rewrite.done', data: '{"type":"rewrite.done","attempt":2}' },
      { event: 'done', data: '{"type":"done"}' },
    ]);
  });

  it('splits a frame across chunks mid-token', () => {
    // The nastiest realistic split: inside the JSON, inside a field name.
    expect(collect(['event: analysis.delta\ndata: {"ty', 'pe":"analysis.de', 'lta","delta":"x"}\n', '\n'])).toEqual([
      { event: 'analysis.delta', data: '{"type":"analysis.delta","delta":"x"}' },
    ]);
  });

  it('joins multi-line data with newlines', () => {
    const frames = collect(['data: line one\ndata: line two\ndata: line three\n\n']);
    expect(frames).toEqual([{ data: 'line one\nline two\nline three' }]);
  });

  it('keeps an empty data line as an empty line, not as nothing', () => {
    // A strategy source with a blank line in it arrives exactly like this.
    expect(collect(['data: a\ndata:\ndata: b\n\n'])).toEqual([{ data: 'a\n\nb' }]);
  });

  it('strips exactly one leading space after the colon', () => {
    expect(collect(['data:  two spaces\n\n'])).toEqual([{ data: ' two spaces' }]);
    expect(collect(['data:none\n\n'])).toEqual([{ data: 'none' }]);
  });

  it('reads the event name, id and retry fields', () => {
    expect(collect(['event: trial.gate\nid: 17\nretry: 3000\ndata: {}\n\n'])).toEqual([
      { event: 'trial.gate', data: '{}', id: '17', retry: 3000 },
    ]);
  });

  it('ignores comments, so a keep-alive is not an empty event', () => {
    const frames = collect([': keep-alive\n\n', ':\n\n', 'data: real\n\n']);
    expect(frames).toEqual([{ data: 'real' }]);
  });

  it('ignores an unknown field and a frame with no data', () => {
    expect(collect(['fizz: buzz\nevent: lonely\n\ndata: real\n\n'])).toEqual([{ data: 'real' }]);
  });

  it('handles CRLF, bare CR, and a CRLF split across chunks', () => {
    expect(collect(['event: a\r\ndata: 1\r\n\r\n'])).toEqual([{ event: 'a', data: '1' }]);
    expect(collect(['event: a\rdata: 1\r\r'])).toEqual([{ event: 'a', data: '1' }]);
    // `\r` at the end of one chunk, `\n` at the start of the next: one terminator,
    // not two. Two would dispatch the frame a line early.
    expect(collect(['data: 1\r', '\ndata: 2\r', '\n\r', '\n'])).toEqual([{ data: '1\n2' }]);
  });

  it('flushes a stream that ends without its final blank line', () => {
    // A server that closes the socket after the last `data:` line still meant it.
    expect(collect(['data: {"type":"done"}\n'])).toEqual([{ data: '{"type":"done"}' }]);
    expect(collect(['data: {"type":"done"}'])).toEqual([{ data: '{"type":"done"}' }]);
  });

  it('drops nothing and invents nothing at end of stream when it is clean', () => {
    expect(collect(['data: a\n\n'], true)).toEqual([{ data: 'a' }]);
  });

  it('carries a full event sequence in one pass', () => {
    const types = ['replay', 'analysis.delta', 'analysis.done', 'rewrite.delta', 'rewrite.done', 'trial.gate', 'trial.progress', 'verdict', 'done'];
    const stream = types.map((t) => `event: ${t}\ndata: ${JSON.stringify({ type: t })}\n\n`).join(': keep-alive\n\n');
    const frames = collect([stream]);
    expect(frames.map((f) => f.event)).toEqual(types);
    expect(frames.map((f) => (JSON.parse(f.data) as { type: string }).type)).toEqual(types);
  });
});

describe('readEventStream', () => {
  /** A `ReadableStream` that yields the given byte chunks, like `fetch` would. */
  function bodyOf(chunks: readonly string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let i = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i >= chunks.length) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(chunks[i] ?? ''));
        i += 1;
      },
    });
  }

  it('reads frames out of a byte stream', async () => {
    const frames: SseFrame[] = [];
    await readEventStream(bodyOf(['event: done\ndata: {"ok":', 'true}\n\n']), (f) => void frames.push(f));
    expect(frames).toEqual([{ event: 'done', data: '{"ok":true}' }]);
  });

  it('decodes a multi-byte character split across two chunks', async () => {
    // `–` (en dash) is three UTF-8 bytes; the band separator in every Gate 3
    // rejection reason is one, so this is not a hypothetical.
    const encoder = new TextEncoder();
    const bytes = encoder.encode('data: 0.35–0.50\n\n');
    const cut = Array.from(bytes).indexOf(0xe2) + 1;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, cut));
        controller.enqueue(bytes.slice(cut));
        controller.close();
      },
    });
    const frames: SseFrame[] = [];
    await readEventStream(stream, (f) => void frames.push(f));
    expect(frames).toEqual([{ data: '0.35–0.50' }]);
  });

  it('stops when the signal aborts', async () => {
    const controller = new AbortController();
    const frames: SseFrame[] = [];
    await readEventStream(
      bodyOf(['data: 1\n\n', 'data: 2\n\n']),
      (f) => {
        frames.push(f);
        controller.abort();
      },
      controller.signal,
    );
    expect(frames).toHaveLength(1);
  });
});
