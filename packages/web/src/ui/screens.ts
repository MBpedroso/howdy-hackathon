/**
 * Screens — a DOM overlay, five states, no menus (spec §2.3: instant restarts).
 *
 * Every screen has exactly one primary action, bound to click, Enter and Space, so a
 * player never has to find a button. While a screen is up the overlay takes pointer
 * events; while the fight is running it is `pointer-events: none` and invisible, so a
 * click during play always reaches the canvas and shoots.
 *
 * `roundWon` is the interlude's seam: it is what `app.ts` shows when nobody supplies
 * an `onRoundWon` handler. When the interlude lands it takes over this moment, gets
 * the same `ReplaySummary`, and calls the same `next()`.
 *
 * ## The start screen is the exception, and why
 *
 * Every other screen is a card in the middle of the arena square. `start` is
 * full-viewport (see `#screen[data-screen='start']` in `styles.css`), because it
 * carries the one thing the game could not explain in the fight: **who the three
 * agents are**. A playtester's report on the interlude was "the player can't
 * connect what's happening to who is doing it", and the fix has two halves — this
 * screen introduces the cast before the first fight, and the interlude then shows
 * the same three faces doing the work.
 *
 * It is laid out to fit 1280×800 with no scrolling, which is the projector the
 * interlude was designed against (`interlude.css`), and it has exactly one primary
 * action like everything else here.
 */
import { AGENTS, CAST, iconSvg, type AgentIcon } from './cast.ts';
import { createPortrait } from './portrait.ts';

export type PrimaryAction = { label: string; danger?: boolean; run: () => void };

/** One of the four "how a round works" steps. */
type Step = { n: string; icon: AgentIcon; accent: string; title: string; text: string };

export type StartOptions = {
  seed: number;
  onFight: () => void;
  /** Initial state of the "skip this intro next time" box. */
  skipIntro?: boolean;
  /** Called on every toggle. `app.ts` persists it; see `ui/intro.ts`. */
  onSkipIntro?: (value: boolean) => void;
};

