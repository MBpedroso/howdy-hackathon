#!/usr/bin/env node
/**
 * `pnpm harness <path/to/strategy.js> [--gates 1,2] [--round 2] [--json]`
 *
 * The harness's human face. One line per gate, exit code 1 on rejection — so it
 * works as a pre-commit check, in CI, and as the thing you run by hand when a
 * generated strategy is misbehaving.
 *
 * Runs under plain `node --experimental-strip-types`: no build step, and the
 * workspace's TypeScript sources resolve directly (see the root README).
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ReplaySummary } from '@rematch/engine';
import { ACTIVITY, BALANCE_ROUNDS, DEFAULT_MATCHES, type BalanceRound } from './gates/balanceConfig.ts';
import { formatGateResult, type GateNumber, type GateResult } from './gates/types.ts';
import { DEFAULT_GATES, runGates, type RunGatesOptions } from './runGates.ts';

const USAGE = `Usage: pnpm harness <path/to/strategy.js> [options]

Options:
  --gates <list>   Comma-separated gate numbers to run.
                   Default: ${DEFAULT_GATES.join(',')}, or 1,2,3,4 when --round is given.
  --round <n>      Fairness band to check in Gate 3 (${BALANCE_ROUNDS.join('|')}); enables gates 3 and 4.
  --summary <path> A replay summary (JSON) to build the Mimic from. Without it,
                   Gate 3 checks FAIR only and skips the ADAPTED assertion.
  --matches <n>    Matches for Gate 3. Default: ${DEFAULT_MATCHES} (half vs Mimic, half vs panel).
  --workers <n>    Worker threads for the simulation. Default: cores - 1.
  --states <n>     States for the Gate 2 fuzz. Default: 500
  --seed <n>       Seed for the Gate 2 fuzz. Default: 1592502478
  --json           Emit one JSON object instead of human-readable lines.
  -h, --help       Show this message.

Exit code is 0 when every requested gate passes, 1 when one rejects, 2 on a
usage or I/O error.`;

type Args = {
  file?: string;
  /** Undefined means "whatever the round implies" — see `gatesFor`. */
  gates?: GateNumber[];
  round?: BalanceRound;
  summary?: string;
  matches?: number;
  workers?: number;
  states?: number;
  seed?: number;
  json: boolean;
  help: boolean;
};

class UsageError extends Error {}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new UsageError(`${arg} needs a value`);
      return value;
    };
    switch (arg) {
      case '-h':
      case '--help':
        args.help = true;
        break;
      case '--json':
        args.json = true;
        break;
      case '--gates': {
        const gates = next()
          .split(',')
          .map((part) => Number(part.trim()));
        for (const gate of gates) {
          if (gate !== 1 && gate !== 2 && gate !== 3 && gate !== 4) {
            throw new UsageError(`--gates: '${gate}' is not a gate number (1-4)`);
          }
        }
        args.gates = gates as GateNumber[];
        break;
      }
      case '--round': {
        const round = Number(next());
        if (round !== 2 && round !== 3 && round !== 4 && round !== 5) {
          throw new UsageError(`--round: '${round}' is not a round with a fairness band (2-5)`);
        }
        args.round = round;
        break;
      }
      case '--summary':
        args.summary = next();
        break;
      case '--matches':
        args.matches = Number(next());
        break;
      case '--workers':
        args.workers = Number(next());
        break;
      case '--states':
        args.states = Number(next());
        break;
      case '--seed':
        args.seed = Number(next());
        break;
      case '--':
        // pnpm forwards the `--` separator from `pnpm --filter ... cli --` into
        // argv. Swallow it rather than reporting it as an unknown option.
        break;
      default:
        if (arg.startsWith('-')) throw new UsageError(`unknown option '${arg}'`);
        if (args.file !== undefined) throw new UsageError('only one strategy file at a time');
        args.file = arg;
    }
  }
  return args;
}

/**
 * Where the CLI writes. Injected rather than hard-wired to `process` so the
 * self-test can assert on the exact output without patching global streams (and
 * without printing usage errors into the test log).
 */
export type CliIo = {
  out: (text: string) => void;
  err: (text: string) => void;
};

const processIo: CliIo = {
  out: (text) => void process.stdout.write(text),
  err: (text) => void process.stderr.write(text),
};

