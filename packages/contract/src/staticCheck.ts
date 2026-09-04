/**
 * Gate 1 — static check of a generated `strategy.js`, run BEFORE any code executes.
 *
 * This is a security boundary, not a lint. It parses the source with a real
 * ES-module parser (acorn) and walks the AST; it never decides anything from a
 * regex, because `Date . now ( )`, `Date.now()` and `globalThis['fe'+'tch']`
 * all defeat text matching and none of them defeat the AST.
 *
 * WHAT THIS GATE CANNOT DO
 * ------------------------
 * Halting problems are out of reach. `while (true) {}`, an accidental O(n!) loop,
 * or a 5 ms `decide` are all *undetectable here* and are deliberately left to the
 * runtime gates: Gate 2 (contract fuzz, which runs `decide` against thousands of
 * states inside QuickJS with a 2 ms deadline) and Gate 4 (perf, p99 budget).
 * Do not add loop heuristics here — false positives would reject good strategies
 * and the runtime gates already catch the real thing.
 *
 * Layering, so nothing is over-claimed:
 *   Gate 1 (this file) — no forbidden *names*, no imports, correct module shape.
 *   QuickJS sandbox    — no host bindings at all, 64 MB heap, seeded PRNG.
 *   Gate 2 / Gate 4    — anything that only shows up when the code runs.
 * A global we forget to denylist here is still unreachable: the sandbox has no
 * host objects to reach. This gate exists so rejection is fast, cheap and legible
 * to the Coder agent, and so a `Date`-using strategy never even boots.
 */

import { parse } from 'acorn';
import { CONSTANTS } from './types.ts';

export type Violation = {
  /** Stable machine-readable rule id; fed back to the Coder agent verbatim. */
  rule: StaticRule;
  message: string;
  line?: number;
};

export type StaticCheckResult = { ok: true } | { ok: false; violations: Violation[] };

export const STATIC_RULES = [
  'input',
  'size',
  'syntax',
  'import',
  'dynamic-import',
  'export',
  'meta',
  'init',
  'decide',
  'forbidden-identifier',
  'forbidden-computed',
  'math-random',
  'with',
  'new-function',
  'this',
  'debugger',
] as const;
export type StaticRule = (typeof STATIC_RULES)[number];

/** The only names a `strategy.js` may export. */
export const ALLOWED_EXPORTS = ['meta', 'init', 'decide'] as const;

/**
 * Names a strategy may not mention, at all, anywhere — including as a local
 * binding. Shadowing (`const Function = 1`) is rejected too: it is never
 * necessary, and allowing it would mean tracking scopes to tell a shadow from a
 * global. Cheap and strict beats clever here.
 */
export const FORBIDDEN_IDENTIFIERS: ReadonlySet<string> = new Set([
  // Explicitly enumerated by the contract (spec §4.4).
  'Date',
  'fetch',
  'XMLHttpRequest',
  'globalThis',
  'window',
  'self',
  'global',
  'process',
  'require',
  'eval',
  'Function',
  'setTimeout',
  'setInterval',
  'setImmediate',
  'queueMicrotask',
  'Promise',
  'WeakRef',
  'FinalizationRegistry',
  'Proxy',
  'Reflect',
  'Atomics',
  'SharedArrayBuffer',
  'WebAssembly',
  'Intl',
  'console',
  // Denylist superset: same class of capability, no legitimate use in a strategy.
  'document',
  'navigator',
  'location',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'crypto',
  'performance',
  'structuredClone',
  'Worker',
  'SharedWorker',
  'MessageChannel',
  'Buffer',
  'module',
  'exports',
  '__dirname',
  '__filename',
  'Deno',
  'Bun',
  'importScripts',
  'Atomics',
]);

type AstNode = { type: string } & Record<string, unknown>;

const SKIP_KEYS = new Set(['type', 'start', 'end', 'loc', 'range', 'regex', 'sourceFile']);

const FUNCTION_VALUE_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

