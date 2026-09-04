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

export function createHud(root: HTMLElement): Hud {
  root.replaceChildren();

  const top = el('div', 'hud-top');
  const round = el('div', 'hud-round');
  const pips = el('div', 'hud-pips');
  const timer = el('div', 'hud-timer');
  top.append(round, timer, pips);

  const strategy = el('div', 'hud-strategy');
  const label = el('div', 'label');
  label.textContent = 'Boss strategy';
  const name = el('div', 'name');
  const rationale = el('div', 'rationale');
  strategy.append(label, name, rationale);

  const foot = el('div', 'hud-foot');

  root.append(top, strategy, foot);

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
      }

      // Small, deliberately technical: the judges asked for determinism, so show it.
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
