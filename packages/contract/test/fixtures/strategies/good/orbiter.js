// Reference strategy: mid-range control. Holds a ring around the player, flips
// orbit direction periodically so a Kiter cannot settle, and slams where the
// player is heading rather than where they are.
export const meta = {
  name: 'Orbiter',
  rationale: 'I circle at knife-edge range and slam where you are going, not where you are.',
  version: 2,
};

const ORBIT_RADIUS = 240;
const SLAM_LEAD_TICKS = 34;
const FLIP_PERIOD = 420;

export function init() {
  return { spin: 1, ticks: 0, slams: 0 };
}

export function decide(view, mem) {
  mem.ticks = mem.ticks + 1;
  if (mem.ticks % FLIP_PERIOD === 0) {
    mem.spin = -mem.spin;
  }

  const boss = view.boss;
  const player = view.player;
  const dx = player.x - boss.x;
  const dy = player.y - boss.y;
  const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 0.0001);

  // Slam is our damage: aim at the extrapolated position so a moving player
  // walks into it. Telegraph is 40 ticks, so lead by a little less than that.
  if (boss.cooldowns.slam === 0) {
    mem.slams = mem.slams + 1;
    return {
      type: 'slam',
      x: clamp(player.x + player.vx * SLAM_LEAD_TICKS, 0, view.arena.w),
      y: clamp(player.y + player.vy * SLAM_LEAD_TICKS, 0, view.arena.h),
    };
  }

  // Burst along the orbit tangent so the spread crosses the player's path.
  if (boss.cooldowns.burst === 0 && dist < ORBIT_RADIUS * 1.4) {
    return { type: 'burst', angle: Math.atan2(dy, dx), count: 5 };
  }

  // Park a minion between the player and the arena centre to cut off retreats.
  if (boss.cooldowns.spawn === 0) {
    return {
      type: 'spawn',
      x: clamp((player.x + view.arena.w / 2) / 2, 0, view.arena.w),
      y: clamp((player.y + view.arena.h / 2) / 2, 0, view.arena.h),
    };
  }

  // Tangential component keeps us orbiting; radial component corrects the radius.
  const tangentX = (-dy / dist) * mem.spin;
  const tangentY = (dx / dist) * mem.spin;
  const radialSign = dist > ORBIT_RADIUS ? 1 : -1;
  const radialX = (dx / dist) * radialSign;
  const radialY = (dy / dist) * radialSign;

  const mx = tangentX * 0.85 + radialX * 0.55;
  const my = tangentY * 0.85 + radialY * 0.55;
  const mag = Math.sqrt(mx * mx + my * my);
  if (mag === 0) {
    return { type: 'idle' };
  }
  return { type: 'move', dx: mx / mag, dy: my / mag };
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
