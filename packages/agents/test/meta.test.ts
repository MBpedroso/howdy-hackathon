/**
 * `extractMeta` — the boss's name off an *unverified* file.
 *
 * It replaced a regex in the interlude (`parseMetaName`), and the tests below are
 * mostly the cases that regex got wrong: a `name:` inside a helper, a `name:` in a
 * comment, a `rationale` that contains the word. The rule it holds to is Gate 1's
 * own: `meta` must be an exported object literal with a string `name`, a string
 * `rationale` and a numeric `version`, so anything this returns `null` for is a
 * file the harness is about to reject anyway.
 */
import { readFileSync } from 'node:fs';
import { staticCheck } from '@rematch/contract';
import { describe, expect, it } from 'vitest';
import { extractMeta } from '../src/index.ts';
import { readGood, readHarnessFixture } from './helpers.ts';

const shell = (metaBody: string, prelude = ''): string =>
  `${prelude}export const meta = ${metaBody};\nexport function init() { return {}; }\nexport function decide() { return { type: 'idle' }; }\n`;

describe('extractMeta', () => {
  it('reads the real strategies the harness ships', () => {
    expect(extractMeta(readHarnessFixture('round2-candidate'))).toEqual({
      name: 'Warden',
      rationale: 'I hold the middle and put everything where you live, not where you are.',
      version: 1,
    });
    expect(extractMeta(readGood('chaser'))?.name).toBe('Hound');
    expect(extractMeta(readGood('idle'))?.name).toBe('Statue');
  });

  it('agrees with every pre-approved fallback in the pool', () => {
    // These are the files the server ships when the loop misses, and the interlude
    // names them on screen. A disagreement here is a wrong name in the demo.
    for (const path of [
      'round2/hollow.js',
      'round2/metronome.js',
      'round3/emberline.js',
      'round3/nettle.js',
      'round4/bellringer.js',
      'round4/curfew.js',
      'round5/crossfire.js',
      'round5/tollkeeper.js',
    ]) {
      const source = readFileSync(new URL(`../../server/fallback/${path}`, import.meta.url), 'utf8');
      const meta = extractMeta(source);
      expect(meta, path).not.toBeNull();
      expect(meta?.name.length, path).toBeGreaterThan(0);
      expect(source, path).toContain(`name: '${meta?.name ?? ''}'`);
    }
  });

  it('reads the *exported* meta, not the first `name:` in the file', () => {
    // The regex this replaced matched a local object's `name` and put a helper's
    // label on the diff.
    const source = shell("{ name: 'Warden', rationale: 'r', version: 2 }", "const tuning = { name: 'not the boss', limit: 3 };\n");
    expect(extractMeta(source)).toEqual({ name: 'Warden', rationale: 'r', version: 2 });
  });

  it('is not fooled by a comment or by a `name` inside the rationale', () => {
    const commented = shell("{ name: 'Curfew', rationale: 'I pick a name and keep it.', version: 1 }", "// name: 'Impostor'\n");
    expect(extractMeta(commented)?.name).toBe('Curfew');
  });

  it('folds a concatenated name the way Gate 1 does', () => {
    // `staticCheck`'s `staticString` accepts `+` over literals, so this file ships
    // and the interlude must be able to name it.
    const source = shell("{ name: 'Cross' + 'fire', rationale: 'r', version: 1 }");
    expect(staticCheck(source).ok).toBe(true);
    expect(extractMeta(source)?.name).toBe('Crossfire');
  });

  it('accepts `export { meta }` and a template-literal name', () => {
    const indirect = `const meta = { name: \`Nettle\`, rationale: 'r', version: 3 };\nexport { meta };\nexport function init() { return {}; }\nexport function decide() { return { type: 'idle' }; }\n`;
    expect(extractMeta(indirect)).toEqual({ name: 'Nettle', rationale: 'r', version: 3 });
  });

  it('returns null exactly where Gate 1 would reject the file', () => {
    const bad: Record<string, string> = {
      'no meta at all': 'export function init() { return {}; }\nexport function decide() { return { type: "idle" }; }\n',
      'not a literal': shell('buildMeta()', 'function buildMeta() { return { name: "x", rationale: "y", version: 1 }; }\n'),
      'a name computed at runtime': shell('{ name: String(1), rationale: "r", version: 1 }'),
      'numeric name': shell("{ name: 7, rationale: 'r', version: 1 }"),
      'empty name': shell("{ name: '', rationale: 'r', version: 1 }"),
      'missing rationale': shell("{ name: 'Warden', version: 1 }"),
      'version as a string': shell("{ name: 'Warden', rationale: 'r', version: '1' }"),
      'spread meta': shell("{ ...base, name: 'Warden', rationale: 'r', version: 1 }", 'const base = { version: 1 };\n'),
      'syntax error': 'export const meta = { name: "Warden",\n',
    };

    for (const [why, source] of Object.entries(bad)) {
      expect(extractMeta(source), why).toBeNull();
      // The contract of the fallback: `null` never means "the file was fine but
      // unreadable", so the caller can safely show the attempt number instead.
      expect(staticCheck(source).ok, why).toBe(false);
    }
  });

  it('does not execute the file it reads', () => {
    // A parse, not a load: this source would throw at module scope, and Gate 2 is
    // the thing that gets to find that out.
    const throws = shell("{ name: 'Bomb', rationale: 'r', version: 1 }", 'const boom = (() => { throw new Error("side effect"); })();\n');
    expect(extractMeta(throws)?.name).toBe('Bomb');
  });
});
