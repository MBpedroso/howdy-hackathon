/**
 * The Claude Code CLI provider: the rewrite loop on a **developer's Claude
 * subscription**, through the installed `claude` binary, instead of a metered API key.
 *
 * Why this exists at all. The standing rule in `docs/AI-DEV-LOG.md` (2026-09-04) is
 * local-first — no model call without a human's explicit say-so — and the reason it had
 * to be written down is that the project's API credit was already gone. But a demo
 * video, a playtest and any honest look at the interlude all need the *real* model, not
 * the mock. A developer with Claude Code installed is already paying for exactly that
 * capacity, so this provider spends it: one `claude -p` subprocess per model call,
 * authenticated by whatever session the CLI already holds.
 *
 * Three properties are deliberate, and each one is a decision the other providers did
 * not have to make.
 *
 * **It is a pure text completion, not an agent.** `--tools ''` disables every built-in
 * tool, `--strict-mcp-config` (with no `--mcp-config`) drops every MCP server, and
 * `--safe-mode` drops the developer's own hooks, skills, plugins, output styles and
 * `CLAUDE.md`. That is not tidiness: without it the Coder — whose whole job is to write
 * a file — would be handed `Read`, `Edit` and `Bash` in the repo it is being evaluated
 * in, and the project's central claim is that the *harness* decides what ships. An
 * agent that can read `packages/harness/` is not writing a strategy, it is reading the
 * answer key. The confirming line in the CLI's own `init` event is `"tools": []`.
 *
 * **It never uses an API key, even if one is in the environment.** `ANTHROPIC_API_KEY`
 * and `ANTHROPIC_AUTH_TOKEN` are stripped from the child's environment
 * (`CLI_STRIPPED_ENV`), because the CLI prefers a key over the subscription when both
 * are present. Choosing this provider is a statement about *which wallet* pays, and a
 * key inherited from `.env` would silently answer that question the other way. The
 * `init` event reports `"apiKeySource": "none"` when this is working.
 *
 * **It is opt-in only.** `selectProvider`'s `auto` never picks it (see
 * `VENDOR_PREFERENCE`): spawning a subprocess that talks to the network on the strength
 * of a binary happening to be on `PATH` is not a default anyone asked for, and on a
 * deployed server it would be wrong twice over — no subscription is logged in there, and
 * the interlude's latency budget cannot absorb a process launch. It is a local-machine
 * provider and the docs say so in those words.
 *
 * ## The stream-json shapes this file reads
 *
 * `claude -p --output-format stream-json --verbose --include-partial-messages` emits one
 * JSON object per line. Four of them matter (verified against CLI 2.1.220):
 *
 * ```jsonc
 * {"type":"system","subtype":"init","model":"claude-sonnet-5","tools":[],"apiKeySource":"none"}
 * {"type":"stream_event","event":{"type":"content_block_delta",
 *                                 "delta":{"type":"text_delta","text":"Waves crash r"}}}
 * {"type":"assistant","message":{"model":"claude-sonnet-5","content":[{"type":"text","text":"…"}]}}
 * {"type":"result","subtype":"success","is_error":false,"result":"…","total_cost_usd":0.0118,
 *  "usage":{"input_tokens":2,"output_tokens":13,"cache_read_input_tokens":0,
 *           "cache_creation_input_tokens":1933}}
 * ```
 *
 * `stream_event` wraps the raw Anthropic streaming event, so the delta shape is the same
 * one `anthropicProvider` reads and the interlude's Rewrite beat streams at the same
 * granularity as it does on the API. `assistant` carries the *whole* message and arrives
 * as well as the deltas; it is therefore only used as a fallback, for the case where
 * partial messages are unavailable and the CLI emits nothing but complete messages —
 * then one `assistant` message becomes one `text` delta, which is coarse but never
 * silent. Everything else on the wire (`hook_started`, `status`, `rate_limit_event`,
 * `message_start`, `content_block_stop`, …) is ignored by design rather than by
 * accident: a new event type must not be able to break a run.
 *
 * ## Latency, which is the real constraint on this path
 *
 * A subprocess launch is ~250 ms, and that is the cheap part. The expensive part is that
 * `claude` inherits a **session effort setting**, and at the level a developer normally
 * keeps for their own coding one Coder call measured 145 s — see `CLI_DEFAULT_EFFORT`,
 * which is why `--effort low` is passed by default. Even then this path is slower than
 * the API providers, because a CLI turn is a whole Claude Code session start. Treat it
 * as the *playtest and demo-rehearsal* provider, not as the one AC 5's 45 s budget was
 * measured against: raise `REMATCH_DEADLINE_MS` when using it, and use
 * `?agent=recorded` for anything that has to hit 45 s.
 *
 * ## What this provider cannot do
 *
 * `LLMRequest.maxTokens` has **no CLI equivalent** and is not enforced. It is left as
 * documentation of intent; the model's own output ceiling applies instead. This matters
 * least where it would matter most — the Coder's budget exists to stop a runaway reply,
 * and `staticCheck` plus Gate 1 already judge whatever arrives.
 *
 * There is also no prompt caching to arrange. The CLI decides its own `cache_control`,
 * and the `result` event's `cache_read_input_tokens` is reported as-is so the run log
 * stays honest about what was cached rather than about what we asked for.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { AbortError, type LLMEvent, type LLMMessage, type LLMProvider, type LLMRequest, type LLMUsage } from './provider.ts';

/**
 * `sonnet`, the CLI's own alias for the latest Sonnet, for the same reason
 * `DEFAULT_MODEL` is Sonnet-class: AC 5's 45 s interlude has to cover an Analyst call,
 * up to four Coder attempts and four gates, so latency is the binding constraint. The
 * CLI accepts an alias (`sonnet`, `opus`, `haiku`, `fable`) or a full id
 * (`claude-sonnet-5`); an alias is the better default here because it does not go stale.
 */
