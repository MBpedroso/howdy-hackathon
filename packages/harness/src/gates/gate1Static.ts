/**
 * Gate 1 — static check. A thin wrapper over `staticCheck` from
 * `@rematch/contract` whose only real job is turning a violation list into one
 * sentence the Coder agent can act on.
 *
 * It runs before anything executes and costs ~1 ms, which is why it is first:
 * a strategy that mentions `Date` never boots a QuickJS runtime.
 */
import { staticCheck, type Violation } from '@rematch/contract';
import { gateFail, gateOk, type GateResult } from './types.ts';

export type Gate1Options = {
  /** Injectable clock so gate timings are reproducible in tests. */
  now?: () => number;
  /** How many violations to name before summarising the rest. Default 3. */
  maxViolations?: number;
};

/** `line 4: forbidden identifier 'Date'` — the line number is the actionable half. */
function formatViolation(violation: Violation): string {
  const where = violation.line === undefined ? '' : `line ${violation.line}: `;
  return `${where}${violation.message}`;
}

export function gate1Static(source: string, opts: Gate1Options = {}): GateResult {
  const now = opts.now ?? (() => performance.now());
  const maxViolations = opts.maxViolations ?? 3;
  const started = now();

  const result = staticCheck(source);
  const ms = now() - started;

  if (result.ok) {
    return gateOk(1, ms, { violations: 0, sourceBytes: new TextEncoder().encode(source).length });
  }

  const shown = result.violations.slice(0, maxViolations).map(formatViolation);
  const hidden = result.violations.length - shown.length;
  const reason =
    shown.join('; ') + (hidden > 0 ? ` (and ${hidden} more violation${hidden === 1 ? '' : 's'})` : '');

  return gateFail(1, ms, reason, {
    violations: result.violations.length,
    rules: [...new Set(result.violations.map((v) => v.rule))],
    all: result.violations,
  });
}
