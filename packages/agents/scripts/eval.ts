/**
 * `pnpm eval:agents` — the CLI over `runEval` (spec §7).
 *
 * **This is the only thing in the repo that spends money, and it now refuses to run
 * without explicit authorisation.** Two gates, in this order:
 *
 * 1. `REMATCH_ALLOW_SPEND=1` must be set (`scripts/spendGuard.ts`). Without it the
 *    script prints the worst-case model-call count for the flags it was given and
 *    exits 0. See that file for why "is there a key" was the wrong condition: on
 *    2026-09-03 eleven runs in one evening exhausted the account's credit, and every
 *    one of them was an ordinary `pnpm eval:agents`.
 * 2. A credential must be present, and `REMATCH_PROVIDER=none` counts as "no". With
 *    neither it says why it is skipping and exits 0, which is what keeps it safe to
 *    reference from CI next to `pnpm verify`.
 *
 * The credential and `REMATCH_PROVIDER` come from the repo-root `.env` via Node's
 * own `--env-file-if-exists` (see this package's `eval` script) — the same file
 * `pnpm dev:server` reads, so the eval and the demo cannot run different models.
 * `REMATCH_ALLOW_SPEND` is deliberately **not** something to put in `.env`: a
 * variable that has to be typed at the call site cannot be silently inherited.
 *
 * ```
 * pnpm eval:agents                            # prints the estimate and refuses
 * REMATCH_ALLOW_SPEND=1 pnpm eval:agents      # all 10 canned replays, round 2
 * REMATCH_ALLOW_SPEND=1 REMATCH_EVAL_MATCHES=60 pnpm eval:agents    # coarser Gate 3
 * REMATCH_ALLOW_SPEND=1 REMATCH_EVAL_ONLY=camper-a,kiter-b pnpm eval:agents
 * REMATCH_ALLOW_SPEND=1 REMATCH_PROVIDER=openai pnpm eval:agents
 * ```
 *
 * Everything the eval measures is also covered against a mock provider by
 * `pnpm --filter @rematch/agents test` — including this script's own aggregation,
 * which lives in `src/eval.ts` precisely so it can be tested. And a real run is
 * already recorded: `docs/evidence/eval-round2-2026-09-03.json`, replayable in the
 * browser with `?agent=recorded` and no key at all.
 */
import { fileURLToPath } from 'node:url';
import { DEFAULT_MATCHES } from '@rematch/harness';
import {
  DEADLINE_MS,
  EVAL_ROUND,
  MAX_ATTEMPTS,
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
import { estimateCalls, refusalMessage, spendAllowed } from './spendGuard.ts';

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
    '',
    'REMATCH_PROVIDER=none forces this path even with a key set — the documented',
    'setting for local development (see the root README env table).',
  ].join('\n');
}

/** `REMATCH_PROVIDER=none` — an off switch that leaves the credential in place. */
function providerDisabled(env: Record<string, string | undefined>): boolean {
  return (env['REMATCH_PROVIDER'] ?? '').trim().toLowerCase() === 'none';
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
  const names = selectCanned(process.env['REMATCH_EVAL_ONLY']);
  const matches = Math.max(8, Number(process.env['REMATCH_EVAL_MATCHES'] ?? DEFAULT_MATCHES));
  const deadlineMs = Number(process.env['REMATCH_EVAL_DEADLINE_MS'] ?? DEADLINE_MS);
  const candidates = resolveCandidates();
  const round = selectRound(process.argv.slice(2), process.env);
  const concurrency = Math.max(1, Number(process.env['REMATCH_EVAL_CONCURRENCY'] ?? 3) || 1);
  const workers = workersPerRun(concurrency);

  if (providerDisabled(process.env)) {
    console.log(skipMessage('REMATCH_PROVIDER=none'));
    return;
  }

  // The spend gate comes **before** `selectProvider`, so the refusal and its estimate
  // are what a developer sees whether or not a key happens to be present — the
  // decision being authorised is "spend money", and it should read the same either way.
  if (!spendAllowed(process.env)) {
    const chosen = selectProvider();
    console.log(
      refusalMessage(estimateCalls({ replays: names.length, attempts: MAX_ATTEMPTS, candidates }), {
        ...(chosen.vendor === null ? {} : { vendor: chosen.vendor }),
        ...(chosen.models === null ? {} : { model: chosen.models.coder }),
      }),
    );
    return;
  }

  const chosen = selectProvider();
  if (chosen.vendor === null || chosen.models === null) {
    console.log(skipMessage(chosen.reason));
    return;
  }

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