export const CLAUDE_CLI_DEFAULT_MODEL = 'sonnet';

/** Override the binary. Default: `claude`, resolved on `PATH`. */
export const CLAUDE_BIN_ENV = 'REMATCH_CLAUDE_BIN';

/** Per-call wall-clock guard. A subprocess that never answers must not hang the loop. */
export const CLI_TIMEOUT_ENV = 'REMATCH_CLI_TIMEOUT_MS';
export const CLI_TIMEOUT_DEFAULT_MS = 60_000;

/** SIGTERM, then SIGKILL this long after. */
export const CLI_KILL_GRACE_MS = 2_000;

/** What `--effort` accepts. Anything else is not passed through. */
export const CLI_EFFORT_VALUES = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * `low`, and this is the single most important line in the file for AC 5.
 *
 * Measured on 2026-09-04, CLI 2.1.220, one real Coder prompt at the session's inherited
 * effort: **145 s wall clock, 126 s of it before the first text delta, 13 456 output
 * tokens for a 5 486-character reply.** Almost all of that was thinking, and the reply
 * it eventually produced passed `staticCheck` on the first try — which is the whole
 * argument: the Coder writes ~80 lines against a *frozen* contract with a deterministic
 * verifier behind it (spec §6.3), so an extra attempt is cheap and an extra two minutes
 * of deliberation is the one thing the 45 s interlude cannot buy.
 *
 * This is the same trade `OPENAI_DEFAULT_EFFORT` makes for the same reason. Unlike the
 * API providers, the CLI *inherits* a session default (`--effort` is a Claude Code
 * setting), so not passing the flag would leave the loop's latency at the mercy of
 * whatever the developer last configured for their own coding — an invisible
 * dependency on someone's editor preferences.
 */
export const CLI_DEFAULT_EFFORT = 'low';

