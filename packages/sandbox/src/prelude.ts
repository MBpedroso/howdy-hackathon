/**
 * The sandbox prelude — the only code we run inside a strategy's context.
 *
 * It is evaluated in global scope *before* the strategy module, and it does four
 * things:
 *
 *  1. Installs `rand()`: a seeded xorshift32 PRNG written in JS, **inside** the
 *     VM. Not a host callback — a host callback would cost a wasm boundary
 *     crossing per call (a strategy may call `rand` several times per tick, 3600
 *     ticks a match, 200+ matches a Gate 3 run) and would make the sandbox's
 *     determinism depend on host state. The generator is the same xorshift32 the
 *     engine uses, so replays agree bit-for-bit (spec §5.2).
 *  2. Installs the marshalling entry points (`init`, `tick`, `meta`, `memBytes`)
 *     as non-writable, non-configurable globals. Non-writable matters: modules
 *     are strict-mode code, and `rand = 0` at module top level would otherwise
 *     *succeed* (it is an assignment to an existing global property, not an
 *     unresolvable reference) and let a strategy tamper with its own harness.
 *  3. Enforces the serialized-memory cap from inside the VM, where the memory
 *     object lives.
 *  4. Hardens the global object: deletes the globals listed in
 *     `SANDBOX_DELETED_GLOBALS`, deletes `Math.random`, freezes `Math` and `JSON`,
 *     and deletes `constructor` from every function prototype so
 *     `(function(){}).constructor` can no longer reach `Function`.
 *
 * Everything the entry points need (`JSON.parse`, `JSON.stringify`, `Infinity`)
 * is captured in closure variables first, so a strategy cannot break the
 * marshalling path by reassigning a global it can still see.
 */
import { SANDBOX_DELETED_GLOBALS } from './quickjs.ts';

/** Names the prelude installs on the sandbox's global object. */
export const PRELUDE_GLOBALS = {
  /** The seeded PRNG. The one name a strategy is *meant* to use. */
  rand: 'rand',
  setModule: '__rematch_setModule',
  meta: '__rematch_meta',
  init: '__rematch_init',
  tick: '__rematch_tick',
  memBytes: '__rematch_memBytes',
} as const;

/**
 * Result tags. Entry points return a *string* rather than throwing, so the
 * ordinary paths (an action, an over-budget memory object) never pay for
 * exception unwinding and are never confused with a strategy's own throw.
 *
 *  - `A` — success. Payload is JSON (`{"v": <action>}`) or a byte count.
 *  - `M` — the serialized memory cap was exceeded. Payload is the byte count.
 *  - `E` — the sandbox could not marshal what the strategy produced. Payload is
 *    a message. (A strategy *throwing* is a real VM exception, not this.)
 */
export const TAG = { ok: 'A', memory: 'M', error: 'E' } as const;

/**
 * Sentinel prefix for non-finite numbers. `JSON.stringify(NaN)` is `"null"`,
 * which would turn `{angle: NaN}` — the exact failure spec §6.3 wants reported as
 * `"returned angle=NaN on 3% of states"` — into a much vaguer `angle=null`. The
 * replacer swaps non-finite numbers for a tagged string and the host reverses it,
 * so `validateAction` sees the real `NaN`.
 *
 * A NUL code unit cannot appear unescaped inside a JSON string, so the tag is
 * cheap to detect (`indexOf`) and cannot be produced by accident.
 */
export const NON_FINITE_TAG = '\u0000nf:';

/**
 * The same tag as it appears in JSON *text*: `JSON.stringify` escapes a NUL code
 * unit, so scanning a returned string for the raw tag would never match. The host
 * tests for this before installing a reviver, and skips the reviver (and its
 * per-key callback) entirely in the overwhelmingly common all-finite case.
 */
export const NON_FINITE_TAG_JSON = '\\u0000nf:';

export type PreludeOptions = {
  /** Serialized-memory ceiling, in UTF-8 bytes. */
  memoryBytesLimit: number;
  /** Re-measure the memory object every N `decide` calls. 1 = every call. */
  memoryCheckEvery: number;
};

