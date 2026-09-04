/**
 * Shared machinery for the server suite: a real server on an ephemeral port, a real
 * `fetch`, a real SSE parse. **No network and no API key** — the only thing mocked
 * is the model, through `createServer({ provider })`.
 *
 * That is the whole point of the suite. The interesting failures in an SSE endpoint
 * are not in the loop (which `@rematch/agents` tests) but in the framing: headers
 * that never flush, a `done` that never arrives, a disconnect that does not reach
 * the loop. None of those are visible to a unit test of a handler, so every test
 * here goes over a socket.
 */
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { loadCanned, mockProvider, type LLMProvider, type LLMRequest } from '@rematch/agents';
import type { ReplaySummary } from '@rematch/engine';
import { createServer, type ServerOptions } from '../src/http.ts';

/**
 * Gate 3 matches per attempt, against the spec's 200.
 *
 * 24 is a measured choice, not a guess: `round2-candidate` scores 0.42 vs the panel
 * (band 0.35-0.50) and 0.83 vs the Mimic (≥ 0.70) at 24 matches, the same verdict it
 * gets at 200, and the gate takes ~0.4 s instead of ~3 s. The whole suite has to stay
 * under 20 s and there are several full loops in it.
 */
export const MATCHES = 24;

/** Known-good strategies live in `contract`; every consumer reuses them (spec §7). */
export function readGood(name: 'idle' | 'chaser' | 'orbiter' | 'cornerbreaker'): string {
  return readFileSync(
    new URL(`../../contract/test/fixtures/strategies/good/${name}.js`, import.meta.url),
    'utf8',
  );
}

/** The harness's rejection corpus and its hand-written Round 2 boss. */
export function readHarnessFixture(name: string): string {
  return readFileSync(new URL(`../../harness/test/fixtures/${name}.js`, import.meta.url), 'utf8');
}

export function cannedSummary(name = 'camper-a' as const): ReplaySummary {
  return loadCanned(name).summary;
}

/** A valid `POST /api/rewrite` body. Override any field to make it invalid. */
export function requestBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  const summary = cannedSummary();
  return {
    round: 2,
    seed: summary.seed,
    summary,
    prevSource: readGood('idle'),
    prevMeta: summary.strategy,
    ...over,
  };
}

/** What a model reply looks like: the Analyst's JSON, the Coder's fenced block. */
export const ANALYSIS_JSON = JSON.stringify({
  observations: ['Camped cell 63 for most of the round.', 'Never dashed.'],
  playerArchetype: 'camper',
  counterPlan: 'Slam the bottom-right corner and hold mid range.',
});

export function asCoderReply(source: string): string {
  return `\`\`\`js\n${source}\n\`\`\`\n`;
}

/**
 * A provider that answers the Analyst then the Coder, and records the `AbortSignal`
 * of every call it was given.
 *
 * The recorded signals are how the disconnect test proves its point: "the client
 * closed the tab" is only meaningful if it reaches the thing that costs money, so
 * the assertion is on the signal the *provider* was handed, not on a server-side
 * flag.
 */
export function scriptedProvider(
  coderReplies: readonly string[],
  opts: { stall?: boolean; delayMs?: number } = {},
): LLMProvider & { signals: AbortSignal[]; requests: LLMRequest[] } {
  const inner = mockProvider([
    {
      text: ANALYSIS_JSON,
      ...(opts.stall === true ? { stall: true } : {}),
      ...(opts.delayMs === undefined ? {} : { delayMs: opts.delayMs }),
    },
    ...coderReplies,
  ]);
  const signals: AbortSignal[] = [];
  const requests: LLMRequest[] = [];
  return {
    name: inner.name,
    model: inner.model,
    signals,
    requests,
    stream(req) {
      requests.push(req);
      if (req.signal !== undefined) signals.push(req.signal);
      return inner.stream(req);
    },
  };
}

export type TestServer = {
  url: string;
  close(): Promise<void>;
};

/**
 * Listen on port 0 and return the base URL.
 *
 * Defaults chosen so a test says only what it is about: no artifact is written (the
 * suite must not litter `artifacts/`), no log line is printed (a passing suite is
 * quiet), the limiter is off unless the test is about the limiter, and Gate 3 runs
 * at `MATCHES`.
 */
