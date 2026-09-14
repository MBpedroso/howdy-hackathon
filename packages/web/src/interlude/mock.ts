/**
 * The mock event source: a scripted, timed replay of one realistic rewrite run.
 *
 * This is not a stub with placeholder text. It is the demo's floor: `pnpm dev` with
 * no server, no API key and no network still plays the full four-beat interlude,
 * including a Gate 3 rejection and the fix, and hands the game a **real strategy**
 * to fight — `packages/harness/test/fixtures/round2-candidate.js`, the same file the
 * harness's balance suite measures at 0.45 vs the panel and 0.75 vs a Mimic. So the
 * fallback path in `?agent=mock` is honest: what the mock says was approved is a
 * strategy that really was.
 *
 * Two shapes are canned rather than computed, and are marked as such on screen (the
 * source badge reads `mock`): the Analyst's prose and the gate timings. Everything
 * else — the streamed code, the unified diff, the `meta` the HUD ends up showing —
 * is derived from the two real strategy files, so the renderer is exercised on real
 * inputs and a rendering bug cannot hide behind friendly fixture data.
 *
 * ## Timing
 *
 * Delays are the real thing's, measured from `packages/agents/test/loop.test.ts`
 * shapes and the harness's own gate costs: an Analyst that streams for ~2.5 s, a
 * Coder that streams a ~110-line file, Gate 2 around a second, Gate 3 around four
 * (200 matches across workers), Gate 4 well under one. Total ≈ 25 s at `speed: 1`,
 * inside the 45 s budget of spec AC 5 with room for the rejection.
 *
 * `speed` divides every delay. The e2e suite runs at 20× (~1.3 s) and the unit tests
 * at 500×; the demo runs at 1.
 */
// `fixtures/attempt1.js` is mock data and is never executed — it exists only to be
// streamed and diffed. It carries no "this is a fixture" banner *on purpose*: its
// header comment ends up inside the diff the player reads, and a diff that says
// "MOCK DATA" in a demo discredits the beat it is meant to prove. So the file reads
// as the plausible first draft it stands in for, and this comment is where its
// nature is recorded.
import attempt1Source from './fixtures/attempt1.js?raw';
// Across packages, but this is a text import of a test fixture, not a code
// dependency: Vite inlines the bytes and `@rematch/harness` never enters the bundle.
import approvedSource from '../../../harness/test/fixtures/round2-candidate.js?raw';
import { unifiedDiff } from './diff.ts';
import type { Analysis, AttemptLog, GateResult, RewriteEvent } from './events.ts';
import type { InterludeSource, RewriteRequest } from './source.ts';

/** One scripted event: wait `delay` ms (scaled by `speed`), then emit. */
export type MockStep = { delay: number; event: RewriteEvent };
export type MockScript = readonly MockStep[];

export type MockOptions = {
  /** Divides every delay. 1 = the demo, 20 = the e2e suite. */
  speed?: number;
  /** Override the whole sequence. A function is given the live request. */
  script?: MockScript | ((req: RewriteRequest) => MockScript);
};

/** Spec §2.2's streaming rate for prose: ~40 characters per 100 ms. */
export const TEXT_CHARS_PER_CHUNK = 40;
export const TEXT_CHUNK_MS = 100;
/** Code arrives a line at a time — a diff is read in lines, not characters. */
export const CODE_LINE_MS = 32;

export const APPROVED_SOURCE = approvedSource;
export const ATTEMPT1_SOURCE = attempt1Source;

/** `meta` of the strategy the mock ships. Matches `round2-candidate.js` exactly. */
export const APPROVED_META = {
  name: 'Warden',
  rationale: 'I hold the middle and put everything where you live, not where you are.',
  version: 1,
} as const;

/** `meta` of the rejected first draft. Matches `fixtures/attempt1.js` exactly. */
export const ATTEMPT1_META = {
  name: 'Warden',
  rationale: 'I close the distance and keep you under fire until you stop shooting.',
  version: 1,
} as const;

// ------------------------------------------------------------- the candidates

/**
 * The three aim points an attempt is fired at, low edge to high edge.
 *
 * The live loop writes K files per attempt (`REMATCH_CANDIDATES`, default 3) from
 * one context, separated by a single "aim for the low / middle / high edge of the
 * band" line, and keeps whichever the harness likes best. The mock has to play that
 * shape or the tab strip and the grouped gate rows are only ever exercised in
 * production.
 */
