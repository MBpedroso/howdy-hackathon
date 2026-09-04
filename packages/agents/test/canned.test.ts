/**
 * The canned replays. These are the eval's inputs (spec §7), so what matters is
 * that they are *real* rounds and that they still describe distinguishable
 * players — a corpus of ten identical campers would make an 80% pass rate
 * meaningless.
 */
import { describe, expect, it } from 'vitest';
import { CANNED_NAMES, loadAllCanned, loadCanned, renderSummary } from '../src/index.ts';

describe('canned replays', () => {
  const all = loadAllCanned();

  it('has ten of them', () => {
    expect(CANNED_NAMES).toHaveLength(10);
    expect(all).toHaveLength(10);
  });

  it('is every one a round the player won — the only kind that reaches the interlude', () => {
    for (const canned of all) {
      expect(canned.summary.outcome, canned.name).toBe('playerWon');
      expect(canned.summary.boss.hpEnd, canned.name).toBe(0);
    }
  });

  it('carries the boss strategy each one was played against', () => {
    for (const canned of all) {
      expect(canned.bossStrategy, canned.name).toContain('export function decide');
    }
  });

  it('describes distinguishable players', () => {
    const peaks = all.map((c) => Math.max(...c.summary.history.playerPosHeat));
    // The campers concentrate almost all of their dwell time in one cell; the
    // mobile archetypes spread it. If this ever collapses, the corpus is measuring
    // one player ten times.
    expect(Math.max(...peaks)).toBeGreaterThan(0.6);
    expect(Math.min(...peaks)).toBeLessThan(0.2);

    const dashes = all.map((c) => c.summary.player.dashes);
    expect(Math.max(...dashes)).toBeGreaterThan(5);
    expect(Math.min(...dashes)).toBe(0);
  });

  it('renders into a prompt-sized block for every one', () => {
    for (const canned of all) {
      const rendered = renderSummary(canned.summary, { round: 1 });
      expect(rendered.length, canned.name).toBeLessThan(12_000);
      expect(rendered, canned.name).toContain('PLAYER POSITION HEAT MAP');
    }
  });

  it('is a real summary shape, not hand-written JSON', () => {
    const one = loadCanned('camper-a').summary;
    expect(one.history.playerPosHeat).toHaveLength(64);
    expect(one.history.playerDashDirs).toHaveLength(8);
    expect(Object.keys(one.history.playerShotsDuring).sort()).toEqual([
      'burst',
      'charge',
      'move',
      'slam',
      'spawn',
    ]);
    expect(one.timeline.length).toBeGreaterThan(0);
    expect(one.timelineTotal).toBeGreaterThanOrEqual(one.timeline.length);
  });
});
