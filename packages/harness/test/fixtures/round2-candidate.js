// A hand-written Round 2 boss: the shape the Coder agent is expected to produce on
// its first rewrite, and proof that the fairness band is reachable by a strategy
// that also counters a camper (`test/balance.test.ts` measures both).
//
// The design idea is *where*, not *how much*. Every point of pressure goes to the
// cell the player lives in — read from `history.playerPosHeat`, which is the only
// thing in the contract that describes the human rather than the moment — while the
// boss itself holds mid range and never spends a cooldown at contact. That is what
// separates it from `chaser` (0.75 vs the panel, too hard) and `orbiter` (1.00):
// those two win by out-damaging anyone in the room, this one wins by being where
// the player is going to be, so a player who moves somewhere else beats it.
export const meta = {
  name: 'Warden',
  rationale: 'I hold the middle and put everything where you live, not where you are.',
  version: 1,
};

const HOLD_RANGE = 250;
const BURST_MIN_RANGE = 260;
const BURST_MAX_RANGE = 430;
const REFRESH_TICKS = 60;
const SPAWN_EVERY = 420;

export function init() {
  return { hot: -1, refreshedAt: -1, lastSpawn: -999 };
}

export function decide(view, mem) {
  const boss = view.boss;
  const player = view.player;
  const cd = boss.cooldowns;

  if (view.tick - mem.refreshedAt >= REFRESH_TICKS || mem.hot < 0) {
    mem.hot = hottestCell(view.history.playerPosHeat);
    mem.refreshedAt = view.tick;
  }
  const cellW = view.arena.w / 8;
  const cellH = view.arena.h / 8;
  const col = mem.hot % 8;
  const row = (mem.hot - col) / 8;
  const hotX = col * cellW + cellW / 2;
  const hotY = row * cellH + cellH / 2;

  const dx = player.x - boss.x;
  const dy = player.y - boss.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const angle = Math.atan2(dy, dx);

  // 1. The slam is the whole strategy, and it goes to the *habit*, never to the
  //    extrapolated position. Leading the player's velocity by 30 ticks lands on
  //    anyone walking a smooth path — a circling kiter included — which measured
  //    0.60 against the panel: too hard, and for the wrong reason. Aiming at the
  //    heat map instead means a player who changes where they stand is not hit,
  //    which is exactly the deal the fairness band is asking for.
  //    It is also *held* until the player is actually near the habit: the cooldown
  //    is only spent when the action lands, so saving it turns the slam from a
  //    metronome that eventually catches everyone into a punish for standing still.
  const nearHabit = Math.abs(player.x - hotX) < cellW * 1.6 && Math.abs(player.y - hotY) < cellH * 1.6;
  if (cd.slam === 0 && nearHabit) {
    return { type: 'slam', x: clamp(hotX, 0, view.arena.w), y: clamp(hotY, 0, view.arena.h) };
  }

  // 2. A minion parked on the habit, rate-limited: `spawn` keeps its cooldown when
  //    it is refused at the minion cap, so asking every tick would waste the tick.
  if (cd.spawn === 0 && view.tick - mem.lastSpawn > SPAWN_EVERY) {
    mem.lastSpawn = view.tick;
    return { type: 'spawn', x: clamp(hotX, 0, view.arena.w), y: clamp(hotY, 0, view.arena.h) };
  }

  // 3. Burst only at range, and only as an aimed cone. A ring of 8 at contact range
  //    is unanswerable and is what makes a boss "too hard" — see the burst note in
  //    the engine's constants. The 260 px floor is the whole difference between
  //    0.50 and 0.40 against the panel: bursting from 200 px meant a player holding
  //    a shooting distance was under fire permanently and never got to fire back.
  if (cd.burst === 0 && dist > BURST_MIN_RANGE && dist < BURST_MAX_RANGE) {
    return { type: 'burst', angle: angle, count: 3 };
  }

  // 4. Never chase. Walking at the player is what makes a boss "too hard": it
  //    keeps a kiter permanently inside burst range and eventually pins it against
  //    a wall, and it measured 0.70 against the panel. This boss holds the habit
  //    and lets the player come to it — but it does back off at contact range,
  //    where a rusher would otherwise farm it for free.
  if (dist < HOLD_RANGE - 60) {
    return { type: 'move', dx: -dx / Math.max(dist, 0.001), dy: -dy / Math.max(dist, 0.001) };
  }
  // Drift towards the habit so the next slam lands before the player leaves it.
  const tx = hotX - boss.x;
  const ty = hotY - boss.y;
  const tmag = Math.sqrt(tx * tx + ty * ty);
  if (tmag < 6) return { type: 'idle' };
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
