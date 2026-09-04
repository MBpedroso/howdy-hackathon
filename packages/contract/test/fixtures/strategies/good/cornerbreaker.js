// Reference strategy: the counter-Camper. Reads history.playerPosHeat to find the
// cell the player lives in and puts pressure there, which is exactly the kind of
// adaptation the Coder agent is expected to produce.
export const meta = {
  name: 'Cornerbreaker',
  rationale: 'You always run to the same corner, so that is where I put the floor slam.',
  version: 1,
};

export function init() {
  return { targetCell: -1, refreshedAt: -1 };
}

export function decide(view, mem) {
  // Refresh the read of the heat map every second; it is a rolling summary.
  if (view.tick - mem.refreshedAt >= 60 || mem.targetCell < 0) {
    mem.targetCell = hottestCell(view.history.playerPosHeat);
    mem.refreshedAt = view.tick;
  }

  const cellW = view.arena.w / 8;
  const cellH = view.arena.h / 8;
  const col = mem.targetCell % 8;
  const row = (mem.targetCell - col) / 8;
  const hotX = clamp(col * cellW + cellW / 2, 0, view.arena.w);
  const hotY = clamp(row * cellH + cellH / 2, 0, view.arena.h);

  const boss = view.boss;
  if (boss.cooldowns.slam === 0) {
    return { type: 'slam', x: hotX, y: hotY };
  }
  if (boss.cooldowns.spawn === 0) {
    return { type: 'spawn', x: hotX, y: hotY };
  }

  const dx = view.player.x - boss.x;
  const dy = view.player.y - boss.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (boss.cooldowns.burst === 0 && dist < 300) {
    return { type: 'burst', angle: Math.atan2(dy, dx), count: 8 };
  }

  // Otherwise walk to the hot cell and camp the camper.
  const tx = hotX - boss.x;
  const ty = hotY - boss.y;
  const tmag = Math.sqrt(tx * tx + ty * ty);
  if (tmag < 4) {
    return { type: 'idle' };
  }
  return { type: 'move', dx: tx / tmag, dy: ty / tmag };
}

function hottestCell(heat) {
  let best = 0;
  let bestValue = -1;
  for (let i = 0; i < heat.length; i = i + 1) {
    const v = heat[i];
    if (typeof v === 'number' && v > bestValue) {
      bestValue = v;
      best = i;
    }
  }
  return best;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
