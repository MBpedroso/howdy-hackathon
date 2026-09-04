/**
 * The QuickJS strategy sandbox — the runtime half of the security boundary
 * described in spec §4.4.
 *
 * Gate 1 (`staticCheck`) rejects forbidden *names* before anything executes.
 * This file makes those names unreachable even if Gate 1 were bypassed, bounds
 * the CPU and memory a strategy may spend, and turns every possible failure into
 * a value: `decide` **never throws**, whatever the strategy does.
 *
 * Shape of the boundary:
 *
 *   host                         │ QuickJS context
 *   ─────────────────────────────┼──────────────────────────────────────────────
 *   JSON.stringify(view)         │  __rematch_tick(json)
 *        │ one string argument   │    ├─ JSON.parse(json)          (view)
 *        ▼                       │    ├─ mod.decide(view, mem)     (strategy)
 *   ctx.callFunction ────────────┼──▶ ├─ memory cap check          (every N)
 *        │                       │    └─ JSON.stringify({v:action})
 *   JSON.parse(result)  ◀────────┼─── one string result
 *
 * There is exactly **one** value type crossing the boundary — a string — and no
 * host function is exposed to the VM at all. `rand()` is JS running inside the
 * VM (see `prelude.ts`), so a strategy cannot call out, and marshalling cannot
 * be attacked with exotic objects: a getter that throws or a cycle fails
 * `JSON.stringify` *inside* the VM and is reported as a failure, not as a crash.
 *
 * Budgets:
 *  - Time: QuickJS's interrupt handler, checked against a deadline. A `while(true)`
 *    in `decide` returns `{ok:false, failure:{kind:'timeout'}}` in ~budget ms.
 *  - Heap: `runtime.setMemoryLimit(CONSTANTS.limits.sandboxMemoryBytes)` plus a
 *    max stack size, so runaway allocation and runaway recursion both land as
 *    failures rather than as a wasm abort.
 *  - Memory object: `JSON.stringify(mem)` measured in UTF-8 bytes *inside* the VM
 *    against `CONSTANTS.limits.memoryBytes`.
 */
import {
  CONSTANTS,
  staticCheck,
  type BossView,
  type DecideResult,
  type RunnerFailure,
  type StrategyMeta,
  type StrategyRunner,
} from '@rematch/contract';
import type {
  QuickJSContext,
  QuickJSHandle,
  QuickJSRuntime,
  QuickJSWASMModule,
} from 'quickjs-emscripten-core';

import { buildPrelude, NON_FINITE_TAG, NON_FINITE_TAG_JSON, PRELUDE_GLOBALS, TAG } from './prelude.ts';
import { getQuickJSModule, SANDBOX_INTRINSICS } from './quickjs.ts';

/* ------------------------------------------------------------------ options */

export type SandboxOptions = {
  /**
   * Monotonic clock, in milliseconds. Injectable so tests can drive the deadline
   * deterministically and so a worker can swap in a cheaper clock. Defaults to
   * `performance.now`.
   */
  now?: () => number;
  /** Wall-clock budget for one `decide`. Default `CONSTANTS.limits.decideBudgetMs` (2 ms). */
  decideBudgetMs?: number;
  /**
   * Budget for module evaluation, `init()` and `meta` reads. Deliberately larger
   * than a tick: parsing and evaluating 32 KB of source is a one-off cost, and a
   * strategy that hangs *here* must still be caught rather than hang the loader.
   */
  loadBudgetMs?: number;
  /**
   * Re-measure `JSON.stringify(mem)` every N `decide` calls. Default 60 — once
   * per simulated second, so a strategy that grows its memory is caught within a
   * second of play while a well-behaved one pays the O(size) serialization cost
   * on 1 tick in 60. Set to 1 to check every call.
   */
  memoryCheckEvery?: number;
  /** Serialized-memory ceiling. Default `CONSTANTS.limits.memoryBytes` (4 KB). */
  memoryBytesLimit?: number;
  /** QuickJS heap ceiling. Default `CONSTANTS.limits.sandboxMemoryBytes` (64 MB). */
  heapBytesLimit?: number;
  /**
   * QuickJS stack ceiling; bounds runaway recursion. Default 128 KB.
   *
   * Do not raise this much. QuickJS detects overflow by comparing the C stack
   * pointer against this limit, and the wasm module's own stack is smaller than
   * you would guess: at 512 KB (and with no limit at all) a recursive strategy
   * blows the *wasm* stack first, which surfaces as a host `RangeError` thrown
   * out of the module and leaves the runtime unusable. At 128 KB the same
   * strategy gets a clean in-VM `InternalError: stack overflow`, which we report
   * as an ordinary `throw` failure.
   */
  maxStackBytes?: number;
};