export const MOCK_DIALS = ['conservative', 'balanced', 'aggressive'] as const;

/**
 * The two flanking candidates, derived from the real fixture rather than invented.
 *
 * There are two hand-written strategy files in the repo and an attempt needs three,
 * so the conservative and aggressive siblings are the real file with the named
 * constants the dials actually move — spawn cadence, hold distance, burst width —
 * turned down and up, and `meta.name` given the suffix the Coder is told to use.
 * Every line the player reads in those two diffs is therefore real code that would
 * load; only the *choice* of numbers is the mock's.
 */
export function mockVariant(source: string, dial: (typeof MOCK_DIALS)[number], suffix: string): string {
  const knobs: Readonly<Record<string, number>> =
    dial === 'conservative'
      ? { HOLD_RANGE: 1.3, SPAWN_EVERY: 1.75, BURST_MIN_RANGE: 1.15, REFRESH_TICKS: 1.5, LEAD_TICKS: 0.7 }
      : dial === 'aggressive'
        ? { HOLD_RANGE: 0.72, SPAWN_EVERY: 0.62, BURST_MIN_RANGE: 0.8, REFRESH_TICKS: 0.7, LEAD_TICKS: 1.3 }
        : {};
  let out = source;
  for (const [name, factor] of Object.entries(knobs)) {
    out = out.replace(
      new RegExp(`(const ${name} = )(\\d+)`),
      (_m: string, head: string, value: string) => `${head}${Math.round(Number(value) * factor)}`,
    );
  }
  if (dial === 'conservative') out = out.replace(/count: 8/g, 'count: 5');
  return out.replace(/(name: ')([^']+)(')/, (_m, head: string, name: string, tail: string) =>
    `${head}${name} ${suffix}${tail}`,
  );
}

/** `Warden I` / `Warden II` / `Warden III` — the suffix rule the Coder is given. */
export const NAME_SUFFIXES = ['I', 'II', 'III'] as const;

/**
 * Matches per `trial.progress` event.
 *
 * The real simulator batches its callbacks at `progressBatch(total)` — 10 for the
 * 200 matches of spec §6.2 — and the loop throttles them to one per 100 ms. 10 here
 * reproduces that cadence, so the meter is exercised by the mock the way the live
 * server will drive it rather than by two events at the ends.
 */
export const MATCH_BATCH = 10;

// ------------------------------------------------------------------ the script

function chunkText(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/** Keep the trailing newline on every line, so a `<pre>` reassembles the file. */
function codeChunks(source: string): string[] {
  return source.split('\n').map((line, i, all) => (i === all.length - 1 ? line : `${line}\n`));
}

/** 8×8 heat index -> the words a human would use. */
function describeCell(index: number): string {
  const col = index % 8;
  const row = Math.floor(index / 8);
  const vertical = row <= 1 ? 'top' : row >= 6 ? 'bottom' : 'middle';
  const horizontal = col <= 1 ? 'left' : col >= 6 ? 'right' : 'centre';
  if (vertical === 'middle' && horizontal === 'centre') return 'the middle of the arena';
  if (vertical === 'middle') return `the ${horizontal} edge`;
  if (horizontal === 'centre') return `the ${vertical} edge`;
  return `the ${vertical}-${horizontal} corner`;
}

/** Bin 0 is +x, counter-clockwise, 8 bins (see `engine/dirBin`). */
const DASH_WORDS = ['right', 'up-right', 'up', 'up-left', 'left', 'down-left', 'down', 'down-right'];

function argmax(values: readonly number[]): number {
  let best = 0;
  let bestValue = -Infinity;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i] ?? 0;
    if (v > bestValue) {
      bestValue = v;
      best = i;
    }
  }
  return best;
}

/**
 * The Analyst's output, built from the *real* replay summary.
 *
 * Canned prose, live numbers: the observations quote this round's dash count, shot
 * count, duration and hottest heat cell, so what the player reads is about the round
 * they just played. `playerArchetype` is inferred with a two-line rule rather than
 * hard-coded — a camper and a rusher must not get the same reading on screen.
 */
