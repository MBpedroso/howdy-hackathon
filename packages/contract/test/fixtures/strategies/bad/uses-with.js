export const meta = { name: 'Scope Bender', rationale: 'I confuse the scope chain.', version: 1 };
export function init() { return {}; }
export function decide(view, mem) {
  with (view.boss) {
    return { type: 'move', dx: 1, dy: 0 };
  }
}
