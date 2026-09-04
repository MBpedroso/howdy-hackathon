/**
 * The recorded event source: replay a **real** eval run from a static JSON file.
 *
 * ```
 * ?agent=recorded              # the first run in public/recorded/index.json
 * ?agent=recorded&run=kiter-a  # a named run
 * ?agent=recorded&speed=20     # 20x, which is how the e2e suite watches it
 * ```
 *
 * ## Why this exists
 *
 * There were three ways to show the interlude before this file: the live server
 * (`sseSource`, real, costs money and needs a key), the mock (`mockSource`, free,
 * scripted by hand), and nothing. For a demo video that is a bad set of choices — the
 * live path spends real credit on every take, and the mock is honest but it is not the
 * model. So this is the fourth: the **real model's real output**, recorded once from
 * `pnpm eval:agents` and replayed from disk for free, forever.
 *
 * Every byte the player reads came out of `gpt-5.4-mini` in September: the Analyst's
 * prose, the candidate files, and — the part that matters — the harness's own
 * rejection sentences and the approval that followed them. The strategy the terminal
 * `done` carries is the one that was actually approved at the round's band, and the
 * next round really loads it through QuickJS. That is the difference between this and
 * a screen recording.
 *
 * ## What is honest about it, and what is not
 *
 * The badge reads `RECORDED RUN · <model> · <date>` for the whole interlude, because a
 * viewer must never have to guess which of the three sources they are looking at.
 *
 * The one reconstructed thing is the **cadence**. The eval artifact records no
 * timestamp per event (see `scripts/timeline.ts`), so the offsets in `at[]` are
 * derived from the durations it does measure — the Analyst's beat, each candidate's
 * Coder call, every gate — and scaled so the replay lasts exactly as long as the real
 * run did. Phase boundaries are measured; the spacing inside a phase is interpolated.
 * Each recorded file states this in its own `timing.method`.
 *
 * @see scripts/record-run.ts — the recorder, and what it strips
 */
import { isRewriteEvent, type RewriteEvent } from './events.ts';
import type { InterludeSource } from './source.ts';

/** Where the recorder writes and this file reads. Relative to the Vite base. */
export const RECORDED_PATH = 'recorded';

/** The seven-field header every recorded file carries, plus an optional caveat. */
export type RecordedHeader = {
  provider: string;
  model: string;
  round: number;
  archetype: string;
  /** ISO. The badge shows the date half. */
  recordedAt: string;
  approved: boolean;
  attempts: number;
  /**
   * A caveat about this recording, shown on screen next to the badge.
   *
   * Added by hand, not by the recorder, and it exists for one specific reason: all
   * three runs committed here were recorded on 2026-09-03, *before* Gate 3 grew its
   * ACTIVE assertion, so the strategies they got approved use `idle` as a resting
   * state and the boss visibly freezes — up to 764 consecutive ticks in `dodger-a`,
   * nearly thirteen seconds. Re-recording would mean inventing model output, which
   * is the one thing this mode exists not to do (see `scripts/record-run.ts`), so
   * the runs stay and the caveat ships with them. A viewer who can see the freeze
   * can also read why it is there.
   */
  knownIssue?: string;
};

export type RecordedFile = RecordedHeader & {
  timing?: { method?: string; totalMs?: number };
  /** Milliseconds from the first event, one per entry of `events`. */
  at: number[];
  events: RewriteEvent[];
};

export type RecordedIndexEntry = {
  name: string;
  model: string;
  recordedAt: string;
  strategy?: string;
  rejections?: number;
  label?: string;
  /** Mirrors the run file's own caveat, so a picker can show it without a fetch. */
  knownIssue?: string;
};

export type RecordedIndex = { runs: RecordedIndexEntry[]; source?: string };

export type RecordedOptions = {
  /** Divides every delay. 1 = the real run's wall clock; 20 = the e2e suite. */
  speed?: number;
  /** Prefix for the fetch. Defaults to Vite's `BASE_URL`. Injected by tests. */
  baseUrl?: string;
  /** Injected by tests. Defaults to the global. */
  fetchImpl?: typeof fetch;
  /**
   * Called once the file's header is known, before the first event.
   *
   * The badge has to name the model and the date, and neither is known until the
   * fetch lands — so provenance arrives out of band rather than as an event. The UI
   * shows `RECORDED RUN` until this fires and the full line after it.
   */
  onHeader?: (header: RecordedHeader, name: string) => void;
};

/**
 * `RECORDED RUN · gpt-5.4-mini · 2026-09-03` — the badge, and the whole honesty claim
 * of this mode in one string.
 *
 * The date is the `recordedAt` day, sliced rather than localised on purpose: a
 * timezone-dependent badge would put a different date in the video than in the docs
 * that cite the same run.
 */
export function provenanceLabel(header: Pick<RecordedHeader, 'model' | 'recordedAt'>): string {
  const day = header.recordedAt.slice(0, 10);
  return `RECORDED RUN · ${header.model} · ${day}`;
}

/**
 * `KNOWN ISSUE · boss idles up to 183 ticks …` — the caveat, ready for the footer.
 *
 * Separate from `provenanceLabel` because the badge is a 9px chip that says *what*
 * the viewer is looking at, and this is a sentence that says what is *wrong* with
 * it. Returns `undefined` when the recording has nothing to disclose, which is how
 * a future re-recording turns the line off: delete the field.
 */
export function knownIssueLabel(header: Pick<RecordedHeader, 'knownIssue'>): string | undefined {
  const note = header.knownIssue;
  if (typeof note !== 'string' || note.trim() === '') return undefined;
  return `KNOWN ISSUE · ${note.trim()}`;
}

