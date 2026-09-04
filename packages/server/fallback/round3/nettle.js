// Round 3 fallback — AMBUSH.
//
// A boss that throws nothing at all. Every cooldown is *held* while it stalks the
// player at walking pace, and the moment they come inside the trigger radius it
// spends all of them at once — a full ring burst on the spot plus a slam centred on
// its own feet. There is no poke, no zoning and no chase; there is one radius, and
// crossing it is the whole fight.
//
// That makes it a lesson rather than a difficulty setting: it eats aggression alive
// and it is completely helpless against distance, because nothing it does travels.
// Refuse the trade and it never lands a hit. Take the trade and it wins it.
//
// Measured through Gate 3 at 200 matches — `pnpm harness packages/server/fallback/round3/nettle.js
// --round 3 --matches 200`:
//
//     panel 0.50   (Camper 1.00, Kiter 0.00, Rusher 1.00, Dodger 0.00)   band 0.45-0.60
//     longest motionless run 1 tick of the 90 Gate 3's ACTIVE assertion allows
//
// The only strategy in the pool whose rates did not move at all when its resting `idle`
// became a strafe, and the reason is the design: the ambush is a *radius*, not a
// projectile, so circling inside it threatens exactly what standing inside it
// threatened. It needed the fix all the same — it used to spend 57% of a typical match
// perfectly still, waiting.
//
// Reproducible: the seed set is fixed (`seedsFor`), and where this strategy rolls
// `rand()` that PRNG is seeded per match, so the numbers above are the same on every
// machine. `packages/server/test/fallback.test.ts` re-checks the band on every run at
// a reduced 120 matches; both counts sit at least 0.03 inside both edges.
export const meta = {
  name: 'Nettle',
  rationale: 'I never throw anything. I just walk towards you and wait for you to come inside arm’s reach.',
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

const TRIGGER = 200;       // the ambush radius
const SLAM_TRIGGER = 165;
const STALK_STOP = 60;     // do not grind into the player's hitbox
const REFRESH = 60;
const SPAWN_EVERY = 420;

export function init() {
  return { hot: -1, refreshedAt: -1, lastSpawn: -999 };
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

  // 1. The trap closes: a slam centred on the boss itself, so it covers the ground
  //    the player has to stand on to keep shooting at this range.
  if (cd.slam === 0 && dist < SLAM_TRIGGER) {
    return { type: 'slam', x: clamp(boss.x, 0, aw), y: clamp(boss.y, 0, ah) };
  }

  // 2. A full ring, not a cone. At this distance a cone is a dodge to the side and a
  //    ring is not, which is the entire reason this boss beats anyone who charges it.
  if (cd.burst === 0 && dist < TRIGGER) {
    return { type: 'burst', angle: angle, count: 8 };
  }

  // 3. A herder posted on the habit, to make hiding at range less comfortable. This
  //    is the only pressure this boss applies from further away than its own arms.
  if (cd.spawn === 0 && view.tick - mem.lastSpawn > SPAWN_EVERY) {
    if (view.tick - mem.refreshedAt >= REFRESH || mem.hot < 0) {
      mem.hot = hottestCell(view.history.playerPosHeat);
      mem.refreshedAt = view.tick;
    }
    const cellW = aw / 8;
    const cellH = ah / 8;
    const col = mem.hot % 8;
    const row = (mem.hot - col) / 8;
    mem.lastSpawn = view.tick;
    return {
      type: 'spawn',
      x: clamp(col * cellW + cellW / 2, 0, aw),
      y: clamp(row * cellH + cellH / 2, 0, ah),
    };
  }

  // 4. Stalk. Never dash, never charge: the walk is the tell, and a player who reads
  //    it simply walks away faster than the boss can follow. Once it is inside arm's
  //    reach it circles instead of stopping — waiting is the design, standing
  //    perfectly still is a boss that reads as crashed (and the earlier version of
  //    this branch spent 57% of a typical match doing exactly that).
  if (dist <= STALK_STOP || dist < 0.001) return strafe(view, angle);
  return { type: 'move', dx: dx / dist, dy: dy / dist };
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
