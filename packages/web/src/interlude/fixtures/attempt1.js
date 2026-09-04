// A first pass at a Round 2 boss against a player who camped a corner: put the
// pressure where the player is *going*, close the distance, and keep the burst up.
//
// It is written the way a first draft usually is — every idea turned up to maximum —
// which is what makes it a useful thing for the harness to reject: it loses nothing
// to a static check or a fuzz sweep, it is fast, and it is simply too strong. See
// the notes on each rule for what it costs.
export const meta = {
  name: 'Warden',
  rationale: 'I close the distance and keep you under fire until you stop shooting.',
  version: 1,
};

const HOLD_RANGE = 250;
const LEAD_TICKS = 30;
const SPAWN_EVERY = 240;

export function init() {
  return { hot: -1, refreshedAt: -1, lastSpawn: -999 };
}

export function decide(view, mem) {
  const boss = view.boss;
  const player = view.player;
  const cd = boss.cooldowns;

  const dx = player.x - boss.x;
  const dy = player.y - boss.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const angle = Math.atan2(dy, dx);

  // 1. Slam where the player is about to be: lead the velocity by half a second.
  if (cd.slam === 0) {
    return {
      type: 'slam',
      x: clamp(player.x + player.vx * LEAD_TICKS, 0, view.arena.w),
      y: clamp(player.y + player.vy * LEAD_TICKS, 0, view.arena.h),
    };
  }

  // 2. A minion on the player, as often as the cooldown allows.
  if (cd.spawn === 0 && view.tick - mem.lastSpawn > SPAWN_EVERY) {
    mem.lastSpawn = view.tick;
    return { type: 'spawn', x: clamp(player.x, 0, view.arena.w), y: clamp(player.y, 0, view.arena.h) };
  }

  // 3. A full ring whenever burst is up. No range floor: the player is always in it.
  if (cd.burst === 0) {
    return { type: 'burst', angle: angle, count: 8 };
  }

  // 4. Charge through the gap when there is one, then walk the player down.
  if (cd.charge === 0 && dist > HOLD_RANGE) {
    return { type: 'charge', angle: angle };
  }
  if (dist < 24) return { type: 'idle' };
  return { type: 'move', dx: dx / Math.max(dist, 0.001), dy: dy / Math.max(dist, 0.001) };
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