export type Screens = {
  loading(message: string): void;
  start(options: StartOptions): void;
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

/**
 * The controls, as chips — the start screen's replacement for the one-line
 * `WASD or arrows to move · mouse to aim · …` string this screen used to show.
 * Five chips read faster than one sentence, and the sentence was the only place the
 * dash was mentioned.
 */
const KEYS: readonly { key: string; does: string }[] = [
  { key: 'WASD / ↑←↓→', does: 'move' },
  { key: 'mouse', does: 'aim' },
  { key: 'click / hold', does: 'shoot' },
  { key: 'Space', does: 'dash' },
];

/**
 * The player's colour, for the one step of the round that is the player's.
 * Duplicated from `render/palette.ts` rather than imported so this file stays DOM
 * and strings — the value is also `--player` in `styles.css`.
 */
const PLAYER_ACCENT = '#4de2b0';

/**
 * One round, in four steps.
 *
 * The wording is the point: every step says what *happens to you*, and step 4 says
 * "rejects" before it says "approves", because a rejection is the thing the demo is
 * actually proving and the interlude will show several.
 */
const STEPS: readonly Step[] = [
  {
    n: '1',
    icon: 'target',
    accent: PLAYER_ACCENT,
    title: 'You fight',
    text: 'Beat the boss inside 60 seconds. Every move you make is recorded.',
  },
  {
    n: '2',
    icon: 'lens',
    accent: AGENTS.analyst.accent,
    title: 'The Analyst reads',
    text: 'It watches your replay and names your habits, out loud, as it types.',
  },
  {
    n: '3',
    icon: 'brackets',
    accent: AGENTS.coder.accent,
    title: 'The Coder rewrites',
    text: "It writes the boss's next strategy as real code, aimed at you.",
  },
  {
    n: '4',
    icon: 'gate',
    accent: AGENTS.judge.accent,
    title: 'The Judge decides',
    text: 'It simulates the new boss and rejects it if it is unfair or broken. Then you fight what survived.',
  },
];

export function createScreens(root: HTMLElement): Screens {
  let action: PrimaryAction | null = null;
  let kind: string | null = null;

  function onKey(ev: KeyboardEvent): void {
    if (action === null) return;
    if (ev.code !== 'Enter' && ev.code !== 'Space' && ev.code !== 'NumpadEnter') return;
    // Space on a focused control is that control's, not the screen's: the start
    // screen has a checkbox, and "tick the box" must not also mean "fight".
    const target = ev.target;
    if (ev.code === 'Space' && target instanceof HTMLElement && target.tagName === 'INPUT') return;
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

  /** A small caps heading above one block of the start screen. */
  function sectionLabel(text: string): HTMLElement {
    const d = document.createElement('div');
    d.className = 'start-label';
    d.textContent = text;
    return d;
  }

  function strong(text: string): HTMLElement {
    const b = document.createElement('b');
    b.textContent = text;
    return b;
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

    start({ seed, onFight, skipIntro, onSkipIntro }): void {
      render(
        'start',
        (card) => {
          card.classList.add('start');

          // ------------------------------------------------------------ the title
          const head = document.createElement('header');
          head.className = 'start-head';
          head.append(
            heading('REMATCH', 'start-title'),
            line('The boss that learns', 'start-tagline'),
            line(
              'Beat it once and it reads your replay, rewrites its own code, and comes back built for you. Five rounds.',
              'dim',
            ),
          );
          card.append(head);

          // ------------------------------------------------------------- the cast
          const cast = document.createElement('section');
          cast.className = 'start-cast';
          cast.dataset.testid = 'start-cast';
          cast.append(sectionLabel('Who rewrites the boss'));
          const cards = document.createElement('div');
          cards.className = 'cast-row';
          for (const agent of CAST) {
            const item = document.createElement('article');
            item.className = 'cast-card';
            item.dataset.agent = agent.id;
            item.dataset.testid = `cast-${agent.id}`;
            item.style.setProperty('--accent', agent.accent);

            item.append(createPortrait(agent.id, { size: 92 }));

            const name = document.createElement('h3');
            name.textContent = agent.name;
            if (agent.deterministic === true) {
              // The thesis, as a chip: the thing with the final say is not a model.
              const tag = document.createElement('span');
              tag.className = 'cast-tag';
              tag.dataset.testid = 'cast-deterministic';
              tag.textContent = 'DETERMINISTIC';
              name.append(tag);
            }
            item.append(name, line(agent.role, 'cast-role'));
            cards.append(item);
          }
          cast.append(cards);
          card.append(cast);

          // --------------------------------------------------- how a round works
          const how = document.createElement('section');
          how.className = 'start-how';
          how.dataset.testid = 'start-how';
          how.append(sectionLabel('How a round works'));
          const steps = document.createElement('ol');
          steps.className = 'step-row';
          for (const step of STEPS) {
            const item = document.createElement('li');
            item.className = 'step';
            item.style.setProperty('--accent', step.accent);
            const icon = document.createElement('span');
            icon.className = 'step-icon';
            // Static markup from `cast.ts`'s own constants; no external input.
            icon.innerHTML = iconSvg(step.icon, step.accent);
            const title = document.createElement('h4');
            title.append(document.createTextNode(step.title));
            item.append(icon, title, line(step.text, 'step-text'));
            steps.append(item);
          }
          how.append(steps, line('…and then the next round starts against whatever the Judge let through.', 'dim'));
          card.append(how);

          // --------------------------------------------------------- the controls
          const controls = document.createElement('section');
          controls.className = 'start-controls';
          controls.dataset.testid = 'start-controls';
          controls.append(sectionLabel('Controls'));
          const chips = document.createElement('div');
          chips.className = 'key-row';
          for (const { key, does } of KEYS) {
            const chip = document.createElement('span');
            chip.className = 'key';
            const kbd = document.createElement('kbd');
            kbd.textContent = key;
            chip.append(kbd, document.createTextNode(does));
            chips.append(chip);
          }
          controls.append(chips);
          // Spec §2.3: every attack has a tell, so the fight is fair to read. It is
          // only fair if the player has been told what the two tells look like.
          const tells = document.createElement('p');
          tells.className = 'start-tells';
          tells.append(
            document.createTextNode('Read the boss’s tells: '),
            strong('a filling line = charge'),
            document.createTextNode(', '),
            strong('a shrinking ring = slam'),
            document.createTextNode('.'),
          );
          controls.append(tells);
          card.append(controls);

          // ----------------------------------------------------------- the footer
          const foot = document.createElement('div');
          foot.className = 'start-foot';

          const label = document.createElement('label');
          label.className = 'start-skip';
          const box = document.createElement('input');
          box.type = 'checkbox';
          box.dataset.testid = 'skip-intro';
          box.checked = skipIntro === true;
          box.addEventListener('change', () => {
            onSkipIntro?.(box.checked);
          });
          // The whole overlay is the primary action's hit box (see the constructor),
          // so a click on the box would otherwise also start the fight.
          label.addEventListener('click', (ev) => {
            ev.stopPropagation();
          });
          label.append(box, document.createTextNode('skip this intro next time'));

          foot.append(label, line(`Session seed ${seed} · press Enter to fight`, 'dim'));
          card.append(foot);
        },
        { label: 'FIGHT', run: onFight },
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
