export const meta = { name: 'Constructor', rationale: 'I compile a function body.', version: 1 };
export function init() { return {}; }
export function decide(view, mem) {
  const f = new Function('view', 'return { type: "idle" };');
  return f(view);
}