/**
 * Removed from the child's environment. The CLI prefers an API key over the logged-in
 * subscription, and this provider exists precisely to *not* spend the API key.
 */
export const CLI_STRIPPED_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const;

/** How much of the child's stderr an error message carries. */
const STDERR_TAIL_CHARS = 800;

// ------------------------------------------------------------- the spawn seam

/** The slice of `child_process` this provider uses — so a test can hand it a fake. */
export type CliSpawnLike = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: Record<string, string | undefined>; stdio: readonly ['pipe', 'pipe', 'pipe'] },
) => CliChildLike;

export type CliChildLike = {
  readonly stdin: CliWritableLike | null;
  readonly stdout: CliReadableLike | null;
  readonly stderr: CliReadableLike | null;
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
};

export type CliReadableLike = {
  on(event: 'data', listener: (chunk: unknown) => void): unknown;
};

export type CliWritableLike = {
  on(event: 'error', listener: (err: Error) => void): unknown;
  write(chunk: string): unknown;
  end(): unknown;
};

export type ClaudeCliProviderOptions = {
  /** Passed to `--model`. Default `sonnet`. */
  model?: string;
  /** Default `claude` (or `REMATCH_CLAUDE_BIN`). */
  bin?: string;
  /** Injected in tests; defaults to `child_process.spawn`. */
  spawn?: CliSpawnLike;
  /** Default 60 s, or `REMATCH_CLI_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** SIGTERM → SIGKILL grace. Default 2 s; the tests shorten it. */
  killGraceMs?: number;
  /**
   * `--effort`: `low` (default), `medium`, `high`, `xhigh`, `max`, or the sentinel
   * `off` to send no flag and inherit the developer's own session setting.
   */
  effort?: string;
  /**
   * Working directory for the child. Defaults to the OS temp dir on purpose: a text
   * completion has no business inheriting the repo's workspace, and `--safe-mode`'s
   * guarantees are easier to reason about from a directory with nothing in it.
   */
  cwd?: string;
  /** Injected in tests. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
};

// ------------------------------------------------------------------- the args

/**
 * The exact argv, as one function, so the tests can assert on it and a human can read
 * what the subprocess was actually asked to do.
 *
 * `--tools ''` is variadic in the CLI's parser and therefore has to be followed by
 * another option rather than by a positional — it is, and the prompt goes on **stdin**,
 * so there is no positional for it to swallow.
 */
export function claudeCliArgs(opts: { model: string; system: string; effort?: string | undefined }): string[] {
  return [
    // Non-interactive: print the reply and exit. The prompt arrives on stdin.
    '-p',
    // Thinking is the dominant cost on this path — see `CLI_DEFAULT_EFFORT`. Omitted
    // only when the caller explicitly asks to inherit the session's own setting.
    ...(opts.effort === undefined ? [] : ['--effort', opts.effort]),
    '--output-format',
    'stream-json',
    // stream-json under --print requires --verbose; without it the CLI refuses.
    '--verbose',
    // Real text deltas (`stream_event`) rather than only whole `assistant` messages.
    // This is what makes the interlude's beats beats instead of a spinner.
    '--include-partial-messages',
    '--model',
    opts.model,
    // Replaces Claude Code's own system prompt outright, rather than appending to it
    // (`--append-system-prompt`): the Analyst and Coder prompts are complete
    // instructions, and a coding-agent preamble underneath them is context the
    // project's whole §8 argument says not to include.
    '--system-prompt',
    opts.system,
    // No tools. See the header: the Coder must not be able to read the harness.
    '--tools',
    '',
    // Nothing to resume, so nothing to write to disk.
    '--no-session-persistence',
    // No MCP servers (there is no --mcp-config, so this leaves exactly none).
    '--strict-mcp-config',
    '--disable-slash-commands',
    // The developer's hooks, skills, plugins, output styles and CLAUDE.md must not
    // change what the model is asked. Auth and model selection still work normally,
    // which is why this rather than --bare (which forbids subscription auth).
    '--safe-mode',
  ];
}

/**
 * One stdin prompt from the request's messages.
 *
 * A single user message — what both agents send today — is passed through byte for
 * byte, so the CLI sees the same prompt the API providers do. A multi-turn request is
 * flattened with role labels rather than dropped: `-p` takes one prompt, and a visibly
 * labelled transcript is a better answer than a silent truncation.
 */
export function claudeCliPrompt(messages: readonly LLMMessage[]): string {
  if (messages.length === 1 && messages[0] !== undefined) return messages[0].content;
  return messages.map((m) => `[${m.role}]\n${m.content}`).join('\n\n');
}

// ------------------------------------------------------------------ the parser

/** The fields this provider reads off a `result` event. */
export type CliResultEvent = {
  isError: boolean;
  subtype: string | undefined;
  text: string | undefined;
  usage: LLMUsage;
  apiErrorStatus: string | undefined;
};

type ParsedLine =
  | { kind: 'delta'; text: string }
  | { kind: 'message'; text: string; model: string | undefined }
  | { kind: 'model'; model: string }
  | { kind: 'result'; result: CliResultEvent }
  | { kind: 'ignore' };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * One line of stream-json → one thing this provider cares about.
 *
 * Exported because it is the whole contract with the CLI's output format, and a
 * contract worth having is a contract worth testing directly. Anything unrecognised is
 * `ignore`: a CLI release that adds an event type must not be able to fail a run.
 */
export function parseCliLine(line: string): ParsedLine {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    // Not JSON at all — a warning the CLI printed to stdout, say. Not our business.
    return { kind: 'ignore' };
  }
  const event = asRecord(value);
  if (event === undefined) return { kind: 'ignore' };

  switch (event['type']) {
    case 'stream_event': {
      const inner = asRecord(event['event']);
      if (inner?.['type'] === 'message_start') {
        const model = asString(asRecord(inner['message'])?.['model']);
        return model === undefined ? { kind: 'ignore' } : { kind: 'model', model };
      }
      if (inner?.['type'] !== 'content_block_delta') return { kind: 'ignore' };
      const delta = asRecord(inner['delta']);
      // `text_delta` only: `thinking_delta` and `input_json_delta` are not the answer,
      // and the interlude must never render them.
      if (delta?.['type'] !== 'text_delta') return { kind: 'ignore' };
      const text = asString(delta['text']) ?? '';
      return text === '' ? { kind: 'ignore' } : { kind: 'delta', text };
    }
    case 'assistant': {
      const message = asRecord(event['message']);
      const blocks = message?.['content'];
      if (!Array.isArray(blocks)) return { kind: 'ignore' };
      const text = blocks
        .map((block) => (asRecord(block)?.['type'] === 'text' ? asString(asRecord(block)?.['text']) ?? '' : ''))
        .join('');
      return { kind: 'message', text, model: asString(message?.['model']) };
    }
    case 'system': {
      if (event['subtype'] !== 'init') return { kind: 'ignore' };
      const model = asString(event['model']);
      return model === undefined ? { kind: 'ignore' } : { kind: 'model', model };
    }
    case 'result':
      return { kind: 'result', result: readResult(event) };
    default:
      return { kind: 'ignore' };
  }
}

