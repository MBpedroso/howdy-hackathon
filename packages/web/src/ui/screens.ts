/**
 * Screens — a DOM overlay, four states, no menus (spec §2.3: instant restarts).
 *
 * Every screen has exactly one primary action, bound to click, Enter and Space, so a
 * player never has to find a button. While a screen is up the overlay takes pointer
 * events; while the fight is running it is `pointer-events: none` and invisible, so a
 * click during play always reaches the canvas and shoots.
 *
 * `roundWon` is the interlude's seam: it is what `app.ts` shows when nobody supplies
 * an `onRoundWon` handler. When the interlude lands it takes over this moment, gets
 * the same `ReplaySummary`, and calls the same `next()`.
 */
export type PrimaryAction = { label: string; danger?: boolean; run: () => void };

export type Screens = {
  loading(message: string): void;
  start(options: { seed: number; onFight: () => void }): void;
  roundWon(options: {
    round: number;
    hash: string;
    seconds: number;
    hpLeft: number;
    onNext: () => void;
  }): void;
  gameOver(options: { round: number; strategy: string; rationale: string; onRetry: () => void }): void;
  won(options: { rounds: number; onRetry: () => void }): void;
  failure(options: { title: string; detail: string; onRetry?: () => void }): void;
  hide(): void;
  /** The screen currently shown, or null. Read by the e2e suite. */
  current(): string | null;
};

const CONTROLS = 'WASD or arrows to move · mouse to aim · hold click to shoot · Space to dash';

export function createScreens(root: HTMLElement): Screens {
  let action: PrimaryAction | null = null;
  let kind: string | null = null;

  function onKey(ev: KeyboardEvent): void {
    if (action === null) return;
    if (ev.code !== 'Enter' && ev.code !== 'Space' && ev.code !== 'NumpadEnter') return;
    ev.preventDefault();
    const run = action.run;
    action = null;
    run();
  }
  window.addEventListener('keydown', onKey);

  // Attached once, not per render: the whole overlay is the primary action's hit box
  // ("click to fight" must mean anywhere), and re-adding it per screen would stack
  // listeners on a node whose children are replaced but which is never itself replaced.
  root.addEventListener('click', () => {
    if (action === null) return;
    const run = action.run;
    action = null;
    run();
  });

  function render(name: string, build: (card: HTMLElement) => void, primary: PrimaryAction | null): void {
    kind = name;
    action = primary;
    root.replaceChildren();
    root.classList.add('active');
    root.dataset.screen = name;

    const card = document.createElement('div');
    card.className = 'card';
    build(card);

    if (primary !== null) {
      const btn = document.createElement('button');
      btn.className = primary.danger === true ? 'btn danger' : 'btn';
      btn.type = 'button';
      btn.textContent = primary.label;
      btn.dataset.testid = 'primary';
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const run = primary.run;
        action = null;
        run();
      });
      card.append(btn);
      queueMicrotask(() => btn.focus());
    }

    root.append(card);
  }

  function line(text: string, className?: string): HTMLElement {
    const p = document.createElement('p');
    if (className !== undefined) p.className = className;
    p.textContent = text;
    return p;
  }

  function heading(text: string, className?: string): HTMLElement {
    const h = document.createElement('h1');
    if (className !== undefined) h.className = className;
    h.textContent = text;
    return h;
  }

  function kicker(text: string): HTMLElement {
    const d = document.createElement('div');
    d.className = 'kicker';
    d.textContent = text;
    return d;
  }

  return {
    loading(message: string): void {
      render(
        'loading',
        (card) => {
          card.append(kicker('REMATCH'), heading(message));
          const spinner = document.createElement('div');
          spinner.className = 'spinner';
          card.append(spinner);
        },
        null,
      );
    },

    start({ seed, onFight }): void {
      render(
        'start',
        (card) => {
          card.append(
            kicker('REMATCH · Round 1'),
            heading('Click to fight'),
            line(CONTROLS),
            line(`Beat the boss and it rewrites itself to counter you. Session seed ${seed}.`, 'dim'),
          );
        },
        { label: 'Fight', run: onFight },
      );
    },

    roundWon({ round, hash, seconds, hpLeft, onNext }): void {
      render(
        'roundWon',
        (card) => {
          card.append(
            kicker('Round cleared'),
            heading(`Round ${round} cleared`, 'win'),
            line(`${seconds.toFixed(1)} s · ${hpLeft} HP left`),
          );
          const h = document.createElement('p');
          h.className = 'hash';
          h.dataset.testid = 'hash';
          h.textContent = `replay hash ${hash}`;
          card.append(h);
          card.append(line('Next: the boss studies this round and rewrites its strategy.', 'dim'));
        },
        { label: 'Next round', run: onNext },
      );
    },

    gameOver({ round, strategy, rationale, onRetry }): void {
      render(
        'gameOver',
        (card) => {
          card.append(kicker('Defeat'), heading(`The boss beat you on Round ${round}`, 'lose'));
          const p = document.createElement('p');
          const strong = document.createElement('span');
          strong.className = 'strategy';
          strong.textContent = strategy;
          p.append('It was playing ', strong);
          card.append(p, line(`“${rationale}”`, 'dim'));
        },
        { label: 'Retry', danger: true, run: onRetry },
      );
    },

    won({ rounds, onRetry }): void {
      render(
        'won',
        (card) => {
          card.append(
            kicker('Victory'),
            heading(`You survived all ${rounds} rounds`, 'win'),
            line('The boss ran out of rewrites before you ran out of HP.'),
          );
        },
        { label: 'Play again', run: onRetry },
      );
    },

    failure({ title, detail, onRetry }): void {
      render(
        'failure',
        (card) => {
          card.append(kicker('Something broke'), heading(title, 'lose'), line(detail, 'dim'));
        },
        onRetry === undefined ? null : { label: 'Retry', danger: true, run: onRetry },
      );
    },

    hide(): void {
      kind = null;
      action = null;
      root.replaceChildren();
      root.classList.remove('active');
      delete root.dataset.screen;
    },

    current(): string | null {
      return kind;
    },
  };
}
