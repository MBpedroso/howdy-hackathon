// Round 5 fallback — SIEGE.
//
// The hardest boss in the pool, and it gets there without ever touching the player. It
// reads `history.playerPosHeat` to find the cell the player lives in, then takes a
// firing post 230 px off it and never leaves: from there its cone bursts cover the
// exact ring a player uses to keep a boss at arm's length, so "stay out of reach"
// stops being a strategy and starts being the trap. It slams the habit, posts a minion
// in it, and keeps something on the board almost permanently, which is what beats a
// player who only shoots when the screen is clear.
//
// It is the only boss here that is genuinely good at every range but one. Measured
// against the panel it takes 0.92 off a camper, 0.84 off a kiter and 0.84 off a
// perfect dodger — and 0.00 off a rusher.
//
// That last number is the whole design. Its hole is deliberate and it is the one every
// siege engine has: it cannot fight at contact. It has no charge, its bursts are narrow
// cones, and it walks backwards the moment anyone closes. Get inside the guns and it
// has nothing — which is the promise the fairness band keeps even at Round 5.
//
// The reload roll is the balance dial and also the boss's tell: a bit over a third of
// its breaths are spent reloading, and those pauses are the windows to cross in.
//
// Measured through Gate 3 at 200 matches — `pnpm harness packages/server/fallback/round5/tollkeeper.js
// --round 5 --matches 200`:
//
//     panel 0.65   (Camper 0.92, Kiter 0.84, Rusher 0.00, Dodger 0.84)   band 0.55-0.70
//
// Reproducible: the seed set is fixed (`seedsFor`), and where this strategy rolls
// `rand()` that PRNG is seeded per match, so the numbers above are the same on every
// machine. `packages/server/test/fallback.test.ts` re-checks the band on every run at
// a reduced 60 matches; both counts sit at least 0.03 inside both edges.
export const meta = {
  name: 'Tollkeeper',
  rationale: 'I take a firing post outside the corner you chose and shell it until you come to me.',
  version: 1,
};

const REFRESH = 45;
const GUARD_RANGE = 230;   // how far off the hot cell the guard post sits
const BACK_OFF = 190;      // never trade at contact
const BURST_MIN = 300;
const BURST_MAX = 470;
const ZONE_CELLS = 1.5;    // "inside the zone", in heat-map cells
const SPAWN_EVERY = 400;
// The balance dial, and the gun crew's rhythm. Once per breath the battery rolls
// whether it is firing or reloading; `rand()` is the engine's seeded PRNG, so the
// match replays byte-for-byte but the player cannot time the gaps by counting.
const BREATH = 150;
const FIRE_CHANCE = 0.62;

export function init() {
  return { hot: -1, refreshedAt: -1, lastSpawn: -999, breath: -1, firing: true };
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
  const hotX = col * cellW + cellW / 2;
  const hotY = row * cellH + cellH / 2;

  // The guard post: GUARD_RANGE from the habit, on the side facing the middle.
  const inX = aw / 2 - hotX;
  const inY = ah / 2 - hotY;
  const inMag = Math.sqrt(inX * inX + inY * inY);
  const postX = inMag < 1 ? aw / 2 : clamp(hotX + (inX / inMag) * GUARD_RANGE, 0, aw);
  const postY = inMag < 1 ? ah / 2 : clamp(hotY + (inY / inMag) * GUARD_RANGE, 0, ah);

  const dx = player.x - boss.x;
  const dy = player.y - boss.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const angle = dist < 0.001 ? boss.facing : Math.atan2(dy, dx);

  // The reload window. Cooldowns are only spent when an action is taken, so holding
  // fire here does not waste them — it just hands the player a gap to cross in.
  const breath = Math.floor(view.tick / BREATH);
  if (mem.breath !== breath) {
    mem.breath = breath;
    mem.firing = rand() < FIRE_CHANCE;
  }
  const armed = mem.firing === true;

  const inZone =
    Math.abs(player.x - hotX) < cellW * ZONE_CELLS && Math.abs(player.y - hotY) < cellH * ZONE_CELLS;

  // 1. The toll: a slam on the zone, spent only while the player is standing in it.
  //    Held otherwise — the cooldown is only consumed when the action is taken, so
  //    waiting turns the slam from a metronome into a tax on staying put.
  if (cd.slam === 0 && inZone && armed) {
    return { type: 'slam', x: clamp(hotX, 0, aw), y: clamp(hotY, 0, ah) };
  }

  // 2. A minion posted on the zone's mouth, so leaving costs something too.
  if (cd.spawn === 0 && view.tick - mem.lastSpawn > SPAWN_EVERY) {
    mem.lastSpawn = view.tick;
    return { type: 'spawn', x: clamp(hotX, 0, aw), y: clamp(hotY, 0, ah) };
  }

  // 3. A narrow cone, and only across the gate — never at contact, where a ring of
  //    projectiles is unanswerable and would put this boss well over its band.
  if (cd.burst === 0 && armed && dist > BURST_MIN && dist < BURST_MAX) {
    return { type: 'burst', angle: angle, count: 3 };
  }

  // 4. Back off if the player closes: this boss does not want a knife fight.
  if (dist < BACK_OFF && dist > 0.001) {
    return { type: 'move', dx: -dx / dist, dy: -dy / dist };
  }

  // 5. Otherwise hold the post.
  const tx = postX - boss.x;
  const ty = postY - boss.y;
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
