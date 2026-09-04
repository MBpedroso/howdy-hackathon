import { describe, expect, it } from 'vitest';
import { formatClock } from '../src/ui/hud.ts';

describe('formatClock', () => {
  it('counts down from the 60-second round cap', () => {
    expect(formatClock(0)).toBe('1:00');
    expect(formatClock(60)).toBe('0:59');
    expect(formatClock(3600)).toBe('0:00');
  });

  it('never goes negative', () => {
    expect(formatClock(99999)).toBe('0:00');
  });
});
