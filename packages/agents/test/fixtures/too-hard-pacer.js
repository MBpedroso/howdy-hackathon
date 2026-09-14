// A plainly too-hard round 2 boss — the fixture the throttle is tested against.
//
// It is the round 2 fallback (`packages/server/fallback/round2/metronome.js`, a
// fixed-cadence boss measured at 0.46 against the panel) with its three measured
// levers turned up until it is over the band: the beat halved, the minion cadence
// halved, and the range at which the burst becomes an unanswerable full ring
// doubled. Nothing else about it changed, and it has no knob of its own — the whole
// point of the 2026-09-11 redesign is that the Coder does not write one.
//
// Measured through Gate 3 at 60 matches, round 2 (band 0.35–0.50), the numbers are
// re-measured by `test/calibrate.test.ts` on every run rather than trusted from
// here: as written it is well over the band, and the Judge's throttle brings it in.
export const meta = {
  name: 'Pacer',
  rationale: 'One, two, three, slam — and I have halved the count since we last met.',
  version: 1,
};

const MARCH_LEG = 68;       // ticks per side of the square
const MARCH_LOOK = 40;      // how far ahead the march checks for a wall
const MARCH_EDGE = 34;      // how close to the arena edge a leg may aim

const BEAT = 36;             // the fallback's 72, halved
const SLAM_LEAD = 26;        // ticks of velocity lead on the slam
const CLOSE = 285;           // walks to here and no closer
const RING_RANGE = 300;      // the fallback's 150, doubled
const SPAWN_EVERY = 450;     // the fallback's 900, halved

export function init() {
  return { lastSpawn: -999 };
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

  const beat = Math.floor(view.tick / BEAT) % 4;
  const vx = typeof player.vx === 'number' && isFinite(player.vx) ? player.vx : 0;
  const vy = typeof player.vy === 'number' && isFinite(player.vy) ? player.vy : 0;

  // Beat 0 — the slam, led by the player's own velocity. It lands on anyone walking
  // a smooth line and misses anyone who changes direction inside the 40-tick tell.
  if (beat === 0 && cd.slam === 0) {
    return {
      type: 'slam',
      x: clamp(player.x + vx * SLAM_LEAD, 0, aw),
      y: clamp(player.y + vy * SLAM_LEAD, 0, ah),
    };
  }

  // Beats 1 and 3 — projectiles. A five-shot cone at range; a full ring if the
  // player happens to be standing close when the beat comes round, because the beat
  // does not care where they are and a cone at contact is a free sidestep.
  if ((beat === 1 || beat === 3) && cd.burst === 0) {
    return { type: 'burst', angle: angle, count: dist < RING_RANGE ? 8 : 5 };
  }

  // Beat 2 — a minion, dropped halfway between the boss and the player.
  if (beat === 2 && cd.spawn === 0 && view.tick - mem.lastSpawn > SPAWN_EVERY) {
    mem.lastSpawn = view.tick;
    return {
      type: 'spawn',
      x: clamp((boss.x + player.x) / 2, 0, aw),
      y: clamp((boss.y + player.y) / 2, 0, ah),
    };
  }

  // Off-beat: keep a working distance. No dodging, no reading, no reacting — the
  // cadence is the entire strategy, and interrupting it to react would be cheating
  // on the joke.
  if (dist > CLOSE && dist > 0.001) {
    return { type: 'move', dx: dx / dist, dy: dy / dist };
  }
  if (dist < CLOSE - 90 && dist > 0.001) {
    return retreat(view, dx / dist, dy / dist);
  }
  // On the beat and at the working distance, it walks its box. `idle` here would be
  // the only thing in this file that stops, and Gate 3's ACTIVE assertion rejects it
  // anyway; a fixed square is also the only resting state that keeps the joke, since
  // it is the one pattern that does not look at the player either.
  return march(view);
}


/** The march: one of four compass headings, changing every `MARCH_LEG` ticks. */
function march(view) {
  const boss = view.boss;
  const leg = Math.floor(view.tick / MARCH_LEG) % 4;
  let dx = leg === 0 ? 1 : leg === 2 ? -1 : 0;
  let dy = leg === 1 ? 1 : leg === 3 ? -1 : 0;
  // A `move` that clamps against the arena edge displaces the boss by nothing, which
  // is exactly as motionless as `idle` and is counted the same way. Turn round first.
  if (blocked(view, boss.x + dx * MARCH_LOOK, boss.y + dy * MARCH_LOOK)) {
    dx = -dx;
    dy = -dy;
  }
  if (blocked(view, boss.x + dx * MARCH_LOOK, boss.y + dy * MARCH_LOOK)) {
    // Cornered: walk back into the room rather than grind into the wall.
    const cx = view.arena.w / 2 - boss.x;
    const cy = view.arena.h / 2 - boss.y;
    const cmag = Math.sqrt(cx * cx + cy * cy);
    if (cmag > 0.001) return { type: 'move', dx: cx / cmag, dy: cy / cmag };
  }
  return { type: 'move', dx: dx, dy: dy };
}

/** Is (`x`, `y`) inside the strip along the arena edge where a `move` would clamp? */
function blocked(view, x, y) {
  return x < MARCH_EDGE || x > view.arena.w - MARCH_EDGE || y < MARCH_EDGE || y > view.arena.h - MARCH_EDGE;
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
    if (!blocked(view, boss.x + cx * MARCH_LOOK, boss.y + cy * MARCH_LOOK)) {
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