export function mockAnalysis(req: RewriteRequest): Analysis {
  const s = req.summary;
  const heat = s.history.playerPosHeat;
  const hot = argmax(heat);
  const hotShare = Math.round((heat[hot] ?? 0) * 100);
  const dashBin = argmax(s.history.playerDashDirs);
  const dashShare = s.player.dashes === 0 ? 0 : Math.round(((s.history.playerDashDirs[dashBin] ?? 0) / s.player.dashes) * 100);
  const slamShots = s.history.playerShotsDuring.slam;

  const archetype: Analysis['playerArchetype'] =
    hotShare >= 22 ? 'camper' : s.player.dashes >= 14 ? 'rusher' : s.player.damageTaken <= 1 ? 'dodger' : 'mixed';

  return {
    observations: [
      `Spent ${hotShare}% of the round in ${describeCell(hot)} — one 8×8 cell held more of the position heat than any other.`,
      `Dashed ${s.player.dashes} times, ${dashShare}% of them ${DASH_WORDS[dashBin] ?? 'right'}; the dash is an escape, not an approach.`,
      `Fired ${s.player.shots} shots and landed ${slamShots} of them while my slam was winding up — the 40-tick tell is being read as a free window.`,
      `Closed the round in ${s.durations.seconds.toFixed(1)}s with ${s.player.hpEnd}/${s.player.hpStart} HP, taking ${s.player.damageTaken} damage total.`,
    ],
    playerArchetype: archetype,
    counterPlan: `Stop chasing and start occupying. Put the slam on ${describeCell(hot)} instead of on the player's feet, and hold it until they are actually standing there, so standing still is what gets punished. Park a minion on the same cell to make it expensive to return to. Keep the burst to aimed cones outside 260 px so a player who holds shooting distance is under pressure without being pinned.`,
  };
}

/**
 * The prose half of the Analyst's reply — what the player actually watches.
 *
 * The real Analyst is asked for 3-6 sentences and then a fenced JSON block, and the
 * agents package withholds the block from the stream (`analysisGate`). The mock has
 * to stream the same thing the server will, or the typewriter is tested against a
 * format that no longer arrives.
 */
export function mockAnalysisProse(analysis: Analysis): string {
  return analysis.observations.join(' ');
}

/** The reply in full: prose, then the block. Carried on `analysis.done.raw`. */
export function mockAnalysisRaw(analysis: Analysis): string {
  return `${mockAnalysisProse(analysis)}\n\n\`\`\`json\n${JSON.stringify(analysis, null, 2)}\n\`\`\`\n`;
}

function gateOk(gate: 1 | 2 | 3 | 4, name: GateResult['name'], ms: number, detail?: unknown): GateResult {
  return { gate, name, ok: true, ms, ...(detail === undefined ? {} : { detail }) };
}

function gateFail(gate: 1 | 2 | 3 | 4, name: GateResult['name'], ms: number, reason: string, detail?: unknown): GateResult {
  return { gate, name, ok: false, ms, reason, ...(detail === undefined ? {} : { detail }) };
}

/**
 * Attempt 1's Gate 3 rejection, in the harness's own voice.
 *
 * Both halves of spec §6.2 fail at once and both are quoted with a number, because
 * that sentence is the entire feedback channel to the Coder (spec §6.3) *and* the
 * thing the player is meant to be able to read.
 */
export function rejectionReason(round: number): string {
  return balanceReason(round, {
    panel: 0.91,
    perBot: [1, 0.96, 0.88, 0.8],
    mimic: 0.41,
  });
}

/**
 * `0.35–0.50` and the rest, per round. Spec §6.2's table, as amended by §13 delta 24.
 *
 * A copy rather than an import: `packages/web` does not depend on `@rematch/harness`
 * (the harness is a Node worker pool). `packages/harness/src/gates/balanceConfig.ts`
 * is the source of truth, and this mock lies to the player if it drifts from it.
 */
export function bandOf(round: number): string {
  return round === 2 ? '0.35–0.50' : round === 3 ? '0.50–0.65' : round === 4 ? '0.60–0.75' : '0.65–0.95';
}

/**
 * ADAPTED's target, and whether missing it rejects (spec §13, deltas 23 and 24).
 * Round 2 reports 0.70 and ships anyway; rounds 3–5 reject at 0.75 / 0.85 / 0.95.
 */
