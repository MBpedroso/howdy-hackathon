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
import { AGENTS, CAST, type AgentId } from './cast.ts';
import { DEFAULT_BOSS_FIGHTER, DEFAULT_PLAYER_FIGHTER, FIGHTER_LIST, type FighterId } from './fighters.ts';
import {
  CONCEPT_FLOW,
  CONCEPT_STEPS,
  INTRO_SCREENS,
  heroUrl,
  introKeyAction,
  nextScreen,
  primaryLabel,
  type IntroScreen,
} from './introSequence.ts';
import { createFighterFace, createPortrait } from './portrait.ts';

export type PrimaryAction = { label: string; danger?: boolean; run: () => void };

export type StartOptions = {
  seed: number;
  onFight: () => void;
  /** Initial state of the remembered "skip the intro" flag. */
  skipIntro?: boolean;
  /** Called when SKIP INTRO is used. `app.ts` persists it; see `ui/intro.ts`. */
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
 * The controls, as chips. Four chips read faster than one sentence, and the
 * sentence was the only place the dash was mentioned.
 */
const KEYS: readonly { key: string; does: string }[] = [
  { key: 'WASD / ↑←↓→', does: 'move' },
  { key: 'mouse', does: 'aim' },
  { key: 'click / hold', does: 'shoot' },
  { key: 'Space', does: 'dash' },
];

/**
 * The player's colour, for the "You" side of the fighter picker.
 * Duplicated from `render/palette.ts` rather than imported so this file stays DOM
 * and strings — the value is also `--player` in `styles.css`.
 */
const PLAYER_ACCENT = '#4de2b0';

export function createScreens(root: HTMLElement): Screens {
  let action: PrimaryAction | null = null;
  let kind: string | null = null;

  function onKey(ev: KeyboardEvent): void {
    // Escape first, and independent of `action`: skipping the intro must work on the
    // last beat too, where the primary action is "enter the arena".
    if (introKeyAction(ev.code) === 'skip' && escapeAction !== null) {
      ev.preventDefault();
      const run = escapeAction;
      escapeAction = null;
      action = null;
      run();
      return;
    }
    if (action === null) return;
    if (introKeyAction(ev.code) !== 'continue') return;
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

  /**
   * What Escape does, or `null` when the screen on show has nothing to escape from.
   * Only the intro sets it: `ESC = skip intro` is the brief's contract, and Escape
   * on a game-over screen should do nothing rather than something surprising.
   */
  let escapeAction: (() => void) | null = null;

  function render(name: string, build: (card: HTMLElement) => void, primary: PrimaryAction | null): void {
    kind = name;
    action = primary;
    primarySlot = null;
    escapeAction = null;
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

  /** Inputs every intro beat may need. Assembled once by `start`. */
  type IntroCtx = {
    seed: number;
    picked: Record<'player' | 'boss', FighterId>;
    onPickFighter?: (which: 'player' | 'boss', id: FighterId) => void;
    skip: () => void;
  };

  /**
   * The bottom band, identical on all four beats: the dots, the action, then one
   * line of small print.
   *
   * It exists because the first cut let every beat put its own furniture wherever
   * its content happened to end, so the dots and the button moved between screens
   * and the sequence read as four pages rather than one machine. The button is
   * planted here through `primarySlot`, and the small-print row keeps a floor
   * height even when a beat has nothing to say in it — otherwise the action jumps
   * vertically on the two beats that do.
   */
  function introFoot(screen: IntroScreen, ctx: IntroCtx): HTMLElement {
    const foot = document.createElement('footer');
    foot.className = 'intro-foot';
    foot.append(introDots(screen));

    const slot = document.createElement('div');
    slot.className = 'intro-primary';
    foot.append(slot);
    primarySlot = slot;

    const meta = document.createElement('div');
    meta.className = 'intro-meta';
    if (screen === 'hook') {
      // The secondary way out. A returning player should not have to sit through
      // four beats, and should not have to hunt for the way past them either.
      const skipBtn = document.createElement('button');
      skipBtn.type = 'button';
      skipBtn.className = 'intro-skip';
      skipBtn.dataset.testid = 'skip-intro';
      skipBtn.dataset.nofight = '1';
      skipBtn.textContent = 'Skip intro';
      skipBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        ctx.skip();
      });
      meta.append(skipBtn);
    } else if (screen === 'arena') {
      meta.append(line('Press Enter to start', 'arena-hint'), line(`Session seed ${ctx.seed}`, 'start-seed'));
    }
    foot.append(meta);
    return foot;
  }

  /** `● ● ○ ○` — where you are in the four. Same slot on every beat. */
  function introDots(screen: IntroScreen): HTMLElement {
    const dots = document.createElement('div');
    dots.className = 'intro-dots';
    dots.dataset.testid = 'intro-dots';
    for (const id of INTRO_SCREENS) {
      const dot = document.createElement('span');
      dot.className = 'intro-dot';
      if (id === screen) dot.dataset.on = '1';
      dots.append(dot);
    }
    return dots;
  }

  /** `YOU → REPLAY → NEW BOSS`, as elements so the arrows can be styled apart. */
  function flowRow(items: readonly string[], className: string): HTMLElement {
    const row = document.createElement('div');
    row.className = className;
    items.forEach((item, i) => {
      if (i > 0) {
        const arrow = document.createElement('span');
        arrow.className = 'flow-arrow';
        arrow.textContent = '→';
        row.append(arrow);
      }
      const node = document.createElement('span');
      node.className = 'flow-node';
      node.textContent = item;
      row.append(node);
    });
    return row;
  }

  /** The two fighter grids. Screen 4 only — it is the last thing before the fight. */
  function fighterPicker(ctx: IntroCtx): HTMLElement {
    const pick = document.createElement('section');
    pick.className = 'start-pick';
    pick.dataset.testid = 'start-pick';
    pick.append(sectionLabel('Pick your fighter', 'Cosmetics only — the fight is identical'));
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
        // The screen's Enter/Space handler advances the intro from anywhere; a pick
        // must not. See `onKey`, which skips anything flagged this way.
        btn.dataset.nofight = '1';
        btn.setAttribute('role', 'radio');
        btn.setAttribute('aria-checked', String(ctx.picked[which] === fighter.id));
        if (ctx.picked[which] === fighter.id) btn.dataset.on = '1';
        btn.style.setProperty('--accent', fighter.accent);

        const name = document.createElement('span');
        name.className = 'pick-name';
        name.textContent = fighter.name;
        btn.append(createFighterFace(fighter.id, 100), name);
        btn.title = fighter.tag;

        btn.addEventListener('click', (ev) => {
          // The whole overlay is the primary action's hit box, so a pick would
          // otherwise also enter the arena.
          ev.stopPropagation();
          ctx.picked[which] = fighter.id;
          for (const other of buttons) {
            const on = other.dataset.fighter === fighter.id;
            other.setAttribute('aria-checked', String(on));
            if (on) other.dataset.on = '1';
            else delete other.dataset.on;
          }
          ctx.onPickFighter?.(which, fighter.id);
        });

        buttons.push(btn);
        row.append(btn);
      }
      side.append(row);
      sides.append(side);
    }
    pick.append(sides);
    return pick;
  }

  /** The controls, one line, plus the two tells. Screen 4 only. */
  function controlsBlock(): HTMLElement {
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
    // Spec §2.3: every attack has a tell, so the fight is fair to read. It is only
    // fair if the player has been told what the two tells look like.
    const tells = document.createElement('p');
    tells.className = 'start-tells';
    tells.append(
      document.createTextNode('Read the boss\u2019s tells: '),
      strong('a filling line = charge'),
      document.createTextNode(', '),
      strong('a shrinking ring = slam'),
      document.createTextNode('.'),
    );
    controls.append(tells);
    return controls;
  }

  /**
   * Build one beat of the intro into `card`.
   *
   * Each branch is a screen and they share almost nothing on purpose — the point of
   * the sequence is that a beat is one idea, so a shared skeleton would only be a
   * place for a second idea to creep back in.
   *
   * What every beat *does* share is the composition: a title band, a content band,
   * and `introFoot`'s action band. The bands are the reason the dots and the button
   * do not move between screens, which is what made the first cut read as four web
   * pages instead of one attract sequence.
   */
  function buildIntro(card: HTMLElement, screen: IntroScreen, ctx: IntroCtx): void {
    if (screen === 'hook') {
      const head = document.createElement('header');
      head.className = 'intro-head hook-head';
      const kick = document.createElement('div');
      kick.className = 'hook-kicker';
      kick.textContent = 'Howdy Hackathon';
      const title = document.createElement('h1');
      title.className = 'hook-title';
      title.textContent = 'A boss that learns';
      head.append(kick, title);

      // The artwork, layered under the title's baseline so the mascots break the
      // composition's edges instead of sitting in a box (the brief's "game poster").
      const art = document.createElement('div');
      art.className = 'hook-art';
      const img = document.createElement('img');
      img.className = 'hook-art-img';
      img.alt = 'The four fighters';
      img.decoding = 'async';
      // Eager, not lazy: it is the screen. A lazy hero is a blank hero.
      img.src = heroUrl();
      img.addEventListener('load', () => {
        art.dataset.ok = '1';
      });
      img.addEventListener('error', () => {
        // No art, no empty frame: the title and the subtitle carry the screen alone.
        img.remove();
      });
      art.append(img);

      const sub = document.createElement('p');
      sub.className = 'hook-sub';
      sub.textContent = 'Five rounds. One boss. It adapts.';

      const body = document.createElement('div');
      body.className = 'intro-body hook-body';
      body.append(art, sub);

      card.append(head, body, introFoot(screen, ctx));
      return;
    }

    if (screen === 'concept') {
      const head = document.createElement('header');
      head.className = 'intro-head';
      const title = document.createElement('h1');
      title.className = 'intro-title';
      title.textContent = 'The boss learns';
      head.append(title, flowRow(CONCEPT_FLOW, 'concept-flow'));

      const steps = document.createElement('ol');
      steps.className = 'concept-row';
      for (const step of CONCEPT_STEPS) {
        const item = document.createElement('li');
        item.className = 'concept-step';
        const n = document.createElement('span');
        n.className = 'concept-n';
        n.textContent = step.n;
        const h = document.createElement('h4');
        h.textContent = step.title;
        item.append(n, h, line(step.text, 'concept-text'));
        steps.append(item);
      }

      const body = document.createElement('div');
      body.className = 'intro-body';
      body.append(steps);
      card.append(head, body, introFoot(screen, ctx));
      return;
    }

    if (screen === 'agents') {
      const head = document.createElement('header');
      head.className = 'intro-head';
      const title = document.createElement('h1');
      title.className = 'intro-title';
      title.textContent = 'Three agents. One fight.';
      head.append(title);

      const cards = document.createElement('div');
      cards.className = 'agent-row';
      for (const agent of CAST) {
        const item = document.createElement('article');
        item.className = 'agent-card';
        item.dataset.agent = agent.id;
        item.dataset.testid = `cast-${agent.id}`;
        item.style.setProperty('--accent', agent.accent);
        // 84 px on the old single screen, where this was one block of six. It is a
        // whole beat now and the illustration is the fastest way to tell the three
        // apart, so it gets the room.
        item.append(createPortrait(agent.id, { size: 112 }));

        const name = document.createElement('h3');
        name.textContent = `The ${agent.name.replace(/^The /, '')}`;
        item.append(name);

        if (agent.deterministic === true) {
          // The thesis, as a chip: the thing with the final say is not a model.
          const tag = document.createElement('span');
          tag.className = 'cast-tag';
          tag.dataset.testid = 'cast-deterministic';
          tag.textContent = 'DETERMINISTIC';
          item.append(tag);
        }
        item.append(line(agent.role, 'agent-role'));
        cards.append(item);
      }

      const closing = document.createElement('p');
      closing.className = 'agent-closing';
      closing.append(
        document.createTextNode('The boss can change. '),
        strong('The Judge decides what gets through.'),
      );

      const body = document.createElement('div');
      body.className = 'intro-body';
      body.append(cards, closing);
      card.append(head, body, introFoot(screen, ctx));
      return;
    }

    // ---------------------------------------------------------------- the arena
    const promise = document.createElement('h1');
    promise.className = 'arena-title';
    promise.dataset.testid = 'arena-title';
    for (const part of ['Five rounds.', 'One boss.', 'It learns you.']) {
      const row = document.createElement('span');
      row.textContent = part;
      promise.append(row);
    }
    const head = document.createElement('header');
    head.className = 'intro-head arena-head';
    head.append(promise, line('Every round makes the fight different.', 'arena-sub'));

    // The picker is the beat's main interactive section and the controls are
    // reference material under it, so they are two blocks with a gap rather than
    // one stack — the first cut ran them together and the fight's four keys read as
    // a fifth row of the fighter grid.
    const body = document.createElement('div');
    body.className = 'intro-body arena-body';
    body.append(fighterPicker(ctx), controlsBlock());

    card.append(head, body, introFoot(screen, ctx));
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

    /**
     * The intro sequence (`ui/introSequence.ts`): four screens, one primary action
     * each, re-rendered in place.
     *
     * Held as one `start()` call rather than four `Screens` methods because the four
     * share every input — the seed, the fighter picks, the skip flag — and because
     * `current()` must keep answering `'start'`: `app.ts` and the e2e suite both key
     * off that, and an intro that reports four different screen names would make
     * "is the game showing its front door" a four-way question.
     *
     * `data-intro` on the overlay carries which beat is up, for the CSS transition
     * and for the specs.
     */
    start({ seed, onFight, skipIntro, onSkipIntro, playerFighter, bossFighter, onPickFighter }): void {
      // The live picks. Held here rather than read back out of the DOM so the arena
      // screen's two grids cannot disagree about who is selected.
      const picked: Record<'player' | 'boss', FighterId> = {
        player: playerFighter ?? DEFAULT_PLAYER_FIGHTER,
        boss: bossFighter ?? DEFAULT_BOSS_FIGHTER,
      };
      let screen: IntroScreen = 'hook';

      /**
       * Leave the intro for good. Ticks the remembered flag on the way out, because
       * a player who pressed SKIP INTRO has said what they want for next time too —
       * `?intro=1` is the documented way back (`ui/intro.ts`).
       */
      function skip(): void {
        onSkipIntro?.(true);
        onFight();
      }

      function advance(): void {
        const to = nextScreen(screen);
        if (to === 'fight') {
          onFight();
          return;
        }
        screen = to;
        show();
      }

      function show(): void {
        render(
          'start',
          (card) => {
            card.classList.add('start');
            card.dataset.intro = screen;
            root.dataset.intro = screen;
            // Escape skips from every beat, including the last one.
            escapeAction = skip;
            buildIntro(card, screen, {
              seed,
              picked,
              ...(onPickFighter === undefined ? {} : { onPickFighter }),
              skip,
            });
          },
          { label: primaryLabel(screen), run: advance },
        );
      }

      show();
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
