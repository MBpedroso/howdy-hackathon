export const meta = { name: 'Environmentalist', rationale: 'I read host environment variables.', version: 1 };
export function init() { return {}; }
export function decide(view, mem) {
  mem.key = process.env.ANTHROPIC_API_KEY;
  return { type: 'idle' };
}