/**
 * `result.usage` → `LLMUsage`, mapped the same way `anthropicProvider` maps the API's
 * own usage block: `input_tokens` excludes cache traffic, and cache reads are reported
 * separately when the CLI reports them. `total_cost_usd` is the one field the API
 * providers have no equivalent for, and it is the most useful number on this path —
 * subscription usage is not free, it is prepaid, so a run log that shows what a rewrite
 * would have cost is the only way to compare the two wallets.
 */
function readResult(event: Record<string, unknown>): CliResultEvent {
  const usage = asRecord(event['usage']);
  const cacheRead = asNumber(usage?.['cache_read_input_tokens']);
  const cost = asNumber(event['total_cost_usd']);
  return {
    isError: event['is_error'] === true,
    subtype: asString(event['subtype']),
    text: asString(event['result']),
    apiErrorStatus: asString(event['api_error_status']),
    usage: {
      inputTokens: asNumber(usage?.['input_tokens']) ?? 0,
      outputTokens: asNumber(usage?.['output_tokens']) ?? 0,
      ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
      ...(cost === undefined ? {} : { costUsd: cost }),
    },
  };
}

// -------------------------------------------------------------------- the queue

type Frame = LLMEvent | { type: 'fail'; error: Error };

/**
 * A one-consumer async queue. The child's callbacks push; the generator pulls.
 *
 * Written out rather than pulled from a dependency because the interesting behaviour is
 * two lines of it: `end()` while the consumer is parked has to wake it, and a `push`
 * that lands before the consumer parks must not be lost.
 */
