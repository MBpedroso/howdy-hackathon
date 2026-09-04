/**
 * Stable state hashing — canonical JSON, then FNV-1a 64.
 *
 * No `crypto`, no Node APIs, no BigInt. Two states hash equal iff their canonical JSON
 * is byte-identical, which is exactly the determinism property spec §7 tests:
 * *same seed + same inputs -> identical state hash*, in Node and in the browser.
 *
 * Canonicalization rules:
 *  - object keys sorted with the default (code-unit) ordering,
 *  - `undefined`-valued properties dropped, like `JSON.stringify`,
 *  - `-0` renders as `"0"` and non-finite numbers as `"null"`, so a JSON round-trip
 *    cannot change a hash,
 *  - everything else exactly as `JSON.stringify` would render it.
 */

/** Canonical JSON: deterministic key order, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';

  const t = typeof value;
  if (t === 'number') {
    const n = value as number;
    if (!Number.isFinite(n)) return 'null';
    return n === 0 ? '0' : String(n);
  }
  if (t === 'boolean') return value === true ? 'true' : 'false';
  if (t === 'string') return JSON.stringify(value as string);
  if (t === 'undefined' || t === 'function' || t === 'symbol') return 'null';

  if (Array.isArray(value)) {
    let out = '[';
    for (let i = 0; i < value.length; i += 1) {
      if (i > 0) out += ',';
      out += canonicalJson(value[i]);
    }
    return `${out}]`;
  }

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  let out = '{';
  let first = true;
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined) continue;
    if (!first) out += ',';
    first = false;
    out += `${JSON.stringify(k)}:${canonicalJson(v)}`;
  }
  return `${out}}`;
}

const FNV_OFFSET_HI = 0xcbf29ce4;
const FNV_OFFSET_LO = 0x84222325;
/** FNV prime 0x100000001b3 = 435 + 256 * 2^32. */
const PRIME_LO = 435;
const PRIME_HI = 256;

/**
 * FNV-1a 64 over the UTF-16 code units of `s` (low byte then high byte), returned as
 * 16 lowercase hex characters. Byte order is fixed here rather than delegated to a
 * platform `TextEncoder`, so the result cannot drift between browser and Node.
 *
 * The 64-bit multiply is done in two uint32 halves: every intermediate product stays
 * below 2^43, well inside exact double-precision integer range.
 */
export function fnv1a64(s: string): string {
  let hi = FNV_OFFSET_HI;
  let lo = FNV_OFFSET_LO;

  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);

    // Low byte.
    lo = (lo ^ (c & 0xff)) >>> 0;
    let low = lo * PRIME_LO;
    let high = hi * PRIME_LO + lo * PRIME_HI + Math.floor(low / 4294967296);
    lo = low >>> 0;
    hi = high >>> 0;

    // High byte.
    lo = (lo ^ ((c >>> 8) & 0xff)) >>> 0;
    low = lo * PRIME_LO;
    high = hi * PRIME_LO + lo * PRIME_HI + Math.floor(low / 4294967296);
    lo = low >>> 0;
    hi = high >>> 0;
  }

  return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
}

/** Canonical JSON of `value`, hashed. */
export function hashValue(value: unknown): string {
  return fnv1a64(canonicalJson(value));
}
