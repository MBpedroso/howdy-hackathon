# HANDOFF — light '90s visual redesign

For the next AI session. Scope: make REMATCH *look* more like a 90s arcade game.
Light touch — restyle, don't rebuild. Written 2026-09-10 by the orchestrator session.

## What this project is (one paragraph)

REMATCH is a deterministic 2D boss-rush where an agent pipeline rewrites the boss's
strategy between rounds and a deterministic harness decides whether the rewrite ships.
The verification is the product's thesis. Your job touches none of that: this is a
**visual** pass. Hackathon submission is 2026-09-14 — anything risky is not worth it.

## Hard boundaries — breaking any of these is failure

- **Touch only `packages/web`** (plus `docs/AI-DEV-LOG.md` for your log entry).
  Never `engine`, `contract`, `sandbox`, `harness`, `agents`, `server`. The engine's
  replay hash (`74cd659935e33202`, asserted in `packages/web/test/replay-fixture.test.ts`
  and `e2e/determinism.spec.ts`) must not move — it will not, as long as you stay out
  of simulation code.
- **Cosmetic code stays out of sim modules.** `packages/web/test/fighters.test.ts` and
  the audio/habit tests assert structurally that game-simulation modules import no
  cosmetic module. Anything you add follows the same pattern and gets the same test.
- **The renderer must not lie about hitboxes.** Sprites are clipped to the entity's
  collision circle on purpose (SPEC §13 delta 22). Keep any new fighter/boss styling
  inside the collision circle; telegraph shapes must keep matching real damage areas.
- **No new raster art on a code path, no image-generation dependency** (SPEC §2.3 +
  deltas 17/22). Existing PNGs (agent portraits, fighter heads, intro hero) render
  behind SVG/flat placeholders and the game must stay complete without them. CSS,
  SVG, Canvas and code-generated effects are your palette.
- **Sound is Tone.js-synthesized only, never sampled files.** An audio system already
  exists (`packages/web/src/audio/`) — a chiptune intro loop, typing ticks, 14 SFX.
  It is already 90s-flavored; reuse, don't replace.
- `pnpm verify` green before you call anything done. The pre-commit hook runs it —
  do not use `--no-verify`. Do not run `pnpm eval:agents` or set `REMATCH_ALLOW_SPEND`
  (spends money). No network/model calls are needed for visual work.

## Where the visual surface lives

| Surface | Files |
|---|---|
| Arena + entities (Canvas 2D) | `packages/web/src/render/renderer.ts`, `render/sprites.ts`, `render/effects.ts`, `render/habitHighlight.ts` |
| All CSS | `packages/web/src/ui/styles.css` (one file; note the specificity lesson below) |
| Intro (4-beat attract sequence) | `ui/screens.ts` + `ui/introSequence.ts` — three-band grid (title / content / action), shape is data and unit-tested |
| HUD (HP pips, timer, boss strategy panel) | `ui/` (grep for hud) |
| Interlude (the 4-beat rewrite screen) | `src/interlude/ui.ts`, `castStatus.ts` — Analyst/Coder/Judge panels, diff view, trial meter, Judge stamps |
| Round-start banner + habit caption | `ui/roundBanner*.ts`, `ui/habitCaption.ts`, `render/habitCells.ts` |
| Audio + mute toggle | `src/audio/*`, `ui/audioToggle.ts` |
| Agent portraits / fighters / hero PNGs | `public/agents/`, `public/fighters/`, `public/intro/` (+ `scripts/prepare-hero.py`, `scripts/crop-fighters.py` for regeneration) |

Current look: flat, high-contrast, dark grounds `#0B0F1A` / `#07080c`, accent colors
that carry meaning — Analyst teal `#2DD4BF`, Coder amber `#F59E0B`, Judge red
`#EF4444`/green `#22C55E`, Boss magenta `#C026D3`. **Keep the accent semantics**: the
acting agent glows in its own color, and the Judge is deliberately styled "not an AI"
(hard corners, DETERMINISTIC chip) — that distinction is part of the argument the
jury is scored on. Restyle it; do not blur it.

## 90s direction that fits this codebase (suggestions, not orders)

