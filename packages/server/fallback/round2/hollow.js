// Round 2 fallback — the turn.
//
// The only boss in the pool that reads its own `hp`, and the whole design is that one
// number. Above the threshold it is barely a boss at all: it keeps its distance, holds
// every cooldown but the slam, and lets the player work. Below it, everything comes
// off the leash at once — charges, rings at contact, led slams, minions.
//
// That makes the difficulty a function of how the player plays rather than of a
// constant: burn it down fast and the dangerous half is short, poke at it and you
// spend most of the round against the version that fights back. It is a Round 2 boss
// because that is the round whose job is to teach, and the lesson is about *pacing*.
//
// The hole is the same one the design is built on, and it is a wide one: the calm phase
// is genuinely calm, so the first 42 hp are nearly free. A patient player who refuses
// every trade beats this boss outright — the Dodger bot, which shoots only when the
// screen is clear, takes it 100% of the time.
//
// Measured through Gate 3 at 200 matches — `pnpm harness packages/server/fallback/round2/hollow.js
// --round 2 --matches 200`:
//
//     panel 0.44   (Camper 1.00, Kiter 0.20, Rusher 0.56, Dodger 0.00)   band 0.35-0.50
//
// Reproducible: the seed set is fixed (`seedsFor`), and where this strategy rolls
// `rand()` that PRNG is seeded per match, so the numbers above are the same on every
// machine. `packages/server/test/fallback.test.ts` re-checks the band on every run at
// a reduced 60 matches; both counts sit at least 0.03 inside both edges.
export const meta = {
  name: 'Hollow',
  rationale: 'While I am whole I will let you work. It is only when you have nearly finished that I stop being polite.',
  version: 1,
};

const TURN_HP = 58;         // below this it stops being polite
const CALM_RANGE = 330;     // the distance it keeps while whole
const REFRESH = 55;
const ZONE_CELLS = 1.6;
const RING_RANGE = 160;
const CONE_MIN = 200;
const CONE_MAX = 450;
const CHARGE_MIN = 240;
const CHARGE_MAX = 430;
const CHARGE_LEAD = 24;
const SLAM_LEAD = 30;
const SPAWN_EVERY = 400;
// The balance dial, applied to the *hollow* phase only — the calm phase needs no
// dial, it is already a boss standing still. `rand()` is the engine's seeded PRNG.
const BREATH = 150;
const FURY_CHANCE = 0.62;

export function init() {
  return { hot: -1, refreshedAt: -1, lastSpawn: -999, breath: -1, furious: true };
}

export function decide(view, mem) {
  const boss = view.boss;
  const player = view.player;
  const cd = boss.cooldowns;
  const aw = view.arena.w;
  const ah = view.arena.h;

  const hp = typeof boss.hp === 'number' && isFinite(boss.hp) ? boss.hp : 100;
  const hollow = hp < TURN_HP;

  const breath = Math.floor(view.tick / BREATH);
  if (mem.breath !== breath) {
    mem.breath = breath;
    mem.furious = rand() < FURY_CHANCE;
  }
  const armed = hollow && mem.furious === true;

  const dx = player.x - boss.x;
  const dy = player.y - boss.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const angle = dist < 0.001 ? boss.facing : Math.atan2(dy, dx);
  const vx = typeof player.vx === 'number' && isFinite(player.vx) ? player.vx : 0;
  const vy = typeof player.vy === 'number' && isFinite(player.vy) ? player.vy : 0;

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

  // ---- the calm half ----
  // One slam, and only onto the habit, and only while the player is standing in it.
  // That is the entire threat while the boss is whole: it is not trying to win yet.
  if (!hollow) {
    const inZone =
      Math.abs(player.x - hotX) < cellW * ZONE_CELLS && Math.abs(player.y - hotY) < cellH * ZONE_CELLS;
    if (cd.slam === 0 && inZone) {
      return { type: 'slam', x: hotX, y: hotY };
    }
    if (dist < CALM_RANGE - 50 && dist > 0.001) {
      return { type: 'move', dx: -dx / dist, dy: -dy / dist };
    }
    if (dist > CALM_RANGE + 50 && dist > 0.001) {
      return { type: 'move', dx: dx / dist, dy: dy / dist };
    }
    return { type: 'idle' };
  }

  // ---- the hollow half ----
  // 1. A ring at contact. Nothing is held back down here.
  if (cd.burst === 0 && armed && dist < RING_RANGE) {
    return { type: 'burst', angle: angle, count: 8 };
  }

  // 2. The slam now leads the player's velocity instead of guarding a cell: the
  //    habit is a patient read, and this half of the fight is not patient.
  if (cd.slam === 0 && armed) {
    return {
      type: 'slam',
      x: clamp(player.x + vx * SLAM_LEAD, 0, aw),
      y: clamp(player.y + vy * SLAM_LEAD, 0, ah),
    };
  }

  // 3. The charge, aimed where the player will be after the 20-tick telegraph.
  if (cd.charge === 0 && armed && dist > CHARGE_MIN && dist < CHARGE_MAX) {
    const lx = player.x + vx * CHARGE_LEAD - boss.x;
    const ly = player.y + vy * CHARGE_LEAD - boss.y;
    const lmag = Math.sqrt(lx * lx + ly * ly);
    return { type: 'charge', angle: lmag < 0.001 ? angle : Math.atan2(ly, lx) };
  }

  // 4. A cone in the mid band, so backing off is not free either.
  if (cd.burst === 0 && armed && dist > CONE_MIN && dist < CONE_MAX) {
    return { type: 'burst', angle: angle, count: 5 };
  }

  // 5. A minion on the habit. Rate-limited by tick: a `spawn` refused at the
  //    two-minion cap keeps its cooldown and costs a contract violation.
  if (cd.spawn === 0 && view.tick - mem.lastSpawn > SPAWN_EVERY) {
    mem.lastSpawn = view.tick;
    return { type: 'spawn', x: hotX, y: hotY };
  }

  // 6. Down here it walks *at* the player. The retreat in the calm half was the
  //    politeness; there is none left.
  if (dist > 70 && dist > 0.001) {
    return { type: 'move', dx: dx / dist, dy: dy / dist };
  }
  return { type: 'idle' };
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
