export const meta = { name: 'Clockwatcher', rationale: 'I read the wall clock.', version: 1 };
export function init() { return { t0: 0 }; }
export function decide(view, mem) {
  if (mem.t0 === 0) { mem.t0 = Date.now(); }
  return { type: 'idle' };
}
