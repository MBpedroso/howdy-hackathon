export const meta = { name: 'Defaulter', rationale: 'I use a default export.', version: 1 };
export function init() { return {}; }
export function decide(view, mem) { return { type: 'idle' }; }
export default decide;
