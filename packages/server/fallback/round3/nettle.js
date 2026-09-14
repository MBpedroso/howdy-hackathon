// Round 3 fallback — AMBUSH.
//
// A boss that throws nothing at all. Every cooldown is *held* while it stalks the
// player at walking pace, and the moment they come inside the trigger radius it
// spends all of them at once — a full ring burst on the spot plus a slam centred on
// its own feet. There is no poke, no zoning and no chase; there is one radius, and
// crossing it is the whole fight.
//
// That makes it a lesson rather than a difficulty setting: it eats aggression alive,
// and refusing the trade is still the counter — but as of 2026-09-11 refusing it is
// no longer free. Take the trade and it wins it.
//
// ## Retuned 2026-09-11, for round 3's new band (spec §13, delta 24)
//
// Round 3's band moved to 0.50-0.65 and this boss measured exactly 0.50 — on the
// floor, with no margin at all. The dials could not fix that and it is worth being
// precise about why: `TRIGGER` 200 -> 260 and `SPAWN_EVERY` 420 -> 300 moved the panel
// rate by 0.02 and 0.00, because neither addresses the reason a kiting or dodging
// player scored 0.00 against it. A boss that walks straight at a player who walks
// 3.6 px/tick to its 2.6 is not slow, it is *behind* — pure pursuit never closes, so
// the ambush radius never fires at anyone who keeps moving.
//
// So the fix is where the boss walks, not what it throws: `ambushPoint` aims the stalk
// at the player's lead, or at the cell the heat map says they keep coming back to,
// whichever is nearer. It throws exactly what it threw before. Kiter 0.00 -> 0.20 and
// Dodger 0.00 -> 0.12 are the whole difference, and `CUT_CHANCE` is the dial that
// keeps it inside the band — cutting on every breath measures 0.77, which is a round 5
// boss wearing a round 3 file.
//
// Measured through Gate 3 at 200 matches — `pnpm harness packages/server/fallback/round3/nettle.js
// --round 3 --matches 200`:
//
//     panel 0.58   (Camper 1.00, Kiter 0.20, Rusher 1.00, Dodger 0.12)   band 0.50-0.65
//     0.600 at the 120 matches `fallback.test.ts` re-checks, so both counts sit
//       at least 0.05 inside both edges
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
  rationale: 'I never throw anything. I just walk to where you are going and wait for you there.',
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
/** Ticks the lead may look ahead. Past this the player has turned and the guess is
 *  worse than no guess at all. */
const LEAD_CAP = 90;
// The balance dial, and the boss's one tell. Once per breath it rolls whether the
// ambush is laid or merely walked: on a quiet breath it plods straight at the player,
// which is the pursuit that never catches anyone, and the player gets a stretch of the
// round in which walking away is free. `rand()` is the engine's seeded PRNG, so a match
// still replays byte-for-byte while the player cannot count the breaths to safety.
//
// It is here because cutting is not a threshold, it is the whole difference between
// this boss and a boss that cannot land anything: measured at 200 matches, always
// cutting puts it at 0.77 against the panel and never cutting at 0.50, with the four
// bots' rates near-binary in between. A per-breath roll is the one knob that moves the
// rate continuously — the same finding `curfew.js` records for its own dial.
const BREATH = 150;
const CUT_CHANCE = 0.75;

export function init() {
  return { hot: -1, refreshedAt: -1, lastSpawn: -999, breath: -1, cutting: true };
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

  // 4. Stalk — by cutting, not by chasing. Never dash, never charge: the walk is the
  //    tell, and a player who reads it simply walks away faster than the boss can
  //    follow. That is also why a straight chase is worthless here: the boss walks
  //    2.6 px/tick and the player 3.6, so pure pursuit is permanently behind and the
  //    ambush radius never closes on anyone who keeps moving. It walks at where they
  //    are *going* instead (`ambushPoint`), which is the only way a slower body ever
  //    arrives first. Once it is inside arm's reach it circles instead of stopping —
  //    waiting is the design, standing perfectly still is a boss that reads as crashed
  //    (and the earlier version of this branch spent 57% of a typical match doing
  //    exactly that).
  if (dist <= STALK_STOP || dist < 0.001) return strafe(view, angle);
  const breath = Math.floor(view.tick / BREATH);
  if (mem.breath !== breath) {
    mem.breath = breath;
    mem.cutting = rand() < CUT_CHANCE;
  }
  if (mem.cutting !== true) return { type: 'move', dx: dx / dist, dy: dy / dist };
  const aim = ambushPoint(view, mem, dist);
  const ax = aim.x - boss.x;
  const ay = aim.y - boss.y;
  const amag = Math.sqrt(ax * ax + ay * ay);
  if (amag < STALK_STOP) return strafe(view, angle);
  return { type: 'move', dx: ax / amag, dy: ay / amag };
}

/**
 * Where to walk so the player arrives too.
 *
 * Two readings of "where they are going", and the boss takes whichever is nearer:
 *
 *  - The **lead**: their position after the time it takes the boss to walk there, at
 *    2.6 px/tick, solved by one iteration. Exact for a straight line and a decent
 *    guess for a circle.
 *  - The **habit**: the hottest cell of `history.playerPosHeat`, which is the one
 *    thing in the view that describes the player rather than the tick. A player who
 *    keeps returning to the same corner is ambushed by standing in it — and unlike
 *    the lead, that works against someone whose velocity says nothing because they
 *    are circling.
 *
 * Neither makes the boss faster. Both make it early, which is the whole design: this
 * boss cannot catch anyone, so the ground has to.
 */
function ambushPoint(view, mem, dist) {
  const boss = view.boss;
  const player = view.player;
  const BOSS_SPEED = 2.6;
  const vx = typeof player.vx === 'number' && isFinite(player.vx) ? player.vx : 0;
  const vy = typeof player.vy === 'number' && isFinite(player.vy) ? player.vy : 0;
  let t = dist / BOSS_SPEED;
  if (t > LEAD_CAP) t = LEAD_CAP;
  const leadX = clamp(player.x + vx * t, 0, view.arena.w);
  const leadY = clamp(player.y + vy * t, 0, view.arena.h);

  if (view.tick - mem.refreshedAt >= REFRESH || mem.hot < 0) {
    mem.hot = hottestCell(view.history.playerPosHeat);
    mem.refreshedAt = view.tick;
  }
  const cellW = view.arena.w / 8;
  const cellH = view.arena.h / 8;
  const col = mem.hot % 8;
  const row = (mem.hot - col) / 8;
  const hotX = clamp(col * cellW + cellW / 2, 0, view.arena.w);
  const hotY = clamp(row * cellH + cellH / 2, 0, view.arena.h);

  const dLead = Math.sqrt((leadX - boss.x) * (leadX - boss.x) + (leadY - boss.y) * (leadY - boss.y));
  const dHot = Math.sqrt((hotX - boss.x) * (hotX - boss.x) + (hotY - boss.y) * (hotY - boss.y));
  return dHot < dLead ? { x: hotX, y: hotY } : { x: leadX, y: leadY };
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
