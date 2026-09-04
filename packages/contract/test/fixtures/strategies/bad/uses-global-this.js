export const meta = { name: 'Escape Artist', rationale: 'I look for the host.', version: 1 };
export function init() { return {}; }
export function decide(view, mem) {
  const host = globalThis;
  return host ? { type: 'idle' } : { type: 'idle' };
}