export async function startServer(opts: ServerOptions = {}): Promise<TestServer> {
  const server = createServer({
    artifactDir: false,
    log: () => {},
    rateLimit: false,
    harnessOpts: { gate3: { matches: MATCHES } },
    // Nothing in the environment may change a test's verdict: no key, no model
    // override, no deadline override, no origin allow-list from a `.env`.
    env: {},
    ...opts,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// ------------------------------------------------------------------ SSE client

export type Frame = { event?: string; data: string };

/**
 * The minimum SSE parser the assertions need.
 *
 * Deliberately *not* the client's parser (`packages/web/src/interlude/sse.ts`):
 * these tests are the other side of that contract, and checking the server with the
 * client's own code would make a shared misreading of the format invisible. This one
 * knows only what the spec says — `event:`, `data:`, blank line dispatches,
 * `:` is a comment.
 */
export function parseFrames(text: string): Frame[] {
  const frames: Frame[] = [];
  for (const block of text.split('\n\n')) {
    const data: string[] = [];
    let event: string | undefined;
    for (const line of block.split('\n')) {
      if (line === '' || line.startsWith(':')) continue;
      if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
      else if (line.startsWith('data:')) data.push(line.slice('data:'.length).replace(/^ /, ''));
    }
    if (data.length > 0) frames.push({ ...(event === undefined ? {} : { event }), data: data.join('\n') });
  }
  return frames;
}

export type StreamedEvent = { type: string } & Record<string, unknown>;

export type StreamResult = {
  status: number;
  headers: Headers;
  frames: Frame[];
  events: StreamedEvent[];
  /** Comment frames seen, keep-alives included. */
  comments: string[];
  raw: string;
};

/** POST a body and drain the event stream to completion. */
export async function postRewrite(
  base: string,
  body: unknown,
  init: { signal?: AbortSignal; headers?: Record<string, string> } = {},
): Promise<StreamResult> {
  const response = await fetch(`${base}/api/rewrite`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...init.headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...(init.signal === undefined ? {} : { signal: init.signal }),
  });

  const raw = response.body === null ? '' : await new Response(response.body).text();
  const frames = response.headers.get('content-type')?.includes('text/event-stream') === true
    ? parseFrames(raw)
    : [];
  return {
    status: response.status,
    headers: response.headers,
    frames,
    events: frames.map((f) => JSON.parse(f.data) as StreamedEvent),
    comments: raw
      .split('\n')
      .filter((line) => line.startsWith(':'))
      .map((line) => line.slice(1).trim()),
    raw,
  };
}

/** Every event of one type, in order. */
export function eventsOf(events: readonly StreamedEvent[], type: string): StreamedEvent[] {
  return events.filter((e) => e.type === type);
}

/**
 * Read a frame's payload at a type the test states.
 *
 * The events come off the wire as parsed JSON, so they are `unknown` by rights and
 * `StreamedEvent` (a `type` and an index signature) is as much as the parser can
 * honestly claim. Each assertion knows which event it is looking at, so it says so
 * here — and stating it in the test is the point: this is the client's view of the
 * contract, written out by hand rather than imported from the server that produced
 * it.
 */
export function payload<T>(event: StreamedEvent | undefined): T {
  if (event === undefined) throw new Error('expected an event, got none');
  return event as unknown as T;
}

/** The shape of the terminal frame, as a client reads it. See `src/events.ts`. */
export type DoneFrame = {
  type: 'done';
  result: {
    approved: boolean;
    attempts: { attempt: number; approved: boolean; reason?: string }[];
    /** Approved only. */
    source?: string;
    meta?: { name: string; rationale: string; version: number };
    /** Not approved only. */
    reason?: string;
    message?: string;
    fallback?: { name: string; source: string };
  };
};

/** The last frame, which the contract says is always `done`. */
export function doneOf(res: { events: StreamedEvent[] }): DoneFrame['result'] {
  const last = res.events.at(-1);
  if (last?.type !== 'done') throw new Error(`the stream ended with ${String(last?.type)}, not \`done\``);
  return payload<DoneFrame>(last).result;
}
