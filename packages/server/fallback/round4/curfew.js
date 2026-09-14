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
// inside `CONTACT`, which is the only price it charges for aggression.
//
// What it actually beats is habit. Measured against the panel: a camper 1.00, a
// kiting player 0.48 — and that 0.48 is bought by the *minion* standing in the zone,
// not by the bursts. `SPAWN_EVERY` is nevertheless *not* the dial: at 300 the minion is
// always standing and this boss measures 0.55, at 460 it is barely ever standing and it
// measures 0.32, with nothing usable in between. The dial is `ENFORCE_CHANCE` below.
//
// ## Retuned 2026-09-11, for round 4's new band (spec §13, delta 24)
//
// Round 4's band moved to 0.60-0.75 and this boss sat at 0.55, losing every match to
// the Rusher. The cause was a number that had never been derived from anything:
// `CONTACT`, the range inside which the curfew applies to the boss's own feet, was 70.
// A slam covers 110 px and the Rusher holds 95 (its own `KNIFE_RANGE`: the boss's
// radius, the player's, and 55 px of clearance) — so the one price this boss charged
// for aggression was posted 25 px inside where aggression actually stands, and was
// never collected. `CONTACT` is the slam's own radius now, which is the only value
// that means what the comment says it means. Rusher 0.00 -> 0.40, one edit, nothing
// else touched: `ENFORCE_CHANCE`, the cone band and the retreat are all unchanged.
//
// Measured through Gate 3 at 200 matches — `pnpm harness packages/server/fallback/round4/curfew.js
// --round 4 --matches 200`:
//
//     panel 0.65   (Camper 1.00, Kiter 0.48, Rusher 0.40, Dodger 0.72)   band 0.60-0.75
//     0.700 at the 120 matches `fallback.test.ts` re-checks, so both counts sit
//       at least 0.05 inside both edges
//     longest motionless run 1 tick of the 90 Gate 3's ACTIVE assertion allows
//
// Two things moved when the resting `idle` became a patrol and the retreat learned not
// to grind into a wall. A rusher used to win every match by pushing this boss into a
// corner, where it froze; now it slides along the wall instead, which took the panel
// rate to 0.69. `ENFORCE_CHANCE` — new, and the only continuous dial this design has —
// pays that back.
//
// Reproducible: the seed set is fixed (`seedsFor`), and where this strategy rolls
// `rand()` that PRNG is seeded per match, so the numbers above are the same on every
// machine. `packages/server/test/fallback.test.ts` re-checks the band on every run at
// a reduced 120 matches; both counts sit at least 0.03 inside both edges.
export const meta = {
  name: 'Curfew',
  rationale: 'You keep coming back to the same square of floor, so I have closed that square.',
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

const REFRESH = 50;
const ZONE_CELLS = 1.7;
const HOLD = 260;          // preferred distance from the player
const BACK_OFF = 200;
/** Inside this the curfew applies to the boss's own feet. It is the slam's own radius
 *  (110 px), not a smaller number that feels like "on top of me": a Rusher stands at
 *  95 px and a 70 px threshold never fired at it at all. */
const CONTACT = 110;
const BURST_MIN = 240;
const BURST_MAX = 372;     // just far enough to graze a kiter's 340 px ring
const SPAWN_EVERY = 300;   // a standing minion is most of this boss's pressure
// The balance dial, and the boss's one tell. Once per breath the curfew is either
// enforced or merely declared: on a quiet breath the boss still holds the zone and
// still refuses contact, but it spends nothing, so the player gets a window to cross
// in. `rand()` is the engine's seeded PRNG, so a match replays byte-for-byte while
// the player cannot count the gaps to safety.
//
// It exists because every other dial in this file is a cliff. Measured at 200 matches
// against the panel: `SPAWN_EVERY` 300 sits at 0.56 and 460 at 0.32, `BACK_OFF` 200 at
// 0.56 and 140 at 0.38 — the four bots' rates are near-binary, so a threshold either
// changes nothing or changes a whole bot. A per-breath roll is the one knob that moves
// the rate continuously, which is exactly what the harness's own notes say.
const BREATH = 150;
const ENFORCE_CHANCE = 0.94;

export function init() {
  return { hot: -1, refreshedAt: -1, lastSpawn: -999, breath: -1, enforcing: true };
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

  const breath = Math.floor(view.tick / BREATH);
  if (mem.breath !== breath) {
    mem.breath = breath;
    mem.enforcing = rand() < ENFORCE_CHANCE;
  }
  const armed = mem.enforcing === true;

  // 1. The curfew itself. Held until the player is actually standing in the zone —
  //    a slam thrown at an empty cell is 210 ticks of cooldown bought for nothing.
  //    The one exception is a player standing on top of the boss: the curfew then
  //    applies where the boss is, which is the only price this boss charges for
  //    aggression and the only reason a rusher cannot simply ignore it.
  if (cd.slam === 0 && armed && (inZone || dist < CONTACT)) {
    return inZone
      ? { type: 'slam', x: hotX, y: hotY }
      : { type: 'slam', x: clamp(boss.x, 0, aw), y: clamp(boss.y, 0, ah) };
  }

  // 2. A minion left in the zone as the standing notice. Rate-limited by tick, not
  //    by cooldown: `spawn` refused at the minion cap keeps its cooldown and costs a
  //    contract violation, so asking every tick is strictly worse than waiting.
  if (cd.spawn === 0 && armed && view.tick - mem.lastSpawn > SPAWN_EVERY) {
    mem.lastSpawn = view.tick;
    return { type: 'spawn', x: hotX, y: hotY };
  }

  // 3. A three-shot cone in a narrow band. The upper bound is the point: a player who
  //    holds a longer range than this is barely shot at all.
  if (cd.burst === 0 && armed && dist > BURST_MIN && dist < BURST_MAX) {
    return { type: 'burst', angle: angle, count: 3 };
  }

  // 4. Refuse the knife fight.
  if (dist < BACK_OFF && dist > 0.001) {
    return retreat(view, dx / dist, dy / dist);
  }

  // 5. Otherwise sit on the zone at holding distance, so the next curfew lands
  //    before the player wanders out of it.
  if (dist > HOLD + 40 && dist > 0.001) {
    return { type: 'move', dx: dx / dist, dy: dy / dist };
  }
  const tx = hotX - boss.x;
  const ty = hotY - boss.y;
  const tmag = Math.sqrt(tx * tx + ty * ty);
  if (tmag < 8) return patrol(view, hotX, hotY);
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