type ResolvedOptions = Required<SandboxOptions>;

const DEFAULTS: Omit<ResolvedOptions, 'now'> = {
  decideBudgetMs: CONSTANTS.limits.decideBudgetMs,
  loadBudgetMs: 250,
  memoryCheckEvery: 60,
  memoryBytesLimit: CONSTANTS.limits.memoryBytes,
  heapBytesLimit: CONSTANTS.limits.sandboxMemoryBytes,
  maxStackBytes: 128 * 1024,
};

const defaultNow = (): number => performance.now();

function resolveOptions(opts: SandboxOptions | undefined): ResolvedOptions {
  return {
    now: opts?.now ?? defaultNow,
    decideBudgetMs: opts?.decideBudgetMs ?? DEFAULTS.decideBudgetMs,
    loadBudgetMs: opts?.loadBudgetMs ?? DEFAULTS.loadBudgetMs,
    memoryCheckEvery: Math.max(1, Math.trunc(opts?.memoryCheckEvery ?? DEFAULTS.memoryCheckEvery)),
    memoryBytesLimit: opts?.memoryBytesLimit ?? DEFAULTS.memoryBytesLimit,
    heapBytesLimit: opts?.heapBytesLimit ?? DEFAULTS.heapBytesLimit,
    maxStackBytes: opts?.maxStackBytes ?? DEFAULTS.maxStackBytes,
  };
}

/* ------------------------------------------------------------------- errors */

/**
 * Thrown by `load` when a strategy cannot be brought up at all: Gate 1
 * violations, a syntax error, a throwing module body, a missing or malformed
 * `meta`. Carries the `RunnerFailure` so a caller can report `failure.kind`
 * without parsing prose.
 */
export class SandboxLoadError extends Error {
  override readonly name = 'SandboxLoadError';
  readonly failure: RunnerFailure;
  constructor(failure: RunnerFailure) {
    super(failureMessage(failure));
    this.failure = failure;
  }
}

/**
 * Thrown by `init(seed)`. `init` returns `void` in the `StrategyRunner`
 * contract, so a failure has nowhere else to go — but the failure is also
 * recorded, so a caller that ignores the throw still gets it back from every
 * subsequent `decide` instead of silently running an uninitialized strategy.
 */
export class SandboxInitError extends Error {
  override readonly name = 'SandboxInitError';
  readonly failure: RunnerFailure;
  constructor(failure: RunnerFailure) {
    super(failureMessage(failure));
    this.failure = failure;
  }
}

function failureMessage(failure: RunnerFailure): string {
  switch (failure.kind) {
    case 'timeout':
      return `timeout after ${failure.ms.toFixed(2)} ms`;
    case 'memory':
      return `memory limit exceeded (${failure.bytes} bytes)`;
    default:
      return failure.message;
  }
}

/* -------------------------------------------------------------- marshalling */

type ErrorInfo = { name: string; message: string };

/** Read `{name, message}` off a QuickJS error handle without ever throwing. */
function readError(ctx: QuickJSContext, handle: QuickJSHandle): ErrorInfo {
  try {
    const dumped: unknown = ctx.dump(handle);
    if (typeof dumped === 'string') return { name: 'Error', message: dumped };
    if (dumped !== null && typeof dumped === 'object') {
      const record = dumped as Record<string, unknown>;
      const name = typeof record['name'] === 'string' ? record['name'] : 'Error';
      const message = typeof record['message'] === 'string' ? record['message'] : JSON.stringify(dumped);
      return { name, message };
    }
    return { name: 'Error', message: String(dumped) };
  } catch {
    return { name: 'Error', message: 'unreadable exception' };
  }
}

