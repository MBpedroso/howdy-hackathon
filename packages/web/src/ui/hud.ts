/**
 * The HUD — everything the player must be able to read without decoding a shape.
 *
 * DOM, not canvas: text stays crisp at any DPR with no font plumbing, and a screen
 * reader (and a Playwright assertion) can see it. The canvas keeps the *world*
 * readouts — the boss's HP bar floats above the boss, where the player is looking.
 *
 * Written on every frame but only touched when a value actually changed: at 60 Hz a
 * blind `textContent =` on six nodes is enough to show up in a profile.
 */
import { CONSTANTS } from '@rematch/contract';
import { ENGINE_CONSTANTS, type GameState } from '@rematch/engine';

import type { RunnerStats } from '../game/runnerStats.ts';

const MAX_TICKS = ENGINE_CONSTANTS.round.maxTicks;

/**
 * The provenance chip's words. A pure function so the one rule that matters can be
 * asserted without a DOM: a strategy nobody approved this session must never read
 * as one that was written for this player.
 */
export function originLabel(provenance: 'bundled' | 'approved' | 'fallback'): string {
  if (provenance === 'approved') return 'written for you';
  if (provenance === 'fallback') return 'pre-approved';
  // Round 1. It ships with the client and claims nothing, so it says nothing.
  return '';
}

export type HudInfo = {
  round: number;
  maxRounds: number;
  sessionSeed: number;
  roundSeed: number;
  /** Averaged tick + render cost, for the small diagnostics line. */
  tickMs: number;
  renderMs: number;
  /** `decide` counters, or `null` when the round does not track them. */
  runner?: RunnerStats | null;
  /**
   * Where this round's strategy came from (`app.ts`, `StrategyProvenance`).
   *
   * On screen it is one small word next to the boss's name, and it is the most
   * honest label in the product: a boss the harness approved this session and one
   * lifted from the pre-approved pool are otherwise identical here, and the claim
   * being made — "it read your replay and rewrote itself" — is only true of one of
   * them. A demo that cannot tell them apart is a demo that overclaims.
   */
  provenance?: 'bundled' | 'approved' | 'fallback';
};

export type Hud = {
  update(state: GameState, info: HudInfo): void;
  /** Called when a round starts, so cached values do not survive it. */
  reset(): void;
};

function el(tag: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  return node;
}

