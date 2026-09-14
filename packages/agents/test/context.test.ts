/**
 * Context assembly, including the **denial** tests — the ones that make spec §8's
 * "context it is denied" column a property of the build rather than an intention.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ADAPT_DIALS,
  DIAL_ORDER,
  DIALS,
  adaptDials,
  analystPrompt,
  blendDials,
  bracketHint,
  cellCentre,
  coderPrompt,
  contractDoc,
  correctionHint,
  dialFor,
  harnessHints,
  harnessRules,
  incumbentAnchor,
  playerProfile,
  promptSize,
  rankHotCells,
  renderBotRates,
  renderCandidateTable,
  renderDashRose,
  renderHeatGrid,
  renderPlayerProfile,
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
  // The player profile (analysis item 7) is real wiring now, not a hypothetical
  // future field — the denial has to hold with it present, or the denial test
  // would be checking a prompt the loop never actually sends.
  const prompt = coderPrompt({
    analysis: ANALYSIS,
    prevSource: readGood('cornerbreaker'),
    round: 2,
    profile: renderPlayerProfile(cannedSummary('camper-a')),
  });
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

describe('analystPrompt retry modes (2026-09-10 live failure)', () => {
  // `artifacts/server/rewrite-2026-09-10T16-53-53-446Z.json`: claude-cli/sonnet
  // streamed 1909 clean characters of real analysis and then no fence at all.
  const ctx = { summary: cannedSummary('camper-a'), round: 1 };

  it('no-echo, full summary re-sent, when a JSON block failed to parse (kind: invalid)', () => {
    const prompt = analystPrompt(ctx, { error: 'the JSON object did not parse: Unexpected token' });
    expect(prompt.messages).toHaveLength(2);
    expect(prompt.messages[1]!.content).toContain('could not be parsed');
    expect(prompt.messages[0]!.content).toContain('PLAYER POSITION HEAT MAP');
  });

  it('extraction task, prose echoed, no summary, when there was no JSON at all (kind: no-json)', () => {
    const prose = 'Player never dashed and camped cell 44 most of the round.';
    const prompt = analystPrompt(ctx, { error: 'no JSON object was found in the reply', prose });
    // One message, not two: the summary is not re-sent (the prose already
    // encodes it), which is also what makes this retry cheaper than the other.
    expect(prompt.messages).toHaveLength(1);
    expect(prompt.messages[0]!.content).toContain(prose);
    expect(prompt.messages[0]!.content).toContain('ONLY the fenced JSON block');
    expect(prompt.messages[0]!.content).not.toContain('PLAYER POSITION HEAT MAP');
    expect(prompt.messages[0]!.content).not.toContain('could not be parsed');
  });

  it('the extraction retry is denied the engine, same as every other Analyst prompt', () => {
    const prompt = analystPrompt(ctx, { error: 'no JSON object was found in the reply', prose: 'Some prose.' });
    const text = [prompt.system, ...prompt.messages.map((m) => m.content)].join('\n');
    const leaked = engineExportNames()
      .filter((name) => !GENERIC_WORDS.has(name))
      .filter((name) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text));
    expect(leaked).toEqual([]);
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
    // With the player profile included: `rewrite()` sends it on every call
    // (loop.ts), so a bound measured without it would not be the bound the loop
    // actually has to respect.
    const profile = renderPlayerProfile(summary);
    const first = coderPrompt({ analysis: ANALYSIS, prevSource: readGood('orbiter'), round: 2, profile });
    const retry = coderPrompt({
      analysis: ANALYSIS,
      prevSource: readGood('orbiter'),
      round: 2,
      profile,
      rejection: { gate: 'balance', gateNumber: 3, reason: '0.91 vs panel — too hard', attempt: 1 },
    });
    for (const prompt of [first, retry]) {
      // 14k, not 13k: `harnessHints` grew from ~0.9k to ~1.25k on 2026-09-09
      // (analysis item 1 — the mem rolling-window hint) on top of the ~0.9k it
      // already spent on 2026-09-04's cumulative-heat warning, then to ~1.7k the
      // same day (later) for the slam-reachability bullet a playtest bought. All
      // three earned a measurable behaviour change for a fixed, cacheable cost.
      //
      // The throttle (2026-09-11, `src/calibrate.ts`) cost nothing here on purpose:
      // a first draft asked the *Coder* for a `const PRESSURE` knob and spent ~1k of
      // system prompt on explaining it, and the live run that followed proved an
      // LLM-wired knob cannot be trusted to be monotone (0.86 / 0.90 / 0.84 across
      // three values of it). The knob is the harness's own now, injected into the
      // source after the fact, and the prompt only says the harness will throttle a
      // boss that comes in too hard. Anything past this is a budget review.
      expect(prompt.system.length).toBeLessThan(14_000);
      expect(prompt.messages[0]!.content.length).toBeLessThan(14_000);
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

describe('playerProfile — analysis item 7', () => {
  const summary = cannedSummary('camper-a');

  it('reuses rankHotCells rather than re-deriving the cell math', () => {
    const expected = rankHotCells(summary.history.playerPosHeat, 800, 800, 4).map((c) => ({
      x: c.x,
      y: c.y,
      share: Math.round(c.share * 10_000) / 10_000,
    }));
    expect(playerProfile(summary).hotCells).toEqual(expected);
  });

  it('reports at most 4 hot cells, hottest first', () => {
    const cells = playerProfile(summary).hotCells;
    expect(cells.length).toBeLessThanOrEqual(4);
    for (let i = 1; i < cells.length; i += 1) {
      expect(cells[i]!.share).toBeLessThanOrEqual(cells[i - 1]!.share);
    }
  });

  it('sums the dash total from playerDashDirs, and reports 0/0 when there were none', () => {
    const p = playerProfile(summary);
    const total = summary.history.playerDashDirs.reduce((a, b) => a + b, 0);
    expect(p.dashes.total).toBe(total);
    expect(p.dashes.dominantAngleRad).toBeGreaterThanOrEqual(0);
    expect(p.dashes.dominantAngleRad).toBeLessThan(Math.PI * 2);

    const noDashes = { ...summary, history: { ...summary.history, playerDashDirs: [0, 0, 0, 0, 0, 0, 0, 0] } };
    const p2 = playerProfile(noDashes);
    expect(p2.dashes).toEqual({ total: 0, dominantAngleRad: 0, dominantShare: 0 });
  });

  it('places bin 0 at angle 0 (+x) and steps TAU/8 per bin, counter-clockwise', () => {
    // Bin 4 is `renderDashRose`'s `COMPASS[4]` ('W'), directly opposite +x — the
    // same 8-bin indexing the dash rose already renders, so bin 4 should land at
    // exactly half a turn (π radians).
    const westOnly = { ...summary, history: { ...summary.history, playerDashDirs: [0, 0, 0, 0, 9, 0, 0, 0] } };
    const p = playerProfile(westOnly);
    // `round4` rounds to 4 decimal places, so the match is to that precision.
    expect(p.dashes.dominantAngleRad).toBeCloseTo((4 * Math.PI * 2) / 8, 4);
    expect(p.dashes.dominantShare).toBe(1);
  });

  it('carries playerShotsDuring and durations.ticks straight through, unrounded', () => {
    const p = playerProfile(summary);
    expect(p.playerShotsDuring).toEqual(summary.history.playerShotsDuring);
    expect(p.durations.ticks).toBe(summary.durations.ticks);
  });

  it('renders as the JSON.stringify of the same value', () => {
    expect(renderPlayerProfile(summary)).toBe(JSON.stringify(playerProfile(summary), null, 2));
  });
});

describe('the PLAYER PROFILE section of the Coder prompt', () => {
  const profile = renderPlayerProfile(cannedSummary('camper-a'));

  it('is absent when no profile is given', () => {
    const content = coderPrompt({ analysis: ANALYSIS, prevSource: readGood('idle'), round: 2 }).messages[0]!.content;
    expect(content).not.toContain('PLAYER PROFILE');
  });

  it('sits right after THE ANALYST and before the code, on a first attempt', () => {
    const content = coderPrompt({
      analysis: ANALYSIS,
      prevSource: readGood('idle'),
      round: 2,
      profile,
    }).messages[0]!.content;
    expect(content).toContain('# PLAYER PROFILE (measured — embed the numbers you aim with as constants, do not retype them from prose)');
    expect(content).toContain(profile);
    const analystAt = content.indexOf('# THE ANALYST ON THIS PLAYER');
    const profileAt = content.indexOf('# PLAYER PROFILE');
    const codeAt = content.indexOf('# THE STRATEGY THAT JUST LOST');
    expect(analystAt).toBeGreaterThanOrEqual(0);
    expect(analystAt).toBeLessThan(profileAt);
    expect(profileAt).toBeLessThan(codeAt);
  });

  it('is the same string across a bracketed retry, and the rejection stays last', () => {
    const reason = '0.55 vs panel — too hard';
    const content = coderPrompt({
      analysis: ANALYSIS,
      prevSource: readGood('idle'),
      round: 2,
      profile,
      rejection: { gate: 'balance', gateNumber: 3, reason, attempt: 1 },
    }).messages[0]!.content;
    expect(content).toContain(profile);
    // Spec §6.3: the harness's sentence is still the last thing in the context,
    // profile block included.
    expect(content.indexOf('PLAYER PROFILE')).toBeLessThan(content.indexOf(reason));
    expect(content.indexOf(reason)).toBeGreaterThan(content.length - 400);
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
    expect(rules).toContain('0.60–0.75');
    expect(rules).toContain('round 4');
    expect(rules).toContain('ADAPTED');
    expect(rules).toContain('FAIR');
    expect(rules).toContain('>= 0.85');
    expect(rules).toContain('ACTIVE');
  });

  /**
   * Delta 24: ADAPTED rejects from round 3, and the Coder is told which of the two
   * regimes it is in. Getting this wrong in either direction wastes an attempt — a
   * Coder that thinks the Mimic rate is optional in round 4 spends its retry on the
   * panel, and one that thinks it is mandatory in round 2 trades FAIR away for it.
   */
  it('tells the Coder that ADAPTED rejects from round 3, and that it does not in round 2', () => {
    const round2 = harnessRules(2);
    expect(round2).toContain('>= 0.70   (a goal — it cannot reject you)');
    expect(round2).not.toContain("didn't adapt");

    for (const [round, min] of [
      [3, '0.75'],
      [4, '0.85'],
      [5, '0.95'],
    ] as const) {
      const rules = harnessRules(round);
      expect(rules).toContain(`>= ${min}   (round ${round} — this rejects you)`);
      // The second route, so a Coder facing an unreachable absolute still has a move.
      expect(rules).toContain('beat the boss you are replacing by 0.10');
      // And the sentence it will actually get back.
      expect(rules).toContain("vs Mimic — didn't adapt");
    }
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

  it('stays inside its 2100-character budget', () => {
    // It rides in the cached system prompt ahead of the analysis; a page of tactics
    // would start competing with the contract for attention. Raised 900 -> 1300 on
    // 2026-09-09 (analysis item 1, the mem rolling-window hint), 1300 -> 1800 the
    // same day (later, the slam-reachability bullet), and 1800 -> 2100 on 2026-09-10
    // (the flat-heat-map clause below) — paid for deliberately every time, not
    // drifted into (see the function's doc comment).
    for (const round of [2, 3, 4, 5] as const) {
      expect(harnessHints(round).length).toBeLessThanOrEqual(2100);
    }
  });

  it('tells the Coder how to keep a recent window in mem, not just the lifetime map', () => {
    // Analysis item 1: the cumulative heat map alone cannot tell "still camping"
    // from "left ten seconds ago" — mem is the only place a strategy can build the
    // distinction, so the hint has to say *how*, mechanically, not just that it can.
    expect(hints).toContain("Push the player's cell index");
    expect(hints).toContain('ring of ~60 entries');
    expect(hints).toContain('~10 ticks');
    expect(hints).toContain('centroid');
    expect(hints).toContain('`mem`');
    // The mem-window's aim point should carry the same "aim where they can be"
    // framing as the reachability bullet below, not just the lifetime-vs-recent one.
    expect(hints).toContain('led by `vx`/`vy` across a slam');
  });

  it('states the slam-reachability arithmetic a playtest found missing (2026-09-09, later)', () => {
    // Matt's report: the boss slammed the player's habit cell while the player was
    // far away — "even dashing toward it he'd only get halfway there". A slam
    // telegraphs 40 ticks (0.667s) and hits once; a player's best-case travel in
    // that window is one 10-tick dash (110px) plus 30 ticks of running (108px) =
    // 218px, and the slam's own hit radius is 110px, so ~328px is the honest
    // "cannot possibly land" line — the hint rounds both numbers for readability.
    expect(hints).toContain('telegraphs for 40 ticks');
    expect(hints).toContain('~0.67s');
    expect(hints).toContain('~220px');
    expect(hints).toContain('~330px');
    expect(hints).toContain('~110px reach');
    expect(hints).toContain('slam where they can BE');
  });

  it('says a low-share hottest cell is transit, not a habit (2026-09-10 playtest)', () => {
    // A spread-out player's real recorded hottest cell was 0.081 share, with the
    // next few cells almost as high (0.071, 0.058, 0.054, 0.054) — passage, not a
    // camp — and the boss still fenced it like a habit
    // (`artifacts/server/rewrite-2026-09-10T16-41-46-470Z.json`). The same week's
    // actual camper measured 0.334 in its hottest cell
    // (`…T18-03-48-701Z.json`), over 4x the flat player's peak — the gap the ~0.10
    // threshold has to sit inside.
    expect(hints).toContain('~0.10');
    expect(hints).toContain('PLAYER\n  PROFILE');
    expect(hints).toContain('not a habit');
    expect(hints).toContain('pick pressure by');
    expect(hints).toContain('archetype');
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
    expect(harnessHints(3)).toContain('0.50–0.65');
    expect(harnessHints(3)).toContain('middle, 0.57');
    expect(harnessHints(5)).toContain('0.65–0.95');
    expect(harnessHints(5)).toContain('middle, 0.80');
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

describe("ADAPT_DIALS 'place' — reach-conditional slam (2026-09-09, later, playtest)", () => {
  const place = ADAPT_DIALS.find((d) => d.name === 'place')!;
  const ground = ADAPT_DIALS.find((d) => d.name === 'ground')!;

  it('no longer commits the slam unconditionally', () => {
    // The exact phrase a playtest found: a slam that lands on ground the player
    // could never reach in time reads as the boss missing on purpose, not pressure.
    expect(place.instruction).not.toContain('whether or not the player is');
  });

  it('gates the habit-cell slam on reach, and leads the live player otherwise', () => {
    expect(place.instruction).toContain('close enough to reach');
    expect(place.instruction).toContain('history.playerPosHeat');
    // Mechanical, not adjectival — same lead formula `orbiter.js` already uses for
    // its own slam, so the pattern is one the harness has already measured works.
    expect(place.instruction).toContain('player.x + player.vx * 40');
    expect(place.instruction).toContain('player.y + player.vy * 40');
  });

  it("'ground' is unchanged in substance and says why it needs no reach gate", () => {
    // Spawn/minion denial has no telegraph-then-resolve gap to be out of reach for,
    // so it does not need the fix `place` needed — the instruction now says so.
    expect(ground.instruction).toContain('does not need');
    expect(ground.instruction).toContain('`spawn` toward the hottest cell');
    expect(ground.instruction).toContain('history.playerPosHeat');
  });

  it("adaptDials still produces three distinct, correctly-suffixed candidates", () => {
    const dials = adaptDials(3);
    expect(dials.map((d) => d.name)).toEqual(['place', 'ground', 'timing']);
    expect(new Set(dials.map((d) => d.nameSuffix)).size).toBe(3);
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
    // ADAPTED advises rather than rejects (2026-09-08), and the marker has to say
    // so: a Coder told it "needs" the number spends its retry on the one assertion
    // that cannot refuse it, at FAIR's expense.
    expect(table).toMatch(/Mimic\s+0\.41\s+<- short of the 0\.70 goal \(did not reject you\)/);
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
    // `DIAL_ORDER`, not `DIALS` order. Before 2026-09-11 candidate 0 was
    // `conservative`, and on a provider whose one Coder call eats most of the 45 s
    // budget the deadline judged candidate 0 and aborted the rest — so the weakest
    // aim point was the only one ever measured.
    expect(dials.map((d) => d.name)).toEqual(['balanced', 'aggressive', 'conservative']);
    expect(new Set(dials.map((d) => d.nameSuffix)).size).toBe(3);
    expect(dials.map((d) => d.aim)).toEqual(['mid', 'high', 'low']);
    // Mechanical, not adjectival: three qualitative nudges produced two identical
    // files in the first real run, so the dials name the knobs instead.
    expect(dials[2]!.instruction).toMatch(/ONE pressure source/);
    expect(dials[2]!.instruction).toMatch(/do not `spawn` at all/);
    expect(dials[1]!.instruction).toMatch(/THREE pressure sources/);
    // …and `conservative` is a stance, not an off switch. Three live interludes on
    // 2026-09-11 shipped 0.26 / 0.20 / 0.00 vs panel out of this dial, all of them
    // from the same instruction to stay quiet after every attack.
    expect(dials[2]!.instruction).toMatch(/fires on every cooldown it has/);
    expect(dials[2]!.instruction).not.toMatch(/quiet ticks after every committed attack/);
    // The band's own numbers reach the prompt, one edge per candidate.
    const low = coderPrompt({ analysis: ANALYSIS, prevSource: readGood('idle'), round: 2, dial: dials[2]! });
    const high = coderPrompt({ analysis: ANALYSIS, prevSource: readGood('idle'), round: 2, dial: dials[1]! });
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
      dial: dialFor(0, 3)!,
    });
    const without = coderPrompt({ analysis: ANALYSIS, prevSource: readGood('idle'), round: 2 });
    // Byte-identical system prompts across candidates: the ~13.7 KB prefix is
    // cached (see 'keeps the Coder prompt inside 13k per part', above, for why
    // 14k and not 13k since 2026-09-09).
    expect(withDial.system).toBe(without.system);
    expect(withDial.system.length).toBeLessThan(14_000);
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

/**
 * STANCE ORDER — 2026-09-11.
 *
 * The K prompts differ by one line, and which line goes to candidate 0 stopped
 * being cosmetic the moment the budget could only judge one candidate. See
 * `DIAL_ORDER`.
 */
describe('DIAL_ORDER puts the best file in the first slot', () => {
  it('aims candidate 0 at the middle of the band, not the low edge', () => {
    expect(DIAL_ORDER.map((i) => DIALS[i]!.name)).toEqual(['balanced', 'aggressive', 'conservative']);
    expect(dialFor(0, 3)!.aim).toBe('mid');
    // DIALS itself is still written low edge to high edge — the order is a routing
    // decision, not a rewrite of what the three stances mean.
    expect(DIALS.map((d) => d.aim)).toEqual(['low', 'mid', 'high']);
  });

  it('gives the three stances three different instructions, none of them a no-op', () => {
    const [low, mid, high] = DIALS;
    expect(new Set([low!.instruction, mid!.instruction, high!.instruction]).size).toBe(3);
    // Each names a different number of pressure sources — the knob, not an adjective.
    expect(low!.instruction).toMatch(/ONE pressure source/);
    expect(mid!.instruction).toMatch(/TWO pressure sources/);
    expect(high!.instruction).toMatch(/THREE pressure sources/);
    // And `conservative` still has to fire. A single attack behind a 120-tick quiet
    // window is what measured 0.00 against the panel on 2026-09-11.
    expect(low!.instruction).toMatch(/fires on every cooldown/);
    expect(low!.instruction).toMatch(/0\.00/);
  });

  it('blends by aim point, so a name in the comparison table means what it says', () => {
    const bracket = {
      low: { label: 'a', panel: 0.1, source: 'x' },
      high: { label: 'b', panel: 0.9, source: 'y' },
    };
    const dials = blendDials(3, bracket, 2);
    expect(dials.map((d) => d.name)).toEqual(['balanced', 'aggressive', 'conservative']);
    const blendOf = (name: string): number => dials.find((d) => d.name === name)!.blend!;
    // Lowest blend on `conservative`, highest on `aggressive`, `balanced` between.
    expect(blendOf('conservative')).toBeLessThan(blendOf('balanced'));
    expect(blendOf('balanced')).toBeLessThan(blendOf('aggressive'));
    // Still K distinct points on the line — that is what the bisection needs.
    expect(new Set(dials.map((d) => d.blend)).size).toBe(3);
  });
});

/**
 * THE FIRST ATTEMPT'S ANCHOR — 2026-09-11.
 *
 * `incumbentAnchor` is the only quantitative thing a first attempt gets, and it is
 * the whole of the first-attempt calibration fix. See the type doc on
 * `CoderIncumbent` for the measured failure it answers.
 */
describe('incumbentAnchor', () => {
  const PER_BOT = [
    { name: 'Camper', winRate: 0 },
    { name: 'Kiter', winRate: 0 },
    { name: 'Rusher', winRate: 0 },
    { name: 'Dodger', winRate: 0 },
  ];

  it('quotes the measured rates and converts the gap into a size of change', () => {
    const text = incumbentAnchor({ name: 'Statue', perBot: PER_BOT, mimic: 0.12 }, 2)!;
    expect(text).toContain('# THE BOSS YOU ARE REPLACING, MEASURED');
    expect(text).toContain('"Statue"');
    expect(text).toMatch(/Camper\s+0\.00/);
    expect(text).toMatch(/Mimic\s+0\.12/);
    expect(text).toContain('That is 0.00 vs the panel. You need 0.35–0.50, so aim at 0.42 — a change of +0.42.');
  });

  it('says in one sentence what 0.00 actually is', () => {
    const text = incumbentAnchor({ perBot: PER_BOT }, 2)!;
    expect(text).toContain('0.00 vs the panel means the boss never wins a single match');
    expect(text).toContain('is not conservative,');
    expect(text).toContain('it is absent');
  });

  it("uses the round's own band, so round 4 is not told to aim at round 2's middle", () => {
    const text = incumbentAnchor({ perBot: PER_BOT, mimic: 0.82 }, 4)!;
    expect(text).toContain('You need 0.60–0.75, so aim at 0.68');
  });

  it('renders with only one of the two measurements, and not at all with neither', () => {
    const mimicOnly = incumbentAnchor({ name: 'Statue', mimic: 0.71 }, 3)!;
    expect(mimicOnly).toMatch(/Mimic\s+0\.71/);
    expect(mimicOnly).toContain('You need 0.50–0.65 against the panel. Aim at 0.57.');
    expect(incumbentAnchor({ perBot: PER_BOT }, 2)).toBeDefined();
    // Nothing measured is nothing to say: a block of adjectives is what this
    // replaces, so it must not degrade back into one.
    expect(incumbentAnchor({ name: 'Statue' }, 2)).toBeUndefined();
    expect(incumbentAnchor({}, 2)).toBeUndefined();
  });

  it('rides the first Coder prompt and is gone from every retry', () => {
    const incumbent = { name: 'Statue', perBot: PER_BOT, mimic: 0.12 };
    const first = coderPrompt({ analysis: ANALYSIS, prevSource: readGood('idle'), round: 2, incumbent });
    expect(first.messages[0]!.content).toContain('# THE BOSS YOU ARE REPLACING, MEASURED');
    // The cached prefix does not move: the numbers are this run's, not every run's.
    expect(first.system).toBe(coderPrompt({ analysis: ANALYSIS, prevSource: readGood('idle'), round: 2 }).system);
    // On a retry the harness has said something better and more recent, and spec
    // §6.3 wants that sentence last.
    const retry = coderPrompt({
      analysis: ANALYSIS,
      prevSource: readGood('idle'),
      round: 2,
      incumbent,
      rejection: { gate: 'balance', gateNumber: 3, reason: '0.91 vs panel — too hard', attempt: 1 },
    });
    expect(retry.messages[0]!.content).not.toContain('# THE BOSS YOU ARE REPLACING, MEASURED');
  });
});
