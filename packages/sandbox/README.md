# `@rematch/sandbox`

QuickJS containment for generated boss strategies — the runtime half of the security
boundary in spec §4.4. Gate 1 (`staticCheck`, in `@rematch/contract`) rejects forbidden
*names* before anything runs; this package makes those names **unreachable** even if Gate 1
were bypassed, bounds the CPU and memory a strategy may spend, and turns every possible
misbehaviour into a value. `decide` never throws, whatever the strategy does.

The engine never imports a strategy and never imports QuickJS: it is handed a
`StrategyRunner` and calls `decide` once per tick.

```ts
import { createSandbox } from '@rematch/sandbox';

const sandbox = await createSandbox();   // instantiates the WASM once per process
const runner = sandbox.load(source);     // synchronous from here on
runner.init(seed);
const result = runner.decide(view);      // { ok: true, action } | { ok: false, failure }
runner.dispose();                        // releases the runtime; not optional
```

## API

```ts
createSandbox(defaults?: SandboxOptions): Promise<SandboxFactory>
  // SandboxFactory = { load(source, opts?): StrategyRunner;
  //                    loadUnchecked(source, opts?): StrategyRunner }

loadStrategy(source: string, opts?: SandboxOptions): Promise<StrategyRunner>
loadStrategyUnchecked(source: string, opts?: SandboxOptions): Promise<StrategyRunner>

class SandboxLoadError extends Error { failure: RunnerFailure }   // from load
class SandboxInitError extends Error { failure: RunnerFailure }   // from init(seed)

getQuickJSModule(): Promise<QuickJSWASMModule>   // memoized; shared by every load
SANDBOX_INTRINSICS         // language features enabled in a strategy context
SANDBOX_DELETED_GLOBALS    // names the prelude deletes from the global object
PRELUDE_GLOBALS            // the names the prelude installs (`rand`, entry points)
NON_FINITE_TAG             // marshalling sentinel; see "NaN survives" below
```

`SandboxOptions`: `now` (injectable clock, default `performance.now`), `decideBudgetMs`
(2 ms), `loadBudgetMs` (250 ms), `memoryCheckEvery` (60), `memoryBytesLimit` (4 KB),
`heapBytesLimit` (64 MB), `maxStackBytes` (128 KB).

`load` throws `SandboxLoadError`; `init` throws `SandboxInitError` **and** records the
failure, so a caller that swallows the throw still gets it back from every later `decide`
rather than running an uninitialized strategy. `decide` never throws.

## Why this QuickJS variant

`@jitl/quickjs-singlefile-cjs-release-sync`:

| Axis | Choice | Why |
|---|---|---|
| sync vs asyncify | **sync** | `decide` must be callable straight from a 60 Hz tick loop with no `await`. Asyncify is also ~2x slower. |
| singlefile vs wasmfile | **singlefile** | The `.wasm` is embedded in the JS. No asset plumbing in Vite, no fetch in the browser — the same bytes in Node, Vitest and the bundle, which is what spec §5.2 means by "same sandbox in browser and Node". |
| cjs vs browser (esm) | **cjs** | The universal build: works in Node and in any bundler. The browser build is ESM-only and needs `import.meta`. |
| release vs debug | **release** | No asserts, no leak sanitizer. |

`quickjs-emscripten`'s default `getQuickJS()` resolves to the *wasmfile* variant, which is
exactly what we do not want, so this package depends on `quickjs-emscripten-core` and names
the variant explicitly. Instantiating WASM is inherently async, so it happens once, memoized,
behind `getQuickJSModule()`; everything after that is synchronous.

## What a strategy can and cannot see

**Removed as intrinsics** (never constructed, so no prototype chain leads back to them):
`Date`, `RegExp`, `Proxy`, `StringNormalize`.

**Deleted from the global object** by the prelude: `eval`, `Function`, `Promise`, `Reflect`,
`globalThis`, `SharedArrayBuffer`, `BigInt`, `BigInt64Array`, `BigUint64Array`, `escape`,
`unescape`, `encodeURI*`, `decodeURI*`, and `Math.random`. `Math` and `JSON` are then frozen.
`constructor` is deleted from every function prototype, so `(function(){}).constructor`
resolves up the chain to `Object` — the classic `Function('return this')()` escape is closed.

**Never there in the first place** (QuickJS ships no host bindings): `fetch`, `setTimeout`,
`console`, `process`, `require`, `crypto`, `performance`, `WebAssembly`, `Intl`, `Atomics`,
`WeakRef`… all asserted in `test/containment.test.ts` so a future variant change that added
one would fail here rather than in production.

**Two intrinsics we would like to remove and cannot:**

- `Eval` — QuickJS stores `ctx->eval_internal` when this intrinsic is added, and the *host's*
  `JS_Eval` goes through the same pointer. With `Eval: false`, `ctx.evalCode` itself fails
  with "eval is not supported" and no strategy can be loaded at all. The `eval` global is
  deleted instead.
- `Promise` — QuickJS evaluates ES modules through a promise capability taken from
  `ctx->promise_ctor`; without the intrinsic, evaluating any module fails with "not a
  function". The `Promise` global is deleted instead, and the internal pointer is not
  reachable from JS.

Both are why Gate 1 keeps `eval`, `Function` and `Promise` on its denylist: the names are
rejected before the code runs, and the capabilities are unreachable if it ever does.

