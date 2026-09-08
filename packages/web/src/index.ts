/**
 * `@rematch/web` — the game client.
 *
 * This is a Vite application, not a library: the browser entry point is `src/main.ts`
 * (referenced by `index.html`). This module exists so the package has a typed public
 * surface for the interlude work that lands next — the server-driven round-won handler
 * plugs into `createApp({ onRoundWon })` and needs these types.
 */
export { createApp, MAX_ROUNDS, type App, type AppOptions, type DebugApi, type RoundWonContext, type RoundWonHandler } from './app.ts';
export { createRound, type Round } from './game/round.ts';
export { createLoop, logInputProvider, MAX_CATCHUP_STEPS, TICK_MS, type Loop } from './game/loop.ts';
export { buildInput, createInputSource, keyBinding, type InputSource } from './game/input.ts';
export { formatSeed, resolveSessionSeed, roundSeed, seedFromQuery, toSeed } from './game/seeds.ts';
export {
  BUNDLED_STRATEGIES,
  bundledSource,
  loadRoundStrategy,
  sandboxFactory,
  LIVE_BUDGET_FACTOR,
  LIVE_DECIDE_BUDGET_MS,
} from './game/strategy.ts';
export { recordingRunner, type RunnerStats } from './game/runnerStats.ts';
export { createRenderer, type Renderer } from './render/renderer.ts';
export { clientToArena, computeViewport, fitSquare, type Viewport } from './render/viewport.ts';
export { createHud, debugFooterEnabled, formatClock, type Hud, type HudOptions } from './ui/hud.ts';
export { createScreens, type Screens, type StartOptions } from './ui/screens.ts';
export {
  AGENTS,
  CAST,
  JUDGE_APPROVE,
  PORTRAIT_BG,
  PORTRAIT_DIR,
  iconSvg,
  placeholderSvg,
  portraitUrl,
  type Agent,
  type AgentIcon,
  type AgentId,
} from './ui/cast.ts';
export { createPortrait, setPortraitDim, type PortraitOptions } from './ui/portrait.ts';
export {
  SKIP_INTRO_KEY,
  defaultStorage,
  introDecision,
  readSkipIntro,
  writeSkipIntro,
  type IntroDecision,
  type StorageLike,
} from './ui/intro.ts';
export {
  CLIENT_FALLBACK_STRATEGY,
  createInterludeHandler,
  createInterludeUi,
  INTERLUDE_DEADLINE_MS,
  mockSource,
  resolveSource,
  sseSource,
  type InterludeDebug,
  type InterludeSource,
  type InterludeState,
  type RewriteEvent,
  type RewriteRequest,
  type RewriteResult,
} from './interlude/index.ts';