class FrameQueue {
  private readonly items: Frame[] = [];
  private wake: (() => void) | undefined;
  private ended = false;

  push(frame: Frame): void {
    if (this.ended) return;
    this.items.push(frame);
    this.flush();
  }

  end(): void {
    this.ended = true;
    this.flush();
  }

  private flush(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  async *drain(): AsyncGenerator<Frame> {
    for (;;) {
      const next = this.items.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}

// ----------------------------------------------------------------- the errors

/** The binary is not there. The single most likely failure, so it gets its own sentence. */
export function cliMissingError(bin: string): Error {
  return new Error(
    `claude-cli: no \`${bin}\` on PATH — install Claude Code or set ${CLAUDE_BIN_ENV}=/path/to/claude; ` +
      'the rewrite loop cannot run, use the fallback pool',
  );
}

function isEnoent(err: unknown): boolean {
  return asRecord(err)?.['code'] === 'ENOENT';
}

function tail(text: string): string {
  const trimmed = text.trimEnd();
  return trimmed.length <= STDERR_TAIL_CHARS ? trimmed : `…${trimmed.slice(-STDERR_TAIL_CHARS)}`;
}

/** A non-zero exit, with the stderr tail — which is where the CLI says why. */
export function cliExitError(bin: string, code: number | null, signal: string | null, stderr: string): Error {
  const how = code === null ? `killed by ${signal ?? 'a signal'}` : `exited ${code}`;
  const why = stderr.trim() === '' ? 'no stderr' : `stderr: ${tail(stderr)}`;
  return new Error(`claude-cli: \`${bin}\` ${how} — ${why}`);
}

/**
 * `REMATCH_CLI_TIMEOUT_MS`, or `undefined` for "not set". A blank or unreadable value
 * is *not* zero: `REMATCH_CLI_TIMEOUT_MS=` in a `.env` would otherwise mean "time out
 * immediately", which is the least likely thing anyone typing it meant.
 */
export function readTimeoutMs(env: Record<string, string | undefined>): number | undefined {
  const raw = (env[CLI_TIMEOUT_ENV] ?? '').trim();
  if (raw === '') return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * `--effort`'s value, or `undefined` to omit the flag.
 *
 * `REMATCH_REASONING_EFFORT` is reused rather than given a CLI-specific twin: to a
 * human it means the same thing on both paths, and one variable that both providers
 * read is one fewer way for the eval and the server to disagree. The value sets do not
 * match exactly, though — the CLI takes `xhigh` and `max` and does not take OpenAI's
 * `minimal` or `none` — so an unusable value falls back to the default instead of being
 * handed to a CLI that would reject it and fail the whole rewrite. `off` is the shared
 * sentinel for "send no flag at all", exactly as it is for `openaiProvider`.
 */
export function readEffort(env: Record<string, string | undefined>, override?: string): string | undefined {
  const raw = (override ?? env['REMATCH_REASONING_EFFORT'] ?? '').trim().toLowerCase();
  if (raw === 'off') return undefined;
  if ((CLI_EFFORT_VALUES as readonly string[]).includes(raw)) return raw;
  return CLI_DEFAULT_EFFORT;
}

// ---------------------------------------------------------------- the provider

/**
 * The provider. One subprocess per `stream()` call, nothing shared between calls.
 *
 * A process launch per model call is ~250 ms of the interlude's budget and is the honest
 * price of this path; it is charged once per Analyst call and once per Coder candidate,
 * and the candidates already run concurrently (spec §13 delta 12), so it costs the loop
 * one launch of wall clock rather than K.
 */
export function claudeCliProvider(opts: ClaudeCliProviderOptions = {}): LLMProvider {
  const env = opts.env ?? process.env;
  const model = opts.model ?? CLAUDE_CLI_DEFAULT_MODEL;
  const bin = opts.bin ?? env[CLAUDE_BIN_ENV] ?? 'claude';
  const spawn = opts.spawn ?? (nodeSpawn as unknown as CliSpawnLike);
  const timeoutMs = opts.timeoutMs ?? readTimeoutMs(env) ?? CLI_TIMEOUT_DEFAULT_MS;
  const killGraceMs = opts.killGraceMs ?? CLI_KILL_GRACE_MS;
  const cwd = opts.cwd ?? tmpdir();
  const effort = readEffort(env, opts.effort);

  /** `process.env` minus the two variables that would redirect the bill. */
  const childEnv = (): Record<string, string | undefined> => {
    const copy: Record<string, string | undefined> = { ...env };
    for (const name of CLI_STRIPPED_ENV) delete copy[name];
    return copy;
  };

  return {
    name: `claude-cli:${model}`,
    model,
    async *stream(req: LLMRequest): AsyncIterable<LLMEvent> {
      const target = req.model ?? model;
      const args = claudeCliArgs({ model: target, system: req.system, effort });
      const queue = new FrameQueue();

      let child: CliChildLike;
      try {
        child = spawn(bin, args, { cwd, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (err) {
        // A synchronous throw from `spawn` — the missing-binary case on some platforms.
        throw isEnoent(err) ? cliMissingError(bin) : err;
      }

      let closed = false;
      let aborted = false;
      let sawDelta = false;
      let text = '';
      let resolvedModel = target;
      let result: CliResultEvent | undefined;
      let stderr = '';
      let pending = '';
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let terminating = false;

      /**
       * SIGTERM now, SIGKILL after the grace — **once**. Idempotence matters here
       * rather than being tidy: an abort terminates, and then the generator's `finally`
       * terminates again on the way out, so without the latch a normal deadline abort
       * would send two SIGTERMs to a process that had already been asked politely.
       */
      const terminate = (): void => {
        if (closed || terminating) return;
        terminating = true;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => {
          if (!closed) child.kill('SIGKILL');
        }, killGraceMs);
        killTimer.unref?.();
      };

      const onAbort = (): void => {
        aborted = true;
        // Reject promptly rather than waiting for the child to notice its signal: the
        // loop's deadline aborting a call is a normal event on this path, and the
        // interlude has beats waiting on it.
        queue.push({ type: 'fail', error: new AbortError() });
        queue.end();
        terminate();
      };

      if (req.signal?.aborted === true) {
        terminate();
        throw new AbortError();
      }
      req.signal?.addEventListener('abort', onAbort, { once: true });

      const handleLine = (line: string): void => {
        if (line.trim() === '') return;
        const parsed = parseCliLine(line);
        switch (parsed.kind) {
          case 'delta':
            sawDelta = true;
            text += parsed.text;
            queue.push({ type: 'text', delta: parsed.text });
            return;
          case 'message':
            if (parsed.model !== undefined) resolvedModel = parsed.model;
            // Only when there were no partial deltas: otherwise this is the same text
            // arriving a second time, whole.
            if (sawDelta || parsed.text === '') return;
            text += parsed.text;
            queue.push({ type: 'text', delta: parsed.text });
            return;
          case 'model':
            resolvedModel = parsed.model;
            return;
          case 'result':
            result = parsed.result;
            return;
          case 'ignore':
            return;
        }
      };

      child.stdout?.on('data', (chunk: unknown) => {
        pending += String(chunk);
        const lines = pending.split('\n');
        // The last element is either '' (the chunk ended on a newline) or a partial
        // line; either way it stays buffered.
        pending = lines.pop() ?? '';
        for (const line of lines) handleLine(line);
      });

      child.stderr?.on('data', (chunk: unknown) => {
        stderr += String(chunk);
        if (stderr.length > STDERR_TAIL_CHARS * 4) stderr = stderr.slice(-STDERR_TAIL_CHARS * 2);
      });

      child.on('error', (err: Error) => {
        closed = true;
        queue.push({ type: 'fail', error: isEnoent(err) ? cliMissingError(bin) : err });
        queue.end();
      });

      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        closed = true;
        if (killTimer !== undefined) clearTimeout(killTimer);
        if (pending !== '') {
          handleLine(pending);
          pending = '';
        }
        if (aborted) {
          queue.end();
          return;
        }
        if (code !== 0) {
          queue.push({ type: 'fail', error: cliExitError(bin, code, signal, stderr) });
          queue.end();
          return;
        }
        if (result?.isError === true || (result !== undefined && result.subtype !== 'success')) {
          const detail = [result.subtype, result.apiErrorStatus, result.text].filter((s) => s !== undefined && s !== '');
          queue.push({
            type: 'fail',
            error: new Error(`claude-cli: the CLI reported a failure — ${detail.join(': ') || 'no detail'}`),
          });
          queue.end();
          return;
        }
        // Exit 0 with neither a result event nor any text is not an empty answer, it is
        // a broken one — and an empty strategy would be silently rejected by Gate 1
        // three attempts later, which is a much worse way to learn about it.
        if (result === undefined && text === '') {
          queue.push({
            type: 'fail',
            error: new Error(
              `claude-cli: \`${bin}\` exited 0 without a result event or any text — ${stderr.trim() === '' ? 'no stderr' : `stderr: ${tail(stderr)}`}`,
            ),
          });
          queue.end();
          return;
        }
        queue.push({
          type: 'done',
          // The streamed text is authoritative: it is what the caller's `onDelta`
          // already showed. `result.result` only fills in when nothing streamed.
          text: text !== '' ? text : result?.text ?? '',
          model: resolvedModel,
          usage: result?.usage ?? { inputTokens: 0, outputTokens: 0 },
        });
        queue.end();
      });

      timeoutTimer = setTimeout(() => {
        queue.push({
          type: 'fail',
          error: new Error(`claude-cli: \`${bin}\` did not answer within ${timeoutMs} ms (${CLI_TIMEOUT_ENV})`),
        });
        queue.end();
        terminate();
      }, timeoutMs);
      timeoutTimer.unref?.();

      // The prompt on stdin, not argv: a Coder prompt is ~10 KB and argv limits are a
      // platform detail nobody should have to think about.
      child.stdin?.on('error', () => {
        // EPIPE, because the child died before reading. The 'close' handler owns the
        // error message; swallowing it here only stops an unhandled 'error' event.
      });
      child.stdin?.write(claudeCliPrompt(req.messages));
      child.stdin?.end();

      try {
        for await (const frame of queue.drain()) {
          if (frame.type === 'fail') throw frame.error;
          yield frame;
        }
      } finally {
        if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
        req.signal?.removeEventListener('abort', onAbort);
        // A consumer that breaks out of the loop early must not leave a subprocess
        // talking to the network on its own time.
        terminate();
      }
    },
  };
}
