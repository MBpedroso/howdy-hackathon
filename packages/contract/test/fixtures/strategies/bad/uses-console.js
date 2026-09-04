export const meta = { name: 'Logger', rationale: 'I write to the host console.', version: 1 };
export function init() { return {}; }
export function decide(view, mem) {
  console.log('tick', view.tick);
  return { type: 'idle' };
}