- CRT flavor: scanline/vignette overlay as a pure CSS/canvas layer (cheap, togglable);
  slight phosphor glow on accents. Keep it subtle — readability of the interlude text
  and rejection sentences is contractual (SPEC §2.2: every rejection stays readable).
- Typography: a pixel/bitmap-style font for headings (bundled via CSS, no network
  fonts at runtime if it breaks offline dev; check how fonts load today). Body/code
  text in the interlude stays monospace and legible.
- Chunky UI: thick borders, hard shadows, dithered gradients, arcade-style
  "INSERT COIN"-energy on the intro action buttons. The intro is already an attract
  sequence — lean into it.
- HP pips/timer as arcade HUD elements; the trial meter as a segmented arcade bar.
- Dash/hit effects: brief palette flashes, 90s-style hit sparks in `render/effects.ts`.

## Lessons already paid for (read before styling — all in `docs/AI-DEV-LOG.md`)

- `.card h1` (0,1,1) outranks any bare class you add later — prefix intro headings
  with `.card.start` or raise specificity deliberately (2026-09-09 entry).
- `[hidden]` loses to any author `display` rule — the interlude has a
  `#interlude [hidden] { display: none !important }` guard; keep it.
- `width:100%` + `max-height` letterboxes images; size the image, not the box.
- Screenshots catch what assertions can't: the e2e suite writes one PNG per intro
  beat at **1280×800 and 1440×900** to `artifacts/web/` — look at every one of them
  after styling. Bands are sized in `vh`, so the two viewports genuinely disagree.
- Audio init must never happen on raw gameplay input (caused dropped frames once);
  it is scoped to menu-level gestures + intro autoplay attempt. Don't rewire it.

## How to run and verify

```bash
pnpm install && pnpm dev              # game at localhost:5173, no API key needed
# offline interlude sources for visual work:
#   ?agent=mock            — instant fake stream
#   ?agent=recorded&run=mimic-camper&autostart=1 — real recorded run
pnpm --filter @rematch/web test       # unit (319 at handoff time)
pnpm --filter @rematch/web test:e2e   # Playwright (33 at handoff time) + screenshots
pnpm verify                           # whole repo; 1183 tests at handoff time
```

E2e specs assert visible text (banner strategy name, mute toggle, beat visibility) —
restyling is fine, renaming/removing elements needs the specs updated in the same pass.

## State at handoff

- Branch `fix/active-gate-and-clocks`; last commit `db2dba3`. The working tree may
  still hold an **uncommitted batch** (audio system, Mimic calibration, habit-cell
  threshold, Analyst extraction retry, honest fallback banner) — check `git status`
  and coordinate with Matheus before committing anything; the pre-commit hook runs
  the full verify.
- Two untracked diagnostic scripts in `packages/harness/scripts/` belong to another
  stream — leave them.
- A local dev server pair may be running (vite :5173, rewrite server :8787 with
  `claude-cli`). Visual work needs only vite; do not start providers.
- Every change gets a dated `docs/AI-DEV-LOG.md` entry in the log's voice — it is
  judged material ("show your work"). Screenshots into `artifacts/web/` are the
  repo's evidence convention.

## Status — 2026-09-10, done (uncommitted)

Shipped in the working tree on `fix/active-gate-and-clocks`, not committed — Matheus decides
how it lands alongside the audio/Mimic batch already sitting there.

- CSS: bundled pixel display font (`@fontsource/press-start-2p`, offline), CSS-only CRT layer
  (`?crt=0` disables, `src/ui/crt.ts` + costume test), chunky borders/hard shadows, bevelled
  HP pips, 20-notch trial meter, rotated double-border Judge stamp. Judge kept hard-cornered.
- Canvas: deterministic hit sparks, sprite flash clipped to the collision circle, dash
  afterimages at true radius, 2-frame hard red hit cut. No palette change.
- Evidence: web 319 → 346 unit tests, e2e 33/33, `pnpm verify` green (1210 tests), replay hash
  unmoved. Screenshots regenerated in `artifacts/web/` at both viewports; see the dated
  `docs/AI-DEV-LOG.md` entry.
- Follow-up (same evening): minions now draw the boss's picked fighter face, small, with a
  violet ring — `fight-minions.png` added to the screenshot spec.
- Not done: no screenshot captures a live hit frame; sub-headings deliberately stayed monospace.
