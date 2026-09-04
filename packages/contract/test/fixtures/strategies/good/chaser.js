// Reference strategy: pure aggression. Walks straight at the player and spends
// every offensive cooldown the moment it is up. Loses to Kiter, beats Camper.
export const meta = {
  name: 'Hound',
  rationale: 'I walk straight at you and spend every cooldown the moment it is up.',
  version: 1,
};

export function init() {
  return { bursts: 0, charges: 0, lastActionTick: -1 };
}

export function decide(view, mem) {
  const boss = view.boss;
  const player = view.player;
  const dx = player.x - boss.x;
  const dy = player.y - boss.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const angle = Math.atan2(dy, dx);

  // Close range: shotgun burst. Wider spread the closer we are.
  if (boss.cooldowns.burst === 0 && dist < 340) {
    mem.bursts = mem.bursts + 1;
    mem.lastActionTick = view.tick;
    return { type: 'burst', angle: angle, count: dist < 150 ? 8 : 5 };
  }

  // Long range: charge to close the gap.
  if (boss.cooldowns.charge === 0 && dist > 260) {
    mem.charges = mem.charges + 1;
    mem.lastActionTick = view.tick;
    return { type: 'charge', angle: angle };
  }

  // Free minion whenever it is available; drop it on top of the player.
  if (boss.cooldowns.spawn === 0) {
    mem.lastActionTick = view.tick;
    return {
      type: 'spawn',
      x: clamp(player.x, 0, view.arena.w),
      y: clamp(player.y, 0, view.arena.h),
    };
  }

  if (dist < 1) {
    return { type: 'idle' };
  }
  return { type: 'move', dx: dx / dist, dy: dy / dist };
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