function isNode(v: unknown): v is AstNode {
  return typeof v === 'object' && v !== null && typeof (v as { type?: unknown }).type === 'string';
}

function nodeField(n: AstNode | undefined, key: string): AstNode | undefined {
  if (!n) return undefined;
  const v = n[key];
  return isNode(v) ? v : undefined;
}

function arrayField(n: AstNode | undefined, key: string): AstNode[] {
  if (!n) return [];
  const v = n[key];
  return Array.isArray(v) ? v.filter(isNode) : [];
}

function nameOf(n: AstNode | undefined): string | undefined {
  if (!n || n.type !== 'Identifier') return undefined;
  const v = n['name'];
  return typeof v === 'string' ? v : undefined;
}

function lineOf(n: AstNode | undefined): number | undefined {
  const loc = n?.['loc'];
  if (!isPlainObject(loc)) return undefined;
  const start = loc['start'];
  if (!isPlainObject(start)) return undefined;
  const line = start['line'];
  return typeof line === 'number' ? line : undefined;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * acorn hangs a `loc: { line, column }` off its SyntaxError (flat, unlike an AST
 * node's `loc.start`), so the Coder agent can be told which line failed to parse.
 */
function parseErrorLine(err: unknown): number | undefined {
  if (!isPlainObject(err)) return undefined;
  const loc = err['loc'];
  if (isPlainObject(loc) && typeof loc['line'] === 'number') return loc['line'];
  return undefined;
}

/**
 * Resolve a node to a string constant when — and only when — it is statically
 * determinable. Covers `'fetch'`, `` `fetch` ``, `'fe' + 'tch'` and nestings of
 * those. Anything depending on runtime values returns `undefined`, which is why
 * ordinary array indexing (`heat[i]`) is not flagged.
 */
function staticString(n: AstNode | undefined): string | undefined {
  if (!n) return undefined;
  switch (n.type) {
    case 'Literal': {
      const v = n['value'];
      if (typeof v === 'string') return v;
      if (typeof v === 'number' || typeof v === 'boolean') return String(v);
      return undefined;
    }
    case 'TemplateLiteral': {
      const quasis = arrayField(n, 'quasis');
      const expressions = arrayField(n, 'expressions');
      let out = '';
      for (let i = 0; i < quasis.length; i += 1) {
        const raw = quasis[i]?.['value'];
        const cooked = isPlainObject(raw) ? raw['cooked'] : undefined;
        if (typeof cooked !== 'string') return undefined;
        out += cooked;
        if (i < expressions.length) {
          const part = staticString(expressions[i]);
          if (part === undefined) return undefined;
          out += part;
        }
      }
      return out;
    }
    case 'BinaryExpression': {
      if (n['operator'] !== '+') return undefined;
      const left = staticString(nodeField(n, 'left'));
      const right = staticString(nodeField(n, 'right'));
      return left === undefined || right === undefined ? undefined : left + right;
    }
    default:
      return undefined;
  }
}

type Visit = (node: AstNode, parents: readonly AstNode[], key: string | undefined) => void;

function walk(node: AstNode, parents: readonly AstNode[], key: string | undefined, visit: Visit): void {
  visit(node, parents, key);
  const next = [...parents, node];
  for (const k of Object.keys(node)) {
    if (SKIP_KEYS.has(k)) continue;
    const v = node[k];
    if (Array.isArray(v)) {
      for (const c of v) if (isNode(c)) walk(c, next, k, visit);
    } else if (isNode(v)) {
      walk(v, next, k, visit);
    }
  }
}

/** True when an Identifier occurrence is a static property/label name, not a reference. */
function isNonReferenceIdentifier(parent: AstNode | undefined, key: string | undefined): boolean {
  if (!parent) return false;
  const computed = parent['computed'] === true;
  switch (parent.type) {
    case 'MemberExpression':
      return key === 'property' && !computed;
    case 'Property':
      return key === 'key' && !computed;
    case 'MethodDefinition':
    case 'PropertyDefinition':
      return key === 'key' && !computed;
    case 'LabeledStatement':
    case 'BreakStatement':
    case 'ContinueStatement':
      return key === 'label';
    case 'ExportSpecifier':
      return key === 'exported';
    case 'ImportSpecifier':
      return key === 'imported';
    default:
      return false;
  }
}

/**
 * Static check a candidate `strategy.js`.
 *
 * Returns `{ ok: true }` only when the source parses as an ES module, mentions no
 * forbidden name, imports nothing, exports exactly `meta` / `init` / `decide`, and
 * `meta` is a literal object with a usable `name`, `rationale` and `version`.
 *
 * Never throws. A parser crash becomes a `syntax` violation.
 */
export function staticCheck(source: string): StaticCheckResult {
  const violations: Violation[] = [];
  const add = (rule: StaticRule, message: string, node?: AstNode): void => {
    const line = lineOf(node);
    violations.push(line === undefined ? { rule, message } : { rule, message, line });
  };

  if (typeof source !== 'string') {
    return { ok: false, violations: [{ rule: 'input', message: 'source must be a string' }] };
  }

  const bytes = new TextEncoder().encode(source).length;
  if (bytes > CONSTANTS.limits.sourceBytes) {
    // Do not parse an oversized blob; rejecting on size is the whole point.
    return {
      ok: false,
      violations: [
        {
          rule: 'size',
          message: `source is ${bytes} bytes; limit is ${CONSTANTS.limits.sourceBytes} bytes`,
        },
      ],
    };
  }

  let program: AstNode;
  try {
    program = parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      locations: true,
      allowReserved: false,
      allowAwaitOutsideFunction: false,
      allowReturnOutsideFunction: false,
      allowSuperOutsideMethod: false,
      allowHashBang: false,
    }) as unknown as AstNode;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const line = parseErrorLine(err);
    // `with` is a SyntaxError in an ES module (modules are always strict), so it
    // never reaches the AST walk. Re-label the parser's OWN diagnostic — not the
    // source text — so the Coder agent gets the actionable rule instead of a
    // generic parse failure.
    const rule: StaticRule = /'with' in strict mode/.test(message) ? 'with' : 'syntax';
    return {
      ok: false,
      violations: [line === undefined ? { rule, message } : { rule, message, line }],
    };
  }

  walk(program, [], undefined, (node, parents, key) => {
    const parent = parents[parents.length - 1];

    switch (node.type) {
      case 'ImportDeclaration': {
        const from = staticString(nodeField(node, 'source'));
        add('import', `imports are not allowed${from === undefined ? '' : ` (found 'import ... from ${JSON.stringify(from)}')`}`, node);
        return;
      }
      case 'ImportExpression': {
        add('dynamic-import', 'dynamic import() is not allowed', node);
        return;
      }
      case 'ExportAllDeclaration': {
        add('export', 'export * is not allowed', node);
        return;
      }
      case 'ExportDefaultDeclaration': {
        add('export', `default export is not allowed; export only ${ALLOWED_EXPORTS.join(', ')}`, node);
        return;
      }
      case 'MetaProperty': {
        add('forbidden-identifier', 'import.meta is not allowed', node);
        return;
      }
      case 'WithStatement': {
        add('with', 'with statements are not allowed', node);
        return;
      }
      case 'DebuggerStatement': {
        add('debugger', 'debugger statements are not allowed', node);
        return;
      }
      case 'ThisExpression': {
        const insideFunction = parents.some(
          (p) => p.type === 'FunctionDeclaration' || p.type === 'FunctionExpression',
        );
        if (!insideFunction) {
          add('this', "`this` at module top level is not allowed (it is not the global object here)", node);
        }
        return;
      }
      case 'NewExpression': {
        const callee = nameOf(nodeField(node, 'callee'));
        if (callee === 'Function') add('new-function', 'new Function(...) is not allowed', node);
        return;
      }
      case 'MemberExpression': {
        const object = nodeField(node, 'object');
        const rootName = nameOf(object);
        const computed = node['computed'] === true;
        const property = nodeField(node, 'property');

        if (rootName !== undefined && FORBIDDEN_IDENTIFIERS.has(rootName) && computed) {
          add(
            'forbidden-computed',
            `computed member access on forbidden global '${rootName}' is not allowed`,
            node,
          );
        }

        if (computed) {
          const resolved = staticString(property);
          if (resolved !== undefined) {
            if (FORBIDDEN_IDENTIFIERS.has(resolved)) {
              add(
                'forbidden-computed',
                `computed access resolves to forbidden name '${resolved}'`,
                node,
              );
            }
            if (rootName === 'Math' && resolved === 'random') {
              add('math-random', 'Math.random is not allowed; use the seeded PRNG the engine injects', node);
            }
          }
        } else if (rootName === 'Math' && nameOf(property) === 'random') {
          add('math-random', 'Math.random is not allowed; use the seeded PRNG the engine injects', node);
        }
        return;
      }
      case 'Identifier': {
        if (isNonReferenceIdentifier(parent, key)) return;
        const name = nameOf(node);
        if (name !== undefined && FORBIDDEN_IDENTIFIERS.has(name)) {
          add('forbidden-identifier', `forbidden identifier '${name}'`, node);
        }
        return;
      }
      default:
        return;
    }
  });

  checkModuleShape(program, add);

  if (violations.length === 0) return { ok: true };
  return { ok: false, violations: dedupe(violations) };
}

