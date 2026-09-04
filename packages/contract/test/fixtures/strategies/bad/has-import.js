import { clamp } from './helpers.js';

export const meta = { name: 'Importer', rationale: 'I pull in outside code.', version: 1 };
export function init() { return {}; }
export function decide(view, mem) {
  return { type: 'move', dx: clamp(1, 0, 1), dy: 0 };
}
