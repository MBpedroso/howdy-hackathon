/**
 * The QuickJS WebAssembly module, and the sandbox's global-surface policy.
 *
 * VARIANT CHOICE — `@jitl/quickjs-singlefile-cjs-release-sync`
 * -----------------------------------------------------------
 * Four axes, and only one combination fits this project:
 *
 *  - `sync` (not asyncify): every VM call returns synchronously, so
 *    `StrategyRunner.decide` can be called straight from the engine's 60 Hz tick
 *    loop with no `await`. The asyncify builds are ~2x slower and force async.
 *  - `singlefile`: the `.wasm` is embedded in the JS file as a byte string. The
 *    `wasmfile` variants fetch a sibling `.wasm`, which means asset plumbing in
 *    Vite and a network round trip in the browser. Embedded = the same bytes in
 *    Node, in Vitest, and in the browser bundle, which is what spec §5.2 means by
 *    "same sandbox in browser and Node".
 *  - `cjs`: the "universal" build — a CommonJS file that works in Node and in any
 *    bundler. (`@jitl/quickjs-singlefile-browser-*` is ESM-only and needs
 *    `import.meta`; `quickjs-emscripten`'s default `getQuickJS()` resolves to the
 *    `wasmfile` variant, which is exactly what we do not want.)
 *  - `release`: no debug asserts, no leak sanitizer.
 *
 * Instantiating the WASM module is inherently async (`WebAssembly.instantiate`),
 * so it happens exactly once, memoized, behind `getQuickJSModule()`. Everything
 * after that — `createSandbox().load(...)`, `init`, `decide` — is synchronous.
 *
 * INTRINSICS — what does not exist at all
 * ---------------------------------------
 * Removing an intrinsic is stronger than deleting a global: the constructor is
 * never created, so no prototype chain can lead back to it. We drop `Date`
 * (spec §4.4: no clocks — a strategy that could read time would break replay
 * determinism), `RegExp` (a strategy has no use for it, and catastrophic
 * backtracking is a DoS path the interrupt handler may not reach), `Proxy`
 * (Gate 1 forbids the name; exotic objects would also let a strategy hand the
 * engine a value whose getters run at marshalling time) and `StringNormalize`
 * (a large Unicode table we never use).
 *
 * Two intrinsics we would like to drop but cannot:
 *  - `Eval`: QuickJS stores `ctx->eval_internal` when this intrinsic is added, and
 *    the *host's* `JS_Eval` goes through the same pointer. With `Eval: false`,
 *    `ctx.evalCode` itself fails with "eval is not supported", so we could not
 *    load a strategy at all. The `eval` global is deleted instead (see prelude).
 *  - `Promise`: QuickJS evaluates ES modules through a promise capability taken
 *    from `ctx->promise_ctor`. Without the intrinsic, evaluating any module fails
 *    with "not a function". The `Promise` global is deleted instead; the internal
 *    pointer is not reachable from JS.
 */
import {
  DefaultIntrinsics,
  memoizePromiseFactory,
  newQuickJSWASMModuleFromVariant,
  type Intrinsics,
  type QuickJSWASMModule,
} from 'quickjs-emscripten-core';

/** Language features enabled inside a strategy context. See the note above. */
export const SANDBOX_INTRINSICS: Intrinsics = Object.freeze({
  ...DefaultIntrinsics,
  // Kept: BaseObjects, JSON, MapSet, TypedArrays (deterministic and useful),
  // Eval and Promise (load-bearing for the host, see above).
  Date: false,
  RegExp: false,
  RegExpCompiler: false,
  Proxy: false,
  StringNormalize: false,
});

/**
 * Global bindings deleted from the sandbox's global object by the prelude.
 *
 * `Promise` and `eval` are here because their intrinsics must stay on; the rest
 * are simply capabilities or non-determinism a strategy has no business touching.
 * Deleting a global is defence in depth, not the security boundary: the boundary
 * is that the context has **no host function bindings at all** (`rand` is
 * implemented in JS inside the VM), so there is nothing to reach even if a name
 * survives.
 */
export const SANDBOX_DELETED_GLOBALS: readonly string[] = Object.freeze([
  'eval',
  'Function',
  'Promise',
  'Reflect',
  'globalThis',
  'SharedArrayBuffer',
  'BigInt',
  'BigInt64Array',
  'BigUint64Array',
  'escape',
  'unescape',
  'encodeURI',
  'decodeURI',
  'encodeURIComponent',
  'decodeURIComponent',
]);

/*
 * WHAT SURVIVES in the sandbox's global scope, and why it is safe.
 *
 * Documented so the security review in spec §11 has something to check against,
 * and so nobody "fixes" the prelude by trying to delete these.
 *
 *  - `Object Array Number String Boolean Symbol Math JSON Map Set WeakMap WeakSet`
 *    `ArrayBuffer DataView *Array Iterator Error/*Error NaN Infinity undefined`
 *    `isNaN isFinite parseInt parseFloat` — pure, deterministic, and needed to
 *    write a strategy at all. `Math.random` is deleted and `Math` is frozen.
 *  - The function constructors (`Function`, `AsyncFunction`, `GeneratorFunction`)
 *    are unreachable *as named globals*, and the prelude also deletes
 *    `constructor` from each function prototype — after which
 *    `(function(){}).constructor` resolves up the chain to `Object`. Even if a
 *    build changed that, compiling code inside the sandbox grants no capability:
 *    there are no host bindings to call.
 *  - `Error.prototype.stack` exists and leaks the strategy's own source
 *    positions. That is the strategy's own text; the harness already has it.
 */
/**
 * Instantiate (once) and return the QuickJS WASM module.
 *
 * Memoized: one WASM instance per process, many runtimes on top of it. Each
 * `load()` still gets its own `QuickJSRuntime`, so strategies share no heap,
 * no globals and no memory limit.
 */
export const getQuickJSModule: () => Promise<QuickJSWASMModule> = memoizePromiseFactory(() =>
  newQuickJSWASMModuleFromVariant(
    // Dynamic import: the variant is a ~1.4 MB file (the WASM is embedded in it),
    // so it is only paid for when a sandbox is actually created, and the promise
    // form is what `newQuickJSWASMModuleFromVariant` accepts for a module
    // namespace (it unwraps `{ default }` itself).
    import('@jitl/quickjs-singlefile-cjs-release-sync'),
  ),
);
