/**
 * `extractMeta` — the boss's name, out of a source file, without running it.
 *
 * ## Why this exists
 *
 * The Rewrite beat (spec §2.2) shows a diff, and a diff of an unnamed file is a
 * wall of code. The boss's `meta.name` is what makes it a *character* changing —
 * "Warden", "Metronome" — and the interlude needs it at `rewrite.done`, which is
 * *before* the gates have run. So it cannot come from the sandbox: an attempt that
 * Gate 1 is about to reject may never be loaded at all, and loading unverified code
 * to read a label would invert the whole point of gating it.
 *
 * ## Why not a regex
 *
 * The interlude used to take the name with `/name\s*:\s*(['"])(...)\1/`, which
 * finds the first `name:` anywhere in the file — a helper's local, a comment, a
 * string in `rationale`. This walks the module's AST instead and reads the
 * *exported* binding, which is the same thing `staticCheck` validates: Gate 1
 * already requires `meta` to be an object literal with a string `name`, a string
 * `rationale` and a number `version` (that is its `meta` rule), so a file this
 * returns `null` for is a file Gate 1 rejects.
 *
 * ## Why it is here and not in `@rematch/contract`
 *
 * `contract` is the API the boss agent depends on and its changes are human-gated
 * (spec §7: CI rejects a `contract/` change without a CHANGELOG entry). This is a
 * presentation convenience for the interlude, not a contract rule, so it lives with
 * the code that needs it. It uses acorn, the same parser `staticCheck` uses, so the
 * two cannot disagree about what "statically readable" means.
 *
 * The authoritative `meta` is still the sandbox's (`readMeta` in `loop.ts`): that is
 * the value the game will actually see, and it is what the *approved* result and the
 * HUD carry. This is for the label on an attempt.
 */
import { parse } from 'acorn';
import type { StrategyMeta } from '@rematch/contract';

type AstNode = { type: string } & Record<string, unknown>;

function isNode(value: unknown): value is AstNode {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}

function field(node: AstNode | undefined, key: string): AstNode | undefined {
  if (node === undefined) return undefined;
  const value = node[key];
  return isNode(value) ? value : undefined;
}

function nodes(node: AstNode | undefined, key: string): AstNode[] {
  if (node === undefined) return [];
  const value = node[key];
  return Array.isArray(value) ? value.filter(isNode) : [];
}

/** An identifier's name, or a string key's value. */
function keyOf(node: AstNode | undefined): string | undefined {
  if (node === undefined) return undefined;
  if (node.type === 'Identifier') return typeof node['name'] === 'string' ? node['name'] : undefined;
  if (node.type === 'Literal') return typeof node['value'] === 'string' ? node['value'] : undefined;
  return undefined;
}

/**
 * A statically readable string: a literal, a substitution-free template literal,
 * or `+` concatenation of those.
 *
 * The three forms `staticCheck` accepts for `meta.name` (its `staticString`), so
 * this function and Gate 1 agree on what "statically readable" means. If they
 * disagreed, `extractMeta` would return `null` for a file that ships.
 */
function stringOf(node: AstNode | undefined): string | undefined {
  if (node === undefined) return undefined;
  if (node.type === 'Literal') return typeof node['value'] === 'string' ? node['value'] : undefined;
  if (node.type === 'TemplateLiteral' && nodes(node, 'expressions').length === 0) {
    const quasis = nodes(node, 'quasis');
    if (quasis.length !== 1) return undefined;
    // `quasis[i].value` is `{ raw, cooked }` — a plain object, not an AST node.
    const value = quasis[0]?.['value'];
    const cooked = typeof value === 'object' && value !== null ? (value as { cooked?: unknown }).cooked : undefined;
    return typeof cooked === 'string' ? cooked : undefined;
  }
  if (node.type === 'BinaryExpression' && node['operator'] === '+') {
    const left = stringOf(field(node, 'left'));
    const right = stringOf(field(node, 'right'));
    return left === undefined || right === undefined ? undefined : left + right;
  }
  return undefined;
}

function numberOf(node: AstNode | undefined): number | undefined {
  if (node?.type !== 'Literal') return undefined;
  const value = node['value'];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * The `meta` a `strategy.js` exports, or `null`.
 *
 * `null` means one of: the file does not parse as a module, nothing named `meta` is
 * exported, or `meta` is not an object literal carrying a string `name`, a string
 * `rationale` and a numeric `version`. Every one of those is a Gate 1 rejection, so
 * a caller's fallback for `null` is "show the attempt number" and never "guess".
 */
export function extractMeta(source: string): StrategyMeta | null {
  let program: AstNode;
  try {
    program = parse(source, { ecmaVersion: 2023, sourceType: 'module' }) as unknown as AstNode;
  } catch {
    return null;
  }

  const body = nodes(program, 'body');
  /** Top-level `const`/`let`/`var` initialisers, for `const meta = …; export { meta }`. */
  const bindings = new Map<string, AstNode | undefined>();
  let metaValue: AstNode | undefined;
  let exported = false;

  const collect = (declaration: AstNode | undefined): void => {
    if (declaration?.type !== 'VariableDeclaration') return;
    for (const d of nodes(declaration, 'declarations')) {
      const name = keyOf(field(d, 'id'));
      if (name !== undefined) bindings.set(name, field(d, 'init'));
    }
  };

  for (const statement of body) collect(statement);

  for (const statement of body) {
    if (statement.type !== 'ExportNamedDeclaration') continue;
    const declaration = field(statement, 'declaration');
    if (declaration !== undefined) {
      // `export const meta = { … }`
      collect(declaration);
      if (declaration.type === 'VariableDeclaration') {
        for (const d of nodes(declaration, 'declarations')) {
          if (keyOf(field(d, 'id')) === 'meta') {
            exported = true;
            metaValue = field(d, 'init');
          }
        }
      }
      continue;
    }
    // `export { meta }` / `export { local as meta }`
    for (const spec of nodes(statement, 'specifiers')) {
      if (keyOf(field(spec, 'exported')) !== 'meta') continue;
      exported = true;
      const local = keyOf(field(spec, 'local'));
      metaValue = local === undefined ? undefined : bindings.get(local);
    }
  }

  if (!exported || metaValue?.type !== 'ObjectExpression') return null;

  const props = new Map<string, AstNode | undefined>();
  for (const property of nodes(metaValue, 'properties')) {
    // A spread or a computed key means the object is not statically readable, and
    // Gate 1 rejects it for exactly that reason ("it has to be statically
    // readable"). Reading the surviving keys anyway would put a name on screen for
    // a file whose real `meta` could be something else.
    if (property.type === 'SpreadElement' || property['computed'] === true) return null;
    if (property.type !== 'Property') continue;
    const key = keyOf(field(property, 'key'));
    if (key !== undefined) props.set(key, field(property, 'value'));
  }

  const name = stringOf(props.get('name'));
  const rationale = stringOf(props.get('rationale'));
  const version = numberOf(props.get('version'));
  if (name === undefined || name.length === 0 || rationale === undefined || version === undefined) return null;

  return { name, rationale, version };
}