function joinBase(base: string, path: string): string {
  const prefix = base === '' ? './' : base.endsWith('/') ? base : `${base}/`;
  return `${prefix}${path}`;
}

/** Vite's configured base, or `./` outside a bundle (the unit tests). */
function defaultBase(): string {
  const base = (import.meta.env?.BASE_URL as string | undefined) ?? './';
  return base;
}

async function fetchJson<T>(url: string, options: RecordedOptions, signal: AbortSignal): Promise<T> {
  const call = options.fetchImpl ?? fetch;
  const response = await call(url, { signal, headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`could not load ${url}: HTTP ${response.status}`);
  return (await response.json()) as T;
}

/** `public/recorded/index.json` — the runs available, newest eval first. */
export async function loadRecordedIndex(
  options: RecordedOptions = {},
  signal: AbortSignal = new AbortController().signal,
): Promise<RecordedIndex> {
  const base = options.baseUrl ?? defaultBase();
  const index = await fetchJson<RecordedIndex>(joinBase(base, `${RECORDED_PATH}/index.json`), options, signal);
  if (!Array.isArray(index.runs) || index.runs.length === 0) {
    throw new Error('recorded index lists no runs');
  }
  return index;
}

/**
 * Read the inter-event delays out of a recorded file.
 *
 * Pure and exported so the replay's arithmetic is testable without a fetch or a clock.
 * Two properties it guarantees, because a recorded run must not be able to hang or to
 * run backwards:
 *
 *  - never negative — a non-monotonic `at[]` (a hand-edited file) yields `0`, so the
 *    events still arrive in order and immediately;
 *  - `at` shorter than `events` falls back to `0` for the remainder, which plays the
 *    tail as fast as the browser can render it rather than dropping it.
 */
export function delaysOf(file: Pick<RecordedFile, 'at' | 'events'>, speed: number): number[] {
  const divisor = Math.max(0.01, speed);
  const at = Array.isArray(file.at) ? file.at : [];
  return file.events.map((_event, index) => {
    const previous = index === 0 ? 0 : (at[index - 1] ?? 0);
    const current = at[index] ?? previous;
    const gap = Math.max(0, current - previous);
    return gap / divisor;
  });
}

/**
 * The shortest sleep worth asking a browser for.
 *
 * A run is ~6 000 events, most of them `rewrite.delta` a millisecond or two apart, and
 * at `?speed=20` those gaps are ~50 µs. One `setTimeout` per event would be *slower
 * than the recording*: browsers clamp a timeout to ≥1 ms and to ~4 ms once timers are
 * nested more than five deep, so 6 000 of them take ~25 s no matter what number they
 * were given. (Measured, not guessed — that is exactly how the first version of this
 * file failed its own e2e test: 1 223 of 6 338 events in six seconds.)
 *
 * So events due within this window of *now* are emitted in the same tick, and the
 * scheduler only yields when there is real time to wait. 4 ms is the clamp itself:
 * asking for less buys nothing and costs a yield.
 */
export const MIN_SLEEP_MS = 4;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * Build a source that replays one recorded run.
 *
 * `name` of `null` means "whatever `index.json` lists first", which is what a bare
 * `?agent=recorded` gets: the demo URL should not have to name a file, and the default
 * is then one edit to `index.json` rather than a code change.
 *
 * Unlike `sseSource` this cannot fall back to the mock. A missing or malformed
 * recorded file is a **build** mistake — the asset is committed — and silently
 * swapping in the mock would be exactly the dishonesty the badge exists to prevent, so
 * it throws and the caller shows the error.
 */
export function recordedSource(name: string | null, options: RecordedOptions = {}): InterludeSource {
  const base = options.baseUrl ?? defaultBase();
  const speed = Math.max(0.01, options.speed ?? 1);

  return async (_req, onEvent, signal) => {
    let chosen = name;
    if (chosen === null || chosen === '') {
      const index = await loadRecordedIndex(options, signal);
      if (signal.aborted) return;
      chosen = index.runs[0]?.name ?? null;
      if (chosen === null) throw new Error('recorded index lists no runs');
    }

    const file = await fetchJson<RecordedFile>(joinBase(base, `${RECORDED_PATH}/${chosen}.json`), options, signal);
    if (signal.aborted) return;
    if (!Array.isArray(file.events) || file.events.length === 0) {
      throw new Error(`recorded run "${chosen}" has no events`);
    }
    options.onHeader?.(file, chosen);

    // Scheduled against a **wall clock**, not by adding up per-event delays. Two
    // things that buys, both of which matter for a run this long:
    //
    //  - no accumulated drift. A tick that oversleeps by 3 ms is absorbed by the next
    //    event's target instead of pushing every later event out, so the replay still
    //    ends on `totalMs / speed` however busy the main thread was.
    //  - no timer per event. Anything already due is emitted in the current tick (see
    //    `MIN_SLEEP_MS`), which is what makes 6 000 events at 20x take ~1.2 s.
    const at = Array.isArray(file.at) ? file.at : [];
    const startedAt = performance.now();
    for (const [index, event] of file.events.entries()) {
      const dueAt = startedAt + (at[index] ?? 0) / speed;
      const waitMs = dueAt - performance.now();
      if (waitMs >= MIN_SLEEP_MS) {
        await sleep(waitMs, signal);
        if (signal.aborted) return;
      }
      // The file is an asset in this repo, but it is still parsed JSON — an event the
      // renderer does not know is dropped exactly as it would be off the wire.
      if (!isRewriteEvent(event)) continue;
      onEvent(event);
    }
  };
}
