/**
 * Sandbox overhead benchmark. Not a test — run it with `pnpm --filter @rematch/sandbox bench`.
 *
 * The number that matters: microseconds per `decide` round trip through QuickJS.
 * The engine pays it 3600x per match and Gate 3 runs 200+ matches per verdict, so
 * `median us x 3600 x 200` is the floor on a single-threaded Gate 3.
 */
import { readFileSync } from 'node:fs';
import { createSandbox } from '../src/index.ts';
import type { BossView } from '@rematch/contract';

const source = readFileSync(
  new URL('../../contract/test/fixtures/strategies/good/chaser.js', import.meta.url),
  'utf8',
);

function makeView(tick: number, projectiles: number): BossView {
  return {
    tick,
    arena: { w: 800, h: 800 },
    boss: { x: 400, y: 400, hp: 100, facing: 0, cooldowns: { move: 0, burst: 0, charge: 0, slam: 0, spawn: 0 } },
    player: { x: 120, y: 640, hp: 100, vx: 1.5, vy: -0.5, isDashing: false, lastShotTick: tick - 7 },
    projectiles: Array.from({ length: projectiles }, (_, i) => ({
      x: i * 7, y: i * 11, vx: 1, vy: -1, owner: i % 2 === 0 ? ('boss' as const) : ('player' as const),
    })),
    history: {
      playerPosHeat: Array.from({ length: 64 }, (_, i) => (i % 8) / 8),
      playerDashDirs: [3, 1, 0, 0, 7, 2, 1, 0],
      playerShotsDuring: { move: 4, burst: 2, charge: 1, slam: 0, spawn: 0 },
    },
  };
}

const N = 10_000;
const sandbox = await createSandbox();

for (const projectiles of [0, 8, 30]) {
  const runner = sandbox.load(source);
  runner.init(0xc0ffee);
  const views = Array.from({ length: 120 }, (_, i) => makeView(i, projectiles));
  // warm up the JIT and the VM's shapes
  for (let i = 0; i < 2000; i++) runner.decide(views[i % views.length]!);

  const samples = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const view = views[i % views.length]!;
    const t0 = performance.now();
    const r = runner.decide(view);
    samples[i] = (performance.now() - t0) * 1000;
    if (!r.ok) throw new Error(`decide failed: ${JSON.stringify(r.failure)}`);
  }
  samples.sort();
  const at = (q: number) => samples[Math.min(N - 1, Math.floor(q * N))]!.toFixed(1);
  const mean = (samples.reduce((a, b) => a + b, 0) / N).toFixed(1);
  console.log(
    `projectiles=${String(projectiles).padStart(2)}  median ${at(0.5)}us  mean ${mean}us  ` +
      `p90 ${at(0.9)}us  p99 ${at(0.99)}us  max ${samples[N - 1]!.toFixed(1)}us  ` +
      `=> 3600 ticks ~ ${((Number(at(0.5)) * 3600) / 1000).toFixed(0)}ms/match`,
  );
  runner.dispose();
}
