/**
 * The "it learned" banner's DOM half — `roundBanner.ts` owns the timing, this owns
 * turning that state into three lines of text and a CSS animation. Split the same
 * way `createHud` is split from `formatClock`/`formatRunnerLine`: the state machine
 * is unit tested in Node, this is exercised by `e2e/interlude.spec.ts` in a browser.
 *
 * Text, not a picture: `meta.rationale` is the honest artifact this feature exists
 * to surface (see the module doc in `roundBanner.ts`), and it has to be read, not
 * glanced at.
 */
import {
  bannerHolding,
  reduceBanner,
  type BannerEvent,
  type BannerPhase,
  type BannerState,
  type StrategyProvenance,
} from './roundBanner.ts';

export { INITIAL_BANNER_STATE } from './roundBanner.ts';

/** How long the dismiss fade plays before the box actually leaves the DOM. Purely
 *  cosmetic — `app.ts` starts the round the instant the reducer says `hidden`,
 *  independent of whether this fade has finished playing over it. */
const DISMISS_FADE_MS = 280;

export type RoundBanner = {
  /**
   * Call once when a round starts. A no-op on screen unless `provenance ===
   * 'approved'` — see `roundBanner.ts`'s `reduceBanner`.
   */
  start(nowMs: number, provenance: StrategyProvenance, name: string, rationale: string): void;
  /**
   * Call repeatedly with the current wall clock while `isHolding()` — `app.ts`
   * runs a small `requestAnimationFrame` ticker for exactly this, since the round
   * has not started stepping yet and there is no tick clock to drive it instead.
   */
  update(nowMs: number): void;
  /** Whether the interstitial is currently up — `app.ts` gates `loop.start()` on this. */
  isHolding(): boolean;
  /** Drop state and hide immediately — a round tearing down mid-banner. */
  reset(): void;
};

function el(tag: string, className: string): HTMLDivElement {
  const node = document.createElement('div');
  node.className = className;
  return node;
}

export function createRoundBanner(root: HTMLElement): RoundBanner {
  const box = el('div', 'round-banner');
  box.dataset.testid = 'round-banner';
  box.hidden = true;

  const kicker = el('div', 'round-banner-kicker');
  kicker.textContent = 'THE BOSS LEARNED';
  const name = el('div', 'round-banner-name');
  name.dataset.testid = 'round-banner-name';
  const rationale = el('div', 'round-banner-rationale');
  rationale.dataset.testid = 'round-banner-rationale';
  box.append(kicker, name, rationale);
  root.append(box);

  let state: BannerState = { phase: 'hidden', name: '', rationale: '', startedAtMs: null };
  let lastPhase: BannerPhase = 'hidden';
  let dismissTimer: ReturnType<typeof setTimeout> | null = null;

  function clearDismissTimer(): void {
    if (dismissTimer !== null) {
      clearTimeout(dismissTimer);
      dismissTimer = null;
    }
  }

  function apply(event: BannerEvent): void {
    const wasHolding = state.phase === 'holding';
    state = reduceBanner(state, event);
    if (state.phase === lastPhase) return;
    lastPhase = state.phase;

    if (state.phase === 'holding') {
      clearDismissTimer();
      box.hidden = false;
      box.classList.remove('leaving');
      name.textContent = state.name;
      rationale.textContent = `“${state.rationale}”`;
      // Restart the entrance animation even on back-to-back approvals. The reflow
      // is what makes the removal-then-add take effect instead of being coalesced.
      box.classList.remove('entering');
      void box.offsetWidth;
      box.classList.add('entering');
      return;
    }

    // `hidden`. A no-op reset (never armed) needs no fade; an actual dismiss —
    // the hold just ended — gets the brief settle before it leaves the DOM.
    if (!wasHolding) {
      box.hidden = true;
      return;
    }
    box.classList.remove('entering');
    box.classList.add('leaving');
    dismissTimer = setTimeout(() => {
      dismissTimer = null;
      box.hidden = true;
      box.classList.remove('leaving');
    }, DISMISS_FADE_MS);
  }

  return {
    start(nowMs, provenance, n, r): void {
      apply({ type: 'roundStart', nowMs, provenance, name: n, rationale: r });
    },
    update(nowMs): void {
      apply({ type: 'clock', nowMs });
    },
    isHolding(): boolean {
      return bannerHolding(state);
    },
    reset(): void {
      clearDismissTimer();
      state = { phase: 'hidden', name: '', rationale: '', startedAtMs: null };
      lastPhase = 'hidden';
      box.hidden = true;
      box.classList.remove('entering', 'leaving');
    },
  };
}
