// Round 3 fallback — MINIONS.
//
// A boss that fights with the board rather than with its own body. It keeps a minion
// standing on the player's habit at all times, saves its slam for the ground the
// player has to cross to get away from that minion, and treats its own bursts as
// cover fire for the minion rather than as the damage.
//
// The reason that is worth a slot at all is what it does to a careful player: a
// player who only shoots when the screen is clear never gets a clear screen, because
// there is always something walking at them. Minions are slower than the player
// (2 px/tick against 3.6), so they are always escapable — but escaping one costs the
// twenty seconds the player needed to spend shooting the boss, and the clock running
// out is a boss win.
//
// The hole: minions have 6 hp. A player who spends four shots killing each one as it
// arrives dismantles this boss for the price of the ammunition.
//
// Measured through Gate 3 at 200 matches — `pnpm harness packages/server/fallback/round3/emberline.js
// --round 3 --matches 200`:
//
//     panel 0.53   (Camper 1.00, Kiter 0.36, Rusher 0.00, Dodger 0.76)   band 0.45-0.60
//     longest motionless run 0 ticks of the 90 Gate 3's ACTIVE assertion allows
//
// The orbit used to walk this boss into the top-left corner and leave it there — 169
// consecutive motionless ticks against a camper, without ever returning `idle`, because
// a `move` into a wall is accepted and displaces nothing. Reversing the orbit at the
// wall instead took it to 0.72, so `SPAWN_EVERY` went from 380 to 560 to pay that back.
//
// Reproducible: the seed set is fixed (`seedsFor`), and where this strategy rolls
// `rand()` that PRNG is seeded per match, so the numbers above are the same on every
// machine. `packages/server/test/fallback.test.ts` re-checks the band on every run at
// a reduced 120 matches; both counts sit at least 0.03 inside both edges.
export const meta = {
  name: 'Emberline',
  rationale: 'I would rather not touch you at all. I will just make sure you are never alone.',
  version: 1,
};

const REFRESH = 55;
const SPAWN_EVERY = 560;     // spawn cooldown is 300; retry slower than that, not faster
// How far ahead the orbit checks for a wall, and how close to the edge it may aim.
// The boss clamps at its own radius (28 px), so a leg aimed inside this strip would
// displace it by nothing — see note 4.
const ORBIT_LOOK = 40;
const ORBIT_EDGE = 34;
const ORBIT = 290;
const FLIP_PERIOD = 360;
const CONE_MIN = 210;
const CONE_MAX = 440;
const SLAM_LEAD = 30;
// The balance dial. Once per breath the boss rolls whether it adds its own pressure
// to the minions' or just walks; `rand()` is the engine's seeded PRNG, so the match
// still replays byte-for-byte.
const BREATH = 150;
const PRESSURE_CHANCE = 0.10;

export function init() {
  return { hot: -1, refreshedAt: -1, lastSpawn: -999, spin: 1, ticks: 0, breath: -1, pressing: true };
}

