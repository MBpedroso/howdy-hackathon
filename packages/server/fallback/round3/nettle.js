// Round 3 fallback — AMBUSH.
//
// A boss that throws nothing at all. Every cooldown is *held* while it stalks the
// player at walking pace, and the moment they come inside the trigger radius it
// spends all of them at once — a full ring burst on the spot plus a slam centred on
// its own feet. There is no poke, no zoning and no chase; there is one radius, and
// crossing it is the whole fight.
//
// That makes it a lesson rather than a difficulty setting: it eats aggression alive
// and it is completely helpless against distance, because nothing it does travels.
// Refuse the trade and it never lands a hit. Take the trade and it wins it.
//
// Measured through Gate 3 at 200 matches — `pnpm harness packages/server/fallback/round3/nettle.js
// --round 3 --matches 200`:
//
//     panel 0.50   (Camper 1.00, Kiter 0.00, Rusher 1.00, Dodger 0.00)   band 0.45-0.60
//
// Reproducible: the seed set is fixed (`seedsFor`), and where this strategy rolls
// `rand()` that PRNG is seeded per match, so the numbers above are the same on every
// machine. `packages/server/test/fallback.test.ts` re-checks the band on every run at
// a reduced 60 matches; both counts sit at least 0.03 inside both edges.
export const meta = {
  name: 'Nettle',
  rationale: 'I never throw anything. I just walk towards you and wait for you to come inside arm’s reach.',
  version: 1,
};

const TRIGGER = 200;       // the ambush radius
const SLAM_TRIGGER = 165;
const STALK_STOP = 60;     // do not grind into the player's hitbox
const REFRESH = 60;
const SPAWN_EVERY = 420;

export function init() {
  return { hot: -1, refreshedAt: -1, lastSpawn: -999 };
}

export function decide(view, mem) {
  const boss = view.boss;
  const player = view.player;
  const cd = boss.cooldowns;
  const aw = view.arena.w;
  const ah = view.arena.h;

  const dx = player.x - boss.x;
  const dy = player.y - boss.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const angle = dist < 0.001 ? boss.facing : Math.atan2(dy, dx);

  // 1. The trap closes: a slam centred on the boss itself, so it covers the ground
  //    the player has to stand on to keep shooting at this range.
  if (cd.slam === 0 && dist < SLAM_TRIGGER) {
    return { type: 'slam', x: clamp(boss.x, 0, aw), y: clamp(boss.y, 0, ah) };
  }

  // 2. A full ring, not a cone. At this distance a cone is a dodge to the side and a
  //    ring is not, which is the entire reason this boss beats anyone who charges it.
  if (cd.burst === 0 && dist < TRIGGER) {
    return { type: 'burst', angle: angle, count: 8 };
  }

  // 3. A herder posted on the habit, to make hiding at range less comfortable. This
  //    is the only pressure this boss applies from further away than its own arms.
  if (cd.spawn === 0 && view.tick - mem.lastSpawn > SPAWN_EVERY) {
    if (view.tick - mem.refreshedAt >= REFRESH || mem.hot < 0) {
      mem.hot = hottestCell(view.history.playerPosHeat);
      mem.refreshedAt = view.tick;
    }
    const cellW = aw / 8;
    const cellH = ah / 8;
    const col = mem.hot % 8;
    const row = (mem.hot - col) / 8;
    mem.lastSpawn = view.tick;
    return {
      type: 'spawn',
      x: clamp(col * cellW + cellW / 2, 0, aw),
      y: clamp(row * cellH + cellH / 2, 0, ah),
    };
  }

  // 4. Stalk. Never dash, never charge: the walk is the tell, and a player who reads
  //    it simply walks away faster than the boss can follow.
  if (dist <= STALK_STOP || dist < 0.001) return { type: 'idle' };
  return { type: 'move', dx: dx / dist, dy: dy / dist };
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
