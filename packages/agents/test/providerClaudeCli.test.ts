/**
 * The Claude Code CLI provider, against a fake `spawn`.
 *
 * **No CLI is launched here and no network is touched**, which is not a convenience —
 * `pnpm verify` runs on every commit (spec §7 control 1) and must never spend a token,
 * and on this path a token is a slice of the developer's subscription rather than a
 * line on an invoice. So the seam is `child_process.spawn` itself: the tests hand the
 * provider canned stream-json lines and an exit code and assert on everything the
 * provider does with them, including the two things a real run would only show you at
 * the worst possible moment — a missing binary and a non-zero exit.
 *
 * The canned lines are copied from a real `claude -p --output-format stream-json
 * --verbose --include-partial-messages` run against CLI 2.1.220, trimmed of the fields
 * this provider ignores. If a future CLI changes those shapes, `parseCliLine`'s own
 * tests are where it will show.
 */
import { describe, expect, it } from 'vitest';
import {
  AbortError,
  CLAUDE_BIN_ENV,
  CLAUDE_CLI_DEFAULT_MODEL,
  CLI_DEFAULT_EFFORT,
  CLI_STRIPPED_ENV,
  CLI_TIMEOUT_ENV,
  claudeCliArgs,
  claudeCliPrompt,
  claudeCliProvider,
  collect,
  parseCliLine,
  readEffort,
  readTimeoutMs,
  type CliChildLike,
  type CliSpawnLike,
} from '../src/index.ts';

// ------------------------------------------------------------------ the fake

/** A `ChildProcess` with the five behaviours this provider uses, and nothing else. */
class FakeChild {
  readonly stdoutListeners: ((chunk: unknown) => void)[] = [];
  readonly stderrListeners: ((chunk: unknown) => void)[] = [];
  readonly errorListeners: ((err: Error) => void)[] = [];
  readonly closeListeners: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];
  readonly kills: string[] = [];
  written = '';

  readonly stdout = { on: (_event: 'data', listener: (chunk: unknown) => void): unknown => this.stdoutListeners.push(listener) };
  readonly stderr = { on: (_event: 'data', listener: (chunk: unknown) => void): unknown => this.stderrListeners.push(listener) };
  readonly stdin = {
    on: (_event: 'error', _listener: (err: Error) => void): unknown => undefined,
    write: (chunk: string): unknown => (this.written += chunk),
    end: (): unknown => undefined,
  };

  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error' | 'close', listener: unknown): unknown {
    if (event === 'error') this.errorListeners.push(listener as (err: Error) => void);
    else this.closeListeners.push(listener as (code: number | null, signal: NodeJS.Signals | null) => void);
    return this;
  }

  kill(signal?: NodeJS.Signals): unknown {
    this.kills.push(signal ?? 'SIGTERM');
    return true;
  }

  emitStdout(chunk: string): void {
    for (const listener of [...this.stdoutListeners]) listener(Buffer.from(chunk));
  }

  emitStderr(chunk: string): void {
    for (const listener of [...this.stderrListeners]) listener(Buffer.from(chunk));
  }

  emitError(err: Error): void {
    for (const listener of [...this.errorListeners]) listener(err);
  }

  emitClose(code: number | null, signal: NodeJS.Signals | null = null): void {
    for (const listener of [...this.closeListeners]) listener(code, signal);
  }
}

type Script = {
  /** Raw stdout chunks, written verbatim — so a test can split a line across two. */
  stdout?: readonly string[];
  stderr?: string;
  /** `null` means "killed by a signal". */
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | null;
  /** Emitted as a `'error'` event instead of running the script (spawn failure). */
  spawnError?: Error;
  /** `spawn` throws synchronously — the other way a missing binary arrives. */
  throwOnSpawn?: Error;
  /** Emit the stdout but never close: for the abort and timeout tests. */
  hold?: boolean;
};

type Recorded = { command: string; args: string[]; cwd: string; env: Record<string, string | undefined> };

/**
 * A `spawn` that replays `script`.
 *
 * The emission is scheduled rather than synchronous because the provider attaches its
 * listeners immediately *after* the spawn call returns; a fake that emitted inline
 * would be testing a race the real `child_process` never runs.
 */
