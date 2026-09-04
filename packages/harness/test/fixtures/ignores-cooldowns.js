// Rejected by Gate 2: always bursts, never reads view.boss.cooldowns. Legal —
// the engine coerces an on-cooldown action to idle — but the resulting boss
// stands still for most of the fight, which reads as broken to the player.
export const meta = {
  name: 'Trigger Happy',
  rationale: 'I burst every single tick and never look at my cooldowns.',
  version: 1,
};

export function init() {
  return {};
}

export function decide(view, mem) {
  const dx = view.player.x - view.boss.x;
  const dy = view.player.y - view.boss.y;
  return { type: 'burst', angle: Math.atan2(dy, dx), count: 8 };
}
