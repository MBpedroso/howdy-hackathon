/**
 * `pnpm dev` — the Vite dev server and the Node API server, together, in one
 * terminal, killed by one Ctrl-C.
 *
 * Plain `.mjs` rather than TypeScript on purpose: it is the only file in the repo
 * outside a package, so no `tsconfig.json` includes it and calling it `.ts` would
 * claim a typecheck that never runs. It is 60 lines of `child_process` and it should
 * stay that way.
 *
 * No `concurrently` dependency, for two reasons. Spec AC 1 budgets two minutes for
 * `pnpm install && pnpm dev` on a fresh clone, and a dev-only dependency is a thing
 * that can be out of date in a lockfile at exactly the wrong moment. The second is
 * the signal handling below, which is the only actually interesting thing here and
 * which a runner would hide.
 *
 * ## Ctrl-C
 *
 * Both children are spawned `detached: true`, so each one leads its own process
 * group. That is deliberate: a child in *this* process group would receive the
 * terminal's SIGINT directly, at the same moment as this script's forwarded one, and
 * the API server treats a second signal as "stop waiting and exit now" (see
 * `packages/server/src/main.ts`). Detaching means each child is signalled exactly
 * once, by this script, and gets its graceful shutdown.
 *
 * The signal goes to the whole group (`kill(-pid)`) because `pnpm run` is a shell
 * that spawns node: signalling the pnpm process alone leaves a Vite or a server
 * still holding its port, which is the failure this file exists to prevent.
 */
import { spawn } from 'node:child_process';

/** Long enough for a graceful close, short enough that Ctrl-C feels like Ctrl-C. */
const KILL_AFTER_MS = 3000;

const TARGETS = [
  { name: 'server', filter: '@rematch/server', color: '\u001b[36m' },
  { name: 'web', filter: '@rematch/web', color: '\u001b[35m' },
];

const dim = '\u001b[2m';
const reset = '\u001b[0m';
const useColor = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
const paint = (color, text) => (useColor ? `${color}${text}${reset}` : text);

let shuttingDown = false;
const children = [];

for (const target of TARGETS) {
  const child = spawn('pnpm', ['--filter', target.filter, 'dev'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    // See the header: its own process group, so this script is the only signaller.
    detached: true,
    env: process.env,
  });
  children.push({ ...target, child });

  const label = paint(target.color, `[${target.name}]`);
  // Prefix every line so two servers in one terminal are still readable. Buffered
  // per chunk, not per line: a partial line is printed when it arrives rather than
  // held back, because Vite prints its URL without a trailing newline.
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      const text = chunk.replace(/\n(?!$)/g, `\n${label} `);
      process.stdout.write(`${label} ${text}`);
    });
  }

  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.log(`${label} exited (${signal ?? code}) — stopping the other`);
    shutdown('SIGTERM', typeof code === 'number' ? code : 1);
  });
}

console.log(
  paint(dim, 'pnpm dev — web on http://127.0.0.1:5173, api on http://127.0.0.1:8787 (Ctrl-C stops both)'),
);

/** Signal both groups once, then hard-kill anything still alive. */
function shutdown(signal, exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of children) {
    // The group, not the process: `pnpm run` is a shell around the real server.
    try {
      process.kill(-child.pid, signal);
    } catch {
      // Already gone, or never started. Either way there is nothing to signal.
    }
  }
  const timer = setTimeout(() => {
    for (const { child } of children) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    process.exit(exitCode);
  }, KILL_AFTER_MS);
  timer.unref();

  void Promise.all(
    children.map(({ child }) => (child.exitCode === null ? new Promise((r) => child.once('exit', r)) : null)),
  ).then(() => process.exit(exitCode));
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(signal, 0));
}
