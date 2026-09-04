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

const MAX_TICKS = ENGINE_CONSTANTS.round.maxTicks;

export type HudInfo = {
  round: number;
  maxRounds: number;
  sessionSeed: number;
  roundSeed: number;
  /** Averaged tick + render cost, for the small diagnostics line. */
  tickMs: number;
  renderMs: number;
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
      const nextFoot =
        `boss ${Math.round(state.boss.hp)}/${ENGINE_CONSTANTS.boss.hp} · tick ${state.tick}` +
        ` · seed ${info.sessionSeed}/${info.roundSeed}` +
        ` · ${info.tickMs.toFixed(2)}+${info.renderMs.toFixed(2)}ms`;
      if (nextFoot !== lastFoot) {
        lastFoot = nextFoot;
        foot.textContent = nextFoot;
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