/**
 * The one line of Gate 3 output worth printing even when it passed: the rates are
 * the whole reason the gate exists, and a `✓` alone hides them.
 *
 * The idle run is on it for the same reason: re-balancing a strategy by hand is
 * exactly when someone needs to see that the fix for the win rate did not
 * reintroduce a stall, and the ACTIVE limit is the number they are working against.
 */
function formatBalanceDetail(gate: GateResult): string | undefined {
  if (gate.gate !== 3 || gate.detail === null || typeof gate.detail !== 'object') return undefined;
  const detail = gate.detail as {
    panel?: { winRate: number; matches: number; perBot?: Array<{ name: string; winRate: number }> };
    mimic?: { winRate: number; matches: number };
    band?: readonly number[];
    activity?: { longestIdleRun: number; worstBot: string; idleFractionP90: number };
  };
  if (detail.panel === undefined) return undefined;
  const perBot = (detail.panel.perBot ?? []).map((b) => `${b.name} ${b.winRate.toFixed(2)}`).join(', ');
  const band = detail.band === undefined ? '' : ` band ${detail.band.map((v) => v.toFixed(2)).join('-')}`;
  const mimic = detail.mimic === undefined ? 'Mimic n/a' : `Mimic ${detail.mimic.winRate.toFixed(2)}`;
  const idle =
    detail.activity === undefined
      ? ''
      : ` · idle run ${detail.activity.longestIdleRun}t/${ACTIVITY.maxIdleRunTicks} (${detail.activity.worstBot}), p90 ${(detail.activity.idleFractionP90 * 100).toFixed(0)}%`;
  return `  panel ${detail.panel.winRate.toFixed(2)} (${perBot}) · ${mimic} ·${band}${idle}`;
}

export async function main(argv: readonly string[], io: CliIo = processIo): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    io.err(`${(err as Error).message}\n\n${USAGE}\n`);
    return 2;
  }

  if (args.help) {
    io.out(`${USAGE}\n`);
    return 0;
  }
  if (args.file === undefined) {
    io.err(`${USAGE}\n`);
    return 2;
  }

  // `pnpm --filter` runs the script with the *package* as cwd, so a path the
  // user typed at the repo root would not resolve. pnpm sets INIT_CWD to the
  // directory the command was actually invoked from; prefer it.
  const baseDir = process.env['INIT_CWD'] ?? process.cwd();
  const path = resolve(baseDir, args.file);
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (err) {
    io.err(`cannot read ${path}: ${(err as Error).message}\n`);
    return 2;
  }

  let mimicSummary: ReplaySummary | undefined;
  if (args.summary !== undefined) {
    const summaryPath = resolve(baseDir, args.summary);
    try {
      mimicSummary = JSON.parse(await readFile(summaryPath, 'utf8')) as ReplaySummary;
    } catch (err) {
      io.err(`cannot read the replay summary ${summaryPath}: ${(err as Error).message}\n`);
      return 2;
    }
  }

  const options: RunGatesOptions = {
    ...(args.gates === undefined ? {} : { gates: args.gates }),
    gate2: {
      ...(args.states === undefined ? {} : { states: args.states }),
      ...(args.seed === undefined ? {} : { seed: args.seed }),
    },
    gate3: {
      ...(args.round === undefined ? {} : { round: args.round }),
      ...(mimicSummary === undefined ? {} : { mimicSummary }),
      ...(args.matches === undefined ? {} : { matches: args.matches }),
      ...(args.workers === undefined ? {} : { workers: args.workers }),
    },
  };

  const result = await runGates(source, options);

  if (args.json) {
    io.out(`${JSON.stringify({ file: path, ...result }, null, 2)}\n`);
    return result.approved ? 0 : 1;
  }

  for (const gate of result.results) {
    io.out(`${formatGateResult(gate)}\n`);
    const balance = formatBalanceDetail(gate);
    if (balance !== undefined) io.out(`${balance}\n`);
  }
  io.out(
    result.approved
      ? `\nAPPROVED — ${result.results.length} gate${result.results.length === 1 ? '' : 's'} passed\n`
      : `\nREJECTED at gate ${result.stoppedAt}\n`,
  );
  return result.approved ? 0 : 1;
}

// `import.meta.filename` is set for a file run directly; guard so importing this
// module from a test does not run the CLI.
if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
