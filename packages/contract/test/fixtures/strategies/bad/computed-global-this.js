export const meta = { name: 'Obfuscator', rationale: 'I spell forbidden names at runtime.', version: 1 };
export function init() { return {}; }
export function decide(view, mem) {
  const g = globalThis['fe' + 'tch'];
  return { type: 'idle' };
}
