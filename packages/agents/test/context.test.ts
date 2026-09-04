/**
 * Context assembly, including the **denial** tests — the ones that make spec §8's
 * "context it is denied" column a property of the build rather than an intention.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  analystPrompt,
  cellCentre,
  coderPrompt,
  contractDoc,
  harnessRules,
  promptSize,
  renderDashRose,
  renderHeatGrid,
  renderShotsDuring,
  renderSummary,
  renderTimeline,
  type Analysis,
} from '../src/index.ts';
import { cannedSummary, readGood } from './helpers.ts';

const ANALYSIS: Analysis = {
  observations: [
    'Lived in cell 63 (x=750, y=750) for 93% of the round.',
    'Fired 163 shots and never dashed once.',
    'Never took a point of damage.',
  ],
  playerArchetype: 'camper',
  counterPlan: 'Put every slam on the bottom-right corner and hold mid range so the corner is never safe.',
};

/**
 * Every name `@rematch/engine` exports, read from its barrel file at test time.
 *
 * Reading the real barrel rather than hardcoding a list is the point: when someone
 * adds an engine export, this test starts checking for it without anyone
 * remembering to update it.
 */
function engineExportNames(): string[] {
  const src = readFileSync(new URL('../../engine/src/index.ts', import.meta.url), 'utf8');
  const names = new Set<string>();
  for (const block of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const raw of (block[1] ?? '').split(',')) {
      const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]?.trim();
      if (name !== undefined && name.length > 0) names.add(name);
    }
  }
  return [...names].sort();
}

/**
 * Engine exports whose *name* is also an ordinary word of the domain, so a hit on
 * them proves nothing. `replay` is the only one: the Coder is told the Mimic is
 * "rebuilt from this player's replay", which is the concept, not `engine.replay`.
 * Every other export — `step`, `cloneState`, `ENGINE_CONSTANTS`, `hashState` — is
 * an identifier and must not appear at all.
 */
const GENERIC_WORDS = new Set(['replay']);

describe('the Coder is denied the engine', () => {
  const prompt = coderPrompt({ analysis: ANALYSIS, prevSource: readGood('cornerbreaker'), round: 2 });
  const text = [prompt.system, ...prompt.messages.map((m) => m.content)].join('\n');

  it('mentions no engine export name', () => {
    const leaked = engineExportNames()
      .filter((name) => !GENERIC_WORDS.has(name))
      .filter((name) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text));
    expect(leaked).toEqual([]);
  });

  it('contains none of the engine internals the spec names explicitly', () => {
    for (const needle of ['step(', 'cloneState', 'PLAYER_HP', 'ENGINE_CONSTANTS', 'createGame', 'hashState', 'nativeRunner', 'buildBossView']) {
      expect(text).not.toContain(needle);
    }
  });

  it('mentions no renderer or server concept', () => {
    // Word-boundary matched: `expressible` legitimately appears in the doc, and a
    // substring check would read it as the web framework.
    for (const needle of ['canvas', 'requestAnimationFrame', 'express', 'EventSource', 'fastify', 'localhost', 'http']) {
      expect(text).not.toMatch(new RegExp(`\\b${needle}\\b`, 'i'));
    }
  });

  it('does contain the contract it is allowed to see', () => {
    expect(text).toContain('BossAction');
    expect(text).toContain('BossView');
    expect(text).toContain('playerPosHeat');
    expect(text).toContain('export function decide');
  });
});

describe('the Analyst is denied all code', () => {
  const prevSource = readGood('cornerbreaker');
  const prompt = analystPrompt({ summary: cannedSummary('camper-a'), round: 1 });
  const text = [prompt.system, ...prompt.messages.map((m) => m.content)].join('\n');

  it('does not contain the previous strategy source', () => {
    expect(text).not.toContain('export function decide');
    expect(text).not.toContain(prevSource.slice(0, 200));
  });

  it('does not contain the Boss Contract', () => {
    expect(text).not.toContain('BossAction');
    expect(text).not.toContain(contractDoc().slice(0, 200));
  });

  it('does not contain a code fence', () => {
    expect(text).not.toContain('```');
  });

  it('mentions no engine export name', () => {
    const leaked = engineExportNames()
      .filter((name) => !GENERIC_WORDS.has(name))
      .filter((name) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text));
    expect(leaked).toEqual([]);
  });

  it('does contain what it is supposed to read', () => {
    expect(text).toContain('PLAYER POSITION HEAT MAP');
    expect(text).toContain('DASH DIRECTIONS');
    expect(text).toContain('SHOTS DURING EACH BOSS PRIMITIVE');
    expect(text).toContain('TIMELINE');
    expect(text).toContain('playerArchetype');
  });
});

describe('prompt sizes', () => {
  const summary = cannedSummary('kiter-b');

  it('keeps the Analyst prompt small', () => {
    const prompt = analystPrompt({ summary, round: 1 });
    expect(prompt.system.length).toBeLessThan(12_000);
    expect(promptSize(prompt)).toBeLessThan(12_000);
  });

  it('keeps the Coder prompt inside 12k per part, first attempt and retry', () => {
    const first = coderPrompt({ analysis: ANALYSIS, prevSource: readGood('orbiter'), round: 2 });
    const retry = coderPrompt({
      analysis: ANALYSIS,
      prevSource: readGood('orbiter'),
      round: 2,
      rejection: { gate: 'balance', gateNumber: 3, reason: '0.91 vs panel — too hard', attempt: 1 },
    });
    for (const prompt of [first, retry]) {
      expect(prompt.system.length).toBeLessThan(12_000);
      expect(prompt.messages[0]!.content.length).toBeLessThan(12_000);
    }
    // The retry only adds the rejection block; it must not balloon the context.
    expect(promptSize(retry) - promptSize(first)).toBeLessThan(600);
  });

  it('reuses one byte-identical system prompt across attempts, so it can be cached', () => {
    const a = coderPrompt({ analysis: ANALYSIS, prevSource: readGood('idle'), round: 2 });
    const b = coderPrompt({
      analysis: ANALYSIS,
      prevSource: readGood('chaser'),
      round: 2,
      rejection: { gate: 'fuzz', gateNumber: 2, reason: 'threw', attempt: 1 },
    });
    expect(a.system).toBe(b.system);
  });
});

