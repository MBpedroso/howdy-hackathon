// Rejected by Gate 2: throws once the player reaches the left edge, because the
// "nearest wall" table has no entry for column 0.
export const meta = {
  name: 'Wallhugger',
  rationale: 'I punish wall-huggers, as long as they hug the right wall.',
  version: 1,
};

const WALL_PLAN = { 1: 'left', 2: 'mid', 3: 'right' };

export function init() {
  return { plans: 0 };
}

export function decide(view, mem) {
  if (view.player.x < 50) {
    // WALL_PLAN[0] is undefined, so reading .length off it throws.
    const plan = WALL_PLAN[0];
    mem.plans = plan.length;
  }
  const dx = view.player.x - view.boss.x;
  const dy = view.player.y - view.boss.y;
  if (view.boss.cooldowns.slam === 0) {
    return { type: 'slam', x: view.player.x, y: view.player.y };
  }
  const dist = Math.sqrt(dx * dx + dy * dy) || 1;
  return { type: 'move', dx: dx / dist, dy: dy / dist };
}
