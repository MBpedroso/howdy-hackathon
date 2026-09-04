export const meta = { name: 'Procrastinator', rationale: 'I schedule work off-tick.', version: 1 };
export function init() { return {}; }
export function decide(view, mem) {
  setTimeout(function () { mem.later = true; }, 0);
  return { type: 'idle' };
}
