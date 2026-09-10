/**
 * The "it learned" banner — a pure timing state machine, in the style of
 * `interlude/castStatus.ts`'s `reduceCast`: fold events into a state, format the
 * state separately, and keep the DOM out of the part that can be unit tested.
 *
 * The claim on screen ("the boss's new name plus its `meta.rationale`") is only
 * true of a strategy the loop actually wrote this session — `originLabel` in
 * `ui/hud.ts` draws the identical line between `approved` and everything else, and
 * this reducer draws it the same way: a round that starts on a `bundled` or
 * `fallback` strategy never arms the banner, so the fight never implies a rewrite
 * that did not happen.
 *
 * A pre-fight interstitial, not an overlay on a live fight: `app.ts` shows this
 * *before* the round's simulation starts stepping (`docs/AI-DEV-LOG.md`'s
 * 2026-09-09 entry has the playtest finding that moved it there — Matt's own
 * words, "coloque na tela... por uns 3-4 segundos, depois feche e comece o
 * jogo"). That is why the clock here is wall time (`nowMs`, from
 * `performance.now()`), not ticks the way `effects.ts` and the rest of the
 * renderer age: while `holding`, the sim has not taken a single tick yet — there
 * is no tick clock to measure against — and the delay is host-side UI timing that
 * gates *when* `app.ts` calls `loop.start()`, the same category of timing as the
 * interlude's own `setTimeout` deadlines, not a simulation input.
 */

/**
 * Mirrors `app.ts`'s `StrategyProvenance` — inlined rather than imported, the same
 * way `HudInfo.provenance` in `ui/hud.ts` is: `app.ts` is this module's caller, and
 * importing its type back would make the module graph circular for no benefit.
 */
export type StrategyProvenance = 'bundled' | 'approved' | 'fallback';

/** ~3.5 seconds, per the playtest ask ("por uns 3-4 segundos"). */
export const BANNER_HOLD_MS = 3500;

export type BannerPhase = 'hidden' | 'holding';

export type BannerState = {
  phase: BannerPhase;
  name: string;
  rationale: string;
  /** Wall-clock ms the interstitial opened, or `null` while hidden. */
  startedAtMs: number | null;
};

export const INITIAL_BANNER_STATE: BannerState = {
  phase: 'hidden',
  name: '',
  rationale: '',
  startedAtMs: null,
};

export type BannerEvent =
  | { type: 'roundStart'; nowMs: number; provenance: StrategyProvenance; name: string; rationale: string }
  | { type: 'clock'; nowMs: number };

/**
 * Fold one event into the banner state. Pure, so `test/round-banner.test.ts` can
 * assert the whole sequence — armed, held, gone — without a DOM or a real timer.
 */
export function reduceBanner(state: BannerState, event: BannerEvent): BannerState {
  if (event.type === 'roundStart') {
    // Round 1's bundled boss, a fallback pick, and a retry (which replays the
    // fight the player just lost rather than a fresh one the loop wrote) all
    // claim nothing here, for the same reason `originLabel('bundled' |
    // 'fallback')` does not say "written for you": none of them is a rewrite
    // this session produced for this player.
    if (event.provenance !== 'approved') return INITIAL_BANNER_STATE;
    return { phase: 'holding', name: event.name, rationale: event.rationale, startedAtMs: event.nowMs };
  }

  if (state.phase !== 'holding' || state.startedAtMs === null) return state;
  if (event.nowMs - state.startedAtMs >= BANNER_HOLD_MS) return INITIAL_BANNER_STATE;
  return state;
}

/** Whether the banner should be in the DOM at all right now. */
export function bannerVisible(state: BannerState): boolean {
  return state.phase !== 'hidden';
}

/**
 * Whether the round this state belongs to must hold — `app.ts` reads this right
 * after `roundStart` to decide whether to call `loop.start()` immediately (no
 * interstitial) or to wait for the hold to end (see `app.ts`'s hold ticker).
 */
export function bannerHolding(state: BannerState): boolean {
  return state.phase === 'holding';
}
