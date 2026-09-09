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
import { AGENTS, type AgentIcon, type AgentId } from './cast.ts';
import { DEFAULT_BOSS_FIGHTER, DEFAULT_PLAYER_FIGHTER, FIGHTER_LIST, type FighterId } from './fighters.ts';
import { createFighterFace, createPortrait } from './portrait.ts';

export type PrimaryAction = { label: string; danger?: boolean; run: () => void };

/**
 * One of the four "how a round works" steps.
 *
 * `agent` is set on the three that an agent performs, and the step then wears that
 * agent's portrait and accent instead of a flat icon. That is what let the separate
 * "who rewrites the boss" cast row go: it was the same three faces and the same
 * three names, one block higher up the screen. Step 1 is the player's, so it wears
 * the fighter they picked.
 *
 * `text` is the step's own, not the agent's `role` from `cast.ts`, which it briefly
 * was. The two surfaces have different budgets: the interlude header has a whole
 * line for "Not an AI. Runs 200 simulated fights and rejects anything unfair or
 * broken", and this card has room for the short half of it. `label` is the one
 * extra word a step may carry as a chip — only the Judge has one, and it is the
 * project's argument in a single word.
 */
type Step = {
  n: string;
  icon: AgentIcon;
  accent: string;
  title: string;
  text: string;
  agent?: AgentId;
  label?: string;
};

