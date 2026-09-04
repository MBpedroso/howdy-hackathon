/**
 * The Boss Contract doc — the Coder agent's only view of the system it writes for.
 *
 * Spec §8 says the Coder gets "Boss Contract docs, `BossView`/`BossAction` types"
 * and is denied "engine source, renderer, server". The cheapest way to honour that
 * *and* keep it honest is to build the doc out of the `contract` package's own
 * files at module load: `contract` has zero workspace dependencies and contains no
 * engine internals by construction (see its README), so a doc assembled only from
 * those two files cannot leak an internal even by accident. If someone later moves
 * engine detail into `contract`, `test/context.test.ts` fails.
 *
 * Read once, at import, and memoized. It is ~6 KB, byte-identical across every
 * attempt of every round, which is exactly the shape a cached prompt prefix wants.
 */
import { readFileSync } from 'node:fs';
import { CONSTANTS, FORBIDDEN_IDENTIFIERS, STATIC_RULES } from '@rematch/contract';

const README_URL = new URL('../../../contract/README.md', import.meta.url);
const TYPES_URL = new URL('../../../contract/src/types.ts', import.meta.url);

/**
 * The README sections worth spending tokens on.
 *
 * "Type shapes" is deliberately **excluded**: it is a prose copy of `types.ts`,
 * which is included verbatim below, and paying twice for the same 1.6 KB is 1.6 KB
 * the analysis and the previous strategy could have had. What is kept is the part
 * of the README that exists nowhere else — the validator's exact behaviour, and
 * what Gate 1 does and does not catch.
 */
const README_SECTIONS = [
  // `## API` is depth 2, so it carries its own `###` subsections with it —
  // `validateAction behaviour worth knowing` and `What Gate 1 deliberately does
  // not do`, the two paragraphs that exist nowhere but the README. Listing those
  // separately would pay for them twice.
  '## API',
] as const;

/** Pull one `#…` section (heading included) out of a markdown document. */
export function markdownSection(markdown: string, heading: string): string {
  const lines = markdown.split('\n');
  const start = lines.indexOf(heading);
  if (start < 0) throw new Error(`contractDoc: the contract README no longer has a "${heading}" section`);
  const depth = heading.match(/^#+/)?.[0]?.length ?? 2;
  const out = [lines[start] ?? heading];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const level = line.match(/^(#+)\s/)?.[1]?.length;
    if (level !== undefined && level <= depth) break;
    out.push(line);
  }
  return out.join('\n').trimEnd();
}

/**
 * Strip block comments and collapse blank runs, keeping the declarations.
 *
 * `types.ts` is heavily commented for the humans who maintain it; the Coder needs
 * the shapes, and the reasoning behind them is already in the README sections
 * above. This roughly halves the file.
 */
export function stripBlockComments(source: string): string {
  return source
    .replace(/\/\*\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function build(): string {
  const readme = readFileSync(README_URL, 'utf8');
  const types = stripBlockComments(readFileSync(TYPES_URL, 'utf8'));

  const cooldowns = Object.entries(CONSTANTS.cooldowns)
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');

  return [
    '# THE BOSS CONTRACT',
    '',
    'You write one file: `strategy.js`. It is an ES module with exactly three exports',
    'and it runs inside a QuickJS sandbox with no host bindings. It is handed a',
    'read-only view of the world each tick and returns one action from a fixed menu.',
    'Nothing dangerous is expressible; all of the creativity is in *when* and *where*.',
    '',
    '## Module shape',
    '',
    '```js',
    'export const meta = { name: string, rationale: string, version: number };',
    'export function init() { return {}; }              // once per round; the object is your memory',
    'export function decide(view, mem) { return { type: "idle" }; }   // once per tick',
    '```',
    '',
    `\`meta.name\` is shown to the player and must be <= ${CONSTANTS.limits.metaNameMaxChars} characters.`,
    '`meta.rationale` is one sentence, also shown to the player — write it in the',
    "boss's voice, addressed to the player (\"You always run to the same corner, so that",
    'is where I put the floor slam.").',
    '',
    '## Types',
    '',
    '```ts',
    types,
    '```',
    '',
    '## Numbers the engine owns (you cannot change these)',
    '',
    `- arena ${CONSTANTS.arena.w}x${CONSTANTS.arena.h}, ${CONSTANTS.ticksPerSecond} ticks/second`,
    `- cooldowns in ticks: ${cooldowns}`,
    `- telegraphs in ticks: charge ${CONSTANTS.telegraphs.charge}, slam ${CONSTANTS.telegraphs.slam}`,
    `- \`decide\` budget ${CONSTANTS.limits.decideBudgetMs} ms; memory <= ${CONSTANTS.limits.memoryBytes} bytes serialized`,
    `- source <= ${CONSTANTS.limits.sourceBytes} bytes; at most ${CONSTANTS.limits.maxMinionsAlive} minions alive`,
    '- boss HP, player HP and damage numbers are NOT yours. You make the boss smarter,',
    '  never tougher.',
    '',
    '## Runtime',
    '',
    'The sandbox has `Math` and a seeded `rand()` and nothing else. No `import`, no',
    '`Date`, no `Math.random`, no timers, no host globals. An action returned while its',
    'primitive is on cooldown is coerced to `idle` and counted as a contract violation.',
    '',
    'Names you may not mention anywhere in the file, including as local bindings:',
    '',
    `\`${[...FORBIDDEN_IDENTIFIERS].join('`, `')}\``,
    '',
    ...README_SECTIONS.map((h) => `${markdownSection(readme, h)}\n`),
    `Gate 1's rule ids, for reference: \`${STATIC_RULES.join('`, `')}\`.`,
  ].join('\n');
}

let cached: string | undefined;

/** The Boss Contract doc. One function, one string, memoized (spec §8). */
export function contractDoc(): string {
  cached ??= build();
  return cached;
}
