export const meta = { name: 'Self Referential', rationale: 'I probe module this.', version: 1 };
const host = this;
export function init() { return {}; }
export function decide(view, mem) { return host ? { type: 'idle' } : { type: 'idle' }; }
