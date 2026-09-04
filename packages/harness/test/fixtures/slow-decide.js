// Rejected by Gate 2 as a timeout: ~5 ms of arithmetic per tick, which is well
// over the 2 ms budget but is not an infinite loop. This is the case Gate 4's p99
// exists for; the sandbox's hard deadline catches it first.
export const meta = {
  name: 'Overthinker',
  rationale: 'I evaluate two million candidate positions before every move.',
  version: 1,
};

export function init() {
  return {};
}

export function decide(view, mem) {
  let best = 0;
  let bestScore = -1;
  for (let i = 0; i < 2000000; i = i + 1) {
    const angle = (i / 2000000) * Math.PI * 2;
    const x = view.boss.x + Math.cos(angle) * 100;
    const y = view.boss.y + Math.sin(angle) * 100;
    const score = Math.abs(x - view.player.x) + Math.abs(y - view.player.y);
    if (score > bestScore) {
      bestScore = score;
      best = angle;
    }
  }
  return { type: 'move', dx: Math.cos(best), dy: Math.sin(best) };
}
