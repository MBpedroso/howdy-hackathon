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
//     panel 0.42   (Camper 0.64, Kiter 1.00, Rusher 0.00, Dodger 0.04)   band 0.35-0.50
//
// Reproducible: the seed set is fixed (`seedsFor`), and where this strategy rolls
// `rand()` that PRNG is seeded per match, so the numbers above are the same on every
// machine. `packages/server/test/fallback.test.ts` re-checks the band on every run at
// a reduced 60 matches; both counts sit at least 0.03 inside both edges.
export const meta = {
  name: 'Metronome',
  rationale: 'One, two, three, slam. I have never once changed the count — you just have not started listening.',
  version: 1,
};

const BEAT = 72;             // ticks per beat
const SLAM_LEAD = 26;        // ticks of velocity lead on the slam
const CLOSE = 285;           // walks to here and no closer
const SPAWN_EVERY = 440;

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
    return { type: 'burst', angle: angle, count: dist < 230 ? 8 : 5 };
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
    return { type: 'move', dx: -dx / dist, dy: -dy / dist };
  }
  return { type: 'idle' };
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
