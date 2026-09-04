/**
 * `pnpm eval:agents` — the CLI over `runEval` (spec §7).
 *
 * **Opt-in.** With no credential it says why it is skipping and exits 0, which is
 * what makes it safe to reference from CI next to `pnpm verify`: it is the only
 * thing in the repo that spends money.
 *
 * ```
 * pnpm eval:agents                            # all 10 canned replays, round 2
 * REMATCH_EVAL_MATCHES=60 pnpm eval:agents    # faster, less precise Gate 3
 * REMATCH_EVAL_ONLY=camper-a,kiter-b pnpm eval:agents
 * REMATCH_CODER_MODEL=claude-opus-5 pnpm eval:agents
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
  PASS_RATE_TARGET,
  anthropicProvider,
  formatEvalTable,
  modelFor,
  runEval,
  selectCanned,
  writeEvalArtifact,
} from '../src/index.ts';

function credential(): string | undefined {
  const key = process.env['ANTHROPIC_API_KEY'] ?? process.env['ANTHROPIC_AUTH_TOKEN'];
  return key === undefined || key === '' ? undefined : key;
}

const SKIP_MESSAGE = [
  'eval:agents — skipped: no ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) in the environment.',
  '',
  'This is the one suite that makes real API calls, so it is opt-in and never runs',
  'in `pnpm verify`. Everything it covers is also tested against a mock provider by',
  '`pnpm --filter @rematch/agents test`.',
  '',
  '  export ANTHROPIC_API_KEY=sk-ant-...   # then: pnpm eval:agents',
  '',
  '(`ant auth status` reports whether a login profile exists; the eval still needs',
  'one of the two environment variables.)',
].join('\n');

async function main(): Promise<void> {
  if (credential() === undefined) {
    console.log(SKIP_MESSAGE);
    return;
  }

  const names = selectCanned(process.env['REMATCH_EVAL_ONLY']);
  const matches = Math.max(8, Number(process.env['REMATCH_EVAL_MATCHES'] ?? DEFAULT_MATCHES));
  const deadlineMs = Number(process.env['REMATCH_EVAL_DEADLINE_MS'] ?? DEADLINE_MS);

  console.log(
    `eval:agents — ${names.length} canned replays, round 2, ${matches} Gate 3 matches, ${(deadlineMs / 1000).toFixed(0)}s deadline\n` +
      `  analyst ${modelFor('analyst')}   coder ${modelFor('coder')}\n`,
  );

  const report = await runEval({
    names,
    matches,
    deadlineMs,
    makeProviders: () => ({
      analyst: anthropicProvider({ model: modelFor('analyst') }),
      coder: anthropicProvider({ model: modelFor('coder') }),
    }),
    onRun: (run) =>
      console.log(
        `  ${run.replay.padEnd(13)} ${run.approved ? '✓ APPROVED' : `✗ ${run.failureReason ?? 'failed'}`}` +
          ` after ${run.attempts} attempt(s), ${(run.ms / 1000).toFixed(1)}s` +
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
