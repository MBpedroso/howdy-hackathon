/**
 * A minimal line-level unified diff.
 *
 * The *server* produces the diff the player sees in a real run — the loop calls
 * `createTwoFilesPatch` from the `diff` package and ships the result in
 * `rewrite.done` (see `packages/agents/src/loop.ts`). The interlude only ever
 * renders that string, so this file is not on the live path.
 *
 * It exists for the mock source: a canned "attempt 1 was too aggressive, attempt 2
 * pulled it back" needs a diff between two *real* strategy files, and hand-writing
 * hunk headers is the kind of thing that is wrong in a demo. 70 lines of LCS is
 * cheaper than adding a dependency to the browser bundle for a mock, and the output
 * is byte-compatible with what the server sends (same `---/+++/@@` shape, same
 * three lines of context), so the renderer is exercised by both.
 */

export type UnifiedDiffOptions = {
  fromFile?: string;
  toFile?: string;
  /** Context lines around each change. `diff`'s default, and the loop's, is 3. */
  context?: number;
};

type Op = { kind: ' ' | '-' | '+'; text: string };

/**
 * Longest common subsequence of two line arrays, as an op script.
 *
 * O(n·m) in a Uint32Array. Strategy files are ~120 lines, so this is ~15k cells —
 * far cheaper than the 100 ms of typewriter it feeds.
 */
function opScript(before: readonly string[], after: readonly string[]): Op[] {
  const n = before.length;
  const m = after.length;
  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);

  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i * width + j] =
        before[i] === after[j]
          ? (lcs[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(lcs[(i + 1) * width + j] ?? 0, lcs[i * width + j + 1] ?? 0);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      ops.push({ kind: ' ', text: before[i] ?? '' });
      i += 1;
      j += 1;
    } else if ((lcs[(i + 1) * width + j] ?? 0) >= (lcs[i * width + j + 1] ?? 0)) {
      ops.push({ kind: '-', text: before[i] ?? '' });
      i += 1;
    } else {
      ops.push({ kind: '+', text: after[j] ?? '' });
      j += 1;
    }
  }
  for (; i < n; i += 1) ops.push({ kind: '-', text: before[i] ?? '' });
  for (; j < m; j += 1) ops.push({ kind: '+', text: after[j] ?? '' });
  return ops;
}

/** Split into lines, ignoring one trailing newline (files end with one). */
function lines(text: string): string[] {
  const trimmed = text.replace(/\n$/, '');
  return trimmed === '' ? [] : trimmed.split('\n');
}

export function unifiedDiff(before: string, after: string, options: UnifiedDiffOptions = {}): string {
  const context = Math.max(0, options.context ?? 3);
  const from = options.fromFile ?? 'strategy.js (previous)';
  const to = options.toFile ?? 'strategy.js (next)';

  const ops = opScript(lines(before), lines(after));
  const changed = ops.some((op) => op.kind !== ' ');
  if (!changed) return '';

  // Group ops into hunks: every run of changes, padded by `context` equal lines,
  // merging two runs whose padding would overlap.
  const changeIdx = ops.map((op, k) => (op.kind === ' ' ? -1 : k)).filter((k) => k >= 0);
  const groups: Array<[number, number]> = [];
  for (const k of changeIdx) {
    const last = groups[groups.length - 1];
    if (last !== undefined && k - last[1] <= context * 2 + 1) last[1] = k;
    else groups.push([k, k]);
  }

  const out: string[] = [`--- ${from}`, `+++ ${to}`];
  let oldLine = 1;
  let newLine = 1;
  /** Line numbers at op index `k`, walked once with the groups. */
  const starts: Array<{ old: number; new: number }> = [];
  for (const op of ops) {
    starts.push({ old: oldLine, new: newLine });
    if (op.kind !== '+') oldLine += 1;
    if (op.kind !== '-') newLine += 1;
  }

  for (const [first, last] of groups) {
    const lo = Math.max(0, first - context);
    const hi = Math.min(ops.length - 1, last + context);
    const head = starts[lo] ?? { old: 1, new: 1 };

    let oldCount = 0;
    let newCount = 0;
    const body: string[] = [];
    for (let k = lo; k <= hi; k += 1) {
      const op = ops[k];
      if (op === undefined) continue;
      if (op.kind !== '+') oldCount += 1;
      if (op.kind !== '-') newCount += 1;
      body.push(`${op.kind}${op.text}`);
    }
    out.push(`@@ -${head.old},${oldCount} +${head.new},${newCount} @@`);
    out.push(...body);
  }

  return `${out.join('\n')}\n`;
}
