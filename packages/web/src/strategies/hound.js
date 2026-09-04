// Alternate boss, reachable in dev/e2e only via `?strategy=hound`.
//
// Byte-identical to `@rematch/contract`'s `chaser` fixture. It is not the Round 1
// boss (it wins 60% against the scripted player -- too hard for a first try, spec
// AC 4), but it is the only shipped strategy that spends `charge`, so it is how the
// charge telegraph gets exercised by hand and screenshotted by the e2e suite.
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
