/**
 * `pnpm eval:agents` — the CLI over `runEval` (spec §7).
 *
 * **Opt-in.** With no credential it says why it is skipping and exits 0, which is
 * what makes it safe to reference from CI next to `pnpm verify`: it is the only
 * thing in the repo that spends money.
 *
 * The credential and `REMATCH_PROVIDER` come from the repo-root `.env` via Node's
 * own `--env-file-if-exists` (see this package's `eval` script) — the same file
 * `pnpm dev:server` reads, so the eval and the demo cannot run different models.
 *
 * ```
 * pnpm eval:agents                            # all 10 canned replays, round 2
 * REMATCH_EVAL_MATCHES=60 pnpm eval:agents    # faster, less precise Gate 3
 * REMATCH_EVAL_ONLY=camper-a,kiter-b pnpm eval:agents
 * REMATCH_PROVIDER=openai pnpm eval:agents
 * REMATCH_CODER_MODEL=gpt-5.4 pnpm eval:agents
 * ```
 *
 * Everything the eval measures is also covered against a mock provider by
 * `pnpm --filter @rematch/agents test` — including this script's own aggregation,
 * which lives in `src/eval.ts` precisely so it can be tested.
 */
import { fileURLToPath } from 'node:url';
import { DEFAULT_MATCHES } from '@rematch/harness';
import {
  DEADLINE_MS,
  EVAL_ROUND,
  PASS_RATE_TARGET,
  formatEvalTable,
  resolveCandidates,
  runEval,
  selectCanned,
  selectProvider,
  workersPerRun,
  writeEvalArtifact,
} from '../src/index.ts';
import { BALANCE_ROUNDS, type BalanceRound } from '@rematch/harness';

function skipMessage(reason: string): string {
  return [
    `eval:agents — skipped: ${reason}.`,
    '',
    'This is the one suite that makes real API calls, so it is opt-in and never runs',
    'in `pnpm verify`. Everything it covers is also tested against a mock provider by',
    '`pnpm --filter @rematch/agents test`.',
    '',
    'Put one of these in the repo-root `.env` (the script reads it automatically):',
    '',
    '  OPENAI_API_KEY=...        # and optionally REMATCH_PROVIDER=openai',
    '  ANTHROPIC_API_KEY=...     # or ANTHROPIC_AUTH_TOKEN',
  ].join('\n');
}

/**
 * `--round 3` / `REMATCH_EVAL_ROUND=3`, else round 2.
 *
 * Round 2 is the round AC 7 is about and the one the pass-rate target is quoted
 * for, but a fix that only works on one band is not a fix — the bands widen with
 * the round — so the CLI takes the round as an argument and the report records it.
 */
export function selectRound(argv: readonly string[], env: Record<string, string | undefined>): BalanceRound {
  const flag = argv.indexOf('--round');
  const raw = flag >= 0 ? argv[flag + 1] : env['REMATCH_EVAL_ROUND'];
  const n = Number(raw);
  return (BALANCE_ROUNDS as readonly number[]).includes(n) ? (n as BalanceRound) : EVAL_ROUND;
}

async function main(): Promise<void> {
  const chosen = selectProvider();
  if (chosen.vendor === null || chosen.models === null) {
    console.log(skipMessage(chosen.reason));
    return;
  }

  const names = selectCanned(process.env['REMATCH_EVAL_ONLY']);
  const matches = Math.max(8, Number(process.env['REMATCH_EVAL_MATCHES'] ?? DEFAULT_MATCHES));
  const deadlineMs = Number(process.env['REMATCH_EVAL_DEADLINE_MS'] ?? DEADLINE_MS);
  const candidates = resolveCandidates();
  const round = selectRound(process.argv.slice(2), process.env);
  const concurrency = Math.max(1, Number(process.env['REMATCH_EVAL_CONCURRENCY'] ?? 3) || 1);
  const workers = workersPerRun(concurrency);

  console.log(
    `eval:agents — ${names.length} canned replays, round ${round}, ${matches} Gate 3 matches, ${(deadlineMs / 1000).toFixed(0)}s deadline\n` +
      `  provider ${chosen.vendor} (${chosen.reason})\n` +
      `  analyst ${chosen.models.analyst}   coder ${chosen.models.coder}\n` +
      `  ${candidates} candidate file(s) per attempt (REMATCH_CANDIDATES)\n` +
      `  ${concurrency} replay(s) at once, ${workers} Gate 3 worker(s) each (REMATCH_EVAL_CONCURRENCY)\n` +
      (concurrency > 1
        ? '  note: concurrent runs share the cores, so each run\'s Gate 3 is slower than it\n' +
          '        would be alone and the wall column is pessimistic. Use =1 to measure latency.\n'
        : ''),
  );

  const report = await runEval({
    names,
    matches,
    deadlineMs,
    round,
    candidates,
    concurrency,
    // Rebuilt per replay so usage and the SDK's per-client state are never shared
    // across runs — the wall-clock and token columns have to be per-run numbers.
    makeProviders: () => chosen.create(),
    onRun: (run) =>
      console.log(
        `  ${run.replay.padEnd(13)} ${run.approved ? '✓ APPROVED' : `✗ ${run.failureReason ?? 'failed'}`}` +
          ` after ${run.attempts} attempt(s) / ${run.candidatesEvaluated} candidate(s), ${(run.ms / 1000).toFixed(1)}s` +
          (run.gatesFailed.length > 0 ? `  [rejected by ${run.gatesFailed.join(', ')}]` : ''),
      ),
  });

  console.log(`\n${formatEvalTable(report)}`);

  const dir = fileURLToPath(new URL('../../../artifacts/agents/', import.meta.url));
  console.log(`\nfull event logs → ${writeEvalArtifact(report, dir)}`);

  if (report.passRate < PASS_RATE_TARGET) {
    console.error(
      `\npass rate ${(report.passRate * 100).toFixed(0)}% is below the ${(PASS_RATE_TARGET * 100).toFixed(0)}% target (spec §7)`,
    );
    process.exitCode = 1;
  }
}

await main();