function adaptedOf(round: number): { min: number; blocks: boolean } {
  if (round === 2) return { min: 0.7, blocks: false };
  if (round === 3) return { min: 0.75, blocks: true };
  if (round === 4) return { min: 0.85, blocks: true };
  return { min: 0.95, blocks: true };
}

const BOT_NAMES = ['Camper', 'Kiter', 'Rusher', 'Dodger'] as const;

/**
 * A Gate 3 rejection in the harness's own voice, for one candidate's numbers.
 *
 * Both halves of spec §6.2 are quoted with a number when both fail, because that
 * sentence is the entire feedback channel to the Coder (spec §6.3) *and* the thing
 * the player is meant to be able to read. The bands and the wording come from
 * `packages/harness/src/gates/gate3Balance.ts`, which is what a live run prints.
 */
export function balanceReason(
  round: number,
  rates: { panel: number; perBot: readonly number[]; mimic: number },
): string {
  const lo = Number(bandOf(round).split('–')[0]);
  const hi = Number(bandOf(round).split('–')[1]);
  const perBot = BOT_NAMES.map((name, i) => `${name} ${(rates.perBot[i] ?? 0).toFixed(2)}`).join(', ');
  const problems: string[] = [];
  if (rates.panel > hi) {
    problems.push(`${rates.panel.toFixed(2)} vs panel — too hard (band ${bandOf(round)} for round ${round}; ${perBot})`);
  } else if (rates.panel < lo) {
    problems.push(`${rates.panel.toFixed(2)} vs panel — too easy (band ${bandOf(round)} for round ${round}; ${perBot})`);
  }
  const adapted = adaptedOf(round);
  if (rates.mimic < adapted.min) {
    problems.push(
      adapted.blocks
        ? `${rates.mimic.toFixed(2)} vs Mimic — didn't adapt (need >= ${adapted.min.toFixed(2)} for round ${round})`
        : `${rates.mimic.toFixed(2)} vs Mimic — aim for >= ${adapted.min.toFixed(2)} (not blocking)`,
    );
  }
  return problems.join('; ');
}

/** `detail` for one candidate's Gate 3 result, in the shape the gate reports. */
function balanceDetail(
  round: number,
  rates: { panel: number; perBot: readonly number[]; mimic: number },
): unknown {
  return {
    round,
    matches: 200,
    workers: 4,
    // Gate 3's third assertion, ACTIVE: both mock strategies keep moving, so every
    // one of these is a real zero rather than a flattering one. `attempt1.js` and
    // `round2-candidate.js` are both measured through the live gate by the suites
    // that own them, and neither has an `idle` resting state.
    activity: { longestIdleRun: 0, worstBot: 'Camper', worstSeed: 0, idleFractionP90: 0 },
    panel: {
      winRate: rates.panel,
      matches: 100,
      perBot: BOT_NAMES.map((name, i) => ({ name, winRate: rates.perBot[i] ?? 0, maxIdleRun: 0 })),
      violations: 0,
      killed: 0,
      ms: 1240,
    },
    mimic: { winRate: rates.mimic, matches: 100, avgTicks: 1820 },
  };
}

/**
 * Gate 3's progress for one candidate: the opening event, then one per batch of
 * matches, spread evenly over `ms` — the shape `simulate()`'s `onProgress`
 * produces once the worker pool is running.
 *
 * The first event is what puts the meter on screen and carries the total, so it is
 * always emitted, and the last always lands exactly on the total.
 */
function pushBalanceProgress(
  push: (delay: number, event: RewriteEvent) => void,
  attempt: number,
  tag: { candidate?: number; candidates?: number },
  total: number,
  ms: number,
): void {
  push(200, { type: 'trial.progress', attempt, matchesDone: 0, matchesTotal: total, gate: 'balance', ...tag });
  const batches = Math.max(1, Math.ceil(total / MATCH_BATCH));
  const per = ms / batches;
  for (let i = 1; i <= batches; i += 1) {
    push(Math.round(per), {
      type: 'trial.progress',
      attempt,
      matchesDone: Math.min(i * MATCH_BATCH, total),
      matchesTotal: total,
      gate: 'balance',
      ...tag,
    });
  }
}

