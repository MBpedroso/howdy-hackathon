// Rejected by Gate 2 as a timeout: the exit condition is never reached because
// `step` is zero, so this searches forever. Gate 1 cannot see it (halting
// problem); the sandbox's 2 ms deadline can.
export const meta = {
  name: 'Seeker',
  rationale: 'I search for the perfect angle and never stop searching.',
  version: 1,
};

export function init() {
  return {};
}

export function decide(view, mem) {
  const target = Math.atan2(view.player.y - view.boss.y, view.player.x - view.boss.x);
  let angle = -10;
  const step = 0;
  while (angle < target) {
    angle = angle + step;
  }
  return { type: 'burst', angle: angle, count: 3 };
}
