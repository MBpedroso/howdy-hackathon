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
// against the panel it takes 1.00 off a kiter and 1.00 off a perfect dodger, 0.96 off a
// camper — and 0.00 off a rusher.
//
// That last number is the whole design. Its hole is deliberate and it is the one every
// siege engine has: it cannot fight at contact. It has no charge, its bursts are narrow
// cones, and it walks backwards the moment anyone closes. Get inside the guns and it
// has nothing — which is the promise the fairness band keeps even at Round 5.
//
// The reload roll is the balance dial and also the boss's tell: a bit over a third of
// its breaths are spent reloading, and those pauses are the windows to cross in.
//
// ## Retuned 2026-09-11, for round 5's new band (spec §13, delta 24)
//
// This is the one file in the pool that needed nothing invented: it was *detuned* to
// fit the old 0.55-0.70 ceiling and the detune is simply given back. When the resting
// `idle` became a patrol (below), this boss reached 0.74 and `SPAWN_EVERY` was pushed
// from 400 to 725 to pay for it — which is what took the camper's rate down to 0.52,
// on a boss whose whole design is a minion standing in the cell the player lives in.
// Round 5's band is 0.65-0.95 now, so the siege can keep its guns: `SPAWN_EVERY` 725 ->
// 500 puts the camper back at 0.96 and the panel at 0.74, which is where this boss
// measured before the ceiling required it to be worse.
//
// Nothing else changed, and the hole stays open: 0.00 against a rusher, by design.
//
// Measured through Gate 3 at 200 matches — `pnpm harness packages/server/fallback/round5/tollkeeper.js
// --round 5 --matches 200`:
//
//     panel 0.74   (Camper 0.96, Kiter 1.00, Rusher 0.00, Dodger 1.00)   band 0.65-0.95
//     0.733 at the 120 matches `fallback.test.ts` re-checks, so both counts sit
//       at least 0.08 inside both edges
//     longest motionless run 1 tick of the 90 Gate 3's ACTIVE assertion allows
//
// The resting `idle` became a patrol and the retreat learned not to grind into a wall
// on 2026-09-04: a defensive player used to beat this boss by walking it into a corner,
// where it froze for 343 consecutive ticks. Now it slides along the wall, and nothing
// that keeps its distance beats it any more.
//
// Reproducible: the seed set is fixed (`seedsFor`), and where this strategy rolls
// `rand()` that PRNG is seeded per match, so the numbers above are the same on every
// machine. `packages/server/test/fallback.test.ts` re-checks the band on every run at
// a reduced 120 matches; both counts sit at least 0.03 inside both edges.
export const meta = {
  name: 'Tollkeeper',
  rationale: 'I take a firing post outside the corner you chose and shell it until you come to me.',
  version: 1,
};

// The resting state, and why it is not `idle`.
//
// A boss that returns `idle` while it waits for a cooldown stands perfectly still,
// and a human playtest reported that as a crash. Gate 3's ACTIVE assertion rejects it
// now: more than 90 motionless ticks (1.5 s) against any reference bot, or a p90 idle
// fraction over 0.25, and the strategy does not ship. So having arrived at the ground
// it wants, this boss patrols *across* it instead of stopping — a triangle wave in x
// through the anchor, +-`PATROL_RADIUS`. `PATROL_RADIUS / PATROL_LEG` is 2.59 px/tick,
// just under the boss's own 2.6, so it tracks the patrol target exactly and is never
// left standing. Straight legs, not a circle: every reference bot leads its shots off
// the boss's last-tick velocity, and a curve defeats a linear lead permanently — a
// boss that is unhittable by construction is not a harder boss, it is a broken one.
const PATROL_LEG = 34;
/** Half the width of the patrol. `PATROL_LEG * 1.29` is 2.59 px/tick, just under
 *  the boss's own 2.6, so it tracks the target exactly instead of jittering around
 *  it — derived rather than typed, so `PATROL_LEG` alone is the dial. */
const PATROL_RADIUS = PATROL_LEG * 1.29;
/** The anchor is held this far off a wall, so no leg can clamp against the edge. */
const PATROL_MARGIN = PATROL_RADIUS + 34;
const PATROL_EDGE = 34;
/** How far ahead a retreat checks for a wall. */
const PATROL_LOOK = 40;

const REFRESH = 45;
const GUARD_RANGE = 230;   // how far off the hot cell the guard post sits
const BACK_OFF = 190;      // never trade at contact
const BURST_MIN = 300;
const BURST_MAX = 470;
const ZONE_CELLS = 1.5;    // "inside the zone", in heat-map cells
const SPAWN_EVERY = 500;
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
    return retreat(view, dx / dist, dy / dist);
  }

  // 5. Otherwise hold the post.
  const tx = postX - boss.x;
  const ty = postY - boss.y;
  const tmag = Math.sqrt(tx * tx + ty * ty);
  if (tmag < 8) return patrol(view, postX, postY);
  return { type: 'move', dx: tx / tmag, dy: ty / tmag };
}


/** The resting patrol: a triangle wave in x through (`ax`, `ay`). Never `idle`. */
function patrol(view, ax, ay) {
  const boss = view.boss;
  const cx = clamp(ax, PATROL_MARGIN, view.arena.w - PATROL_MARGIN);
  const cy = clamp(ay, PATROL_EDGE, view.arena.h - PATROL_EDGE);
  const phase = view.tick % (PATROL_LEG * 2);
  const leg = phase < PATROL_LEG ? phase : PATROL_LEG * 2 - phase;
  const tx = cx + ((leg / PATROL_LEG) * 2 - 1) * PATROL_RADIUS - boss.x;
  const ty = cy - boss.y;
  const tmag = Math.sqrt(tx * tx + ty * ty);
  // The target is under the boss this tick. It moves every tick, so this cannot
  // repeat: nudge along the patrol axis rather than standing still for one frame.
  if (tmag < 0.001) return { type: 'move', dx: phase < PATROL_LEG ? 1 : -1, dy: 0 };
  return { type: 'move', dx: tx / tmag, dy: ty / tmag };
}


/** Is (`x`, `y`) inside the strip along the arena edge where a `move` would clamp? */
function blocked(view, x, y) {
  return (
    x < PATROL_EDGE || x > view.arena.w - PATROL_EDGE || y < PATROL_EDGE || y > view.arena.h - PATROL_EDGE
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
    if (!blocked(view, boss.x + cx * PATROL_LOOK, boss.y + cy * PATROL_LOOK)) {
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