type Add = (rule: StaticRule, message: string, node?: AstNode) => void;

/** name -> the node that produces its value (function declaration, or initializer). */
function collectTopLevelBindings(program: AstNode): Map<string, AstNode | undefined> {
  const bindings = new Map<string, AstNode | undefined>();
  const record = (stmt: AstNode): void => {
    switch (stmt.type) {
      case 'FunctionDeclaration':
      case 'ClassDeclaration': {
        const name = nameOf(nodeField(stmt, 'id'));
        if (name !== undefined) bindings.set(name, stmt);
        return;
      }
      case 'VariableDeclaration': {
        for (const d of arrayField(stmt, 'declarations')) {
          const name = nameOf(nodeField(d, 'id'));
          if (name !== undefined) bindings.set(name, nodeField(d, 'init'));
        }
        return;
      }
      default:
        return;
    }
  };

  for (const stmt of arrayField(program, 'body')) {
    if (stmt.type === 'ExportNamedDeclaration') {
      const decl = nodeField(stmt, 'declaration');
      if (decl) record(decl);
    } else {
      record(stmt);
    }
  }
  return bindings;
}

function checkModuleShape(program: AstNode, add: Add): void {
  const bindings = collectTopLevelBindings(program);
  /** exported name -> value node (undefined when unresolvable). */
  const exported = new Map<string, { value: AstNode | undefined; at: AstNode }>();

  for (const stmt of arrayField(program, 'body')) {
    if (stmt.type !== 'ExportNamedDeclaration') continue;

    if (nodeField(stmt, 'source')) {
      add('import', 're-export from another module is not allowed', stmt);
      continue;
    }

    const decl = nodeField(stmt, 'declaration');
    if (decl) {
      if (decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') {
        const name = nameOf(nodeField(decl, 'id'));
        if (name !== undefined) exported.set(name, { value: decl, at: decl });
      } else if (decl.type === 'VariableDeclaration') {
        for (const d of arrayField(decl, 'declarations')) {
          const id = nodeField(d, 'id');
          const name = nameOf(id);
          if (name === undefined) {
            add('export', 'destructuring exports are not allowed', d);
            continue;
          }
          exported.set(name, { value: nodeField(d, 'init'), at: d });
        }
      }
      continue;
    }

    for (const spec of arrayField(stmt, 'specifiers')) {
      const exportedNode = nodeField(spec, 'exported');
      const name = nameOf(exportedNode) ?? staticString(exportedNode);
      if (name === undefined) {
        add('export', 'unresolvable export name', spec);
        continue;
      }
      const localName = nameOf(nodeField(spec, 'local'));
      const value = localName === undefined ? undefined : bindings.get(localName);
      exported.set(name, { value, at: spec });
    }
  }

  for (const [name, entry] of exported) {
    if (!(ALLOWED_EXPORTS as readonly string[]).includes(name)) {
      add(
        'export',
        `unexpected export '${name}'; only ${ALLOWED_EXPORTS.join(', ')} may be exported`,
        entry.at,
      );
    }
  }

  const meta = exported.get('meta');
  if (!meta) {
    add('meta', "missing required export 'meta'");
  } else {
    checkMeta(meta.value, meta.at, add);
  }

  for (const fnName of ['init', 'decide'] as const) {
    const entry = exported.get(fnName);
    if (!entry) {
      add(fnName, `missing required export '${fnName}'`);
      continue;
    }
    const value = entry.value;
    if (!value || !FUNCTION_VALUE_TYPES.has(value.type)) {
      add(fnName, `'${fnName}' must be exported as a function`, entry.at);
      continue;
    }
    if (value['async'] === true) add(fnName, `'${fnName}' must not be async`, value);
    if (value['generator'] === true) add(fnName, `'${fnName}' must not be a generator`, value);
  }
}