/** One candidate of a scripted attempt: the file it wrote and what the gates said. */
type MockCandidate = {
  dial: (typeof MOCK_DIALS)[number];
  source: string;
  meta: { name: string; rationale: string; version: number };
  /** `undefined` means every gate passed. */
  rates?: { panel: number; perBot: readonly number[]; mimic: number };
  /** The approved one, with its passing Gate 3 numbers. */
  ok?: { panel: number; perBot: readonly number[]; mimic: number };
};

/** `meta` of a derived variant: the fixture's, with the Coder's name suffix on it. */
function variantMeta(
  base: { name: string; rationale: string; version: number },
  suffix: string,
): { name: string; rationale: string; version: number } {
  return { ...base, name: `${base.name} ${suffix}` };
}

/**
 * The three files one attempt writes, from one real fixture.
 *
 * `balanced` is the fixture itself; the two flanking it are the same file with the
 * named constants the dials move turned down and up (see `mockVariant`). The
 * `meta.name` suffixes are the ones the live Coder is told to use, so the tab strip
 * shows what a real run shows.
 */
function candidatesFor(
  base: string,
  baseMeta: { name: string; rationale: string; version: number },
  outcomes: {
    conservative: MockCandidate['rates'];
    balanced: MockCandidate['rates'];
    aggressive: MockCandidate['rates'];
    approved?: (typeof MOCK_DIALS)[number];
    approvedRates?: { panel: number; perBot: readonly number[]; mimic: number };
  },
): MockCandidate[] {
  return MOCK_DIALS.map((dial, i) => {
    const suffix = NAME_SUFFIXES[i] as string;
    const source = mockVariant(base, dial, suffix);
    const meta = variantMeta(baseMeta, suffix);
    if (outcomes.approved === dial) {
      return { dial, source, meta, ...(outcomes.approvedRates === undefined ? {} : { ok: outcomes.approvedRates }) };
    }
    return { dial, source, meta, ...(outcomes[dial] === undefined ? {} : { rates: outcomes[dial] }) };
  });
}

/**
 * One attempt: K files streamed at once, then the harness on each in turn.
 *
 * The deltas are interleaved round-robin rather than played one file after another,
 * because that is what the live loop does — the K model calls run concurrently and
 * their deltas arrive mixed — and it is what the tab strip has to survive. The
 * gates then run candidate by candidate, in index order, exactly as the loop
 * sequences them (one worker pool at a time).
 */
function pushAttempt(
  push: (delay: number, event: RewriteEvent) => void,
  attempt: number,
  baseline: string,
  candidates: readonly MockCandidate[],
  round: number,
): { gates: GateResult[][]; diffs: string[] } {
  const total = candidates.length;
  const tagOf = (i: number): { candidate?: number; candidates?: number } =>
    total > 1 ? { candidate: i, candidates: total } : {};

  // ------------------------------------------------------------- the streams
  const streams = candidates.map((c) => codeChunks(c.source));
  const longest = Math.max(...streams.map((s) => s.length));
  let first = true;
  for (let line = 0; line < longest; line += 1) {
    for (let i = 0; i < total; i += 1) {
      const delta = streams[i]?.[line];
      if (delta === undefined) continue;
      push(first ? 500 : Math.max(1, Math.round(CODE_LINE_MS / total)), {
        type: 'rewrite.delta',
        attempt,
        delta,
        ...tagOf(i),
      });
      first = false;
    }
  }

  const diffs = candidates.map((c) =>
    unifiedDiff(baseline, c.source, {
      fromFile: 'strategy.js (previous)',
      toFile: `strategy.js (attempt ${attempt})`,
    }),
  );
  candidates.forEach((c, i) => {
    push(i === 0 ? 300 : 60, {
      type: 'rewrite.done',
      attempt,
      source: c.source,
      diff: diffs[i] as string,
      meta: { ...c.meta },
      dial: c.dial,
      ...tagOf(i),
    });
  });

  // -------------------------------------------------------------- the gates
  const gates: GateResult[][] = [];
  candidates.forEach((c, i) => {
    const tag = tagOf(i);
    const mine: GateResult[] = [];

    const g1 = gateOk(1, 'static', 11 + i, { identifiers: 0, exports: ['meta', 'init', 'decide'] });
    push(300, { type: 'trial.gate', attempt, gate: g1, ...tag });
    mine.push(g1);

    const g2 = gateOk(2, 'fuzz', 780 + i * 20, { states: 500, invalid: 0, threw: 0 });
    push(420, { type: 'trial.gate', attempt, gate: g2, ...tag });
    mine.push(g2);

    pushBalanceProgress(push, attempt, tag, 200, 1150);
    const measured = c.ok ?? c.rates;
    const g3 =
      c.rates === undefined
        ? gateOk(3, 'balance', 1290, balanceDetail(round, measured ?? { panel: 0.5, perBot: [1, 0.3, 0.4, 0.3], mimic: 0.78 }))
        : gateFail(3, 'balance', 1290, balanceReason(round, c.rates), balanceDetail(round, c.rates));
    push(60, { type: 'trial.gate', attempt, gate: g3, ...tag });
    mine.push(g3);

    if (c.rates === undefined) {
      const g4 = gateOk(4, 'perf', 590, { samples: 2000, p50: 0.09, p99: 0.41, max: 1.2, budgetMs: 2 });
      push(560, { type: 'trial.gate', attempt, gate: g4, ...tag });
      mine.push(g4);
    }

    push(180, {
      type: 'verdict',
      attempt,
      approved: c.rates === undefined,
      ...(c.rates === undefined ? {} : { reason: balanceReason(round, c.rates) }),
      ...(measured === undefined ? {} : { panel: measured.panel }),
      ...tag,
    });
    gates.push(mine);
  });

  return { gates, diffs };
}

