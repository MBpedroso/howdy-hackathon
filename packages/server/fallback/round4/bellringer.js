// Round 4 fallback — CHARGE.
//
// The `charge` primitive is the only thing in the contract that closes 300 px in one
// commitment, and this is the only boss in the pool built around it. Charge, ring,
// withdraw: it saves the charge for exactly the range where 300 px of travel arrives,
// throws it down the player's *lead* rather than at their feet, cashes the arrival
// with a ring burst at contact, then walks back out to reload the runway.
//
// Worth knowing before tuning it: the charge is the boss's *character*, not the source
// of its win rate. Measured against the panel, this boss beats a kiting player only
// 0.28 of the time — less than the zone boss in this same round, which never charges
// at all and reaches distance with a standing minion instead. Closing the gap and
// winning once you are there are two different problems, and the charge only solves
// the first.
//
// The loop is deliberately loud: 20 ticks of telegraph on the charge, 40 on the slam,
// so the player is told twice. The counter is the dash — 10 invulnerable ticks, which
// beats both tells if it is spent on the right frame. A Round 4 boss should demand the
// dash, and this one does; the Rusher bot, which dashes through everything, holds it
// to 0.24.
//
// Measured through Gate 3 at 200 matches — `pnpm harness packages/server/fallback/round4/bellringer.js
// --round 4 --matches 200`:
//
//     panel 0.54   (Camper 1.00, Kiter 0.28, Rusher 0.24, Dodger 0.64)   band 0.50-0.65
//
// Reproducible: the seed set is fixed (`seedsFor`), and where this strategy rolls
// `rand()` that PRNG is seeded per match, so the numbers above are the same on every
// machine. `packages/server/test/fallback.test.ts` re-checks the band on every run at
// a reduced 60 matches; both counts sit at least 0.03 inside both edges.
export const meta = {
  name: 'Bellringer',
  rationale: 'Distance is not a plan. I will cross it, ring the bell in your face, and walk back out.',
  version: 1,
};

const CHARGE_MIN = 230;      // below this the charge overshoots and wastes 150 ticks
const CHARGE_MAX = 430;      // above it, 300 px of travel does not arrive
const CHARGE_LEAD = 24;      // charge telegraphs 20 ticks; lead by a little more
const RING_RANGE = 165;      // where a ring beats a cone
const CONE_MIN = 250;
const SLAM_LEAD = 30;
const STANDOFF = 300;
const SPAWN_EVERY = 1000;
// The balance dial, and the boss's rhythm. Once per breath it rolls whether it is
// hunting or resting; `rand()` is the engine's seeded PRNG, so a match replays
// byte-for-byte while the player still cannot count the beats to safety. A short
// breath matters as much as the odds: 40 rolls a match average out, where 24 long
// ones let a single unlucky stretch decide the whole round.
const BREATH = 90;
const HUNT_CHANCE = 0.45;

export function init() {
  return { lastSpawn: -999, charges: 0, breath: -1, hunting: true };
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
    return { type: 'burst', angle: angle, count: 8 };
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
    return { type: 'burst', angle: angle, count: 5 };
  }

  // 5. A minion behind the player, cutting the retreat the charge pushes them into.
  //    Deliberately rare — roughly three in a whole round, and this cadence is the
  //    balance dial that actually moves. Measured: `SPAWN_EVERY` 460 (a minion nearly
  //    always standing) put this boss at 0.70 against the panel, 1000 puts it at 0.54,
  //    and never spawning at all drops it to 0.28. The pets, not the charge, are what
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
    return { type: 'move', dx: -dx / dist, dy: -dy / dist };
  }
  if (dist > STANDOFF && dist > 0.001) {
    return { type: 'move', dx: dx / dist, dy: dy / dist };
  }
  return { type: 'idle' };
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
