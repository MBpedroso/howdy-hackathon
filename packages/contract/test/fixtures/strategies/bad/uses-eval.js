export const meta = { name: 'Evaluator', rationale: 'I build code at runtime.', version: 1 };
export function init() { return {}; }
export function decide(view, mem) {
  const f = eval('(v) => ({ type: "idle" })');
  return f(view);
}
