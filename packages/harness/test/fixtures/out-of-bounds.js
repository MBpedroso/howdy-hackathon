// Rejected by Gate 2: slams at coordinates outside the arena on most states,
// because it extrapolates the player's velocity without clamping.
export const meta = {
  name: 'Overshoot',
  rationale: 'I slam where you will be in two seconds, wherever that is.',
  version: 1,
};

export function init() {
  return {};
}

export function decide(view, mem) {
  if (view.boss.cooldowns.slam === 0) {
    return { type: 'slam', x: view.player.x + view.player.vx * 400, y: view.player.y + view.player.vy * 400 };
  }
  return { type: 'idle' };
}
