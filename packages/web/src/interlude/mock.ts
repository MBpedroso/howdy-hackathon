/**
 * The mock event source: a scripted, timed replay of one realistic rewrite run.
 *
 * This is not a stub with placeholder text. It is the demo's floor: `pnpm dev` with
 * no server, no API key and no network still plays the full four-beat interlude,
 * including a Gate 3 rejection and the fix, and hands the game a **real strategy**
 * to fight — `packages/harness/test/fixtures/round2-candidate.js`, the same file the
 * harness's balance suite measures at 0.52 vs the panel and 0.78 vs a Mimic. So the
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
  const band = round === 2 ? '0.35–0.50' : round === 3 ? '0.45–0.60' : round === 4 ? '0.50–0.65' : '0.55–0.70';
  return (
    `0.91 vs panel — too hard (band ${band} for round ${round}; Camper 1.00, Kiter 0.96, Rusher 0.88, Dodger 0.80); ` +
    `0.41 vs Mimic — didn't adapt (need ≥ 0.70)`
  );
}

const G3_DETAIL_FAIL = {
  round: 2,
  matches: 200,
  workers: 4,
  panel: { winRate: 0.91, matches: 100, violations: 0, killed: 0, ms: 3980 },
  mimic: { winRate: 0.41, matches: 100, avgTicks: 1520 },
};

const G3_DETAIL_OK = {
  round: 2,
  matches: 200,
  workers: 4,
  panel: { winRate: 0.52, matches: 100, violations: 0, killed: 0, ms: 3870 },
  mimic: { winRate: 0.78, matches: 100, avgTicks: 2140 },
};

/**
 * Gate 3's progress for one attempt: the opening event, then one per batch of
 * matches, spread evenly over `ms` — the shape `simulate()`'s `onProgress`
 * produces once the worker pool is running.
 *
 * The first event is what puts the meter on screen and carries the total, so it is
 * always emitted, and the last always lands exactly on the total.
 */
function pushBalanceProgress(
  push: (delay: number, event: RewriteEvent) => void,
  attempt: number,
  total: number,
  ms: number,
): void {
  push(250, { type: 'trial.progress', attempt, matchesDone: 0, matchesTotal: total, gate: 'balance' });
  const batches = Math.max(1, Math.ceil(total / MATCH_BATCH));
  const per = ms / batches;
  for (let i = 1; i <= batches; i += 1) {
    push(Math.round(per), {
      type: 'trial.progress',
      attempt,
      matchesDone: Math.min(i * MATCH_BATCH, total),
      matchesTotal: total,
      gate: 'balance',
    });
  }
}

/**
 * Build the canned run for one request.
 *
 * The shape is spec §6.3's loop with exactly one rejection: Coder → Gates 1,2 pass →
 * Gate 3 fails "too hard" → rejection reason → Coder → all four pass → APPROVED.
 * That is the minimum sequence that proves the product's thesis on screen, so it is
 * what the mock always plays.
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

  // ------------------------------------------------- attempt 1: too hard
  const a1Gates: GateResult[] = [];
  first = true;
  for (const delta of codeChunks(attempt1Source)) {
    push(first ? 500 : CODE_LINE_MS, { type: 'rewrite.delta', attempt: 1, delta });
    first = false;
  }
  const diff1 = unifiedDiff(req.prevSource, attempt1Source, {
    fromFile: 'strategy.js (previous)',
    toFile: 'strategy.js (attempt 1)',
  });
  push(350, { type: 'rewrite.done', attempt: 1, source: attempt1Source, diff: diff1, meta: { ...ATTEMPT1_META } });

  const g1a = gateOk(1, 'static', 12, { identifiers: 0, exports: ['meta', 'init', 'decide'] });
  push(500, { type: 'trial.gate', attempt: 1, gate: g1a });
  a1Gates.push(g1a);

  const g2a = gateOk(2, 'fuzz', 842, { states: 500, invalid: 0, threw: 0 });
  push(1050, { type: 'trial.gate', attempt: 1, gate: g2a });
  a1Gates.push(g2a);

  pushBalanceProgress(push, 1, 200, 3950);
  const g3a = gateFail(3, 'balance', 4118, rejectionReason(round), G3_DETAIL_FAIL);
  push(60, { type: 'trial.gate', attempt: 1, gate: g3a });
  a1Gates.push(g3a);

  push(300, { type: 'verdict', attempt: 1, approved: false, reason: rejectionReason(round) });

  // ------------------------------------------------ attempt 2: approved
  const a2Gates: GateResult[] = [];
  first = true;
  for (const delta of codeChunks(approvedSource)) {
    push(first ? 900 : CODE_LINE_MS, { type: 'rewrite.delta', attempt: 2, delta });
    first = false;
  }
  const diff2 = unifiedDiff(attempt1Source, approvedSource, {
    fromFile: 'strategy.js (previous)',
    toFile: 'strategy.js (attempt 2)',
  });
  push(350, { type: 'rewrite.done', attempt: 2, source: approvedSource, diff: diff2, meta: { ...APPROVED_META } });

  const g1b = gateOk(1, 'static', 11, { identifiers: 0, exports: ['meta', 'init', 'decide'] });
  push(450, { type: 'trial.gate', attempt: 2, gate: g1b });
  a2Gates.push(g1b);

  const g2b = gateOk(2, 'fuzz', 795, { states: 500, invalid: 0, threw: 0 });
  push(900, { type: 'trial.gate', attempt: 2, gate: g2b });
  a2Gates.push(g2b);

  pushBalanceProgress(push, 2, 200, 3850);
  const g3b = gateOk(3, 'balance', 4032, G3_DETAIL_OK);
  push(60, { type: 'trial.gate', attempt: 2, gate: g3b });
  a2Gates.push(g3b);

  const g4b = gateOk(4, 'perf', 611, { samples: 2000, p50: 0.09, p99: 0.41, max: 1.2, budgetMs: 2 });
  push(650, { type: 'trial.gate', attempt: 2, gate: g4b });
  a2Gates.push(g4b);

  push(400, { type: 'verdict', attempt: 2, approved: true });

  const attempts: AttemptLog[] = [
    {
      attempt: 1,
      source: attempt1Source,
      diff: diff1,
      coder: { calls: 1, promptChars: 9840, usage: { inputTokens: 3010, outputTokens: 742 }, ms: 5210 },
      gates: a1Gates,
      approved: false,
      reason: rejectionReason(round),
      ms: 10_290,
    },
    {
      attempt: 2,
      source: approvedSource,
      diff: diff2,
      coder: { calls: 1, promptChars: 11_260, usage: { inputTokens: 3488, outputTokens: 968 }, ms: 5620 },
      gates: a2Gates,
      approved: true,
      ms: 11_120,
    },
  ];

  push(300, {
    type: 'done',
    result: { approved: true, source: approvedSource, meta: { ...APPROVED_META }, attempts, analysis },
  });

  return steps;
}

/** Sum of the script's delays at `speed: 1` — what "~25 s" is measured against. */
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
