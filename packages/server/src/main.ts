/**
 * `pnpm dev:server` — the entry point.
 *
 * ```
 * node --experimental-strip-types --env-file-if-exists=.env src/main.ts
 * ```
 *
 * No dotenv dependency: Node's own `--env-file-if-exists` reads the repo-root `.env`
 * (`--if-exists` because a fresh clone has none, and spec AC 1 requires the game to
 * run without one — no key means fallback-only mode, not a crash).
 *
 * The boot log answers, in one place and before anyone plays, the two questions that
 * decide what the interlude will do: is there a credential, and did the fallback pool
 * load. Both are cheap to print and expensive to discover halfway through a demo.
 */
import { createServer, poolSummary } from './http.ts';
import { resolveDeadlineMs } from './handleRewrite.ts';
import { resolveArtifactDir } from './log.ts';
import { selection } from './providers.ts';
import { POOL_BYTES } from './fallback.ts';

const port = Number(process.env['PORT'] ?? 8787);
const host = process.env['HOST'] ?? '127.0.0.1';

const server = createServer();

server.listen(port, host, () => {
  const chosen = selection();
  console.log(
    [
      `@rematch/server listening on http://${host}:${port}`,
      `  agents:    ${
        chosen.vendor === null
          ? `FALLBACK-ONLY — ${chosen.reason}`
          : `live (${chosen.vendor}: analyst ${chosen.models?.analyst}, coder ${chosen.models?.coder}) — ${chosen.reason}`
      }`,
      `  deadline:  ${resolveDeadlineMs()} ms`,
      `  pool:      ${(POOL_BYTES / 1024).toFixed(1)} kB — ${poolSummary()}`,
      `  artifacts: ${resolveArtifactDir()}`,
      `  health:    http://${host}:${port}/api/health`,
    ].join('\n'),
  );
});

/**
 * Ctrl-C must actually stop.
 *
 * `pnpm dev` runs this next to Vite, so SIGINT arrives at both. `close()` stops
 * accepting and waits for in-flight responses — but an in-flight response here can
 * be a 40-second interlude, and a developer pressing Ctrl-C is not waiting 40
 * seconds. So open connections are destroyed after a short grace period, and a
 * second signal exits immediately.
 */
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (closing) {
      process.exit(130);
    }
    closing = true;
    console.log(`\n${signal} — closing`);
    server.close(() => process.exit(0));
    const grace = setTimeout(() => server.closeAllConnections(), 500);
    grace.unref();
  });
}