/**
 * Read a handle's string value and dispose it, even if reading throws.
 *
 * Disposal cannot be best-effort here: a surviving handle makes
 * `JS_FreeRuntime` fail an assertion, which aborts the whole wasm module and
 * takes the process with it. Every handle that crosses this boundary goes
 * through `takeString`/`takeError`.
 */
function takeString(ctx: QuickJSContext, handle: QuickJSHandle): string {
  try {
    return ctx.getString(handle);
  } finally {
    handle.dispose();
  }
}

/** Read a handle's numeric value and dispose it. */
function takeNumber(ctx: QuickJSContext, handle: QuickJSHandle): number {
  try {
    return ctx.getNumber(handle);
  } finally {
    handle.dispose();
  }
}

/** Read `{name, message}` off an error handle and dispose it. */
function takeError(ctx: QuickJSContext, handle: QuickJSHandle): ErrorInfo {
  try {
    return readError(ctx, handle);
  } finally {
    handle.dispose();
  }
}

/**
 * Map a VM exception onto a `RunnerFailure`.
 *
 * QuickJS reports an interrupted execution as `InternalError: interrupted`, and
 * both allocation failure and stack exhaustion as `InternalError` too, so the
 * message text is the only discriminator available. A strategy that throws its
 * own `InternalError('interrupted')` is therefore reported as a timeout — it is
 * rejected either way, and the alternative (trusting elapsed time) misreports
 * real timeouts on a loaded machine.
 */
function classifyError(info: ErrorInfo, elapsedMs: number, heapBytesLimit: number): RunnerFailure {
  if (info.name === 'InternalError') {
    if (info.message.includes('interrupted')) return { kind: 'timeout', ms: elapsedMs };
    if (info.message.includes('out of memory')) return { kind: 'memory', bytes: heapBytesLimit };
  }
  if (info.message.includes('out of memory')) return { kind: 'memory', bytes: heapBytesLimit };
  const message = info.message.length > 0 ? info.message : info.name;
  return { kind: 'throw', message };
}

/** Reverse the prelude's non-finite tagging. */
function reviveNonFinite(_key: string, value: unknown): unknown {
  if (typeof value === 'string' && value.startsWith(NON_FINITE_TAG)) {
    const rest = value.slice(NON_FINITE_TAG.length);
    if (rest === 'NaN') return Number.NaN;
    if (rest === 'Infinity') return Number.POSITIVE_INFINITY;
    if (rest === '-Infinity') return Number.NEGATIVE_INFINITY;
  }
  return value;
}

/**
 * Parse a `{"v": ...}` envelope. The envelope exists because
 * `JSON.stringify(undefined)` is `undefined`, not a string — a strategy that
 * returns nothing has to arrive as a *value* the validator can reject, not as a
 * marshalling error.
 */
function parseEnvelope(json: string): { ok: true; value: unknown } | { ok: false; message: string } {
  try {
    const parsed: unknown =
      json.includes(NON_FINITE_TAG_JSON) ? JSON.parse(json, reviveNonFinite) : JSON.parse(json);
    if (parsed === null || typeof parsed !== 'object') {
      return { ok: false, message: 'sandbox returned a malformed envelope' };
    }
    return { ok: true, value: (parsed as Record<string, unknown>)['v'] };
  } catch (err) {
    return { ok: false, message: `sandbox result was not JSON: ${String(err)}` };
  }
}

/* -------------------------------------------------------------------- meta */

type MetaPayload = { meta: StrategyMeta };

function validateMeta(value: unknown, initType: unknown, decideType: unknown): MetaPayload | string {
  if (initType !== 'function') return `'init' must be an exported function, got ${String(initType)}`;
  if (decideType !== 'function') return `'decide' must be an exported function, got ${String(decideType)}`;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return `'meta' must be an object, got ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}`;
  }
  const record = value as Record<string, unknown>;
  const name = record['name'];
  const rationale = record['rationale'];
  const version = record['version'];
  if (typeof name !== 'string' || name.length === 0) return "'meta.name' must be a non-empty string";
  if (name.length > CONSTANTS.limits.metaNameMaxChars) {
    return `'meta.name' is ${name.length} characters; limit is ${CONSTANTS.limits.metaNameMaxChars}`;
  }
  if (typeof rationale !== 'string' || rationale.trim().length === 0) {
    return "'meta.rationale' must be a non-empty string";
  }
  if (typeof version !== 'number' || !Number.isFinite(version)) {
    return "'meta.version' must be a finite number";
  }
  return { meta: { name, rationale, version } };
}

