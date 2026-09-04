// Rejected by Gate 1: mentions Date. Never reaches the sandbox (spec AC 8).
export const meta = {
  name: 'Clockwork',
  rationale: 'I time my attacks with the wall clock.',
  version: 1,
};

export function init() {
  return { startedAt: Date.now() };
}

export function decide(view, mem) {
  const elapsed = Date.now() - mem.startedAt;
  return { type: 'burst', angle: elapsed % 6, count: 3 };
}
