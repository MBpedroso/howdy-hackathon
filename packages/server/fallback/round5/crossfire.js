// Round 5 fallback — PRESSURE, by geometry.
//
// Most of this pool aims at where the player is, or at where they habitually stand.
// This one asks a different question — "which way can they still go?" — and then takes
// that away. It finds the wall the player is nearest to, walks to the *opposite* side
// of them, and squeezes: the slam goes into the escape lane between the player and open
// space rather than onto the player themselves, and the cone burst goes down the
// squeeze line, so dodging the shots means dodging into the wall.
//
// The arena is 800x800 and the player moves 3.6 px/tick against the boss's 2.6, so
// this can never be a trap the player cannot escape — they are always faster. What it
// costs them is the ground they wanted, and a player pressed into a corner has no room
// to read the next telegraph. The counter is to break the squeeze early and cross the
// middle, which is why this boss opens the middle to do it — and it works: a player who
// simply holds a long orbit and never lets the wall get behind them beats this boss
// 0.84 of the time, which is the widest hole of any Round 5 boss here.
//
// Measured through Gate 3 at 200 matches — `pnpm harness packages/server/fallback/round5/crossfire.js
// --round 5 --matches 200`:
//
//     panel 0.63   (Camper 1.00, Kiter 0.16, Rusher 0.64, Dodger 0.72)   band 0.55-0.70
//
// Reproducible: the seed set is fixed (`seedsFor`), and where this strategy rolls
// `rand()` that PRNG is seeded per match, so the numbers above are the same on every
// machine. `packages/server/test/fallback.test.ts` re-checks the band on every run at
// a reduced 60 matches; both counts sit at least 0.03 inside both edges.
export const meta = {
  name: 'Crossfire',
  rationale: 'I am not aiming at you. I am aiming at the only place you had left to stand.',
  version: 1,
};

const PIN_OFFSET = 250;      // how far off the player the pressing post sits
const CONE_MIN = 170;
const CONE_MAX = 460;
const LANE_LEAD = 120;       // how far up the escape lane the slam is placed
const CHARGE_MIN = 250;
const CHARGE_MAX = 420;
const RING_RANGE = 130;
const SPAWN_EVERY = 460;
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

  // 3. The cone down the squeeze line, so sidestepping it costs ground too.
  if (cd.burst === 0 && armed && dist > CONE_MIN && dist < CONE_MAX) {
    return { type: 'burst', angle: angle, count: 5 };
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
  if (tmag < 10) return { type: 'idle' };
  return { type: 'move', dx: tx / tmag, dy: ty / tmag };
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
