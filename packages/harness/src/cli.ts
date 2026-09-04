#!/usr/bin/env node
/**
 * `pnpm harness <path/to/strategy.js> [--gates 1,2] [--json]`
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
import { formatGateResult, type GateNumber } from './gates/types.ts';
import { DEFAULT_GATES, runGates } from './runGates.ts';

const USAGE = `Usage: pnpm harness <path/to/strategy.js> [options]

Options:
  --gates <list>   Comma-separated gate numbers to run. Default: ${DEFAULT_GATES.join(',')}
                   (Gates 3 and 4 are not implemented yet and always reject.)
  --states <n>     States for the Gate 2 fuzz. Default: 500
  --seed <n>       Seed for the Gate 2 fuzz. Default: 1592502478
  --json           Emit one JSON object instead of human-readable lines.
  -h, --help       Show this message.

Exit code is 0 when every requested gate passes, 1 when one rejects, 2 on a
usage or I/O error.`;

type Args = {
  file?: string;
  gates: GateNumber[];
  states?: number;
  seed?: number;
  json: boolean;
  help: boolean;
};

class UsageError extends Error {}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { gates: [...DEFAULT_GATES], json: false, help: false };
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

  const result = await runGates(source, {
    gates: args.gates,
    gate2: {
      ...(args.states === undefined ? {} : { states: args.states }),
      ...(args.seed === undefined ? {} : { seed: args.seed }),
    },
  });

  if (args.json) {
    io.out(`${JSON.stringify({ file: path, ...result }, null, 2)}\n`);
    return result.approved ? 0 : 1;
  }

  for (const gate of result.results) io.out(`${formatGateResult(gate)}\n`);
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