**Kept**, because a strategy needs them and they are pure and deterministic: `Object`,
`Array`, `Number`, `String`, `Boolean`, `Symbol`, `Math` (frozen, no `random`), `JSON`,
`Map`/`Set`/`WeakMap`/`WeakSet`, typed arrays, the `Error` hierarchy, `NaN`, `Infinity`,
`isNaN`, `isFinite`, `parseInt`, `parseFloat`.

## `rand()`

A seeded xorshift32, implemented **inside** the VM and installed as a non-writable global.
Not a host callback: a callback would cost a wasm boundary crossing per call (a strategy may
call it several times per tick, 3600 ticks a match, 200+ matches per Gate 3 verdict) and
would make determinism depend on host state. `init(seed)` reseeds it, so the same seed
replays byte-for-byte — `test/determinism.test.ts` pins two outputs of seed 12345 so a
change to the generator cannot slip through unnoticed.

Non-writable matters: module bodies are strict-mode code, but `rand = 0` is an assignment to
an *existing global property*, not an unresolvable reference, so without the property flag it
would succeed and let a strategy replace its own PRNG.

## Budgets and how each is reported

| Budget | Mechanism | Failure |
|---|---|---|
| 2 ms per `decide` | QuickJS interrupt handler polled against a deadline | `{kind:'timeout', ms}` — a `while(true)` returns in ~2 ms |
| 64 MB heap | `runtime.setMemoryLimit` | `{kind:'memory', bytes}` |
| 128 KB stack | `runtime.setMaxStackSize` | `{kind:'throw', message:'stack overflow'}` |
| 4 KB memory object | `JSON.stringify(mem)` measured in **UTF-8 bytes** inside the VM | `{kind:'memory', bytes}`, and sticky |

The memory object is re-measured every `memoryCheckEvery` calls (default 60 — once per
simulated second, so growth is caught within a second of play while a well-behaved strategy
pays the O(size) serialization on 1 tick in 60). Set it to `1` to check every call. Once the
cap is blown the failure is **sticky**: the strategy is dead and stays dead. A `timeout` or
`throw` is *not* sticky, because Gate 2 needs to count how many states fail.

`maxStackBytes` is deliberately small. QuickJS detects overflow by comparing the C stack
pointer against the limit, and the wasm module's own stack is smaller than you would guess:
at 512 KB — and with no limit at all — a recursive strategy blows the *wasm* stack first,
which surfaces as a host `RangeError` thrown out of the module and leaves the runtime
unusable. At 128 KB the same strategy gets a clean in-VM `InternalError: stack overflow`.

## Marshalling

Exactly one value type crosses the boundary: a string.

```
JSON.stringify(view) ──▶ __rematch_tick(json) ──▶ JSON.parse ──▶ decide ──▶ JSON.stringify({v: action})
                    ◀──────────────────────────────────────────────────── one string back
```

No host function is exposed to the VM, so nothing exotic can attack the marshalling: a
throwing getter or a cyclic action fails `JSON.stringify` *inside* the VM and comes back as
`{kind:'throw', message:'the returned action could not be serialized: circular reference'}`.

Two details that matter for gate reasons:

- **`NaN` survives.** `JSON.stringify(NaN)` is `"null"`, which would turn the exact failure
  spec §6.3 wants reported as `"returned angle=NaN on 3% of states"` into a much vaguer
  `angle=null`. A replacer swaps non-finite numbers for a NUL-tagged string and the host
  reverses it, so `validateAction` sees the real `NaN`, `Infinity` or `-Infinity`.
- **`undefined` survives**, as `undefined`. The `{v: ...}` envelope exists because
  `JSON.stringify(undefined)` is not a string; a strategy that returns nothing has to arrive
  as a value the validator can reject.

The returned action is **not** validated here — `validateAction` is the engine's job (see
`StrategyRunner.decide`: "Raw action — the ENGINE validates it"). `{ok: true}` means the
strategy ran inside its budget, not that what it returned is legal.

## Disposal is not optional

A leaked QuickJS handle is not a soft failure: `runtime.dispose()` asserts
`list_empty(&rt->gc_obj_list)`, and a failed assertion **aborts the wasm module** — which is
memoized per process, so one leak takes down every later load in the harness, the sim and the
server. Every handle that crosses the boundary goes through a `try/finally`, and
`test/lifecycle.test.ts` loads and disposes 200 runners (plus 100 failing ones) precisely
because a missed `dispose` crashes that test.

## Cost

`pnpm --filter @rematch/sandbox bench` — median wall time for one full `decide` round trip
(host stringify → VM → parse), 10k calls, `chaser` fixture, Node 25 / M-series:

| Projectiles in view | Median | p99 | Per 3600-tick match |
|---|---|---|---|
| 0 | ~16 µs | ~25 µs | ~59 ms |
| 8 | ~24 µs | ~33 µs | ~85 ms |
| 30 | ~43 µs | ~56 µs | ~154 ms |

Cost scales with the size of the `BossView`, because marshalling dominates — the strategy's
own logic is noise next to `JSON.parse`. At 200 matches per Gate 3 verdict that is 12–31 s of
sandbox time alone on one thread, so Gate 3 should parallelize across workers to stay inside
the interlude's 45 s budget (spec §11).

## Tests

```
pnpm --filter @rematch/sandbox test
```

`sandbox.test.ts` (behaviour and every failure kind) · `containment.test.ts` (the boundary,
with Gate 1 deliberately bypassed via `loadUnchecked`) · `determinism.test.ts` (same seed →
identical actions, with a pinned PRNG stream) · `lifecycle.test.ts` (200 load/dispose cycles,
isolation between runners).
