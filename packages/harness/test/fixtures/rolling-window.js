// Feasibility fixture for analysis item 1 / open question Q2
// (`docs/ANALYSIS-learning-signal-2026-09-09.md`): "can a strategy actually afford
// a rolling window in `mem`?" `harnessHints` (`packages/agents/src/context/prompts.ts`)
// now tells the Coder to push the player's cell index into a ~60-entry ring every
// ~10 ticks and aim at the ring's centroid instead of only the lifetime-cumulative
// heat map. Whether a *model* writes that reliably is spend-gated (no eval runs
// here, `REMATCH_ALLOW_SPEND` stays unset) — but whether the *pattern* fits inside
// the contract's 4 KB memory cap and 2 ms `decide` budget is answerable for free,
// by hand, through the harness. This file is that hand-written proof, and
// `harness/test/rollingWindow.test.ts` is the measurement.
//
// It is not tuned to land in any fairness band and is not asserted against Gate 3:
// the only claim this file makes is "the ring buffer mechanics are cheap enough",
// so only Gates 1, 2 and 4 are the ones that matter for it.
export const meta = {
  name: 'Rolling Window (fixture)',
  rationale:
    'Keeps a 60-entry ring of the player cell in mem, sampled every 10 ticks, and aims at its centroid rather than the lifetime-cumulative map — proof the pattern fits the 4KB/2ms budget.',
  version: 1,
};

const GRID = 8;
/** 10 ticks/sample x 60 samples = 600 ticks = 10 s at 60 ticks/s — the window the
 *  prompt hint asks for ("the last 10 s, not the lifetime peak"). */
const PUSH_EVERY_TICKS = 10;
const RING_SIZE = 60;
const HOLD_RANGE = 260;
const BURST_MIN_RANGE = 220;
const BURST_MAX_RANGE = 420;
const PATROL_RADIUS = 44;
const PATROL_LEG = 34;

export function init() {
  // Fixed-length and pre-filled with -1 ("never sampled"), not grown with
  // push/shift: a fixed array serializes to the same byte count on tick 1 and on
  // tick 3599, which is what makes the memory-cap check a one-time fact rather
  // than something that could grow into a rejection mid-round.
  const ring = new Array(RING_SIZE);
  for (let i = 0; i < RING_SIZE; i = i + 1) ring[i] = -1;
  return { ring: ring, head: 0, filled: 0 };
}

function cellOf(x, y, arenaW, arenaH) {
  const col = Math.min(GRID - 1, Math.max(0, Math.floor((x / arenaW) * GRID)));
  const row = Math.min(GRID - 1, Math.max(0, Math.floor((y / arenaH) * GRID)));
  return row * GRID + col;
}

function cellCentre(cell, arenaW, arenaH) {
  const col = cell % GRID;
  const row = (cell - col) / GRID;
  return { x: (col + 0.5) * (arenaW / GRID), y: (row + 0.5) * (arenaH / GRID) };
}

/** The centroid of every valid ring entry, or the arena's centre before the first sample lands. */
function recentCentroid(ring, arenaW, arenaH) {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let i = 0; i < ring.length; i = i + 1) {
    const cell = ring[i];
    if (cell < 0) continue;
    const c = cellCentre(cell, arenaW, arenaH);
    sx = sx + c.x;
    sy = sy + c.y;
    n = n + 1;
  }
  if (n === 0) return { x: arenaW / 2, y: arenaH / 2 };
  return { x: sx / n, y: sy / n };
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function decide(view, mem) {
  const boss = view.boss;
  const player = view.player;
  const cd = boss.cooldowns;

  // 1. Sample every ~10 ticks into the ring, overwriting the oldest entry —
  //    `head` wraps rather than the array growing, which is the whole trick that
  //    keeps this cheap: no shift(), no allocation, one write per sample tick.
  if (view.tick % PUSH_EVERY_TICKS === 0) {
    mem.ring[mem.head] = cellOf(player.x, player.y, view.arena.w, view.arena.h);
    mem.head = (mem.head + 1) % RING_SIZE;
    mem.filled = Math.min(RING_SIZE, mem.filled + 1);
  }

  // 2. Aim at the ring's centroid — the last ~10 s of the player, not their
  //    lifetime habit. This fixture does not even read `history.playerPosHeat`:
  //    proving the ring alone carries a usable target is the point of it.
  const target = recentCentroid(mem.ring, view.arena.w, view.arena.h);
  const dx = player.x - boss.x;
  const dy = player.y - boss.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const tdx = target.x - boss.x;
  const tdy = target.y - boss.y;
  const tdist = Math.sqrt(tdx * tdx + tdy * tdy);
  const cellW = view.arena.w / GRID;
  const nearTarget = Math.abs(boss.x - target.x) < cellW && Math.abs(boss.y - target.y) < cellW;

  if (cd.slam === 0 && nearTarget) {
    return { type: 'slam', x: clamp(target.x, 0, view.arena.w), y: clamp(target.y, 0, view.arena.h) };
  }
  if (cd.burst === 0 && tdist > BURST_MIN_RANGE && tdist < BURST_MAX_RANGE) {
    return { type: 'burst', angle: Math.atan2(tdy, tdx), count: 3 };
  }

  // 3. Never rest as `idle`: back off at contact range, otherwise patrol a
  //    straight-legged triangle wave across the target. `round2-candidate.js`'s
  //    note 5 has the measurement for why straight legs and not a curve — a
  //    curved patrol is unhittable by construction, which fails ACTIVE's span
  //    clause for the wrong reason.
  if (dist < HOLD_RANGE - 60) {
    const m = Math.max(dist, 0.001);
    return { type: 'move', dx: -dx / m, dy: -dy / m };
  }
  const phase = view.tick % (PATROL_LEG * 2);
  const leg = phase < PATROL_LEG ? phase : PATROL_LEG * 2 - phase;
  const px = target.x + ((leg / PATROL_LEG) * 2 - 1) * PATROL_RADIUS - boss.x;
  const py = target.y - boss.y;
  const pm = Math.sqrt(px * px + py * py);
  if (pm < 0.001) return { type: 'move', dx: phase < PATROL_LEG ? 1 : -1, dy: 0 };
  return { type: 'move', dx: px / pm, dy: py / pm };
}