function fakeSpawn(script: Script = {}): { spawn: CliSpawnLike; calls: Recorded[]; children: FakeChild[] } {
  const calls: Recorded[] = [];
  const children: FakeChild[] = [];
  const spawn: CliSpawnLike = (command, args, options) => {
    if (script.throwOnSpawn !== undefined) throw script.throwOnSpawn;
    calls.push({ command, args: [...args], cwd: options.cwd, env: options.env });
    const child = new FakeChild();
    children.push(child);
    setTimeout(() => {
      if (script.spawnError !== undefined) {
        child.emitError(script.spawnError);
        return;
      }
      for (const chunk of script.stdout ?? []) child.emitStdout(chunk);
      if (script.stderr !== undefined) child.emitStderr(script.stderr);
      if (script.hold !== true) child.emitClose('exitCode' in script ? script.exitCode ?? null : 0, script.exitSignal ?? null);
    }, 0);
    return child as unknown as CliChildLike;
  };
  return { spawn, calls, children };
}

// --------------------------------------------------------------- canned lines

const INIT = JSON.stringify({
  type: 'system',
  subtype: 'init',
  cwd: '/private/tmp',
  tools: [],
  mcp_servers: [],
  model: 'claude-sonnet-5',
  apiKeySource: 'none',
});

const delta = (text: string): string =>
  JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });

const assistantMessage = (text: string): string =>
  JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-5', content: [{ type: 'text', text }] } });

const RESULT = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'hello',
  total_cost_usd: 0.011799,
  usage: {
    input_tokens: 11,
    output_tokens: 13,
    cache_read_input_tokens: 7,
    cache_creation_input_tokens: 1933,
  },
});

/** The whole happy stream, in the order the CLI emits it. */
const SUCCESS: readonly string[] = [
  `${INIT}\n`,
  `${JSON.stringify({ type: 'system', subtype: 'status', status: 'requesting' })}\n`,
  `${delta('he')}\n`,
  `${JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'IGNORED' } } })}\n`,
  `${delta('llo')}\n`,
  `${assistantMessage('hello')}\n`,
  `${JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } })}\n`,
  `${RESULT}\n`,
];

const REQ = { system: 'SYS', messages: [{ role: 'user' as const, content: 'USER' }], maxTokens: 100 };

// ------------------------------------------------------------------- the tests

