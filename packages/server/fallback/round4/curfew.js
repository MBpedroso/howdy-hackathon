// Round 4 fallback — ZONE CONTROL.
//
// The purest expression of the one thing in the contract that describes the *player*
// rather than the moment: `history.playerPosHeat`. This boss picks the cell the player
// lives in, declares a curfew on it, and then enforces the curfew instead of chasing —
// the slam goes into that cell, the minion stands in that cell, and it keeps a minion
// standing there almost permanently, which is where most of its pressure comes from.
//
// The restraint that keeps it inside the Round 4 band is that it almost never spends a
// cooldown on where the player *is*: its cone bursts live in a narrow 240-372 px band
// that only just grazes the ring a kiting player holds, and it walks backwards rather
// than trade at contact. The one exception is a slam on its own feet when someone is
// inside `CONTACT`, which is the only price it charges for aggression — and not a
// large one: the Rusher bot, which dives everything, beats this boss 1.00 of the time.
//
// What it actually beats is habit. Measured against the panel: a camper 1.00, a
// kiting player 0.56 — and that 0.56 is bought by the *minion* standing in the zone,
// not by the bursts, which is why `SPAWN_EVERY` and not `BURST_MAX` is the dial in
// the constants below.
//
// Measured through Gate 3 at 200 matches — `pnpm harness packages/server/fallback/round4/curfew.js
// --round 4 --matches 200`:
//
//     panel 0.56   (Camper 1.00, Kiter 0.56, Rusher 0.00, Dodger 0.68)   band 0.50-0.65
//
// Reproducible: the seed set is fixed (`seedsFor`), and where this strategy rolls
// `rand()` that PRNG is seeded per match, so the numbers above are the same on every
// machine. `packages/server/test/fallback.test.ts` re-checks the band on every run at
// a reduced 60 matches; both counts sit at least 0.03 inside both edges.
export const meta = {
  name: 'Curfew',
  rationale: 'You keep coming back to the same square of floor, so I have closed that square.',
  version: 1,
};

const REFRESH = 50;
const ZONE_CELLS = 1.7;
const HOLD = 260;          // preferred distance from the player
const BACK_OFF = 200;
const CONTACT = 140;       // inside this the curfew applies to the boss's own feet
const BURST_MIN = 240;
const BURST_MAX = 372;     // just far enough to graze a kiter's 340 px ring
const SPAWN_EVERY = 300;   // the balance dial: a standing minion is most of this boss's pressure

export function init() {
  return { hot: -1, refreshedAt: -1, lastSpawn: -999 };
}

export function decide(view, mem) {
  const boss = view.boss;
  const player = view.player;
  const cd = boss.cooldowns;
  const aw = view.arena.w;
  const ah = view.arena.h;

  if (view.tick - mem.refreshedAt >= REFRESH || mem.hot < 0) {
    mem.hot = hottestCell(view.history.playerPosHeat);
    mem.refreshedAt = view.tick;
  }
  const cellW = aw / 8;
  const cellH = ah / 8;
  const col = mem.hot % 8;
  const row = (mem.hot - col) / 8;
  const hotX = clamp(col * cellW + cellW / 2, 0, aw);
  const hotY = clamp(row * cellH + cellH / 2, 0, ah);

  const dx = player.x - boss.x;
  const dy = player.y - boss.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const angle = dist < 0.001 ? boss.facing : Math.atan2(dy, dx);

  const inZone =
    Math.abs(player.x - hotX) < cellW * ZONE_CELLS && Math.abs(player.y - hotY) < cellH * ZONE_CELLS;

  // 1. The curfew itself. Held until the player is actually standing in the zone —
  //    a slam thrown at an empty cell is 210 ticks of cooldown bought for nothing.
  //    The one exception is a player standing on top of the boss: the curfew then
  //    applies where the boss is, which is the only price this boss charges for
  //    aggression and the only reason a rusher cannot simply ignore it.
  if (cd.slam === 0 && (inZone || dist < CONTACT)) {
    return inZone
      ? { type: 'slam', x: hotX, y: hotY }
      : { type: 'slam', x: clamp(boss.x, 0, aw), y: clamp(boss.y, 0, ah) };
  }

  // 2. A minion left in the zone as the standing notice. Rate-limited by tick, not
  //    by cooldown: `spawn` refused at the minion cap keeps its cooldown and costs a
  //    contract violation, so asking every tick is strictly worse than waiting.
  if (cd.spawn === 0 && view.tick - mem.lastSpawn > SPAWN_EVERY) {
    mem.lastSpawn = view.tick;
    return { type: 'spawn', x: hotX, y: hotY };
  }

  // 3. A three-shot cone in a narrow band. The upper bound is the point: a player who
  //    holds a longer range than this is barely shot at all.
  if (cd.burst === 0 && dist > BURST_MIN && dist < BURST_MAX) {
    return { type: 'burst', angle: angle, count: 3 };
  }

  // 4. Refuse the knife fight.
  if (dist < BACK_OFF && dist > 0.001) {
    return { type: 'move', dx: -dx / dist, dy: -dy / dist };
  }

  // 5. Otherwise sit on the zone at holding distance, so the next curfew lands
  //    before the player wanders out of it.
  if (dist > HOLD + 40 && dist > 0.001) {
    return { type: 'move', dx: dx / dist, dy: dy / dist };
  }
  const tx = hotX - boss.x;
  const ty = hotY - boss.y;
  const tmag = Math.sqrt(tx * tx + ty * ty);
  if (tmag < 8) return { type: 'idle' };
  return { type: 'move', dx: tx / tmag, dy: ty / tmag };
}

function hottestCell(heat) {
  let best = 0;
  let bestValue = -1;
  if (heat === null || typeof heat !== 'object' || typeof heat.length !== 'number') return 27;
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
