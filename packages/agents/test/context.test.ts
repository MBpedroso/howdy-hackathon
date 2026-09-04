/**
 * Context assembly, including the **denial** tests — the ones that make spec §8's
 * "context it is denied" column a property of the build rather than an intention.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  analystPrompt,
  bracketHint,
  cellCentre,
  coderPrompt,
  contractDoc,
  correctionHint,
  dialFor,
  harnessHints,
  harnessRules,
  promptSize,
  renderBotRates,
  renderCandidateTable,
  renderDashRose,
  renderHeatGrid,
  renderShotsDuring,
  renderSummary,
  renderTimeline,
  takenNames,
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

  it('asks for a JSON block and nothing that could be code', () => {
    // The Analyst's reply is prose first, then one fenced JSON block (spec §2.2's
    // typewriter, then the data the Coder reads), so a fence is expected — a
    // *language* fence is not. The denial is code, not markdown.
    expect(text).toContain('```json');
    // `js`, not `json`: the one fence it may ask for is data.
    expect(text).not.toMatch(/```js(?!on)/);
    for (const lang of ['```javascript', '```ts']) expect(text).not.toContain(lang);
  });

  it('asks for the prose first, so the player sees sentences and not JSON', () => {
    expect(text).toMatch(/PART 1[\s\S]*plain prose/);
    expect(text).toMatch(/PART 1[\s\S]*PART 2/);
    // The example in the prompt is spec §2.2's example, near enough to be checked.
    expect(text).toContain('Player camped the bottom-left corner.');
    expect(text).toContain('3 to 6 short sentences');
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

  it('keeps the Coder prompt inside 13k per part, first attempt and retry', () => {
    const first = coderPrompt({ analysis: ANALYSIS, prevSource: readGood('orbiter'), round: 2 });
    const retry = coderPrompt({
      analysis: ANALYSIS,
      prevSource: readGood('orbiter'),
      round: 2,
      rejection: { gate: 'balance', gateNumber: 3, reason: '0.91 vs panel — too hard', attempt: 1 },
    });
    for (const prompt of [first, retry]) {
      // 13k, not 12k: the harness-hints section (~0.9k) bought a measurable win
      // rate for a fixed, cacheable cost. Anything past this is a budget review.
      expect(prompt.system.length).toBeLessThan(13_000);
      expect(prompt.messages[0]!.content.length).toBeLessThan(13_000);
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
  it("states the round's band and all three assertions", () => {
    const rules = harnessRules(4);
    expect(rules).toContain('0.50–0.65');
    expect(rules).toContain('round 4');
    expect(rules).toContain('ADAPTED');
    expect(rules).toContain('FAIR');
    expect(rules).toContain('>= 0.70');
    expect(rules).toContain('ACTIVE');
  });

  /**
   * ACTIVE is the assertion the Coder is most likely to fail by accident, because
   * `idle` is the obvious thing to return when nothing is off cooldown — so the
   * section has to say what to do *instead*, not just what is forbidden, and it has
   * to carry the real rejection sentence the harness will send back.
   */
  it('tells the Coder how to rest, and what a stall rejection looks like', () => {
    const rules = harnessRules(2);
    expect(rules).toContain('90 ticks');
    expect(rules).toContain('never as a resting state');
    expect(rules).toContain('walks into a wall');
    expect(rules).toContain('boss motionless for 263 consecutive ticks');
    expect(rules).toContain('patrol, reposition or feint instead');
  });

  it('names every gate', () => {
    const rules = harnessRules(2);
    for (const gate of ['Gate 1 — static', 'Gate 2 — contract fuzz', 'Gate 3 — balance', 'Gate 4 — perf']) {
      expect(rules).toContain(gate);
    }
  });
});