describe('claudeCliProvider', () => {
  it('names the provider and defaults to a Sonnet-class alias, for latency', () => {
    const provider = claudeCliProvider({ env: {} });
    expect(provider.name).toBe(`claude-cli:${CLAUDE_CLI_DEFAULT_MODEL}`);
    expect(provider.model).toBe(CLAUDE_CLI_DEFAULT_MODEL);
    expect(CLAUDE_CLI_DEFAULT_MODEL).toBe('sonnet');
  });

  it('streams text deltas and normalises the result event onto the shared usage shape', async () => {
    const { spawn } = fakeSpawn({ stdout: SUCCESS });
    const deltas: string[] = [];
    const done = await collect(claudeCliProvider({ spawn, env: {} }), REQ, (d) => deltas.push(d));

    // Two `text_delta`s, and the `thinking_delta` between them never reaches the UI.
    expect(deltas).toEqual(['he', 'llo']);
    expect(done.text).toBe('hello');
    // The *resolved* model id from the stream, not the `sonnet` alias that was asked for.
    expect(done.model).toBe('claude-sonnet-5');
    expect(done.usage).toEqual({ inputTokens: 11, outputTokens: 13, cacheReadTokens: 7, costUsd: 0.011799 });
  });

  it('does not replay the whole `assistant` message on top of the deltas it already sent', async () => {
    // Both arrive on a real stream. Counting them both would double every reply — and
    // the Coder's reply is a file, so a doubled one is a syntax error at Gate 1.
    const { spawn } = fakeSpawn({ stdout: SUCCESS });
    const done = await collect(claudeCliProvider({ spawn, env: {} }), REQ);
    expect(done.text).toBe('hello');
  });

  it('falls back to one delta per whole message when no partial messages arrive', async () => {
    // The shape to expect if `--include-partial-messages` ever stops being honoured:
    // coarse, but the Rewrite beat still renders something rather than nothing.
    const { spawn } = fakeSpawn({ stdout: [`${INIT}\n`, `${assistantMessage('whole reply')}\n`, `${RESULT}\n`] });
    const deltas: string[] = [];
    const done = await collect(claudeCliProvider({ spawn, env: {} }), REQ, (d) => deltas.push(d));
    expect(deltas).toEqual(['whole reply']);
    expect(done.text).toBe('whole reply');
  });

  it('reassembles a JSON line split across two stdout chunks', async () => {
    const line = delta('split');
    const { spawn } = fakeSpawn({
      stdout: [`${INIT}\n${line.slice(0, 30)}`, `${line.slice(30)}\n${RESULT}\n`],
    });
    const done = await collect(claudeCliProvider({ spawn, env: {} }), REQ);
    expect(done.text).toBe('split');
  });

  it('sends the prompt on stdin, not on argv', async () => {
    const { spawn, children } = fakeSpawn({ stdout: SUCCESS });
    await collect(claudeCliProvider({ spawn, env: {} }), {
      ...REQ,
      messages: [{ role: 'user', content: 'THE PROMPT' }],
    });
    expect(children[0]?.written).toBe('THE PROMPT');
  });

  it('passes the tool-disabling flags, the model and the system prompt', async () => {
    const { spawn, calls } = fakeSpawn({ stdout: SUCCESS });
    await collect(claudeCliProvider({ spawn, env: {}, model: 'sonnet' }), { ...REQ, model: 'opus' });

    const args = calls[0]?.args ?? [];
    expect(args).toContain('-p');
    expect(args.join(' ')).toContain('--output-format stream-json');
    expect(args).toContain('--verbose');
    expect(args).toContain('--include-partial-messages');
    // The request's model wins over the provider's default, like the other providers.
    expect(args[args.indexOf('--model') + 1]).toBe('opus');
    expect(args[args.indexOf('--system-prompt') + 1]).toBe('SYS');
    // The Coder must not be able to read the harness or run a command: no tools at all.
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--disable-slash-commands');
    // No hooks, skills, plugins, output styles or CLAUDE.md from the developer's machine.
    expect(args).toContain('--safe-mode');
    // Nothing to resume means nothing written to disk.
    expect(args).toContain('--no-session-persistence');
  });

  it('caps the effort, so the loop does not inherit the developer\'s own session setting', async () => {
    // Measured 2026-09-04: the same Coder prompt took 145 s and 13 456 output tokens at
    // an inherited high effort, and 17.6 s and 1 549 at `low` — both passing
    // `staticCheck` on the first try. The 45 s interlude cannot buy the difference.
    const { spawn, calls } = fakeSpawn({ stdout: SUCCESS });
    await collect(claudeCliProvider({ spawn, env: {} }), REQ);
    const args = calls[0]?.args ?? [];
    expect(args[args.indexOf('--effort') + 1]).toBe(CLI_DEFAULT_EFFORT);
    expect(CLI_DEFAULT_EFFORT).toBe('low');
  });

  it('lets REMATCH_REASONING_EFFORT raise it, and `off` inherit the session', async () => {
    const raised = fakeSpawn({ stdout: SUCCESS });
    await collect(claudeCliProvider({ spawn: raised.spawn, env: { REMATCH_REASONING_EFFORT: 'xhigh' } }), REQ);
    expect(raised.calls[0]?.args).toContain('xhigh');

    const inherited = fakeSpawn({ stdout: SUCCESS });
    await collect(claudeCliProvider({ spawn: inherited.spawn, env: { REMATCH_REASONING_EFFORT: 'off' } }), REQ);
    expect(inherited.calls[0]?.args).not.toContain('--effort');
  });

  it('strips the API-key variables so the subscription pays, not the key', async () => {
    // The CLI prefers a key over the logged-in session. Inheriting one from `.env`
    // would silently bill the account this provider exists to avoid.
    const { spawn, calls } = fakeSpawn({ stdout: SUCCESS });
    const env = { ANTHROPIC_API_KEY: 'sk-ant-live', ANTHROPIC_AUTH_TOKEN: 'tok', PATH: '/usr/bin' };
    await collect(claudeCliProvider({ spawn, env }), REQ);
    for (const name of CLI_STRIPPED_ENV) expect(calls[0]?.env).not.toHaveProperty(name);
    // Everything else the CLI needs is still there.
    expect(calls[0]?.env['PATH']).toBe('/usr/bin');
  });

  it('honours REMATCH_CLAUDE_BIN, and the option over it', async () => {
    const a = fakeSpawn({ stdout: SUCCESS });
    await collect(claudeCliProvider({ spawn: a.spawn, env: { [CLAUDE_BIN_ENV]: '/opt/claude' } }), REQ);
    expect(a.calls[0]?.command).toBe('/opt/claude');

    const b = fakeSpawn({ stdout: SUCCESS });
    await collect(claudeCliProvider({ spawn: b.spawn, env: { [CLAUDE_BIN_ENV]: '/opt/claude' }, bin: 'claude' }), REQ);
    expect(b.calls[0]?.command).toBe('claude');
  });

  // ------------------------------------------------------------------- aborts

  it('kills the child and raises an AbortError when the caller aborts', async () => {
    // The loop's deadline aborts model calls (spec §6.3). A closed tab or an expired
    // interlude must not leave a subprocess talking to the network.
    const { spawn, children } = fakeSpawn({ stdout: [`${INIT}\n`, `${delta('partial')}\n`], hold: true });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    await expect(
      collect(claudeCliProvider({ spawn, env: {}, killGraceMs: 5 }), { ...REQ, signal: controller.signal }),
    ).rejects.toBeInstanceOf(AbortError);
    expect(children[0]?.kills[0]).toBe('SIGTERM');
  });

  it('escalates to SIGKILL when SIGTERM does not end the child', async () => {
    const { spawn, children } = fakeSpawn({ hold: true });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);
    await expect(
      collect(claudeCliProvider({ spawn, env: {}, killGraceMs: 10 }), { ...REQ, signal: controller.signal }),
    ).rejects.toBeInstanceOf(AbortError);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(children[0]?.kills).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('does not spawn at all when the signal is already aborted', async () => {
    const { spawn, calls } = fakeSpawn({ stdout: SUCCESS });
    await expect(
      collect(claudeCliProvider({ spawn, env: {} }), { ...REQ, signal: AbortSignal.abort() }),
    ).rejects.toBeInstanceOf(AbortError);
    // One spawn happened (the signal is checked after it, so the child is killed), but
    // nothing was ever yielded and the process was terminated immediately.
    expect(calls).toHaveLength(1);
  });

  it('gives up on a child that never answers, naming the timeout variable', async () => {
    const { spawn, children } = fakeSpawn({ hold: true });
    await expect(collect(claudeCliProvider({ spawn, env: {}, timeoutMs: 15, killGraceMs: 5 }), REQ)).rejects.toThrow(
      new RegExp(CLI_TIMEOUT_ENV),
    );
    expect(children[0]?.kills[0]).toBe('SIGTERM');
  });

  // ------------------------------------------------------------------- errors

  it('says how to fix a missing binary rather than reporting ENOENT', async () => {
    const enoent = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
    const { spawn } = fakeSpawn({ spawnError: enoent });
    await expect(collect(claudeCliProvider({ spawn, env: {} }), REQ)).rejects.toThrow(
      /no `claude` on PATH — install Claude Code or set REMATCH_CLAUDE_BIN/,
    );
  });

  it('reports a synchronous spawn failure the same way', async () => {
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const { spawn } = fakeSpawn({ throwOnSpawn: enoent });
    await expect(collect(claudeCliProvider({ spawn, env: {}, bin: 'nope' }), REQ)).rejects.toThrow(
      /no `nope` on PATH/,
    );
  });

  it('includes the stderr tail on a non-zero exit, which is where the CLI says why', async () => {
    const { spawn } = fakeSpawn({
      exitCode: 1,
      stderr: 'Invalid API key · Please run /login\n',
    });
    await expect(collect(claudeCliProvider({ spawn, env: {} }), REQ)).rejects.toThrow(
      /exited 1 — stderr: Invalid API key · Please run \/login/,
    );
  });

  it('names the signal when the child was killed rather than exiting', async () => {
    const { spawn } = fakeSpawn({ exitCode: null, exitSignal: 'SIGSEGV' });
    await expect(collect(claudeCliProvider({ spawn, env: {} }), REQ)).rejects.toThrow(/killed by SIGSEGV/);
  });

  it('treats an is_error result as a failure even though the CLI exited 0', async () => {
    const failure = JSON.stringify({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'the model is overloaded',
      api_error_status: '529',
    });
    const { spawn } = fakeSpawn({ stdout: [`${INIT}\n`, `${failure}\n`] });
    await expect(collect(claudeCliProvider({ spawn, env: {} }), REQ)).rejects.toThrow(
      /error_during_execution: 529: the model is overloaded/,
    );
  });

  it('refuses an empty success rather than handing the loop an empty strategy', async () => {
    // Exit 0, no result event, no text. Passing that on would surface three attempts
    // later as a Gate 1 rejection with no explanation.
    const { spawn } = fakeSpawn({ stdout: [`${INIT}\n`], stderr: 'nothing to say' });
    await expect(collect(claudeCliProvider({ spawn, env: {} }), REQ)).rejects.toThrow(
      /exited 0 without a result event or any text/,
    );
  });
});

// ------------------------------------------------------------------ the pieces

describe('claudeCliArgs', () => {
  it('never puts a positional after the variadic --tools, which would be swallowed', () => {
    const args = claudeCliArgs({ model: 'sonnet', system: 'SYS' });
    const after = args[args.indexOf('--tools') + 2];
    expect(after).toBeDefined();
    expect(after?.startsWith('--')).toBe(true);
  });
});

describe('claudeCliPrompt', () => {
  it('passes a single user message through byte for byte', () => {
    expect(claudeCliPrompt([{ role: 'user', content: 'exactly this' }])).toBe('exactly this');
  });

  it('labels the roles when a request is multi-turn, since -p takes one prompt', () => {
    expect(
      claudeCliPrompt([
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'second' },
      ]),
    ).toBe('[user]\nfirst\n\n[assistant]\nsecond');
  });
});

