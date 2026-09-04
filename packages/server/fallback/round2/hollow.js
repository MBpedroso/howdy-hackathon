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
// is genuinely calm, so the first 32 hp are nearly free. A patient player who refuses
// every trade beats this boss outright — the Dodger bot, which shoots only when the
// screen is clear, takes it 100% of the time.
//
// Measured through Gate 3 at 200 matches — `pnpm harness packages/server/fallback/round2/hollow.js
// --round 2 --matches 200`:
//
//     panel 0.44   (Camper 1.00, Kiter 0.16, Rusher 0.60, Dodger 0.00)   band 0.35-0.50
//     longest motionless run 1 tick of the 90 Gate 3's ACTIVE assertion allows
//
// `TURN_HP` moved from 58 to 68 when the resting `idle` became a strafe. A boss in
// motion is harder to lead, so it takes longer to reach its own turn — and this one's
// entire win rate lives below that line, so it measured 0.30 (too easy) until the
// turn came earlier. That is the trade the strafe costs, paid back in the one dial
// this design has.
//
// Reproducible: the seed set is fixed (`seedsFor`), and where this strategy rolls
// `rand()` that PRNG is seeded per match, so the numbers above are the same on every
// machine. `packages/server/test/fallback.test.ts` re-checks the band on every run at
// a reduced 120 matches; both counts sit at least 0.03 inside both edges.
export const meta = {
  name: 'Hollow',
  rationale: 'While I am whole I will let you work. It is only when you have nearly finished that I stop being polite.',
  version: 1,
};

// The resting state, and why it is not `idle`.
//
// A boss that returns `idle` while it waits for a cooldown stands perfectly still,
// and a human playtest reported that as a crash. Gate 3's ACTIVE assertion rejects
// it now: more than 90 motionless ticks (1.5 s) against any reference bot, or a p90
// idle fraction over 0.25, and the strategy does not ship. The resting state here is
// a strafe perpendicular to the player, so it holds whatever range the branches above
// chose while staying visibly alive. Straight legs, not a curve: every reference bot
// leads its shots off the boss's last-tick velocity, and a curve defeats a linear
// lead permanently — a boss that is unhittable by construction is not a harder boss.
const STRAFE_LEG = 34;      // ticks per straight leg
const STRAFE_LOOK = 40;     // how far ahead the strafe checks for a wall
const STRAFE_EDGE = 34;     // how close to the arena edge a leg may aim

const TURN_HP = 68;         // below this it stops being polite
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
      return retreat(view, dx / dist, dy / dist);
    }
    if (dist > CALM_RANGE + 50 && dist > 0.001) {
      return { type: 'move', dx: dx / dist, dy: dy / dist };
    }
    // At the holding distance. Strafe across it rather than stand in it: the calm
    // phase is meant to read as a boss that is letting the player work, not as one
    // that has stopped running.
    return strafe(view, angle);
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
  // Already on top of the player, with everything spent: circle them.
  return strafe(view, angle);
}


/** The resting strafe: perpendicular to `angle`, reversing every `STRAFE_LEG` ticks. */
function strafe(view, angle) {
  const boss = view.boss;
  const dir = Math.floor(view.tick / STRAFE_LEG) % 2 === 0 ? 1 : -1;
  let dx = -Math.sin(angle) * dir;
  let dy = Math.cos(angle) * dir;
  // A `move` that clamps against the arena edge displaces the boss by nothing, which
  // is exactly as motionless as `idle` and is counted the same way. Turn round first.
  if (blocked(view, boss.x + dx * STRAFE_LOOK, boss.y + dy * STRAFE_LOOK)) {
    dx = -dx;
    dy = -dy;
  }
  if (blocked(view, boss.x + dx * STRAFE_LOOK, boss.y + dy * STRAFE_LOOK)) {
    // Both legs run into a wall: the boss is in a corner. Walk back into the room.
    const cx = view.arena.w / 2 - boss.x;
    const cy = view.arena.h / 2 - boss.y;
    const cmag = Math.sqrt(cx * cx + cy * cy);
    if (cmag > 0.001) return { type: 'move', dx: cx / cmag, dy: cy / cmag };
  }
  return { type: 'move', dx: dx, dy: dy };
}

/** Is (`x`, `y`) inside the strip along the arena edge where a `move` would clamp? */
function blocked(view, x, y) {
  return (
    x < STRAFE_EDGE || x > view.arena.w - STRAFE_EDGE || y < STRAFE_EDGE || y > view.arena.h - STRAFE_EDGE
  );
}


/**
 * Back away from the player without grinding into a wall.
 *
 * The straight retreat is tried first; when the arena edge is in the way the boss
 * slides along it instead. Without this, a boss backing off from a player who is
 * standing in a corner walks into the corner and stays there: `move` clamps at the
 * boss's own radius, so the action is accepted, nothing moves, and the boss is as
 * motionless as if it had returned `idle` — 416 consecutive ticks of it against a
 * camper, before this existed. Gate 3's ACTIVE assertion counts displacement, not
 * action types, which is exactly why.
 */
function retreat(view, ux, uy) {
  const boss = view.boss;
  // Straight back, then the two slides. Fixed order, so the choice is deterministic.
  const dirs = [-ux, -uy, -uy, ux, uy, -ux];
  for (let i = 0; i < dirs.length; i = i + 2) {
    const cx = dirs[i];
    const cy = dirs[i + 1];
    if (!blocked(view, boss.x + cx * STRAFE_LOOK, boss.y + cy * STRAFE_LOOK)) {
      return { type: 'move', dx: cx, dy: cy };
    }
  }
  // Boxed in on every side the retreat could use: walk back into the room.
  const cx = view.arena.w / 2 - boss.x;
  const cy = view.arena.h / 2 - boss.y;
  const cmag = Math.sqrt(cx * cx + cy * cy);
  if (cmag > 0.001) return { type: 'move', dx: cx / cmag, dy: cy / cmag };
  return { type: 'move', dx: 1, dy: 0 };
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
