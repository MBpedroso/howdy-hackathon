// Rejected by Gate 2: returns the primitive's *name* instead of an action object.
// A real Coder-agent mistake, and one the validator has to catch every time.
export const meta = {
  name: 'Stringly Typed',
  rationale: 'I return the name of the move I want and hope for the best.',
  version: 1,
};

export function init() {
  return {};
}

export function decide(view, mem) {
  if (view.boss.cooldowns.burst === 0) {
    return 'burst';
  }
  return 'idle';
}