function checkMeta(value: AstNode | undefined, at: AstNode, add: Add): void {
  if (!value || value.type !== 'ObjectExpression') {
    add('meta', "'meta' must be exported as an object literal", value ?? at);
    return;
  }

  const props = new Map<string, AstNode | undefined>();
  for (const p of arrayField(value, 'properties')) {
    if (p.type === 'SpreadElement') {
      add('meta', "'meta' must not use spread; it has to be statically readable", p);
      continue;
    }
    if (p['computed'] === true) {
      add('meta', "'meta' keys must be plain identifiers or string literals", p);
      continue;
    }
    const keyNode = nodeField(p, 'key');
    const key = nameOf(keyNode) ?? staticString(keyNode);
    if (key === undefined) continue;
    props.set(key, nodeField(p, 'value'));
  }

  const name = props.get('name');
  const nameLiteral = staticStringLiteral(name);
  if (nameLiteral === undefined) {
    add('meta', "'meta.name' must be a string literal", name ?? value);
  } else if (nameLiteral.length === 0) {
    add('meta', "'meta.name' must not be empty", name ?? value);
  } else if (nameLiteral.length > CONSTANTS.limits.metaNameMaxChars) {
    add(
      'meta',
      `'meta.name' is ${nameLiteral.length} characters; limit is ${CONSTANTS.limits.metaNameMaxChars}`,
      name ?? value,
    );
  }

  const rationale = props.get('rationale');
  const rationaleLiteral = staticStringLiteral(rationale);
  if (rationaleLiteral === undefined) {
    add('meta', "'meta.rationale' must be a string literal", rationale ?? value);
  } else if (rationaleLiteral.trim().length === 0) {
    add('meta', "'meta.rationale' must not be empty", rationale ?? value);
  }

  const version = props.get('version');
  if (!version || version.type !== 'Literal' || typeof version['value'] !== 'number') {
    add('meta', "'meta.version' must be a number literal", version ?? value);
  }
}

/** Like {@link staticString} but only accepts real string values (not stringified numbers). */
function staticStringLiteral(n: AstNode | undefined): string | undefined {
  if (!n) return undefined;
  if (n.type === 'Literal') return typeof n['value'] === 'string' ? n['value'] : undefined;
  if (n.type === 'TemplateLiteral' || n.type === 'BinaryExpression') return staticString(n);
  return undefined;
}

function dedupe(violations: readonly Violation[]): Violation[] {
  const seen = new Set<string>();
  const out: Violation[] = [];
  for (const v of violations) {
    const k = `${v.rule}|${v.line ?? ''}|${v.message}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out.sort((a, b) => (a.line ?? 0) - (b.line ?? 0) || a.rule.localeCompare(b.rule));
}
