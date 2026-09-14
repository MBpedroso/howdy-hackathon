// Round 5 fallback — PRESSURE, by geometry.
//
// Most of this pool aims at where the player is, or at where they habitually stand.
// This one asks a different question — "which way can they still go?" — and then takes
// that away. It finds the wall the player is nearest to, walks to the *opposite* side
// of them, and squeezes: the slam goes into the escape lane between the player and open
// space rather than onto the player themselves, and the cone burst goes down the
// squeeze line — at where the player will be when it arrives — so dodging the shots
// means dodging into the wall.
//
// The arena is 800x800 and the player moves 3.6 px/tick against the boss's 2.6, so
// this can never be a trap the player cannot escape — they are always faster. What it
// costs them is the ground they wanted, and a player pressed into a corner has no room
// to read the next telegraph. The counter is to break the squeeze early and cross the
// middle, which is why this boss opens the middle to do it.
//
// ## Retuned 2026-09-11, for round 5's new band (spec §13, delta 24)
//
// Round 5's band moved to 0.65-0.95 and this boss sat at 0.61, with one hole doing all
// the damage: a player who simply held a long orbit beat it 0.92 of the time. The
// reason was arithmetic, not design. A boss projectile travels 5.5 px/tick, so a cone
// thrown 340 px down the squeeze line is 62 ticks in the air, and a kiter orbiting at
// 3.6 px/tick is 220 px from where it was aimed by the time it arrives. This boss was
// not missing its shots; it was aiming at a place the player had already left.
//
// `leadAngle` solves the intercept — two passes, no new primitive, nothing fired more
// often, `PRESS_CHANCE` untouched at 0.50 — and Kiter goes 0.08 -> 0.52. The squeeze
// still has its counter: cross the middle before the wall is behind you, and none of
// this geometry gets set up in the first place.
//
// Measured through Gate 3 at 200 matches — `pnpm harness packages/server/fallback/round5/crossfire.js
// --round 5 --matches 200`:
//
//     panel 0.73   (Camper 1.00, Kiter 0.52, Rusher 0.44, Dodger 0.96)   band 0.65-0.95
//     0.750 at the 120 matches `fallback.test.ts` re-checks, so both counts sit
//       at least 0.08 inside both edges
//     longest motionless run 0 ticks of the 90 Gate 3's ACTIVE assertion allows
//
// Holding the pressing post used to mean standing on it — up to 485 consecutive
// motionless ticks, eight seconds of a boss that reads as crashed. Pacing across it
// instead cost the panel bots accuracy and took this boss to 0.72, so `SPAWN_EVERY`
// went from 460 to 800 to pay it back.
//
// Reproducible: the seed set is fixed (`seedsFor`), and where this strategy rolls
// `rand()` that PRNG is seeded per match, so the numbers above are the same on every
// machine. `packages/server/test/fallback.test.ts` re-checks the band on every run at
// a reduced 120 matches; both counts sit at least 0.03 inside both edges.
export const meta = {
  name: 'Crossfire',
  rationale: 'I am not aiming at you. I am aiming at the only place you had left to stand.',
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

const PIN_OFFSET = 250;      // how far off the player the pressing post sits
const CONE_MIN = 170;
const CONE_MAX = 460;
const LANE_LEAD = 120;       // how far up the escape lane the slam is placed
const CHARGE_MIN = 250;
const CHARGE_MAX = 420;
const RING_RANGE = 130;
const SPAWN_EVERY = 800;
// The balance dial. Once per breath the boss rolls whether it presses or resets;
// `rand()` is the engine's seeded PRNG, so the match still replays byte-for-byte.
const BREATH = 150;
const PRESS_CHANCE = 0.5;

export function init() {
  return { lastSpawn: -999, breath: -1, pressing: true };
}

export function decide(view, mem) {
  const boss = view.boss;
  const player = view.player;
  const cd = boss.cooldowns;
  const aw = view.arena.w;
  const ah = view.arena.h;

  const breath = Math.floor(view.tick / BREATH);
  if (mem.breath !== breath) {
    mem.breath = breath;
    mem.pressing = rand() < PRESS_CHANCE;
  }
  const armed = mem.pressing === true;

  const dx = player.x - boss.x;
  const dy = player.y - boss.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const angle = dist < 0.001 ? boss.facing : Math.atan2(dy, dx);

  // Which wall is the player nearest? `outX/outY` points from the player at it, so
  // `-outX/-outY` is the lane they have to run down to get away from it.
  const left = player.x;
  const right = aw - player.x;
  const top = player.y;
  const bottom = ah - player.y;
  let outX = 0;
  let outY = 0;
  const nearest = Math.min(left, right, top, bottom);
  if (nearest === left) outX = -1;
  else if (nearest === right) outX = 1;
  else if (nearest === top) outY = -1;
  else outY = 1;

  // 1. A ring if the player has already closed: at contact there is no lane to
  //    squeeze and a cone is a free sidestep.
  if (cd.burst === 0 && armed && dist < RING_RANGE) {
    return { type: 'burst', angle: angle, count: 8 };
  }

  // 2. The slam goes into the escape lane, not onto the player. A slam on the player
  //    is dodged by walking anywhere; a slam on the lane is dodged by walking into
  //    the wall, which is where this boss wanted them.
  if (cd.slam === 0 && armed) {
    return {
      type: 'slam',
      x: clamp(player.x - outX * LANE_LEAD, 0, aw),
      y: clamp(player.y - outY * LANE_LEAD, 0, ah),
    };
  }

  // 3. The cone down the squeeze line, so sidestepping it costs ground too — thrown
  //    at where the player will be when it arrives rather than at where they are
  //    (`leadAngle`), because at this range those are two different places.
  if (cd.burst === 0 && armed && dist > CONE_MIN && dist < CONE_MAX) {
    return { type: 'burst', angle: leadAngle(boss, player, angle), count: 5 };
  }

  // 4. The charge is used to shut the lane, not to deal damage: it goes down the
  //    line the player would have run, which is why it is worth 150 ticks here.
  if (cd.charge === 0 && armed && dist > CHARGE_MIN && dist < CHARGE_MAX) {
    const lx = player.x - outX * LANE_LEAD - boss.x;
    const ly = player.y - outY * LANE_LEAD - boss.y;
    const lmag = Math.sqrt(lx * lx + ly * ly);
    return { type: 'charge', angle: lmag < 0.001 ? angle : Math.atan2(ly, lx) };
  }

  // 5. A minion parked in the lane's mouth. Rate-limited by tick: `spawn` refused at
  //    the two-minion cap keeps its cooldown and costs a contract violation, so
  //    asking every tick is strictly worse than waiting.
  if (cd.spawn === 0 && view.tick - mem.lastSpawn > SPAWN_EVERY) {
    mem.lastSpawn = view.tick;
    return {
      type: 'spawn',
      x: clamp(player.x - outX * PIN_OFFSET, 0, aw),
      y: clamp(player.y - outY * PIN_OFFSET, 0, ah),
    };
  }

  // 6. Take the pressing post: on the open side of the player, so the boss's body is
  //    itself part of the squeeze. On a resting breath, reset to the middle instead —
  //    which is also the honest tell that the pressure has stopped.
  const postX = armed ? player.x - outX * PIN_OFFSET : aw / 2;
  const postY = armed ? player.y - outY * PIN_OFFSET : ah / 2;
  const tx = postX - boss.x;
  const ty = postY - boss.y;
  const tmag = Math.sqrt(tx * tx + ty * ty);
  if (tmag < 10) return patrol(view, postX, postY);
  return { type: 'move', dx: tx / tmag, dy: ty / tmag };
}


/**
 * Where to aim a cone so the shots and the player arrive together.
 *
 * A boss projectile travels 5.5 px/tick, so a cone thrown 340 px down the squeeze line
 * is 62 ticks in the air — and a player orbiting at 3.6 px/tick is 220 px from where it
 * was aimed by the time it gets there. Aiming at the present position is therefore not
 * aiming at all at this range, which is most of why a kiting player used to walk
 * through this boss. Two passes of the standard intercept iteration: guess the time of
 * flight from the present range, move the player along their own velocity by that much,
 * re-measure.
 */
function leadAngle(boss, player, fallback) {
  const SHOT_SPEED = 5.5;
  const vx = typeof player.vx === 'number' && isFinite(player.vx) ? player.vx : 0;
  const vy = typeof player.vy === 'number' && isFinite(player.vy) ? player.vy : 0;
  let t = 0;
  let ax = player.x;
  let ay = player.y;
  for (let i = 0; i < 2; i = i + 1) {
    ax = player.x + vx * t;
    ay = player.y + vy * t;
    t = Math.sqrt((ax - boss.x) * (ax - boss.x) + (ay - boss.y) * (ay - boss.y)) / SHOT_SPEED;
  }
  const lx = ax - boss.x;
  const ly = ay - boss.y;
  if (Math.sqrt(lx * lx + ly * ly) < 0.001) return fallback;
  return Math.atan2(ly, lx);
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

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
