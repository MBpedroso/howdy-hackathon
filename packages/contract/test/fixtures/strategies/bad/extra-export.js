export const meta = { name: 'Chatty', rationale: 'I export more than I should.', version: 1 };
export const secretTuning = { aggression: 9000 };
export function init() { return {}; }
export function decide(view, mem) { return { type: 'idle' }; }
