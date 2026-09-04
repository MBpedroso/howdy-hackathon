// Round 2 fallback — PRESSURE, on a fixed beat.
//
// The joke is the design: this boss does not read the player at all. It ignores the
// heat map, ignores the projectiles, ignores the range, and fires on a strict
// cadence — a slam on one beat, a burst on the next, a minion on the one after —
// forever, from wherever it happens to be standing. It is the only boss in the pool
// with no adaptation whatsoever.
//
// It still wins matches, and that is the interesting part: constant, predictable
// pressure beats a player who is not counting. It loses badly to anyone who *is*,
// because every beat is announced twice — once by the cadence and once by the
// engine's telegraph — so the counter is simply to be somewhere else on the beat.
// A Round 2 boss should be the one the player learns to read, and this is it.
//
// Measured through Gate 3 at 200 matches — `pnpm harness packages/server/fallback/round2/metronome.js
// --round 2 --matches 200`:
//
//     panel 0.46   (Camper 1.00, Kiter 0.52, Rusher 0.00, Dodger 0.32)   band 0.35-0.50
//     longest motionless run 0 ticks of the 90 Gate 3's ACTIVE assertion allows
//
// The off-beat used to be `idle`, which stood the boss still for up to 143 consecutive
// ticks. Marching instead cost the panel bots accuracy — a boss in motion is harder to
// lead — and took this boss to 0.57, so `SPAWN_EVERY` went from 440 to 900 to pay it
// back. Minions really are the strongest lever here: 700 measures 0.46, 1600 measures
// 0.36.
//
// Reproducible: the seed set is fixed (`seedsFor`), and where this strategy rolls
// `rand()` that PRNG is seeded per match, so the numbers above are the same on every
// machine. `packages/server/test/fallback.test.ts` re-checks the band on every run at
// a reduced 120 matches; both counts sit at least 0.03 inside both edges.
export const meta = {
  name: 'Metronome',
  rationale: 'One, two, three, slam. I have never once changed the count — you just have not started listening.',
  version: 1,
};

// The resting march, and why it is not `idle`.
//
// A boss that returns `idle` while it waits for its next beat stands perfectly still,
// and a human playtest reported that as a crash. Gate 3's ACTIVE assertion rejects it
// now: more than 90 motionless ticks (1.5 s) against any reference bot, or a p90 idle
// fraction over 0.25, and the strategy does not ship. This one marches a fixed square
// — one heading per leg, four legs, forever — because that is the only resting pattern
// that does not consult the player, and not consulting the player is the whole joke.
// Straight legs, not a circle: every reference bot leads its shots off the boss's
// last-tick velocity, and a curve defeats a linear lead permanently. The leg length
// is a balance dial in its own right, and a strong one — a shot crosses 300 px in ~27
// ticks, so a leg shorter than that means most shots are in flight across a turn and
// miss for free. Measured at 200 matches against the panel: 34-tick legs put this
// boss at 0.57, 68-tick legs at 0.51.
const MARCH_LEG = 68;       // ticks per side of the square
const MARCH_LOOK = 40;      // how far ahead the march checks for a wall
const MARCH_EDGE = 34;      // how close to the arena edge a leg may aim

const BEAT = 72;             // ticks per beat
const SLAM_LEAD = 26;        // ticks of velocity lead on the slam
const CLOSE = 285;           // walks to here and no closer
// Inside this the burst is a full ring instead of a cone. It is the balance dial:
// the march ignores the player, so the boss drifts in and out of ring range on its
// own, and a ring at contact is unanswerable (see the harness's own notes). Measured
// at 200 matches: 230 puts this boss at 0.57 against the panel, 150 at 0.42.
const RING_RANGE = 150;
const SPAWN_EVERY = 900;

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