export type StartOptions = {
  seed: number;
  onFight: () => void;
  /** Initial state of the "skip this intro next time" box. */
  skipIntro?: boolean;
  /** Called on every toggle. `app.ts` persists it; see `ui/intro.ts`. */
  onSkipIntro?: (value: boolean) => void;
  /** The remembered fighter picks. See `ui/fighters.ts` — cosmetic, always. */
  playerFighter?: FighterId;
  bossFighter?: FighterId;
  /** Called on every pick. `app.ts` persists it; see `ui/intro.ts`. */
  onPickFighter?: (which: 'player' | 'boss', id: FighterId) => void;
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
 *
 * Steps 2–4 take their body text from the agent's own `role` in `cast.ts` rather
 * than restating it, so there is exactly one copy of "what the Analyst does" in the
 * codebase and the start screen cannot drift from the interlude header.
 */
const STEPS: readonly Step[] = [
  {
    n: '01',
    icon: 'target',
    accent: PLAYER_ACCENT,
    title: 'You fight',
    text: 'Beat the boss inside 60 seconds. Every move you make is recorded.',
  },
  {
    n: '02',
    icon: 'lens',
    accent: AGENTS.analyst.accent,
    title: 'The Analyst',
    text: 'Reads your replay and identifies your habits.',
    agent: 'analyst',
  },
  {
    n: '03',
    icon: 'brackets',
    accent: AGENTS.coder.accent,
    title: 'The Coder',
    text: 'Rewrites the boss to counter you.',
    agent: 'coder',
  },
  {
    n: '04',
    icon: 'gate',
    accent: AGENTS.judge.accent,
    title: 'The Judge',
    // "The Judge decides DETERMINISTIC" was one string in the title, which does not
    // read as English. The word is a chip of its own now.
    label: 'DETERMINISTIC',
    text: 'Runs 200 simulations and rejects unfair or broken behaviour.',
    agent: 'judge',
  },
];

/**
 * Why the thing exists — three lines, above everything else on the screen.
 *
 * This block is aimed at someone who has thirty seconds and has never heard of the
 * project: a judge opening the deployed URL, or a player wondering why a boss fight
 * is explaining itself. It says what is unusual (the boss's code is rewritten
 * mid-game), what stops that from being a disaster (a harness that is not a model),
 * and why anyone should care (that is the argument, not a feature).
 *
 * Three, and short, on purpose. The screen already asks the player to read a
 * four-step diagram, four control chips and two tells; a fourth paragraph of prose
 * here would be the thing that makes people press FIGHT without reading any of it.
 */
const WHY: readonly { title: string; text: string; accent: string }[] = [
  {
    title: 'The boss writes itself',
    text: 'No difficulty slider. Between rounds, AI reads your replay and rewrites the boss.',
    accent: AGENTS.coder.accent,
  },
  {
    // Was "Something that is not an AI has the final say", which is the same fact
    // stated as a negation — and in the strongest position on the screen it read as
    // "we do not trust AI", which is the opposite of the argument. The verifier
    // being deterministic is not a caveat about the agent; it is what makes handing
    // the agent executable code defensible. The mechanism still shows: the chip on
    // step 04 says DETERMINISTIC and the third card draws the conclusion.
    title: 'Every rewrite has to prove itself',
    text: 'Every rewrite runs 200 simulated fights. Too strong, too weak, frozen or unsafe — rejected.',
    accent: AGENTS.judge.accent,
  },
  {
    title: 'That is the whole argument',
    text: 'The agent gets real power — executable code. Deterministic checks decide what gets through.',
    accent: PLAYER_ACCENT,
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
    // The fighter buttons are the same case for *both* keys: a pick made from the
    // keyboard would otherwise choose a costume and start the fight in one press,
    // and Enter on a focused `<button>` is that button's by every convention.
    if (target instanceof HTMLElement && target.closest('[data-nofight]') !== null) return;
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

  /**
   * `build` may set this to put the primary button somewhere other than the end of
   * the card. Only the start screen does: its bottom band is skip-box | FIGHT |
   * seed, and the button has to be the middle cell of that row rather than a line
   * under it. Reset per render so no screen inherits another's slot.
   */
  let primarySlot: HTMLElement | null = null;

  function render(name: string, build: (card: HTMLElement) => void, primary: PrimaryAction | null): void {
    kind = name;
    action = primary;
    primarySlot = null;
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
      (primarySlot ?? card).append(btn);
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

  /**
   * A small caps heading above one block of the start screen, with an optional
   * caveat pushed to the far end of the same rule.
   */
  function sectionLabel(text: string, aside?: string): HTMLElement {
    const d = document.createElement('div');
    d.className = 'start-label';
    d.append(document.createTextNode(text));
    if (aside !== undefined) {
      const note = document.createElement('span');
      note.className = 'start-label-aside';
      note.textContent = aside;
      d.append(note);
    }
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

    start({ seed, onFight, skipIntro, onSkipIntro, playerFighter, bossFighter, onPickFighter }): void {
      // The live picks. Held here rather than read back out of the DOM so the
      // "you" step's face and the two grids cannot disagree about who is selected.
      const picked: Record<'player' | 'boss', FighterId> = {
        player: playerFighter ?? DEFAULT_PLAYER_FIGHTER,
        boss: bossFighter ?? DEFAULT_BOSS_FIGHTER,
      };
      render(
        'start',
        (card) => {
          card.classList.add('start');

          // ------------------------------------------------------------ the title
          const head = document.createElement('header');
          head.className = 'start-head';
          // No third line here any more: it used to say "beat it once and it reads
          // your replay, rewrites its own code, and comes back built for you", which
          // is the first of the three `WHY` points immediately below it. Two copies
          // of the pitch cost the title its place on a 1280x800 projector.
          head.append(heading('REMATCH', 'start-title'), line('The boss that learns · five rounds', 'start-tagline'));
          card.append(head);

          // -------------------------------------------------------------- the why
          const why = document.createElement('section');
          why.className = 'start-why';
          why.dataset.testid = 'start-why';
          why.append(sectionLabel('Why this exists'));
          const points = document.createElement('ul');
          points.className = 'why-row';
          for (const point of WHY) {
            const item = document.createElement('li');
            item.className = 'why';
            item.style.setProperty('--accent', point.accent);
            const title = document.createElement('h4');
            title.textContent = point.title;
            item.append(title, line(point.text, 'why-text'));
            points.append(item);
          }
          why.append(points);
          card.append(why);

          // --------------------------------------------------- how a round works
          // Doubles as the cast: steps 2–4 wear the agent's portrait, name and own
          // `role` line, so the three faces are introduced here instead of in a
          // second row that said the same thing. Step 1 wears the player's pick.
          const how = document.createElement('section');
          how.className = 'start-how';
          how.dataset.testid = 'start-how';
          how.append(sectionLabel('How a round works'));
          const steps = document.createElement('ol');
          steps.className = 'step-row';
          /** Step 1's face, kept so a pick can repaint it without a re-render. */
          let youFace: HTMLElement | null = null;
          for (const step of STEPS) {
            const item = document.createElement('li');
            item.className = 'step';
            item.style.setProperty('--accent', step.accent);
            if (step.agent !== undefined) {
              item.dataset.agent = step.agent;
              // Kept from the cast row this section absorbed: the e2e suite reads
              // `cast-<id>` to check each agent is introduced before the first fight.
              item.dataset.testid = `cast-${step.agent}`;
            }

            const icon = document.createElement('span');
            icon.className = 'step-icon';
            if (step.agent !== undefined) {
              icon.append(createPortrait(step.agent, { size: 60 }));
            } else {
              // The face alone. A crosshair glyph used to sit beside it, and between
              // it, the number and the title the step said "this is the fight" three
              // times — decoration, by the third telling.
              youFace = createFighterFace(picked.player, 60);
              icon.append(youFace);
            }

            // `01 — THE ANALYST`. The number is its own element so the rule that
            // renders the em dash and dims the digits lives in CSS, not in a string.
            const title = document.createElement('h4');
            const num = document.createElement('span');
            num.className = 'step-n';
            num.textContent = step.n;
            title.append(num, document.createTextNode(step.title));
            item.append(icon, title);

            if (step.label !== undefined) {
              // The thesis, as a chip on its own line: the thing with the final say
              // is not a model. Its testid is unchanged — the e2e suite reads it.
              const tag = document.createElement('span');
              tag.className = 'cast-tag';
              tag.dataset.testid = 'cast-deterministic';
              tag.textContent = step.label;
              item.append(tag);
            }

            item.append(line(step.text, 'step-text'));
            steps.append(item);
          }
          // The "…and then the next round starts against whatever the Judge let
          // through" line that used to close this section is gone: the ▸ arrows
          // between the steps already read as a loop, and the line cost the title
          // its last 20 px on the projector.
          how.append(steps);
          card.append(how);

          // ------------------------------------------------------ pick a fighter
          const pick = document.createElement('section');
          pick.className = 'start-pick';
          pick.dataset.testid = 'start-pick';
          // The caveat sits on the label's own line, right-aligned, rather than as a
          // paragraph under the grids: a picker that looks like a class select is a
          // picker that implies stats, so "no stats" has to be adjacent to the title
          // — but it is a caveat, and the screen has no spare line for one.
          pick.append(sectionLabel('Pick your fighter', 'Costumes only — the fight is identical'));
          const sides = document.createElement('div');
          sides.className = 'pick-sides';
          for (const which of ['player', 'boss'] as const) {
            const side = document.createElement('div');
            side.className = 'pick-side';
            side.dataset.side = which;
            side.style.setProperty('--accent', which === 'player' ? PLAYER_ACCENT : AGENTS.boss.accent);

            const label = document.createElement('h4');
            label.textContent = which === 'player' ? 'You' : 'The boss';
            side.append(label);

            const row = document.createElement('div');
            row.className = 'pick-row';
            row.setAttribute('role', 'radiogroup');
            row.setAttribute('aria-label', which === 'player' ? 'Your fighter' : "The boss's fighter");

            const buttons: HTMLButtonElement[] = [];
            for (const fighter of FIGHTER_LIST) {
              const btn = document.createElement('button');
              btn.type = 'button';
              btn.className = 'pick-btn';
              btn.dataset.fighter = fighter.id;
              btn.dataset.testid = `pick-${which}-${fighter.id}`;
              // The screen's Enter/Space handler starts the fight from anywhere; a
              // pick must not. See `onKey`, which skips anything flagged this way.
              btn.dataset.nofight = '1';
              btn.setAttribute('role', 'radio');
              btn.setAttribute('aria-checked', String(picked[which] === fighter.id));
              if (picked[which] === fighter.id) btn.dataset.on = '1';
              btn.style.setProperty('--accent', fighter.accent);

              const name = document.createElement('span');
              name.className = 'pick-name';
              name.textContent = fighter.name;
              btn.append(createFighterFace(fighter.id, 64), name);
              btn.title = fighter.tag;

              btn.addEventListener('click', (ev) => {
                // The whole overlay is the primary action's hit box, so a pick would
                // otherwise also start the fight.
                ev.stopPropagation();
                picked[which] = fighter.id;
                for (const other of buttons) {
                  const on = other.dataset.fighter === fighter.id;
                  other.setAttribute('aria-checked', String(on));
                  if (on) other.dataset.on = '1';
                  else delete other.dataset.on;
                }
                if (which === 'player' && youFace !== null) {
                  const next = createFighterFace(fighter.id, 60);
                  youFace.replaceWith(next);
                  youFace = next;
                }
                onPickFighter?.(which, fighter.id);
              });

              buttons.push(btn);
              row.append(btn);
            }
            side.append(row);
            sides.append(side);
          }
          pick.append(sides);
          card.append(pick);

          // --------------------------------------------------------- the controls
          // No section label here any more. Four key chips and one sentence about
          // the tells are self-evident, and the rule above them made this block
          // compete for attention with the two that carry the argument.
          const controls = document.createElement('section');
          controls.className = 'start-controls';
          controls.dataset.testid = 'start-controls';
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

          // The bottom band is three cells: the box on the left, FIGHT in the middle,
          // the seed on the right. The middle one is filled by `render`, which is what
          // `primarySlot` is for — the button has to be *in* this row rather than on a
          // line under it, or the three read as two unrelated things.
          const slot = document.createElement('div');
          slot.className = 'start-cta';
          primarySlot = slot;

          foot.append(label, slot, line(`Session seed ${seed} · press Enter to fight`, 'start-seed'));
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