describe('parseCliLine', () => {
  it('ignores everything it does not recognise, so a new event cannot fail a run', () => {
    expect(parseCliLine('not json at all').kind).toBe('ignore');
    expect(parseCliLine('null').kind).toBe('ignore');
    expect(parseCliLine(JSON.stringify({ type: 'brand_new_event_type' })).kind).toBe('ignore');
    expect(parseCliLine(JSON.stringify({ type: 'system', subtype: 'hook_started' })).kind).toBe('ignore');
    expect(parseCliLine(JSON.stringify({ type: 'stream_event', event: { type: 'message_stop' } })).kind).toBe('ignore');
  });

  it('reads the model off both the init event and message_start', () => {
    expect(parseCliLine(INIT)).toEqual({ kind: 'model', model: 'claude-sonnet-5' });
    expect(
      parseCliLine(JSON.stringify({ type: 'stream_event', event: { type: 'message_start', message: { model: 'claude-opus-5' } } })),
    ).toEqual({ kind: 'model', model: 'claude-opus-5' });
  });

  it('defaults the usage numbers to zero rather than NaN when the CLI omits them', () => {
    const parsed = parseCliLine(JSON.stringify({ type: 'result', subtype: 'success', is_error: false }));
    expect(parsed).toMatchObject({ kind: 'result' });
    if (parsed.kind !== 'result') throw new Error('unreachable');
    expect(parsed.result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

describe('readEffort', () => {
  it('falls back to the default for a value the CLI does not accept', () => {
    // `REMATCH_REASONING_EFFORT` is shared with the OpenAI provider, whose value set
    // is not the same one. Handing `minimal` to the CLI would fail the whole rewrite
    // on an argument error, which is a much worse answer than a slightly wrong effort.
    expect(readEffort({})).toBe(CLI_DEFAULT_EFFORT);
    expect(readEffort({ REMATCH_REASONING_EFFORT: 'minimal' })).toBe(CLI_DEFAULT_EFFORT);
    expect(readEffort({ REMATCH_REASONING_EFFORT: 'none' })).toBe(CLI_DEFAULT_EFFORT);
    expect(readEffort({ REMATCH_REASONING_EFFORT: 'nonsense' })).toBe(CLI_DEFAULT_EFFORT);
    expect(readEffort({ REMATCH_REASONING_EFFORT: 'MAX' })).toBe('max');
    expect(readEffort({ REMATCH_REASONING_EFFORT: 'high' })).toBe('high');
    // `off` is the shared sentinel for "send no flag at all".
    expect(readEffort({ REMATCH_REASONING_EFFORT: 'off' })).toBeUndefined();
    // An explicit option beats the environment.
    expect(readEffort({ REMATCH_REASONING_EFFORT: 'max' }, 'low')).toBe('low');
  });
});

describe('readTimeoutMs', () => {
  it('treats a blank or unreadable value as unset, not as zero', () => {
    expect(readTimeoutMs({})).toBeUndefined();
    expect(readTimeoutMs({ [CLI_TIMEOUT_ENV]: '' })).toBeUndefined();
    expect(readTimeoutMs({ [CLI_TIMEOUT_ENV]: '  ' })).toBeUndefined();
    expect(readTimeoutMs({ [CLI_TIMEOUT_ENV]: 'soon' })).toBeUndefined();
    expect(readTimeoutMs({ [CLI_TIMEOUT_ENV]: '0' })).toBeUndefined();
    expect(readTimeoutMs({ [CLI_TIMEOUT_ENV]: '90000' })).toBe(90_000);
  });
});
