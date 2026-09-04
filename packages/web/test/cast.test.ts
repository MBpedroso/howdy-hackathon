/**
 * The cast, as data: the three agents, their accents, and the placeholder portrait.
 *
 * Worth testing because two of these are contracts with things outside the code —
 * the accents are the human's chosen palette (2026-09-04) and the portrait path is
 * where a human drops PNGs generated separately. A typo in either is invisible on
 * screen until the art lands and then reads as "the portraits are broken".
 */
import { describe, expect, it } from 'vitest';

import { AGENTS, CAST, iconSvg, placeholderSvg, portraitUrl, type AgentId } from '../src/ui/cast.ts';

describe('the cast', () => {
  it('is Analyst, Coder, Judge — in the order they act', () => {
    expect(CAST.map((a) => a.id)).toEqual(['analyst', 'coder', 'judge']);
  });

  it('holds the accents the human chose', () => {
    expect(AGENTS.analyst.accent).toBe('#2DD4BF');
    expect(AGENTS.coder.accent).toBe('#F59E0B');
    expect(AGENTS.judge.accent).toBe('#EF4444');
    expect(AGENTS.boss.accent).toBe('#C026D3');
  });

  // The project's whole argument. Exactly one member of the cast is not a model,
  // and the start screen renders its card differently off this flag.
  it('marks the Judge, and only the Judge, as deterministic', () => {
    expect(CAST.filter((a) => a.deterministic === true).map((a) => a.id)).toEqual(['judge']);
    expect(AGENTS.judge.role).toContain('Not an AI');
  });

  it('gives each one a role in plain language, no jargon', () => {
    for (const agent of CAST) {
      expect(agent.role.length).toBeGreaterThan(20);
      expect(agent.role.endsWith('.')).toBe(true);
      expect(agent.role.toLowerCase()).not.toContain('llm');
    }
  });
});

describe('portraitUrl', () => {
  it('points at public/agents/<id>.png under the site base', () => {
    expect(portraitUrl('analyst', '/')).toBe('/agents/analyst.png');
    expect(portraitUrl('coder', './')).toBe('./agents/coder.png');
    // A subpath deploy: the same shape as `interlude/recorded.ts`'s asset URLs.
    expect(portraitUrl('judge', '/rematch/')).toBe('/rematch/agents/judge.png');
    // A base without its trailing slash must not produce `…agentsjudge.png`.
    expect(portraitUrl('boss', '/rematch')).toBe('/rematch/agents/boss.png');
    expect(portraitUrl('boss', '')).toBe('./agents/boss.png');
  });
});

describe('placeholderSvg', () => {
  const ids: AgentId[] = ['analyst', 'coder', 'judge', 'boss'];

  it('is a complete, self-contained SVG for every member', () => {
    for (const id of ids) {
      const svg = placeholderSvg(id);
      expect(svg.startsWith('<svg viewBox="0 0 64 64"')).toBe(true);
      expect(svg.endsWith('</svg>')).toBe(true);
      // Carries its own colours, so it renders correctly with no CSS at all.
      expect(svg).toContain(AGENTS[id].accent);
      // The dark navy the shipped portraits are generated against, so the swap
      // does not change the panel's ground colour.
      expect(svg).toContain('#0B0F1A');
      // Labelled for a screen reader; it stands in for a portrait of a character.
      expect(svg).toContain(`aria-label="${AGENTS[id].name}"`);
    }
  });

  it('draws a different icon per member, so they are not four grey squares', () => {
    const drawings = new Set(ids.map((id) => placeholderSvg(id)));
    expect(drawings.size).toBe(4);
  });

  // The Judge's square is machined: a dashed rule the other two do not have.
  it('marks the deterministic one mechanically', () => {
    expect(placeholderSvg('judge')).toContain('stroke-dasharray');
    expect(placeholderSvg('analyst')).not.toContain('stroke-dasharray');
  });
});

describe('iconSvg', () => {
  it('draws a bare icon in the colour it is given', () => {
    const svg = iconSvg('target', '#4de2b0');
    expect(svg).toContain('#4de2b0');
    expect(svg).toContain('aria-hidden="true"');
    // No ground and no silhouette: a step label is not a character.
    expect(svg).not.toContain('#0B0F1A');
  });
});
