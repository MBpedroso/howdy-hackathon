// Rejected by Gate 2: bursts with a NaN angle whenever the player is moving left.
// This is the archetypal first-draft bug — a plausible formula with an undefined
// case (acos of a value outside [-1, 1]) that only shows up on some states.
export const meta = {
  name: 'Nanburst',
  rationale: 'I aim with an arccosine and never check its domain.',
  version: 1,
};

export function init() {
  return { fired: 0 };
}

export function decide(view, mem) {
  const dx = view.player.x - view.boss.x;
  const dy = view.player.y - view.boss.y;
  if (view.boss.cooldowns.burst === 0) {
    mem.fired = mem.fired + 1;
    // acos of anything outside [-1, 1] is NaN, and dx/40 usually is.
    const angle = view.player.vx < 0 ? Math.acos(dx / 40) : Math.atan2(dy, dx);
    return { type: 'burst', angle: angle, count: 5 };
  }
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 1) {
    return { type: 'idle' };
  }
  return { type: 'move', dx: dx / dist, dy: dy / dist };
}