describe('the rejection reason reaches the Coder verbatim', () => {
  it('quotes the harness sentence exactly, and puts it last', () => {
    const reason =
      "0.91 vs panel — too hard (band 0.35–0.50 for round 2; Camper 1.00, Kiter 0.96, Rusher 0.92, Dodger 0.76); 0.41 vs Mimic — didn't adapt (need >= 0.70)";
    const prompt = coderPrompt({
      analysis: ANALYSIS,
      prevSource: readGood('chaser'),
      round: 3,
      rejection: { gate: 'balance', gateNumber: 3, reason, attempt: 2 },
    });
    const content = prompt.messages[0]!.content;
    expect(content).toContain(reason);
    expect(content).toContain('ATTEMPT 2 WAS REJECTED BY GATE 3 (balance)');
    // Nothing but the closing instruction may follow it.
    expect(content.indexOf(reason)).toBeGreaterThan(content.length - 400);
  });
});

describe('harnessRules', () => {
  it('states the round\'s band and both assertions', () => {
    const rules = harnessRules(4);
    expect(rules).toContain('0.50–0.65');
    expect(rules).toContain('round 4');
    expect(rules).toContain('ADAPTED');
    expect(rules).toContain('FAIR');
    expect(rules).toContain('>= 0.70');
  });

  it('names every gate', () => {
    const rules = harnessRules(2);
    for (const gate of ['Gate 1 — static', 'Gate 2 — contract fuzz', 'Gate 3 — balance', 'Gate 4 — perf']) {
      expect(rules).toContain(gate);
    }
  });
});

describe('contractDoc', () => {
  it('is memoized and stable', () => {
    expect(contractDoc()).toBe(contractDoc());
  });

  it('carries the contract, the limits and the forbidden names', () => {
    const doc = contractDoc();
    expect(doc).toContain('BossAction');
    expect(doc).toContain('validateAction');
    expect(doc).toContain('`Date`');
    expect(doc).toContain('800x800');
    expect(doc).toContain('burst 90');
  });

  it('does not pay twice for the type shapes', () => {
    // `## API` already contains both `###` subsections; if the section list ever
    // double-counts them, the doc grows by ~1.8 KB and this catches it.
    const doc = contractDoc();
    const occurrences = doc.split('### What Gate 1 deliberately does not do').length - 1;
    expect(occurrences).toBe(1);
  });
});

describe('renderers', () => {
  it('renders the heat map peak-relative, so a secondary pattern survives', () => {
    const heat = new Array<number>(64).fill(0);
    heat[63] = 0.9;
    heat[0] = 0.1;
    const grid = renderHeatGrid(heat);
    const rows = grid.split('\n');
    expect(rows).toHaveLength(9);
    expect(rows[1]).toContain('1');
    expect(rows[8]).toContain('9');
    // Cells never visited are dots, not zeroes: absence should read as absence.
    expect(rows[4]?.slice('y=3    '.length)).not.toMatch(/\d/);
  });

  it('maps a cell index to the arena', () => {
    expect(cellCentre(0, 800, 800)).toEqual({ x: 50, y: 50 });
    expect(cellCentre(63, 800, 800)).toEqual({ x: 750, y: 750 });
    expect(cellCentre(7, 800, 800)).toEqual({ x: 750, y: 50 });
  });

  it('names the dominant dash direction', () => {
    expect(renderDashRose([0, 0, 0, 0, 11, 1, 0, 0])).toContain('dominant: W');
    expect(renderDashRose([0, 0, 0, 0, 0, 0, 0, 0])).toBe('  never dashed');
  });

  it('puts shots next to uses so the ratio is visible', () => {
    const table = renderShotsDuring(
      { move: 0, burst: 4, charge: 0, slam: 40, spawn: 0 },
      { move: 100, burst: 8, charge: 2, slam: 3, spawn: 1 },
      120,
    );
    expect(table).toContain('slam');
    expect(table).toContain('13.3'); // 40 shots / 3 slams
    expect(table).toContain('120 shots in total');
  });

  it('collapses runs of shots and keeps every decision', () => {
    const rendered = renderTimeline(
      [
        { tick: 1, kind: 'playerShot' },
        { tick: 5, kind: 'playerShot' },
        { tick: 9, kind: 'playerShot' },
        { tick: 12, kind: 'playerDash' },
        { tick: 20, kind: 'playerShot' },
      ],
      5,
      30,
    );
    expect(rendered).toContain('playerShot x3 over ticks 1-9');
    expect(rendered).toContain('playerDash');
  });

  it('renders the same summary byte-for-byte every time', () => {
    const summary = cannedSummary('rusher-a');
    expect(renderSummary(summary, { round: 1 })).toBe(renderSummary(summary, { round: 1 }));
  });
});