/** Build the prelude source for one sandbox. */
export function buildPrelude(opts: PreludeOptions): string {
  const deleted = JSON.stringify(SANDBOX_DELETED_GLOBALS);
  const g = PRELUDE_GLOBALS;
  return `(function () {
  'use strict';
  var g = globalThis;
  var JSONparse = JSON.parse;
  var JSONstringify = JSON.stringify;
  var INF = Infinity;
  var NF = ${JSON.stringify(NON_FINITE_TAG)};
  var MEM_LIMIT = ${opts.memoryBytesLimit};
  var MEM_EVERY = ${opts.memoryCheckEvery};

  var mod = null;
  var mem = null;
  var sinceCheck = 0;

  /* ---- seeded xorshift32, the same generator the engine uses ---- */
  var state = 0x9e3779b9;
  function nextU32() {
    var x = state;
    x ^= x << 13; x = x >>> 0;
    x ^= x >>> 17;
    x ^= x << 5;  x = x >>> 0;
    state = x;
    return x;
  }
  function rand() { return nextU32() / 4294967296; }
  function reseed(n) {
    n = n >>> 0;
    state = n === 0 ? 0x9e3779b9 : n;
    /* xorshift32 output is poor for the first few steps of a small seed. */
    nextU32(); nextU32(); nextU32(); nextU32();
  }

  function messageOf(e) {
    try {
      if (e && typeof e.message === 'string' && e.message.length > 0) return e.message;
      return String(e);
    } catch (x) { return 'unknown error'; }
  }

  /* UTF-8 byte length. String#length counts UTF-16 units, so 4096 emoji would
     read as 4096 and slip past a 4 KB cap that is expressed in bytes. */
  function utf8Len(s) {
    var n = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) { n += 4; i++; }
      else n += 3;
    }
    return n;
  }

  function memBytes() {
    if (mem === null || mem === undefined) return 0;
    var json = JSONstringify(mem);
    return typeof json === 'string' ? utf8Len(json) : 0;
  }

  function nonFiniteReplacer(key, value) {
    if (typeof value === 'number' && (value !== value || value === INF || value === -INF)) {
      return NF + (value !== value ? 'NaN' : (value > 0 ? 'Infinity' : '-Infinity'));
    }
    return value;
  }

  function define(name, fn) {
    Object.defineProperty(g, name, { value: fn, writable: false, enumerable: false, configurable: false });
  }

  define(${JSON.stringify(g.rand)}, rand);

  define(${JSON.stringify(g.setModule)}, function (m) { mod = m; });

  define(${JSON.stringify(g.meta)}, function () {
    try {
      return ${JSON.stringify(TAG.ok)} + JSONstringify({
        v: mod ? mod.meta : undefined,
        init: mod ? typeof mod.init : 'undefined',
        decide: mod ? typeof mod.decide : 'undefined'
      }, nonFiniteReplacer);
    } catch (e) {
      return ${JSON.stringify(TAG.error)} + 'meta is not serializable: ' + messageOf(e);
    }
  });

  define(${JSON.stringify(g.init)}, function (seed) {
    reseed(seed);
    sinceCheck = 0;
    mem = null;
    var value = mod.init();
    if (value === null || typeof value !== 'object') {
      return ${JSON.stringify(TAG.error)} + 'init() must return an object, got ' + (value === null ? 'null' : typeof value);
    }
    mem = value;
    var bytes;
    try { bytes = memBytes(); }
    catch (e) {
      mem = null;
      return ${JSON.stringify(TAG.error)} + 'init() returned memory that is not JSON-serializable: ' + messageOf(e);
    }
    if (bytes > MEM_LIMIT) return ${JSON.stringify(TAG.memory)} + bytes;
    return ${JSON.stringify(TAG.ok)} + bytes;
  });

  define(${JSON.stringify(g.memBytes)}, function () {
    try { return memBytes(); } catch (e) { return -1; }
  });

  define(${JSON.stringify(g.tick)}, function (json) {
    var view = JSONparse(json);
    var action = mod.decide(view, mem);
    sinceCheck = sinceCheck + 1;
    if (sinceCheck >= MEM_EVERY) {
      sinceCheck = 0;
      var bytes;
      try { bytes = memBytes(); }
      catch (e) {
        return ${JSON.stringify(TAG.error)} + 'strategy memory is not JSON-serializable: ' + messageOf(e);
      }
      if (bytes > MEM_LIMIT) return ${JSON.stringify(TAG.memory)} + bytes;
    }
    try { return ${JSON.stringify(TAG.ok)} + JSONstringify({ v: action }, nonFiniteReplacer); }
    catch (e) { return ${JSON.stringify(TAG.error)} + 'the returned action could not be serialized: ' + messageOf(e); }
  });

  /* ---- harden ---- */
  var deleted = ${deleted};
  for (var i = 0; i < deleted.length; i++) { try { delete g[deleted[i]]; } catch (e) {} }
  try { delete Math.random; } catch (e) {}
  var protos = [];
  try { protos.push(Object.getPrototypeOf(function () {})); } catch (e) {}
  try { protos.push(Object.getPrototypeOf(function* () {})); } catch (e) {}
  try { protos.push(Object.getPrototypeOf(async function () {})); } catch (e) {}
  try { protos.push(Object.getPrototypeOf(async function* () {})); } catch (e) {}
  for (var j = 0; j < protos.length; j++) { try { delete protos[j].constructor; } catch (e) {} }
  try { Object.freeze(Math); } catch (e) {}
  try { Object.freeze(JSON); } catch (e) {}
})();`;
}
