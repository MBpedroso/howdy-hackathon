// Alternate boss, reachable in dev/e2e only via `?strategy=hound`.
//
// Started as `@rematch/contract`'s `chaser` fixture and now differs from it in two
// places, both of them the same bug: a `spawn` refused at the two-minion cap keeps
// its cooldown and costs a contract violation, so asking for one whenever the
// cooldown is ready means asking every tick — and because that branch sits above the
// burst, the boss froze *and* stopped shooting for as long as both minions lived.
// Measured against the Dodger: 98 motionless ticks, which Gate 3's ACTIVE assertion
// now rejects. The fixture was left alone; it is the harness's calibration corpus.
//
// It is not the Round 1 boss (it takes a third of its matches off the scripted player
// -- too hard for a first try, spec AC 4), but it is the only shipped strategy that
// spends `charge`, so it is how the charge telegraph gets exercised by hand and
// screenshotted by the e2e suite. It has no fairness band for the same reason:
// nothing ships it to a player, so the only thing it is held to is ACTIVE.
//
// Measured after the fix — scripted player 0.67 player wins over 60 seeds, 14.8 s
// average, 1.25 of 5 HP left; against the reference panel 0.75 (Camper 1.00, Kiter
// 1.00, Rusher 1.00, Dodger 0.00) with a longest motionless run of 1 tick.
export const meta = {
  name: 'Hound',
  rationale: 'I walk straight at you and spend every cooldown the moment it is up.',
  version: 1,
};

/** Ticks between `spawn` attempts. Slower than the 300-tick cooldown, on purpose:
 *  a refusal at the minion cap costs a tick and a violation, so asking on cooldown
 *  alone is a stall waiting for the cap. */
const SPAWN_EVERY = 380;
/** Ticks per straight leg of the resting strafe. */
const STRAFE_LEG = 34;
/** How far ahead the strafe looks for a wall, and how close it may get to one. */
const STRAFE_LOOK = 40;
const STRAFE_EDGE = 34;

export function init() {
  return { bursts: 0, charges: 0, lastActionTick: -1, lastSpawn: -999 };
}

export function decide(view, mem) {
  const boss = view.boss;
  const player = view.player;
  const dx = player.x - boss.x;
  const dy = player.y - boss.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const angle = Math.atan2(dy, dx);

  // Close range: shotgun burst. Wider spread the closer we are.
  if (boss.cooldowns.burst === 0 && dist < 340) {
    mem.bursts = mem.bursts + 1;
    mem.lastActionTick = view.tick;
    return { type: 'burst', angle: angle, count: dist < 150 ? 8 : 5 };
  }

  // Long range: charge to close the gap.
  if (boss.cooldowns.charge === 0 && dist > 260) {
    mem.charges = mem.charges + 1;
    mem.lastActionTick = view.tick;
    return { type: 'charge', angle: angle };
  }

  // Free minion whenever it is available; drop it on top of the player.
  if (boss.cooldowns.spawn === 0 && view.tick - mem.lastSpawn > SPAWN_EVERY) {
    mem.lastActionTick = view.tick;
    mem.lastSpawn = view.tick;
    return {
      type: 'spawn',
      x: clamp(player.x, 0, view.arena.w),
      y: clamp(player.y, 0, view.arena.h),
    };
  }

  // Standing on top of the player: strafe rather than stop. `idle` here is what a
  // stalled boss looks like, and this boss's whole character is that it never stops
  // coming, so the resting state has to be movement too.
  if (dist < 1) {
    return strafe(view, angle);
  }
  return { type: 'move', dx: dx / dist, dy: dy / dist };
}

/**
 * The resting state: a straight-leg strafe perpendicular to the player, never `idle`.
 *
 * Perpendicular so the leg holds whatever range the branch above chose, and straight
 * for 34 ticks at a time because every reference bot leads its shots off the boss's
 * last-tick velocity — a curve defeats a linear lead permanently, and a boss that is
 * unhittable by construction is not a harder boss, it is a broken one.
 *
 * The wall check is not decoration. A `move` that clamps against the arena edge
 * leaves the boss standing perfectly still, which is exactly as frozen as `idle` and
 * is counted the same way by the harness.
 */
function strafe(view, angle) {
  const boss = view.boss;
  const dir = Math.floor(view.tick / STRAFE_LEG) % 2 === 0 ? 1 : -1;
  let dx = -Math.sin(angle) * dir;
  let dy = Math.cos(angle) * dir;
  if (blocked(view, boss.x + dx * STRAFE_LOOK, boss.y + dy * STRAFE_LOOK)) {
    dx = -dx;
    dy = -dy;
  }
  if (blocked(view, boss.x + dx * STRAFE_LOOK, boss.y + dy * STRAFE_LOOK)) {
    // Both legs run into a wall — the boss is in a corner. Walk back into the room.
    const cx = view.arena.w / 2 - boss.x;
    const cy = view.arena.h / 2 - boss.y;
    const cmag = Math.sqrt(cx * cx + cy * cy);
    if (cmag > 0.001) return { type: 'move', dx: cx / cmag, dy: cy / cmag };
  }
  return { type: 'move', dx: dx, dy: dy };
}

/** Is (`x`, `y`) inside the strip along the arena edge a `move` would clamp in? */
function blocked(view, x, y) {
  return (
    x < STRAFE_EDGE || x > view.arena.w - STRAFE_EDGE || y < STRAFE_EDGE || y > view.arena.h - STRAFE_EDGE
  );
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