/**
 * Build the canned run for one request.
 *
 * The shape is spec §6.3's loop as it now runs: each attempt writes three files at
 * once — aimed at the low edge, the middle and the high edge of the round's band —
 * and the harness judges all three. Attempt 1's three all miss (one too easy, two
 * too hard, which is exactly the bracket the retry prompt interpolates inside) and
 * attempt 2's middle candidate lands in the band and beats the Mimic. That is the
 * minimum sequence that proves the product's thesis on screen, so it is what the
 * mock always plays.
 */
export function buildMockScript(req: RewriteRequest): MockScript {
  const steps: MockStep[] = [];
  const push = (delay: number, event: RewriteEvent): void => void steps.push({ delay, event });

  const analysis = mockAnalysis(req);
  const round = req.round;

  push(0, { type: 'replay', summary: req.summary, round });

  // ------------------------------------------------------------- beat 2
  // Prose only, exactly like the live stream: the Analyst writes its sentences
  // first and its JSON block second, and the block never reaches the player (see
  // `analysisGate` in `@rematch/agents`). `raw` carries both for the run log.
  let first = true;
  for (const delta of chunkText(mockAnalysisProse(analysis), TEXT_CHARS_PER_CHUNK)) {
    push(first ? 700 : TEXT_CHUNK_MS, { type: 'analysis.delta', delta });
    first = false;
  }
  push(400, {
    type: 'analysis.done',
    analysis,
    raw: mockAnalysisRaw(analysis),
    calls: 1,
    promptChars: 4180,
    usage: { inputTokens: 1246, outputTokens: 331, cacheReadTokens: 0 },
    ms: 2960,
  });

  // --------------------------------------- attempt 1: three files, all rejected
  // Below the band, above it, and far above it: the bracket the retry prompt
  // interpolates inside, and the 0.91 of spec §2.2's rejection line.
  const a1 = candidatesFor(attempt1Source, ATTEMPT1_META, {
    conservative: { panel: 0.22, perBot: [0.64, 0, 0.24, 0], mimic: 0.66 },
    balanced: { panel: 0.55, perBot: [1, 0.2, 1, 0], mimic: 0.62 },
    aggressive: { panel: 0.91, perBot: [1, 0.96, 0.88, 0.8], mimic: 0.41 },
  });
  const run1 = pushAttempt(push, 1, req.prevSource, a1, round);
  // The attempt's own verdict, with no `candidate`: the summary a K-unaware client
  // sees, carrying the reason of the candidate closest to the middle of the band —
  // the one the loop feeds forward as the next attempt's baseline.
  const chosen1 = 1;
  push(280, {
    type: 'verdict',
    attempt: 1,
    approved: false,
    reason: balanceReason(round, a1[chosen1]!.rates!),
  });

  // -------------------------------------- attempt 2: the middle one is approved
  const a2 = candidatesFor(approvedSource, APPROVED_META, {
    conservative: { panel: 0.29, perBot: [0.84, 0, 0.32, 0], mimic: 0.71 },
    balanced: undefined,
    aggressive: { panel: 0.74, perBot: [1, 0.68, 0.96, 0.32], mimic: 0.86 },
    approved: 'balanced',
    // The real Gate 3 numbers for `round2-candidate.js` at the spec's 200 matches
    // (`pnpm test:harness`, "approves the hand-written Round 2 candidate"). Canned,
    // but not invented: if the fixture changes, these have to be re-measured, and
    // `test/mock-source.test.ts` keeps the claim tied to the band.
    approvedRates: { panel: 0.45, perBot: [0.64, 0.52, 0, 0.64], mimic: 0.75 },
  });
  // The middle candidate is the real fixture, byte for byte, because it is the file
  // the game is about to run — only its name carries the suffix.
  a2[1] = { ...a2[1]!, source: approvedSource, meta: { ...APPROVED_META } };
  const run2 = pushAttempt(push, 2, a1[chosen1]!.source, a2, round);
  push(320, { type: 'verdict', attempt: 2, approved: true });

  const attempts: AttemptLog[] = [
    {
      attempt: 1,
      source: a1[chosen1]!.source,
      diff: run1.diffs[chosen1] as string,
      coder: { calls: 3, promptChars: 9840, usage: { inputTokens: 9030, outputTokens: 2226 }, ms: 5210 },
      gates: run1.gates[chosen1] as GateResult[],
      approved: false,
      reason: balanceReason(round, a1[chosen1]!.rates!),
      ms: 12_400,
      chosen: chosen1,
      candidates: a1.map((c, i) => ({
        candidate: i,
        dial: c.dial,
        source: c.source,
        diff: run1.diffs[i] as string,
        name: c.meta.name,
        coder: { calls: 1, promptChars: 9840, usage: { inputTokens: 3010, outputTokens: 742 }, ms: 5210 },
        gates: run1.gates[i] as GateResult[],
        approved: false,
        reason: balanceReason(round, c.rates!),
        panel: c.rates!.panel,
      })),
    },
    {
      attempt: 2,
      source: approvedSource,
      diff: run2.diffs[1] as string,
      coder: { calls: 3, promptChars: 11_260, usage: { inputTokens: 10_464, outputTokens: 2904 }, ms: 5620 },
      gates: run2.gates[1] as GateResult[],
      approved: true,
      ms: 13_100,
      chosen: 1,
      candidates: a2.map((c, i) => ({
        candidate: i,
        dial: c.dial,
        source: c.source,
        diff: run2.diffs[i] as string,
        name: c.meta.name,
        coder: { calls: 1, promptChars: 11_260, usage: { inputTokens: 3488, outputTokens: 968 }, ms: 5620 },
        gates: run2.gates[i] as GateResult[],
        approved: c.rates === undefined,
        ...(c.rates === undefined ? {} : { reason: balanceReason(round, c.rates) }),
        panel: (c.ok ?? c.rates)!.panel,
      })),
    },
  ];

  push(300, {
    type: 'done',
    result: { approved: true, source: approvedSource, meta: { ...APPROVED_META }, attempts, analysis },
  });

  return steps;
}


export function scriptDuration(script: MockScript): number {
  return script.reduce((total, step) => total + step.delay, 0);
}

// ------------------------------------------------------------------ the source

/** `setTimeout` that resolves early — not rejects — when the signal aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
    signal.addEventListener('abort', finish, { once: true });
  });
}

/**
 * The mock `InterludeSource`.
 *
 * On abort it stops emitting and resolves — no `fallback`/`done` synthesized. The
 * caller aborted, so the caller already knows what it is going to show (the 45 s
 * deadline banner in `app.ts`); an event stream that keeps talking after being
 * cancelled is how a UI ends up in two states at once.
 */
export function mockSource(options: MockOptions = {}): InterludeSource {
  const speed = Math.max(0.01, options.speed ?? 1);

  return async (req, onEvent, signal) => {
    const built = options.script === undefined ? buildMockScript(req) : typeof options.script === 'function' ? options.script(req) : options.script;

    for (const step of built) {
      if (signal.aborted) return;
      await sleep(step.delay / speed, signal);
      if (signal.aborted) return;
      onEvent(step.event);
    }
  };
}
