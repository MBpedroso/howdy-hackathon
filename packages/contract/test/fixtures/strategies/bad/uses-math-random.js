export const meta = { name: 'Dice Roller', rationale: 'I am unpredictable and unreplayable.', version: 1 };
export function init() { return {}; }
export function decide(view, mem) {
  return { type: 'charge', angle: Math.random() * 6.28 };
}
