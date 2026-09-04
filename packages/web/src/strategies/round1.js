// Round 1 — shipped, hand-written, balance-tested.
//
// Started as `@rematch/contract`'s `cornerbreaker` reference fixture with different
// `meta`, and now differs from it in one more way: its resting state is a patrol
// across the cell it is guarding rather than `idle` (see the note on note 4 below).
// The fixture stayed as it was — it is a *calibration* corpus for the harness, and
// `test/balance.test.ts` uses it as the counter-camper control — so the two files have
// deliberately parted company.
//
// It is the Round 1 boss because it is the fairest of the four fixtures against a
// human-shaped opponent: over 60 seeds with the engine's scripted mid-range player it
// loses every time in ~17 s, taking half a heart on the way -- winnable on a first try
// (spec AC 4), which is what Round 1 has to be, and every one of its threats is a
// readable telegraph. If playtesting says
// it is *too* soft, the fix is a harder Round 1 strategy (the `chaser` fixture sits at
// 63% player wins with 1.15 of 5 HP left), never a change to an engine constant.
//
// It is ALSO the honest starting point for the story: it already adapts, in-round, by
// reading `history.playerPosHeat`. The interlude's Coder agent replaces this file from
// Round 2 on; nothing else about the game changes when it does.
//
// Measured against the engine's scripted mid-range player over 60 seeds: player wins
// 1.00, average 16.6 s, 4.52 of 5 HP left — the same fight it was before the ACTIVE
// fixes. Against Gate 3's reference panel it is 0.60 (Camper 1.00, Kiter 0.00,
// Rusher 1.00, Dodger 0.40) with a longest motionless run of 1 tick, where it used to
// be 0.48 with a run of 169. Both halves of that shift are the same bug: while two
// minions were alive the boss asked for a third every tick, which the engine refuses
// at the cap — so it froze *and* never reached its own burst branch. Round 1 has no
// fairness band (it is the boss the player meets before any rewrite), and the number
// it is held to is the scripted player's, which has not moved.
export const meta = {
  name: 'Cornerbreaker',
  rationale: 'I watch which square of the floor you live in, and I slam that square.',
  version: 1,
};

// The resting patrol. `PATROL_RADIUS / PATROL_LEG` is 2.59 px/tick, just under the
// boss's own 2.6, so the boss tracks the patrol target exactly and is never left
// standing. 44 px is well inside a 100 px heat cell, so the boss still reads as
// guarding the square it slams.
const PATROL_LEG = 34;
/** Half the width of the patrol. `PATROL_LEG * 1.29` is 2.59 px/tick, just under
 *  the boss's own 2.6, so it tracks the target exactly instead of jittering around
 *  it — derived rather than typed, so `PATROL_LEG` alone is the dial. */
const PATROL_RADIUS = PATROL_LEG * 1.29;
/** How far the patrol's anchor is held off a wall, so no leg can clamp. */
const PATROL_MARGIN = PATROL_RADIUS + 34;
const PATROL_EDGE = 34;

/**
 * `spawn`'s own cooldown is 300 ticks, but a `spawn` refused at the two-minion cap
 * keeps its cooldown *and* costs a contract violation — so a boss that asks whenever
 * the cooldown is ready asks again every single tick for as long as both minions are
 * alive, and stands perfectly still doing it. That was 169 motionless ticks against
 * the reference panel, and it is why this cadence is a tick counter rather than a
 * cooldown check. Slower than the cooldown, on purpose.
 */
const SPAWN_EVERY = 380;

export function init() {
  return { targetCell: -1, refreshedAt: -1, lastSpawn: -999 };
}

export function decide(view, mem) {
  // Refresh the read of the heat map every second; it is a rolling summary.
  if (view.tick - mem.refreshedAt >= 60 || mem.targetCell < 0) {
    mem.targetCell = hottestCell(view.history.playerPosHeat);
    mem.refreshedAt = view.tick;
  }

  const cellW = view.arena.w / 8;
  const cellH = view.arena.h / 8;
  const col = mem.targetCell % 8;
  const row = (mem.targetCell - col) / 8;
  const hotX = clamp(col * cellW + cellW / 2, 0, view.arena.w);
  const hotY = clamp(row * cellH + cellH / 2, 0, view.arena.h);

  const boss = view.boss;
  if (boss.cooldowns.slam === 0) {
    return { type: 'slam', x: hotX, y: hotY };
  }
  if (boss.cooldowns.spawn === 0 && view.tick - mem.lastSpawn > SPAWN_EVERY) {
    mem.lastSpawn = view.tick;
    return { type: 'spawn', x: hotX, y: hotY };
  }

  const dx = view.player.x - boss.x;
  const dy = view.player.y - boss.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (boss.cooldowns.burst === 0 && dist < 300) {
    return { type: 'burst', angle: Math.atan2(dy, dx), count: 8 };
  }

  // 4. Otherwise walk to the hot cell and camp the camper — and once it is standing
  //    on the cell, patrol *across* it instead of stopping.
  //
  //    The earlier version returned `idle` here, and a human playtest is what found
  //    out what that means: a boss that has arrived at a stale hot cell, with the
  //    player out of burst range and both its cooldowns spent, stands perfectly
  //    still until something expires. Against the reference panel that was 169
  //    motionless ticks — nearly three seconds of a boss that reads as crashed —
  //    and no gate could see it, because `idle` is legal, free of cooldown, the
  //    cheapest possible `decide`, and a *stationary* boss is easy to shoot, so
  //    freezing actively helped the win rate stay in band. Gate 3's ACTIVE
  //    assertion exists now; `patrol` is what satisfies it.
  const tx = hotX - boss.x;
  const ty = hotY - boss.y;
  const tmag = Math.sqrt(tx * tx + ty * ty);
  if (tmag < 4) {
    return patrol(view, hotX, hotY);
  }
  return { type: 'move', dx: tx / tmag, dy: ty / tmag };
}

/**
 * The resting state: a triangle wave in x through (`ax`, `ay`), never `idle`.
 *
 * **Straight legs, on purpose.** A circular orbit was tried first, in the Round 2
 * candidate this pattern comes from, and it took that boss's panel win rate from
 * 0.38 to 0.72 — "too hard" — because every reference bot (and every competent
 * human) leads its shots off the boss's last-tick velocity, and a curve defeats a
 * linear lead permanently. A boss that is unhittable by construction is not a
 * harder boss, it is a broken one. A 34-tick straight leg is led correctly for 33
 * of its 34 ticks.
 *
 * The anchor is pulled `PATROL_MARGIN` away from the walls before the wave is
 * built: an un-clamped patrol across a corner cell spends a quarter of each cycle
 * walking into the arena edge, where a `move` displaces nothing and the boss is
 * just as motionless as if it had returned `idle`.
 */
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
  if (tmag < 0.001) {
    return { type: 'move', dx: phase < PATROL_LEG ? 1 : -1, dy: 0 };
  }
  return { type: 'move', dx: tx / tmag, dy: ty / tmag };
}

function hottestCell(heat) {
  let best = 0;
  let bestValue = -1;
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
