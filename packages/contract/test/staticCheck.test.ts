import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ALLOWED_EXPORTS,
  CONSTANTS,
  FORBIDDEN_IDENTIFIERS,
  STATIC_RULES,
  staticCheck,
  type StaticRule,
} from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const GOOD_DIR = join(here, 'fixtures/strategies/good');
const BAD_DIR = join(here, 'fixtures/strategies/bad');

const read = (dir: string, file: string): string => readFileSync(join(dir, file), 'utf8');
const listJs = (dir: string): string[] => readdirSync(dir).filter((f) => f.endsWith('.js')).sort();

const rulesOf = (source: string): StaticRule[] => {
  const result = staticCheck(source);
  return result.ok ? [] : result.violations.map((v) => v.rule);
};

const PROBE_META = "export const meta = { name: 'Probe', rationale: 'Probe.', version: 1 };";
const PROBE_INIT = 'export function init() { return {}; }';
const PROBE_DECIDE = "export function decide(view, mem) { return { type: 'idle' }; }";

/** Wrap a fragment in an otherwise-valid strategy so only the fragment is under test. */
const inDecide = (body: string): string =>
  `${PROBE_META}
${PROBE_INIT}
export function decide(view, mem) {
${body}
  return { type: 'idle' };
}`;

/**
 * Every bad fixture, and the rule it MUST trip. Extra violations are allowed
 * (`new Function` legitimately trips both `new-function` and
 * `forbidden-identifier`), but the named rule has to be one of them — that string
 * is what gets fed back to the Coder agent.
 */
const BAD_FIXTURES: Array<[file: string, rule: StaticRule]> = [
  ['computed-global-this.js', 'forbidden-computed'],
  ['decide-not-a-function.js', 'decide'],
  ['default-export.js', 'export'],
  ['dynamic-import.js', 'dynamic-import'],
  ['extra-export.js', 'export'],
  ['has-import.js', 'import'],
  ['meta-name-too-long.js', 'meta'],
  ['meta-version-not-number.js', 'meta'],
  ['missing-decide.js', 'decide'],
  ['missing-meta.js', 'meta'],
  ['new-function.js', 'new-function'],
  ['syntax-error.js', 'syntax'],
  ['this-at-top-level.js', 'this'],
  ['uses-console.js', 'forbidden-identifier'],
  ['uses-date-now.js', 'forbidden-identifier'],
  ['uses-eval.js', 'forbidden-identifier'],
  ['uses-fetch.js', 'forbidden-identifier'],
  ['uses-global-this.js', 'forbidden-identifier'],
  ['uses-math-random.js', 'math-random'],
  ['uses-process.js', 'forbidden-identifier'],
  ['uses-promise.js', 'forbidden-identifier'],
  ['uses-set-timeout.js', 'forbidden-identifier'],
  ['uses-with.js', 'with'],
];

describe('staticCheck — good fixtures', () => {
  const files = listJs(GOOD_DIR);

  it('has at least three reference strategies', () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
  });

  it.each(files)('accepts %s', (file) => {
    const result = staticCheck(read(GOOD_DIR, file));
    if (!result.ok) {
      const detail = result.violations.map((v) => `  ${v.rule} @${v.line ?? '?'}: ${v.message}`).join('\n');
      throw new Error(`${file} was rejected:\n${detail}`);
    }
    expect(result).toEqual({ ok: true });
  });
});

