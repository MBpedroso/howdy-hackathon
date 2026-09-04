// Reference strategy: the null boss. Baseline for harness calibration —
// win rate against this must be ~0 for every reference bot.
export const meta = {
  name: 'Statue',
  rationale: 'I do nothing, so you can measure everything else against me.',
  version: 1,
};

export function init() {
  return {};
}

export function decide(view, mem) {
  return { type: 'idle' };
}