describe('harnessHints', () => {
  const hints = harnessHints(3);

  it('stays inside its 900-character budget', () => {
    // It rides in the cached system prompt ahead of the analysis; a page of tactics
    // would start competing with the contract for attention.
    for (const round of [2, 3, 4, 5] as const) {
      expect(harnessHints(round).length).toBeLessThanOrEqual(900);
    }
  });

  it('names the five levers the harness actually measured', () => {
    expect(hints).toContain('`spawn` cadence is the strongest single lever');
    expect(hints).toContain('`count: 8`');
    expect(hints).toContain("`slam` on\n  the boss's own feet");
    expect(hints).toContain('Long cone bursts beat a kiter');
    expect(hints).toContain('`charge` alone does not');
    expect(hints).toContain('`rand()`');
    expect(hints).toContain('`history.playerPosHeat`');
  });

  it('says the heat map is cumulative, which is what the frozen boss missed', () => {
    // The Round 2 stall of 2026-09-04 was a boss parked on the hottest cell of a
    // map that never decays — a cell the player had left twenty seconds earlier.
    // "Aim there, then keep moving" is the fix, and Gate 3's ACTIVE assertion is
    // what enforces the second half of it.
    expect(hints).toContain('cumulative over the round');
    expect(hints).toContain('never park on it');
  });

  it('gives the round its own band and the middle of it as the target', () => {
    expect(harnessHints(3)).toContain('0.45–0.60');
    expect(harnessHints(3)).toContain('middle, 0.53');
    expect(harnessHints(5)).toContain('0.55–0.70');
    expect(harnessHints(5)).toContain('middle, 0.63');
  });

  it('is tactics, not engine internals', () => {
    // The same denial as the whole Coder prompt, asserted on the section alone so a
    // future hint cannot hide behind the size of the contract doc.
    const leaked = engineExportNames()
      .filter((name) => !GENERIC_WORDS.has(name))
      .filter((name) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(hints));
    expect(leaked).toEqual([]);
    for (const needle of ['tick(', 'step(', 'cloneState', 'ENGINE_CONSTANTS', 'projectiles[', 'GameState']) {
      expect(hints).not.toContain(needle);
    }
  });
});

