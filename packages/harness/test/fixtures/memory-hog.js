// Rejected by Gate 2 as a memory failure: keeps every position it has ever seen,
// which passes the 4 KB serialized cap somewhere around tick 200.
export const meta = {
  name: 'Archivist',
  rationale: 'I remember every place you have ever stood.',
  version: 1,
};

export function init() {
  return { seen: [] };
}

export function decide(view, mem) {
  mem.seen.push([Math.round(view.player.x), Math.round(view.player.y), view.tick]);
  if (view.boss.cooldowns.slam === 0 && mem.seen.length > 0) {
    const last = mem.seen[mem.seen.length - 1];
    return { type: 'slam', x: last[0], y: last[1] };
  }
  return { type: 'idle' };
}
