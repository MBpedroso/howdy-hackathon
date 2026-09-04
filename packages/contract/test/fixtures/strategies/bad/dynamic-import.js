export const meta = { name: 'Lazy Loader', rationale: 'I import at runtime.', version: 1 };
export function init() { return {}; }
export function decide(view, mem) {
  import('node:fs').then(function () {});
  return { type: 'idle' };
}