/* ------------------------------------------------------------------ runner */

type Deadline = { value: number };

class QuickJsStrategyRunner implements StrategyRunner {
  readonly meta: StrategyMeta;

  readonly #options: ResolvedOptions;
  readonly #runtime: QuickJSRuntime;
  readonly #context: QuickJSContext;
  readonly #deadline: Deadline;
  readonly #initFn: QuickJSHandle;
  readonly #tickFn: QuickJSHandle;
  readonly #memFn: QuickJSHandle;

  #disposed = false;
  #initialized = false;
  /** Once the memory cap is blown the strategy is dead; keep reporting it. */
  #sticky: RunnerFailure | null = null;
  #lastMemoryBytes = 0;

  constructor(args: {
    meta: StrategyMeta;
    options: ResolvedOptions;
    runtime: QuickJSRuntime;
    context: QuickJSContext;
    deadline: Deadline;
    initFn: QuickJSHandle;
    tickFn: QuickJSHandle;
    memFn: QuickJSHandle;
  }) {
    this.meta = args.meta;
    this.#options = args.options;
    this.#runtime = args.runtime;
    this.#context = args.context;
    this.#deadline = args.deadline;
    this.#initFn = args.initFn;
    this.#tickFn = args.tickFn;
    this.#memFn = args.memFn;
  }

