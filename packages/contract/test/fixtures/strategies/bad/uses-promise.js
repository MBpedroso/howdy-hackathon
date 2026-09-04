export const meta = { name: 'Async Boss', rationale: 'I defer my decision.', version: 1 };
export function init() { return {}; }
export function decide(view, mem) {
  Promise.resolve().then(function () { mem.done = true; });
  return { type: 'idle' };
}