describe('staticCheck — bad fixtures', () => {
  it('covers at least twelve rejection cases', () => {
    expect(BAD_FIXTURES.length).toBeGreaterThanOrEqual(12);
  });

  it('every bad fixture on disk is listed in the table', () => {
    expect(listJs(BAD_DIR)).toEqual(BAD_FIXTURES.map(([f]) => f).sort());
  });

  it.each(BAD_FIXTURES)('rejects %s with rule %s', (file, rule) => {
    const result = staticCheck(read(BAD_DIR, file));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations.map((v) => v.rule)).toContain(rule);
    for (const v of result.violations) {
      expect(STATIC_RULES).toContain(v.rule);
      expect(v.message.length).toBeGreaterThan(0);
      if (v.line !== undefined) expect(v.line).toBeGreaterThan(0);
    }
  });

  it('reports the line a syntax error occurred on', () => {
    const result = staticCheck(read(BAD_DIR, 'syntax-error.js'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.rule).toBe('syntax');
    expect(result.violations[0]?.line).toBe(4);
  });

  it('labels `with` as its own rule even though it is a strict-mode syntax error', () => {
    const result = staticCheck(read(BAD_DIR, 'uses-with.js'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations[0]).toMatchObject({ rule: 'with', line: 4 });
  });

  it('reports the offending line where the AST knows it', () => {
    const result = staticCheck(read(BAD_DIR, 'uses-date-now.js'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const forbidden = result.violations.find((v) => v.rule === 'forbidden-identifier');
    expect(forbidden?.line).toBe(4);
    expect(forbidden?.message).toContain("'Date'");
  });
});

describe('staticCheck — forbidden identifiers', () => {
  it.each([...FORBIDDEN_IDENTIFIERS].sort())('rejects a bare reference to %s', (name) => {
    expect(rulesOf(inDecide(`  const probe = ${name};`))).toContain('forbidden-identifier');
  });

  it('rejects a forbidden name used as a local binding (no shadowing loophole)', () => {
    expect(rulesOf(inDecide('  const Date = 1;'))).toContain('forbidden-identifier');
    expect(rulesOf(inDecide('  function Function() {}'))).toContain('forbidden-identifier');
  });

  it('rejects a forbidden name reached through a parameter default', () => {
    expect(rulesOf(inDecide('  const f = (t = Date) => t; f();'))).toContain('forbidden-identifier');
  });

  it('does not flag a forbidden name used as a plain property key', () => {
    expect(staticCheck(inDecide('  const bag = { Date: 1, fetch: 2 }; const n = bag.Date + bag.fetch;'))).toEqual({
      ok: true,
    });
  });

  it('rejects whitespace-obfuscated member access that regex matching would miss', () => {
    expect(rulesOf(inDecide('  const t = Date\n    .\n    now();'))).toContain('forbidden-identifier');
  });

  it('rejects (0, eval)(...)', () => {
    expect(rulesOf(inDecide('  const r = (0, eval)("1");'))).toContain('forbidden-identifier');
  });

  it('rejects import.meta', () => {
    expect(rulesOf(inDecide('  const u = import.meta.url;'))).toContain('forbidden-identifier');
  });
});

describe('staticCheck — computed and obfuscated access', () => {
  it('rejects a concatenated forbidden name on a forbidden root', () => {
    expect(rulesOf(inDecide("  const g = globalThis['fe' + 'tch'];"))).toContain('forbidden-computed');
  });

  it('rejects a template-literal forbidden name on an innocent root', () => {
    expect(rulesOf(inDecide('  const g = view[`fetch`];'))).toContain('forbidden-computed');
  });

  it('rejects Math["random"] and Math[`ran` + `dom`]', () => {
    expect(rulesOf(inDecide('  const r = Math["random"]();'))).toContain('math-random');
    expect(rulesOf(inDecide('  const r = Math[`ran` + `dom`]();'))).toContain('math-random');
  });

  it('rejects plain Math.random', () => {
    expect(rulesOf(inDecide('  const r = Math.random();'))).toContain('math-random');
  });

  it('allows ordinary runtime-indexed access, which is not statically resolvable', () => {
    const body = `  let s = 0;
  const heat = view.history.playerPosHeat;
  for (let i = 0; i < heat.length; i = i + 1) { s = s + heat[i]; }`;
    expect(staticCheck(inDecide(body))).toEqual({ ok: true });
  });

  it('allows the rest of Math', () => {
    expect(
      staticCheck(inDecide('  const a = Math.atan2(1, 2) + Math.hypot(3, 4) + Math.min(Math.PI, Math.abs(-1));')),
    ).toEqual({ ok: true });
  });
});

describe('staticCheck — module shape', () => {
  it('accepts arrow-function exports', () => {
    expect(
      staticCheck(
        `${PROBE_META}\nexport const init = () => ({});\nexport const decide = (view, mem) => ({ type: 'idle' });`,
      ),
    ).toEqual({ ok: true });
  });

  it('accepts function-expression exports', () => {
    expect(
      staticCheck(
        `${PROBE_META}
export const init = function () { return {}; };
export const decide = function (view, mem) { return { type: 'idle' }; };`,
      ),
    ).toEqual({ ok: true });
  });

  it('accepts an export list at the bottom of the file', () => {
    expect(
      staticCheck(
        `const meta = { name: 'Probe', rationale: 'Probe.', version: 1 };
function init() { return {}; }
function decide(view, mem) { return { type: 'idle' }; }
export { meta, init, decide };`,
      ),
    ).toEqual({ ok: true });
  });

  it('accepts private top-level helpers that are not exported', () => {
    expect(
      staticCheck(
        `const RADIUS = 240;
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
${PROBE_META}
${PROBE_INIT}
export function decide(view, mem) { return { type: 'move', dx: clamp(RADIUS, -1, 1), dy: 0 }; }`,
      ),
    ).toEqual({ ok: true });
  });

  it('rejects a missing init', () => {
    expect(rulesOf(`${PROBE_META}\n${PROBE_DECIDE}`)).toContain('init');
  });

  it('rejects an async decide', () => {
    expect(
      rulesOf(`${PROBE_META}\n${PROBE_INIT}\nexport async function decide(view, mem) { return { type: 'idle' }; }`),
    ).toContain('decide');
  });

  it('rejects a generator decide', () => {
    expect(
      rulesOf(`${PROBE_META}\n${PROBE_INIT}\nexport function* decide(view, mem) { yield { type: 'idle' }; }`),
    ).toContain('decide');
  });

  it('rejects an extra export under any syntax', () => {
    expect(rulesOf(`${PROBE_META}\n${PROBE_INIT}\n${PROBE_DECIDE}\nexport const tuning = 1;`)).toContain('export');
    expect(
      rulesOf(`${PROBE_META}\n${PROBE_INIT}\n${PROBE_DECIDE}\nconst tuning = 1;\nexport { tuning };`),
    ).toContain('export');
    expect(rulesOf(`${PROBE_META}\n${PROBE_INIT}\n${PROBE_DECIDE}\nexport class Helper {}`)).toContain('export');
  });

  it('rejects a re-export', () => {
    expect(
      rulesOf(`${PROBE_META}\n${PROBE_INIT}\n${PROBE_DECIDE}\nexport { clamp } from './helpers.js';`),
    ).toContain('import');
  });

  it('rejects a non-literal meta', () => {
    expect(
      rulesOf(`const build = () => ({});\nexport const meta = build();\n${PROBE_INIT}\n${PROBE_DECIDE}`),
    ).toContain('meta');
  });

  it('rejects a spread inside meta', () => {
    expect(
      rulesOf(
        `const base = { version: 1 };\nexport const meta = { name: 'P', rationale: 'P.', ...base };\n${PROBE_INIT}\n${PROBE_DECIDE}`,
      ),
    ).toContain('meta');
  });

  it('rejects a computed meta key', () => {
    expect(
      rulesOf(
        `const k = 'name';\nexport const meta = { [k]: 'P', rationale: 'P.', version: 1 };\n${PROBE_INIT}\n${PROBE_DECIDE}`,
      ),
    ).toContain('meta');
  });

  it('rejects a non-string meta.name and a non-string meta.rationale', () => {
    expect(
      rulesOf(`export const meta = { name: 7, rationale: 'P.', version: 1 };\n${PROBE_INIT}\n${PROBE_DECIDE}`),
    ).toContain('meta');
    expect(
      rulesOf(`export const meta = { name: 'P', rationale: 7, version: 1 };\n${PROBE_INIT}\n${PROBE_DECIDE}`),
    ).toContain('meta');
  });

  it('rejects an empty meta.name', () => {
    expect(
      rulesOf(`export const meta = { name: '', rationale: 'P.', version: 1 };\n${PROBE_INIT}\n${PROBE_DECIDE}`),
    ).toContain('meta');
  });

  it('accepts a meta.name of exactly the limit and rejects one character more', () => {
    const atLimit = 'x'.repeat(CONSTANTS.limits.metaNameMaxChars);
    const overLimit = 'x'.repeat(CONSTANTS.limits.metaNameMaxChars + 1);
    expect(
      staticCheck(
        `export const meta = { name: '${atLimit}', rationale: 'P.', version: 1 };\n${PROBE_INIT}\n${PROBE_DECIDE}`,
      ),
    ).toEqual({ ok: true });
    expect(
      rulesOf(
        `export const meta = { name: '${overLimit}', rationale: 'P.', version: 1 };\n${PROBE_INIT}\n${PROBE_DECIDE}`,
      ),
    ).toContain('meta');
  });

  it('only allows the three contract exports', () => {
    expect(ALLOWED_EXPORTS).toEqual(['meta', 'init', 'decide']);
  });
});

describe('staticCheck — limits and totality', () => {
  it('rejects source over the size limit without parsing it', () => {
    const filler = `// ${'p'.repeat(80)}\n`;
    const huge = filler.repeat(Math.ceil(CONSTANTS.limits.sourceBytes / filler.length) + 1);
    const result = staticCheck(huge);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]?.rule).toBe('size');
    }
  });

  it('accepts source just under the size limit', () => {
    const base = `${PROBE_META}\n${PROBE_INIT}\n${PROBE_DECIDE}\n`;
    const padding = '// pad\n'.repeat(Math.floor((CONSTANTS.limits.sourceBytes - base.length - 32) / 7));
    const source = base + padding;
    expect(new TextEncoder().encode(source).length).toBeLessThanOrEqual(CONSTANTS.limits.sourceBytes);
    expect(staticCheck(source)).toEqual({ ok: true });
  });

  it('counts bytes, not characters, for the size limit', () => {
    // Four-byte astral characters: under the limit by length, over it by bytes.
    const astral = String.fromCodePoint(0x1f642).repeat(Math.ceil(CONSTANTS.limits.sourceBytes / 4));
    const source = `// ${astral}\n`;
    expect(source.length).toBeLessThan(CONSTANTS.limits.sourceBytes);
    expect(rulesOf(source)).toContain('size');
  });

  it('never throws, whatever it is handed', () => {
    const inputs: unknown[] = [
      '',
      ' ',
      'export',
      '}{',
      '/*',
      '(((((((((((',
      'a'.repeat(1000),
      '#!/usr/bin/env node\nexport const meta = {};',
      String.fromCharCode(0),
      String.fromCharCode(0xd800),
      null,
      undefined,
      42,
      {},
      [],
      () => {},
    ];
    for (const input of inputs) {
      expect(() => staticCheck(input as string)).not.toThrow();
      expect(staticCheck(input as string).ok).toBeTypeOf('boolean');
    }
  });

  it('rejects an empty file with missing-export violations, not a crash', () => {
    expect(rulesOf('')).toEqual(expect.arrayContaining<StaticRule>(['meta', 'init', 'decide']));
  });

  it('rejects a non-string input', () => {
    expect(rulesOf(null as unknown as string)).toContain('input');
  });

  it('reports only known rule ids', () => {
    for (const file of listJs(BAD_DIR)) {
      for (const rule of rulesOf(read(BAD_DIR, file))) {
        expect(STATIC_RULES).toContain(rule);
      }
    }
  });

  it('is deterministic', () => {
    const source = read(BAD_DIR, 'uses-fetch.js');
    expect(JSON.stringify(staticCheck(source))).toBe(JSON.stringify(staticCheck(source)));
  });
});

describe('staticCheck — documented non-goals', () => {
  const bodyOnly = (body: string): string =>
    `${PROBE_META}
${PROBE_INIT}
export function decide(view, mem) {
${body}
}`;

  it('does NOT catch infinite loops — that is Gate 2/4 (runtime deadline), by design', () => {
    expect(staticCheck(bodyOnly('  while (true) {}'))).toEqual({ ok: true });
    expect(staticCheck(bodyOnly('  for (;;) {}'))).toEqual({ ok: true });
  });

  it('does NOT catch a runtime-invalid action — that is the validator, every tick', () => {
    expect(staticCheck(bodyOnly("  return { type: 'burst', angle: 0 / 0, count: 4 };"))).toEqual({ ok: true });
  });
});