  init(seed: number): void {
    this.#assertLive();
    this.#initialized = false;
    this.#sticky = null;
    this.#lastMemoryBytes = 0;

    const ctx = this.#context;
    const started = this.#options.now();
    this.#deadline.value = started + this.#options.loadBudgetMs;
    let arg: QuickJSHandle | undefined;
    try {
      arg = ctx.newNumber(Number.isFinite(seed) ? Math.trunc(seed) : 0);
      const call = ctx.callFunction(this.#initFn, ctx.undefined, arg);
      const elapsed = this.#options.now() - started;
      if (call.error) {
        const info = takeError(ctx, call.error);
        throw new SandboxInitError(this.#remember(classifyError(info, elapsed, this.#options.heapBytesLimit)));
      }
      const raw = takeString(ctx, call.value);
      const tag = raw.charAt(0);
      const body = raw.slice(1);
      if (tag === TAG.memory) {
        const bytes = Number(body);
        throw new SandboxInitError(
          this.#remember({ kind: 'memory', bytes: Number.isFinite(bytes) ? bytes : this.#options.memoryBytesLimit }),
        );
      }
      if (tag !== TAG.ok) {
        throw new SandboxInitError(this.#remember({ kind: 'throw', message: body }));
      }
      const bytes = Number(body);
      this.#lastMemoryBytes = Number.isFinite(bytes) ? bytes : 0;
      this.#initialized = true;
    } finally {
      arg?.dispose();
      this.#deadline.value = Number.POSITIVE_INFINITY;
    }
  }

  decide(view: BossView): DecideResult {
    if (this.#disposed) {
      return { ok: false, failure: { kind: 'load', message: 'runner has been disposed' }, elapsedMs: 0 };
    }
    if (this.#sticky) return { ok: false, failure: this.#sticky, elapsedMs: 0 };
    if (!this.#initialized) {
      return { ok: false, failure: { kind: 'load', message: 'init(seed) has not been called' }, elapsedMs: 0 };
    }

    const ctx = this.#context;
    const now = this.#options.now;
    const started = now();

    let json: string;
    try {
      json = JSON.stringify(view);
    } catch (err) {
      // The engine handed us something unserializable. Not the strategy's fault,
      // but `decide` must not throw, so it is reported like any other failure.
      return {
        ok: false,
        failure: { kind: 'throw', message: `view could not be serialized: ${String(err)}` },
        elapsedMs: now() - started,
      };
    }

    let arg: QuickJSHandle | undefined;
    try {
      arg = ctx.newString(json);
      // Deadline starts at VM entry, not at `started`: a host-side GC pause
      // before the call must not spend the strategy's budget for it.
      this.#deadline.value = now() + this.#options.decideBudgetMs;
      const call = ctx.callFunction(this.#tickFn, ctx.undefined, arg);
      const elapsedMs = now() - started;

      if (call.error) {
        const info = takeError(ctx, call.error);
        const failure = classifyError(info, elapsedMs, this.#options.heapBytesLimit);
        if (failure.kind === 'memory') this.#remember(failure);
        return { ok: false, failure, elapsedMs };
      }

      const raw = takeString(ctx, call.value);
      const tag = raw.charAt(0);
      const body = raw.slice(1);

      if (tag === TAG.memory) {
        const bytes = Number(body);
        const resolved = Number.isFinite(bytes) ? bytes : this.#options.memoryBytesLimit;
        this.#lastMemoryBytes = resolved;
        return { ok: false, failure: this.#remember({ kind: 'memory', bytes: resolved }), elapsedMs };
      }
      if (tag === TAG.error) {
        return { ok: false, failure: { kind: 'throw', message: body }, elapsedMs };
      }

      const envelope = parseEnvelope(body);
      if (!envelope.ok) {
        return { ok: false, failure: { kind: 'throw', message: envelope.message }, elapsedMs };
      }
      return { ok: true, action: envelope.value, elapsedMs };
    } catch (err) {
      // Nothing above is meant to throw. If something does, the VM's state is no
      // longer trustworthy (this is the shape a wasm-level stack overflow takes),
      // so the failure becomes sticky rather than being retried 3599 more times.
      const failure: RunnerFailure = { kind: 'throw', message: `sandbox error: ${String(err)}` };
      this.#sticky = failure;
      return { ok: false, failure, elapsedMs: now() - started };
    } finally {
      arg?.dispose();
      this.#deadline.value = Number.POSITIVE_INFINITY;
    }
  }

  memoryBytes(): number {
    if (this.#disposed || !this.#initialized) return this.#lastMemoryBytes;
    const ctx = this.#context;
    const started = this.#options.now();
    this.#deadline.value = started + this.#options.loadBudgetMs;
    try {
      const call = ctx.callFunction(this.#memFn, ctx.undefined);
      if (call.error) {
        call.error.dispose();
        return this.#lastMemoryBytes;
      }

      const bytes = takeNumber(ctx, call.value);
      if (Number.isFinite(bytes) && bytes >= 0) this.#lastMemoryBytes = bytes;
      return this.#lastMemoryBytes;
    } catch {
      return this.#lastMemoryBytes;
    } finally {
      this.#deadline.value = Number.POSITIVE_INFINITY;
    }
  }

  /**
   * Release every handle, then the context, then the runtime — in that order.
   * A surviving handle makes `JS_FreeRuntime` fail its `list_empty(gc_obj_list)`
   * assertion, which aborts the whole wasm module (and with it the process), so
   * this is not merely hygiene. Idempotent.
   */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#initialized = false;
    this.#deadline.value = Number.POSITIVE_INFINITY;
    try {
      for (const handle of [this.#initFn, this.#tickFn, this.#memFn]) {
        if (handle.alive) handle.dispose();
      }
      if (this.#context.alive) this.#context.dispose();
      if (this.#runtime.alive) this.#runtime.dispose();
    } catch (err) {
      // `JS_FreeRuntime`'s leak assertion aborts the wasm module, which poisons
      // the (process-wide, memoized) QuickJS module for every later load. Re-throw
      // it with a message that names the actual bug instead of an opaque
      // "Aborted(Assertion failed: list_empty...)" from wasm.
      throw new Error(`sandbox dispose failed — a QuickJS handle leaked: ${String(err)}`, { cause: err });
    }
  }

  get alive(): boolean {
    return !this.#disposed;
  }

  #remember(failure: RunnerFailure): RunnerFailure {
    if (failure.kind === 'memory') this.#sticky = failure;
    return failure;
  }

  #assertLive(): void {
    if (this.#disposed) throw new SandboxInitError({ kind: 'load', message: 'runner has been disposed' });
  }
}

/* -------------------------------------------------------------------- load */

/** A ready sandbox: the WASM module is instantiated, so loading is synchronous. */
export type SandboxFactory = {
  /** Gate 1 then load. Throws `SandboxLoadError` on either. */
  load(source: string, opts?: SandboxOptions): StrategyRunner;
  /**
   * Load **without** Gate 1. Exists so the sandbox's own containment can be
   * tested directly (`typeof Date`, `fetch`, `Math.random` with the static check
   * out of the way). Never call this on agent-generated source.
   */
  loadUnchecked(source: string, opts?: SandboxOptions): StrategyRunner;
};

/** Gate 1, formatted as a `load` failure. */
function runStaticCheck(source: string): void {
  const result = staticCheck(source);
  if (result.ok) return;
  const rendered = result.violations
    .map((v) => `${v.line === undefined ? '' : `line ${v.line}: `}${v.message} [${v.rule}]`)
    .join('; ');
  throw new SandboxLoadError({ kind: 'load', message: `static check failed: ${rendered}` });
}

function loadSync(
  wasm: QuickJSWASMModule,
  source: string,
  opts: SandboxOptions | undefined,
  checked: boolean,
): StrategyRunner {
  if (typeof source !== 'string') {
    throw new SandboxLoadError({ kind: 'load', message: 'strategy source must be a string' });
  }
  if (checked) runStaticCheck(source);

  const options = resolveOptions(opts);
  const deadline: Deadline = { value: Number.POSITIVE_INFINITY };

  const runtime = wasm.newRuntime();
  let context: QuickJSContext | undefined;
  const owned: QuickJSHandle[] = [];
  const fail = (failure: RunnerFailure): never => {
    for (const h of owned) if (h.alive) h.dispose();
    if (context?.alive) context.dispose();
    if (runtime.alive) runtime.dispose();
    throw new SandboxLoadError(failure);
  };

  try {
    runtime.setMemoryLimit(options.heapBytesLimit);
    runtime.setMaxStackSize(options.maxStackBytes);
    // Enforced from here on, so a `while(true)` at module top level or in
    // `init()` is a failure rather than a hung loader.
    runtime.setInterruptHandler(() => options.now() >= deadline.value);
    context = runtime.newContext({ intrinsics: SANDBOX_INTRINSICS });

    const started = options.now();
    deadline.value = started + options.loadBudgetMs;

    // 1. Prelude: install `rand` and the entry points, then harden the globals.
    const prelude = context.evalCode(
      buildPrelude({ memoryBytesLimit: options.memoryBytesLimit, memoryCheckEvery: options.memoryCheckEvery }),
      'rematch-prelude.js',
    );
    if (prelude.error) {
      const info = takeError(context, prelude.error);
      return fail({ kind: 'load', message: `sandbox prelude failed: ${info.name}: ${info.message}` });
    }
    prelude.value.dispose();

    // 2. The strategy, as an ES module. No module loader is registered, so any
    //    `import` fails here even if it somehow got past Gate 1.
    const evaluated = context.evalCode(source, 'strategy.js', { type: 'module' });
    if (evaluated.error) {
      const info = takeError(context, evaluated.error);
      const elapsed = options.now() - started;
      const failure = classifyError(info, elapsed, options.heapBytesLimit);
      return fail(
        failure.kind === 'throw'
          ? { kind: 'load', message: `strategy module failed to evaluate: ${info.name}: ${info.message}` }
          : failure,
      );
    }

    // In this QuickJS build `evalCode(..., {type:'module'})` returns the module
    // namespace directly once the module has evaluated; `getPromiseState` reports
    // `notAPromise` for it. A module with top-level await returns a real promise
    // that is still pending, which we refuse rather than pump.
    const namespaceCandidate = evaluated.value;
    owned.push(namespaceCandidate);
    let namespace = namespaceCandidate;
    const state = context.getPromiseState(namespaceCandidate);
    if (!('notAPromise' in state && state.notAPromise === true)) {
      if (state.type === 'pending') {
        return fail({
          kind: 'load',
          message: 'strategy module did not finish evaluating; top-level await is not allowed',
        });
      }
      if (state.type === 'rejected') {
        const info = takeError(context, state.error);
        return fail({ kind: 'load', message: `strategy module rejected: ${info.name}: ${info.message}` });
      }
      namespace = state.value;
      owned.push(namespace);
    }

    // 3. Hand the namespace to the prelude closure. Nothing on the global object
    //    references it afterwards, so a strategy cannot reach its own module
    //    object (or another load's) through the globals.
    const setModule = context.getProp(context.global, PRELUDE_GLOBALS.setModule);
    owned.push(setModule);
    const stored = context.callFunction(setModule, context.undefined, namespace);
    if (stored.error) {
      const info = takeError(context, stored.error);
      return fail({ kind: 'load', message: `sandbox could not store the strategy: ${info.message}` });
    }
    stored.value.dispose();

    // 4. Read `meta` once, and validate it here too — `loadUnchecked` skips
    //    Gate 1, and even under Gate 1 only *literal* metadata was checked.
    const metaFn = context.getProp(context.global, PRELUDE_GLOBALS.meta);
    owned.push(metaFn);
    const metaCall = context.callFunction(metaFn, context.undefined);
    if (metaCall.error) {
      const info = takeError(context, metaCall.error);
      return fail({ kind: 'load', message: `reading meta failed: ${info.name}: ${info.message}` });
    }
    const metaRaw = takeString(context, metaCall.value);
    if (metaRaw.charAt(0) !== TAG.ok) return fail({ kind: 'load', message: metaRaw.slice(1) });
    const metaEnvelope = parseEnvelope(metaRaw.slice(1));
    if (!metaEnvelope.ok) return fail({ kind: 'load', message: metaEnvelope.message });
    const metaParsed: unknown = JSON.parse(metaRaw.slice(1));
    const metaRecord = (metaParsed ?? {}) as Record<string, unknown>;
    const validated = validateMeta(metaEnvelope.value, metaRecord['init'], metaRecord['decide']);
    if (typeof validated === 'string') return fail({ kind: 'load', message: validated });

    // 5. Cache the hot-path handles for the runner's lifetime.
    const initFn = context.getProp(context.global, PRELUDE_GLOBALS.init);
    owned.push(initFn);
    const tickFn = context.getProp(context.global, PRELUDE_GLOBALS.tick);
    owned.push(tickFn);
    const memFn = context.getProp(context.global, PRELUDE_GLOBALS.memBytes);
    owned.push(memFn);

    // Release the load-only handles; the three above are handed to the runner.
    for (const handle of owned) {
      if (handle !== initFn && handle !== tickFn && handle !== memFn && handle.alive) handle.dispose();
    }
    deadline.value = Number.POSITIVE_INFINITY;

    return new QuickJsStrategyRunner({
      meta: validated.meta,
      options,
      runtime,
      context,
      deadline,
      initFn,
      tickFn,
      memFn,
    });
  } catch (err) {
    if (err instanceof SandboxLoadError) throw err;
    return fail({ kind: 'load', message: `sandbox failed to start: ${String(err)}` });
  }
}

/**
 * Create a sandbox factory. The WASM module is instantiated once per process
 * (memoized), so `factory.load(...)` — and every `decide` after it — is
 * synchronous and safe to call from the engine's tick loop.
 */
export async function createSandbox(defaults?: SandboxOptions): Promise<SandboxFactory> {
  const wasm = await getQuickJSModule();
  return {
    load: (source, opts) => loadSync(wasm, source, { ...defaults, ...opts }, true),
    loadUnchecked: (source, opts) => loadSync(wasm, source, { ...defaults, ...opts }, false),
  };
}

/**
 * Load one strategy into a fresh QuickJS context.
 *
 * Runs Gate 1 (`staticCheck`) first — belt and braces, so the sandbox is never
 * handed unchecked code even though the harness checks it too. Rejects with
 * `SandboxLoadError` (a `load` failure) on any static violation.
 */
export async function loadStrategy(source: string, opts?: SandboxOptions): Promise<StrategyRunner> {
  const wasm = await getQuickJSModule();
  return loadSync(wasm, source, opts, true);
}

/**
 * `loadStrategy` without Gate 1. For the sandbox's own containment tests only —
 * it is how we prove that `Date`, `fetch` and `Math.random` are unreachable at
 * runtime and not merely rejected by name.
 */
export async function loadStrategyUnchecked(source: string, opts?: SandboxOptions): Promise<StrategyRunner> {
  const wasm = await getQuickJSModule();
  return loadSync(wasm, source, opts, false);
}