describe('renderBotRates', () => {
  const rates = {
    perBot: [
      { name: 'Camper', winRate: 1 },
      { name: 'Kiter', winRate: 0.96 },
      { name: 'Rusher', winRate: 0 },
      { name: 'Dodger', winRate: 0.76 },
    ],
    mimic: 0.41,
  };

  it('marks the bots at 1.00 and 0.00 — the two ends the Coder has to fix', () => {
    const table = renderBotRates(rates);
    expect(table).toMatch(/Camper\s+1\.00\s+<- unwinnable/);
    expect(table).toMatch(/Rusher\s+0\.00\s+<- that bot wins every match/);
    // A rate inside the band is stated and left alone.
    expect(table).toMatch(/Kiter\s+0\.96$/m);
    expect(table).toMatch(/Dodger\s+0\.76$/m);
    expect(table).toMatch(/Mimic\s+0\.41\s+<- ADAPTED needs >= 0\.70/);
  });

  it('leaves the Mimic unmarked once ADAPTED passes, and omits it when unmeasured', () => {
    expect(renderBotRates({ ...rates, mimic: 0.82 })).toMatch(/Mimic\s+0\.82$/m);
    expect(renderBotRates({ perBot: rates.perBot })).not.toContain('Mimic');
  });

  it('reaches the retry prompt above the verbatim reason, which stays last', () => {
    const reason = "0.91 vs panel — too hard (band 0.35–0.50 for round 2; Camper 1.00, Kiter 0.96, Rusher 0.00, Dodger 0.76); 0.41 vs Mimic — didn't adapt (need >= 0.70)";
    const content = coderPrompt({
      analysis: ANALYSIS,
      prevSource: readGood('chaser'),
      round: 2,
      rejection: { gate: 'balance', gateNumber: 3, reason, attempt: 1, rates },
    }).messages[0]!.content;

    expect(content).toContain('Your win rate against each opponent');
    expect(content).toContain(renderBotRates(rates));
    // Spec §6.3: the harness's sentence is the last thing the Coder reads. The
    // table is a lookup for it, so it goes above.
    expect(content.indexOf(renderBotRates(rates))).toBeLessThan(content.indexOf(reason));
    expect(content.indexOf(reason)).toBeGreaterThan(content.length - 400);
  });

  it('is absent when the rejecting gate had no rates to report', () => {
    const content = coderPrompt({
      analysis: ANALYSIS,
      prevSource: readGood('chaser'),
      round: 2,
      rejection: { gate: 'fuzz', gateNumber: 2, reason: 'decide() threw', attempt: 1 },
    }).messages[0]!.content;
    expect(content).not.toContain('Your win rate against each opponent');
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
    // `## API` carries its `###` subsections with it; if the section list ever
    // double-counts them, the doc grows by ~1.8 KB and this catches it.
    const doc = contractDoc();
    const occurrences = doc.split('### `validateAction` behaviour worth knowing').length - 1;
    expect(occurrences).toBe(1);
  });

  it('cuts the gate-layering table, which `harnessRules` already covers', () => {
    // 0.8 KB of "which gate catches what", told better and with real rejection
    // sentences by `harnessRules` — and the system prompt has a 13k ceiling.
    expect(contractDoc()).not.toContain('### What Gate 1 deliberately does not do');
    expect(harnessRules(2)).toContain('Gate 4 — perf');
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

describe('correctionHint', () => {
  const panel = (rates: number[]): { perBot: { name: string; winRate: number }[] } => ({
    perBot: rates.map((winRate, i) => ({ name: `bot${i}`, winRate })),
  });

  it('turns a large "too hard" miss into a size of change, not a nudge', () => {
    // 0.88 against a 0.42 target: the measured failure of a retry is a boss that
    // moves 0.05 and comes back with the same rejection.
    const hint = correctionHint(panel([1, 1, 1, 0.52]), 2);
    expect(hint).toMatch(/You are at 0.88 and the target is 0.42/);
    expect(hint).toMatch(/remove roughly 52% of your total pressure/);
    expect(hint).toMatch(/3 of the four bots cannot win a single match/);
  });

  it('asks for more pressure when the boss is under the band', () => {
    expect(correctionHint(panel([0.2, 0, 0.1, 0.1]), 2)).toMatch(/Add roughly 76% more/);
  });

  it('tells the Coder to freeze the panel when only ADAPTED failed', () => {
    const hint = correctionHint({ ...panel([1, 0.2, 0.2, 0.2]), mimic: 0.4 }, 2);
    expect(hint).toMatch(/already inside the band: change NOTHING/);
  });

  it('says nothing when there is nothing to correct', () => {
    expect(correctionHint({ ...panel([1, 0.2, 0.2, 0.2]), mimic: 0.9 }, 2)).toBeUndefined();
    expect(correctionHint({ perBot: [] }, 2)).toBeUndefined();
  });

  it('reaches the Coder, above the verbatim reason', () => {
    const prompt = coderPrompt({
      analysis: ANALYSIS,
      prevSource: 'export const meta = {}; export function init() {} export function decide() {}',
      round: 2,
      rejection: {
        gate: 'balance',
        gateNumber: 3,
        attempt: 1,
        reason: '0.88 vs panel — too hard',
        rates: panel([1, 1, 1, 0.52]),
      },
    });
    const content = prompt.messages[0]!.content;
    expect(content).toMatch(/remove roughly 52%/);
    // The harness sentence still ends the context (spec §6.3).
    expect(content.indexOf('remove roughly 52%')).toBeLessThan(content.indexOf('0.88 vs panel'));
  });
});

describe('parallel candidates', () => {
  const OUTCOMES = [
    {
      candidate: 0,
      dial: 'conservative',
      approved: false,
      gate: 'balance' as const,
      gateNumber: 3,
      reason: '0.31 vs panel — too easy',
      panel: 0.31,
      rates: {
        perBot: [
          { name: 'Camper', winRate: 1 },
          { name: 'Kiter', winRate: 0 },
          { name: 'Rusher', winRate: 0.24 },
          { name: 'Dodger', winRate: 0 },
        ],
        mimic: 0.72,
      },
    },
    {
      candidate: 1,
      dial: 'balanced',
      approved: false,
      gate: 'balance' as const,
      gateNumber: 3,
      reason: '0.55 vs panel — too hard',
      panel: 0.55,
      rates: {
        perBot: [
          { name: 'Camper', winRate: 1 },
          { name: 'Kiter', winRate: 0.2 },
          { name: 'Rusher', winRate: 1 },
          { name: 'Dodger', winRate: 0 },
        ],
        mimic: 0.81,
      },
    },
    {
      candidate: 2,
      dial: 'aggressive',
      approved: false,
      gate: 'balance' as const,
      gateNumber: 3,
      reason: '0.78 vs panel — too hard',
      panel: 0.78,
      rates: {
        perBot: [
          { name: 'Camper', winRate: 1 },
          { name: 'Kiter', winRate: 1 },
          { name: 'Rusher', winRate: 1 },
          { name: 'Dodger', winRate: 0.12 },
        ],
        mimic: 0.9,
      },
    },
  ];

  it('gives each candidate a different aim point and a different name suffix', () => {
    const dials = [0, 1, 2].map((i) => dialFor(i, 3)!);
    expect(dials.map((d) => d.name)).toEqual(['conservative', 'balanced', 'aggressive']);
    expect(new Set(dials.map((d) => d.nameSuffix)).size).toBe(3);
    expect(dials.map((d) => d.aim)).toEqual(['low', 'mid', 'high']);
    // Mechanical, not adjectival: three qualitative nudges produced two identical
    // files in the first real run, so the dials name the knobs instead.
    expect(dials[0]!.instruction).toMatch(/ONE pressure source/);
    expect(dials[0]!.instruction).toMatch(/Do not `spawn` at all/);
    expect(dials[2]!.instruction).toMatch(/THREE pressure sources/);
    // The band's own numbers reach the prompt, one edge per candidate.
    const low = coderPrompt({ analysis: ANALYSIS, prevSource: readGood('idle'), round: 2, dial: dials[0]! });
    const high = coderPrompt({ analysis: ANALYSIS, prevSource: readGood('idle'), round: 2, dial: dials[2]! });
    expect(low.messages[0]!.content).toContain('TARGET 0.35 VS THE PANEL');
    expect(high.messages[0]!.content).toContain('TARGET 0.50 VS THE PANEL');
    // K = 1 is the legacy loop: no dial, so the prompt is the one it always sent.
    expect(dialFor(0, 1)).toBeUndefined();
  });

  it('puts the aim point in the message, never in the cached system prompt', () => {
    const withDial = coderPrompt({
      analysis: ANALYSIS,
      prevSource: readGood('idle'),
      round: 2,
      dial: dialFor(1, 3)!,
    });
    const without = coderPrompt({ analysis: ANALYSIS, prevSource: readGood('idle'), round: 2 });
    // Byte-identical system prompts across candidates: the ~13 KB prefix is cached.
    expect(withDial.system).toBe(without.system);
    expect(withDial.system.length).toBeLessThan(13_000);
    expect(withDial.messages[0]!.content).toContain('# YOUR AIM POINT: BALANCED');
    expect(withDial.messages[0]!.content).toContain('meta.name` must end with');
  });

  /**
   * The naming rule.
   *
   * Both live runs of the loop (2026-09-03/04) shipped a boss called "Warden II",
   * and neither model invented it: `Warden` was the example name in the dial block
   * and the model copied the example. Two consecutive rounds of a game about a boss
   * that changes both produced a boss with the same name.
   */
  describe('the boss gets a new name', () => {
    it('lists the previous name as taken and forbids the burned example', () => {
      const prompt = coderPrompt({
        analysis: ANALYSIS,
        prevSource: readGood('cornerbreaker'),
        round: 2,
        dial: dialFor(1, 3)!,
      });
      const content = prompt.messages[0]!.content;
      expect(content).toContain('# THE NAME');
      expect(content).toContain('Invent a NEW name');
      // The name it just beat, read out of the file itself, and the example name
      // that the two live runs copied.
      expect(content).toContain('TAKEN — do not use any of these, or a variation of one: Warden, Cornerbreaker.');
      expect(takenNames({ prevSource: readGood('orbiter') })).toEqual(['Warden', 'Orbiter']);
      // `Warden` may appear as *forbidden*, but never again as a sample to copy.
      expect(content).not.toContain("name: 'Warden");
      expect(prompt.system).not.toContain('Warden');
    });

    it('keeps the suffix rule, with a placeholder instead of a copyable name', () => {
      const content = coderPrompt({
        analysis: ANALYSIS,
        prevSource: readGood('idle'),
        round: 2,
        dial: dialFor(2, 3)!,
      }).messages[0]!.content;
      expect(content).toContain("name: '<your new name> III'");
      expect(content).toContain('must end with " III"');
    });

    it('also takes the names of the two files a retry is interpolating between', () => {
      // On a bracketed retry `bracket` replaces `prevSource` in the prompt, and both
      // endpoints are this round's own rejected candidates — reusing one of their
      // names is the same failure a round late.
      const taken = takenNames({
        prevSource: readGood('cornerbreaker'),
        bracket: {
          low: { label: 'conservative', panel: 0.31, source: readGood('orbiter') },
          high: { label: 'aggressive', panel: 0.55, source: readGood('chaser') },
        },
      });
      expect(taken).toContain('Cornerbreaker');
      expect(taken).toContain('Orbiter');
      expect(taken.length).toBeGreaterThan(3);
    });

    it('strips the candidate suffix, so "Warden II" burns "Warden" too', () => {
      const taken = takenNames({
        prevSource: "export const meta = { name: 'Lantern III', rationale: 'r', version: 2 };",
      });
      expect(taken).toContain('Lantern III');
      expect(taken).toContain('Lantern');
    });

    it('says nothing extra when the previous file has no readable meta', () => {
      // Gate 1 rejects such a file, so this is the "we could not read it" path and
      // not a case worth inventing a name for.
      expect(takenNames({ prevSource: 'const meta = 4; export { meta };' })).toEqual(['Warden']);
    });

    // The taken list changes per round and per attempt, so it must not touch the
    // ~13 KB cached prefix.
    it('lives in the message, not in the cached system prompt', () => {
      const a = coderPrompt({ analysis: ANALYSIS, prevSource: readGood('cornerbreaker'), round: 2, dial: dialFor(0, 3)! });
      const b = coderPrompt({ analysis: ANALYSIS, prevSource: readGood('orbiter'), round: 2, dial: dialFor(0, 3)! });
      expect(a.system).toBe(b.system);
      expect(a.system).not.toContain('# THE NAME');
      expect(a.messages[0]!.content.length).toBeLessThan(13_000);
    });
  });

  it('renders every candidate as one table with per-bot rates', () => {
    const table = renderCandidateTable(OUTCOMES, 2);
    for (const dial of ['conservative', 'balanced', 'aggressive']) expect(table).toContain(dial);
    for (const bot of ['Camper', 'Kiter', 'Rusher', 'Dodger', 'Mimic']) expect(table).toContain(bot);
    expect(table).toContain('too easy');
    expect(table).toContain('too hard');
    expect(table).toContain('0.31');
    expect(table).toContain('0.78');
  });

  it('turns a bracketed band into an interpolation instead of a correction', () => {
    const hint = bracketHint(OUTCOMES, 2)!;
    expect(hint).toContain('"conservative" measured 0.31');
    expect(hint).toContain('"balanced" measured 0.55');
    // 0.425 sits 48% of the way from 0.31 to 0.55.
    expect(hint).toMatch(/about 48% of the way towards "balanced"/);
    expect(hint).toContain('spawn cadence');
    expect(hint).toContain('hold distance');
    // Nothing to interpolate between when every candidate missed the same way.
    expect(bracketHint(OUTCOMES.slice(1), 2)).toBeUndefined();
  });

  it('replaces the single-point correction when the band was bracketed', () => {
    const prompt = coderPrompt({
      analysis: ANALYSIS,
      prevSource: readGood('chaser'),
      round: 2,
      rejection: {
        gate: 'balance',
        gateNumber: 3,
        reason: '0.55 vs panel — too hard',
        attempt: 1,
        rates: OUTCOMES[1]!.rates,
        candidates: OUTCOMES,
      },
    });
    const content = prompt.messages[0]!.content;
    expect(content).toContain('ALL 3 CANDIDATES WERE REJECTED');
    expect(content).toContain('The band is bracketed');
    // `correctionHint`'s "remove roughly N% of your pressure" would contradict it.
    expect(content).not.toMatch(/remove roughly \d+% of your total pressure/);
    // Spec §6.3 is unchanged: the harness's sentence is still the last thing read.
    expect(content.indexOf('0.55 vs panel — too hard')).toBeGreaterThan(content.length - 400);
  });

  it('states the near-binary arithmetic that makes a 0.15-wide band hard', () => {
    const rules = harnessRules(2);
    expect(rules).toContain('near-binary');
    expect(rules).toContain('steps of 0.25');
    expect(rules).toContain('`rand()` roll per phase');
  });
});