export function decide(view, mem) {
  const boss = view.boss;
  const player = view.player;
  const cd = boss.cooldowns;
  const aw = view.arena.w;
  const ah = view.arena.h;

  mem.ticks = (typeof mem.ticks === 'number' ? mem.ticks : 0) + 1;
  if (mem.ticks % FLIP_PERIOD === 0) mem.spin = -(typeof mem.spin === 'number' ? mem.spin : 1);
  const spin = typeof mem.spin === 'number' && mem.spin !== 0 ? mem.spin : 1;

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
  const vx = typeof player.vx === 'number' && isFinite(player.vx) ? player.vx : 0;
  const vy = typeof player.vy === 'number' && isFinite(player.vy) ? player.vy : 0;

  // 1. The minion is the strategy, so it comes first and it is never skipped. It is
  //    placed on the habit rather than on the player: a minion dropped at the
  //    player's feet is outrun in two seconds, one waiting where they were going is
  //    not. The tick rate-limit is what stops a refusal at the two-minion cap from
  //    burning a tick and a contract violation every frame.
  if (cd.spawn === 0 && view.tick - mem.lastSpawn > SPAWN_EVERY) {
    mem.lastSpawn = view.tick;
    return { type: 'spawn', x: hotX, y: hotY };
  }

  // The lull. The minion is never held — it *is* the boss — but everything the boss
  // throws itself is, so the screen does clear periodically and a patient player has
  // a window to spend on the boss instead of on its pets.
  const breath = Math.floor(view.tick / BREATH);
  if (mem.breath !== breath) {
    mem.breath = breath;
    mem.pressing = rand() < PRESSURE_CHANCE;
  }
  const armed = mem.pressing === true;

  // 2. The slam goes where the player is *going*, which while they are running away
  //    from a minion is a very short list of places.
  if (cd.slam === 0 && armed) {
    return {
      type: 'slam',
      x: clamp(player.x + vx * SLAM_LEAD, 0, aw),
      y: clamp(player.y + vy * SLAM_LEAD, 0, ah),
    };
  }

  // 3. Cover fire only, and only in a mid band: a cone that keeps the player moving
  //    towards the minion. This boss has no interest in winning the duel itself, so
  //    it never throws a ring, and a player who dives it is fought by the pets.
  if (cd.burst === 0 && armed && dist > CONE_MIN && dist < CONE_MAX) {
    return { type: 'burst', angle: angle, count: 5 };
  }

  // 4. Orbit at range, which keeps the boss between the player and the open arena
  //    without ever committing to a chase — and *reverse* the orbit rather than
  //    grind into the arena edge.
  //
  //    This branch never returned `idle` and still froze the boss for 169
  //    consecutive ticks against a camper: the orbit ran the boss into the top-left
  //    corner, where `move` clamps at the boss's own radius and displaces it by
  //    nothing at all. A `move` that moves nothing is exactly as motionless as
  //    `idle` and Gate 3's ACTIVE assertion counts it the same way, which is the
  //    whole reason that assertion is defined on displacement rather than on the
  //    action type. The reversal is committed to memory so the boss keeps going the
  //    new way instead of turning back into the wall on the next tick.
  const ux = dist < 0.001 ? 1 : dx / dist;
  const uy = dist < 0.001 ? 0 : dy / dist;
  const radial = dist > ORBIT + 30 ? 1 : dist < ORBIT - 30 ? -1 : 0;
  let step = orbitStep(ux, uy, spin, radial);
  if (blocked(view, boss.x + step.x * ORBIT_LOOK, boss.y + step.y * ORBIT_LOOK)) {
    mem.spin = -spin;
    step = orbitStep(ux, uy, -spin, radial);
  }
  if (blocked(view, boss.x + step.x * ORBIT_LOOK, boss.y + step.y * ORBIT_LOOK)) {
    // Both orbit directions run into a wall — the boss is in a corner. Walk back
    // into the room; the orbit resumes as soon as there is room to walk it.
    const cx = view.arena.w / 2 - boss.x;
    const cy = view.arena.h / 2 - boss.y;
    const cmag = Math.sqrt(cx * cx + cy * cy);
    if (cmag > 0.001) return { type: 'move', dx: cx / cmag, dy: cy / cmag };
  }
  return { type: 'move', dx: step.x, dy: step.y };
}

/** One normalized orbit step: tangential by `spin`, plus a radius correction. */
function orbitStep(ux, uy, spin, radial) {
  const mx = -uy * spin + ux * radial;
  const my = ux * spin + uy * radial;
  const mag = Math.sqrt(mx * mx + my * my);
  // |tangent| is 1 and the radial term is 0 or 1, so `mag` cannot be 0 — but the
  // guard costs nothing and a NaN direction is a Gate 2 rejection.
  if (mag < 0.001) return { x: 1, y: 0 };
  return { x: mx / mag, y: my / mag };
}

/** Is (`x`, `y`) inside the strip along the arena edge where a `move` would clamp? */
function blocked(view, x, y) {
  return x < ORBIT_EDGE || x > view.arena.w - ORBIT_EDGE || y < ORBIT_EDGE || y > view.arena.h - ORBIT_EDGE;
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
