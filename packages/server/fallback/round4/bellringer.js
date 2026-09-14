// Round 4 fallback — CHARGE.
//
// The `charge` primitive is the only thing in the contract that closes 300 px in one
// commitment, and this is the only boss in the pool built around it. Charge, ring,
// withdraw: it saves the charge for exactly the range where 300 px of travel arrives,
// throws it down the player's *lead* rather than at their feet, cashes the arrival
// with a ring burst at contact, then walks back out to reload the runway.
//
// Worth knowing before tuning it: the charge is the boss's *character*, not the source
// of its win rate. Closing the gap and winning once you are there are two different
// problems, and the charge only solves the first — which is why what finally moved this
// boss's rate was what it does *after* it arrives (see the 2026-09-11 note below).
//
// The loop is deliberately loud: 20 ticks of telegraph on the charge, 40 on the slam,
// so the player is told twice. The counter is the dash — 10 invulnerable ticks, which
// beats both tells if it is spent on the right frame. A Round 4 boss should demand the
// dash, and this one does.
//
// ## Retuned 2026-09-11, for round 4's new band (spec §13, delta 24)
//
// Round 4's band moved to 0.60-0.75 and this boss sat at 0.54, with the shortfall in
// one place: the Rusher beat it 1.00 of the time, every match, on every count. The
// note above says why and it was right — "the counter is the dash" — but it read the
// dash as an answer rather than as a resource. It is 10 invulnerable ticks on a
// 45-tick cooldown, so a player at contact range can answer *one* thing.
//
// So the file now throws two. Branch 1b: the slam follows the ring inside 14 ticks and
// resolves 40 ticks later, which lands inside the 45 the dash spends recovering from
// the ring. Nothing fires more often than it did — the burst and the slam are on their
// own cooldowns and the resting breaths are untouched at `HUNT_CHANCE` 0.45 — they are
// simply thrown as a pair instead of separately, which is the same trick `nettle.js`
// has always used at contact. Rusher 0.00 -> 0.16. `SPAWN_EVERY` 1380 -> 1250 covers
// the rest of the distance to the new band's middle.
//
// It is still beatable by the thing it is meant to be beaten by: hold the dash for the
// slam rather than spending it on the ring, and the pair costs nothing.
//
// Measured through Gate 3 at 200 matches — `pnpm harness packages/server/fallback/round4/bellringer.js
// --round 4 --matches 200`:
//
//     panel 0.70   (Camper 1.00, Kiter 0.76, Rusher 0.16, Dodger 0.88)   band 0.60-0.75
//     0.700 at the 120 matches `fallback.test.ts` re-checks, so both counts sit
//       at least 0.05 inside both edges
//     longest motionless run 0 ticks of the 90 Gate 3's ACTIVE assertion allows
//
// Two things moved when the resting `idle` became a strafe and the retreat learned not
// to grind into a wall. It used to freeze for 416 consecutive ticks — nearly seven
// seconds — backing away from a camper standing in a corner, and it used to lose the
// runway it needed whenever that happened. Fixing both took it to 0.62, so `SPAWN_EVERY`
// went from 1000 to 1380 to pay it back.
//
// Reproducible: the seed set is fixed (`seedsFor`), and where this strategy rolls
// `rand()` that PRNG is seeded per match, so the numbers above are the same on every
// machine. `packages/server/test/fallback.test.ts` re-checks the band on every run at
// a reduced 120 matches; both counts sit at least 0.03 inside both edges.
export const meta = {
  name: 'Bellringer',
  rationale: 'Distance is not a plan. I will cross it, ring the bell in your face, and walk back out.',
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

const CHARGE_MIN = 230;      // below this the charge overshoots and wastes 150 ticks
const CHARGE_MAX = 430;      // above it, 300 px of travel does not arrive
const CHARGE_LEAD = 24;      // charge telegraphs 20 ticks; lead by a little more
const RING_RANGE = 165;      // where a ring beats a cone
const CONE_MIN = 250;
const SLAM_LEAD = 30;
const STANDOFF = 300;
const SPAWN_EVERY = 1250;
// How long after a ring the slam still counts as the second half of the pair.
const RING_CHASE = 14;
// The balance dial, and the boss's rhythm. Once per breath it rolls whether it is
// hunting or resting; `rand()` is the engine's seeded PRNG, so a match replays
// byte-for-byte while the player still cannot count the beats to safety. A short
// breath matters as much as the odds: 40 rolls a match average out, where 24 long
// ones let a single unlucky stretch decide the whole round.
const BREATH = 90;
const HUNT_CHANCE = 0.45;

export function init() {
  return { lastSpawn: -999, charges: 0, breath: -1, hunting: true, ringAt: -999 };
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
  const vx = typeof player.vx === 'number' && isFinite(player.vx) ? player.vx : 0;
  const vy = typeof player.vy === 'number' && isFinite(player.vy) ? player.vy : 0;

  // The resting breaths: everything offensive is held, so the player gets stretches
  // of the fight in which the boss is only walking. Cooldowns are spent on use, not
  // on request, so nothing is wasted by waiting.
  const breath = Math.floor(view.tick / BREATH);
  if (mem.breath !== breath) {
    mem.breath = breath;
    mem.hunting = rand() < HUNT_CHANCE;
  }
  const armed = mem.hunting === true;

  // 1. The ring, first: if the player is already at contact there is nothing to
  //    close and a cone here is a free sidestep.
  if (cd.burst === 0 && armed && dist < RING_RANGE) {
    mem.ringAt = view.tick;
    return { type: 'burst', angle: angle, count: 8 };
  }

  // 1b. Cash the ring. A player at contact range answers the ring with the dash —
  //     10 invulnerable ticks, then 45 of cooldown. The slam resolves 40 ticks after
  //     it is thrown, which lands inside that window, so throwing it on the heels of
  //     the ring is the one thing at this range the dash cannot answer twice.
  const sinceRing = view.tick - (typeof mem.ringAt === 'number' ? mem.ringAt : -999);
  if (cd.slam === 0 && armed && sinceRing < RING_CHASE && dist < RING_RANGE + 60) {
    return { type: 'slam', x: clamp(boss.x, 0, aw), y: clamp(boss.y, 0, ah) };
  }

  // 2. The charge. Aimed at where the player will be after the telegraph, not at
  //    where they are — a circling player walks into the lead and a stationary one
  //    is hit either way.
  if (cd.charge === 0 && armed && dist > CHARGE_MIN && dist < CHARGE_MAX) {
    const leadX = player.x + vx * CHARGE_LEAD;
    const leadY = player.y + vy * CHARGE_LEAD;
    const lx = leadX - boss.x;
    const ly = leadY - boss.y;
    const lmag = Math.sqrt(lx * lx + ly * ly);
    mem.charges = (typeof mem.charges === 'number' ? mem.charges : 0) + 1;
    return { type: 'charge', angle: lmag < 0.001 ? angle : Math.atan2(ly, lx) };
  }

  // 3. The slam covers the retreat: it goes where the player is heading, so chasing
  //    the boss out of the ring costs something.
  if (cd.slam === 0 && armed && dist < CHARGE_MAX) {
    return {
      type: 'slam',
      x: clamp(player.x + vx * SLAM_LEAD, 0, aw),
      y: clamp(player.y + vy * SLAM_LEAD, 0, ah),
    };
  }

  // 4. A cone while the charge is down, so the mid range is never entirely free.
  if (cd.burst === 0 && armed && dist > CONE_MIN) {
    return { type: 'burst', angle: leadAngle(boss, player, vx, vy, angle), count: 5 };
  }

  // 5. A minion behind the player, cutting the retreat the charge pushes them into.
  //    Deliberately rare — two in a whole round, and this cadence is the balance dial
  //    that actually moves. Measured at 200 matches, before the ring-slam pair existed:
  //    `SPAWN_EVERY` 1300 put this boss at 0.59 against the panel, 1380 at 0.54 and 1800
  //    at 0.49; with the pair it is 1250 -> 0.70 and 1150 -> 0.73. The pets, not the charge, are what
  //    deny a defensive player the clear screen they need to shoot back. This boss is
  //    meant to be beaten by dashing its telegraphs, so the pets stay a garnish.
  if (cd.spawn === 0 && view.tick - mem.lastSpawn > SPAWN_EVERY) {
    mem.lastSpawn = view.tick;
    const bx = dist < 0.001 ? 0 : dx / dist;
    const by = dist < 0.001 ? 0 : dy / dist;
    return { type: 'spawn', x: clamp(player.x + bx * 130, 0, aw), y: clamp(player.y + by * 130, 0, ah) };
  }

  // 6. Reset to charging distance. Backing off is not caution here, it is reloading:
  //    the charge needs CHARGE_MIN of runway to be worth 150 ticks of cooldown.
  if (dist < CHARGE_MIN && dist > 0.001) {
    return retreat(view, dx / dist, dy / dist);
  }
  if (dist > STANDOFF && dist > 0.001) {
    return { type: 'move', dx: dx / dist, dy: dy / dist };
  }
  // On the runway at charging distance, waiting for the charge. Pace it rather than
  // stand on it: the earlier version spent up to 630 consecutive ticks — ten and a
  // half seconds — motionless here while the resting breaths held everything back.
  return strafe(view, angle);
}


/**
 * Where to aim a cone so the shots and the player arrive together.
 *
 * A boss projectile travels 5.5 px/tick, so at 350 px it is ~64 ticks in the air and a
 * player walking across the cone at 3.6 px/tick is 230 px from where it was aimed.
 * Two passes of the standard intercept iteration: guess the time of flight from the
 * present range, move the player along its own velocity by that much, re-measure.
 */
function leadAngle(boss, player, vx, vy, fallback) {
  const SHOT_SPEED = 5.5;
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

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