/** `mm:ss` remaining out of the 60-second round cap. */
export function formatClock(tick: number): string {
  const remaining = Math.max(0, MAX_TICKS - tick);
  const seconds = Math.ceil(remaining / CONSTANTS.ticksPerSecond);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * The `decide` half of the diagnostics line.
 *
 * A boss that stands still has exactly two explanations — the strategy chose `idle`,
 * or the sandbox is refusing to run it — and from the outside they look identical.
 * Both are now on screen:
 *
 *   `d 0.03/0.11ms`  the `decide` p50 / p99. Everything after it is a problem.
 *   `idle 43%`       the strategy asked for nothing on 43% of its calls. Shown only
 *                    past `IDLE_WARN_SHARE`, because a boss holding position for a
 *                    beat is normal and one that has frozen is not.
 *   `viol 12`        contract violations the engine recorded (an invalid action or a
 *                    runner failure — both cost the tick).
 *   `2 timeout`      failures by kind, from the sandbox.
 *   `x14`            longest run of *consecutive* failures: what separates one
 *                    unlucky frame from a strategy that has stopped answering.
 *   `KILLED`         the sandbox gave up on it (see `TIMEOUT_KILL_STREAK`).
 */
/** Idle share past which the diagnostics line calls it out. */
export const IDLE_WARN_SHARE = 0.25;
export function formatRunnerLine(state: GameState, runner: RunnerStats | null | undefined): string {
  const parts: string[] = [];
  if (runner != null && runner.calls > 0) {
    parts.push(`d ${runner.p50Ms.toFixed(2)}/${runner.p99Ms.toFixed(2)}ms`);
  }
  if (runner != null && runner.calls > 0 && runner.idle / runner.calls >= IDLE_WARN_SHARE) {
    parts.push(`idle ${Math.round((runner.idle / runner.calls) * 100)}%`);
  }
  if (state.violations > 0) parts.push(`viol ${state.violations}`);
  if (runner != null) {
    for (const [kind, count] of Object.entries(runner.failures)) {
      if ((count ?? 0) > 0) parts.push(`${count} ${kind}`);
    }
    if (runner.worstStreak > 1) parts.push(`x${runner.worstStreak}`);
  }
  if (state.strategyKilled) parts.push('KILLED');
  return parts.join(' · ');
}

/**
 * `?debug=1` — show the determinism footer.
 *
 * The footer (`tick`, both seeds, tick+render ms, the runner's call/idle/violation
 * counts) is the strongest single piece of evidence in the whole UI that this is a
 * fixed-seed deterministic simulation, and the reason it used to be on all the time
 * was that judges asked to see determinism. An independent review pointed out the
 * other half of that audience: to anyone not reading it as evidence it is an unfinished
 * screen, permanently, during every normal fight
 * (`docs/REVIEW-2026-09-08.md`, question 5).
 *
 * So it is a flag rather than a deletion: default clean for a player, `?debug=1` for
 * the technical walkthrough. Off by default is the only part that is a judgement call;
 * everything the footer said is still one query parameter away.
 */
export function debugFooterEnabled(search: string): boolean {
  const value = new URLSearchParams(search).get('debug');
  return value !== null && value !== '0' && value !== 'false';
}

export type HudOptions = {
  /** Show the determinism footer. Default false — see `debugFooterEnabled`. */
  debugFooter?: boolean;
};

export function createHud(root: HTMLElement, options: HudOptions = {}): Hud {
  const debugFooter = options.debugFooter ?? false;
  root.replaceChildren();

  const top = el('div', 'hud-top');
  const round = el('div', 'hud-round');
  const pips = el('div', 'hud-pips');
  const timer = el('div', 'hud-timer');
  top.append(round, timer, pips);

  const strategy = el('div', 'hud-strategy');
  const label = el('div', 'label');
  label.textContent = 'Boss strategy';
  // The provenance chip lives on the label's line, right-aligned: it is metadata
  // about the strategy, not part of its name.
  const origin = el('span', 'origin');
  origin.dataset.testid = 'boss-origin';
  label.append(origin);
  const name = el('div', 'name');
  const rationale = el('div', 'rationale');
  strategy.append(label, name, rationale);

  const foot = el('div', 'hud-foot');

  root.append(top, strategy);
  // Appended rather than hidden, so the element is genuinely absent from the DOM in
  // the default build — an `[hidden]` footer still shows up in a screenshot diff and
  // in the accessibility tree.
  if (debugFooter) root.append(foot);

  let lastHp = -1;
  let lastClock = '';
  let lastRound = -1;
  let lastName = '';
  let lastFoot = '';

  return {
    update(state: GameState, info: HudInfo): void {
      if (state.player.hp !== lastHp) {
        lastHp = state.player.hp;
        const max = ENGINE_CONSTANTS.player.hp;
        pips.replaceChildren();
        for (let i = 0; i < max; i += 1) {
          const pip = el('div', i < state.player.hp ? 'hud-pip' : 'hud-pip empty');
          pips.append(pip);
        }
      }

      const clock = formatClock(state.tick);
      if (clock !== lastClock) {
        lastClock = clock;
        timer.textContent = clock;
        const secondsLeft = (MAX_TICKS - state.tick) / CONSTANTS.ticksPerSecond;
        timer.classList.toggle('low', secondsLeft <= 10);
      }

      if (info.round !== lastRound) {
        lastRound = info.round;
        round.innerHTML = '';
        round.append(document.createTextNode(`Round ${info.round} `));
        const of = document.createElement('span');
        of.textContent = `/ ${info.maxRounds}`;
        round.append(of);
      }

      if (state.strategy.name !== lastName) {
        lastName = state.strategy.name;
        name.textContent = state.strategy.name;
        rationale.textContent = `“${state.strategy.rationale}”`;
        // Round 1's boss ships with the client and claims nothing, so it says
        // nothing. The other two both need saying, and the fallback one especially:
        // it is the case where the product did *not* do what it promises.
        const provenance = info.provenance ?? 'bundled';
        origin.textContent = originLabel(provenance);
        origin.dataset.origin = provenance;
      }

      // Small, deliberately technical: this is the determinism evidence. `?debug=1`
      // only — see `debugFooterEnabled`. Skipped entirely when off, so the per-frame
      // string building goes with it.
      if (!debugFooter) return;
      const runnerLine = formatRunnerLine(state, info.runner);
      const nextFoot =
        `boss ${Math.round(state.boss.hp)}/${ENGINE_CONSTANTS.boss.hp} · tick ${state.tick}` +
        ` · seed ${info.sessionSeed}/${info.roundSeed}` +
        ` · ${info.tickMs.toFixed(2)}+${info.renderMs.toFixed(2)}ms` +
        (runnerLine === '' ? '' : ` · ${runnerLine}`);
      if (nextFoot !== lastFoot) {
        lastFoot = nextFoot;
        foot.textContent = nextFoot;
        // A stalled strategy is a failure state, not a statistic: mark the line so it
        // is visible from across a room, which is where the demo is watched from.
        const runner = info.runner;
        const stalling = runner != null && runner.calls > 0 && runner.idle / runner.calls >= IDLE_WARN_SHARE;
        foot.classList.toggle('warn', state.strategyKilled || state.violations > 0 || stalling);
      }
    },

    reset(): void {
      lastHp = -1;
      lastClock = '';
      lastRound = -1;
      lastName = '';
      lastFoot = '';
    },
  };
}
