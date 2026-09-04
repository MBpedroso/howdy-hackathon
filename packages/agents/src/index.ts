/**
 * `@rematch/agents` — the Analyst, the Coder, and the loop that puts them under
 * the harness's back pressure (spec §6.3, §8).
 *
 * ```ts
 * import { anthropicProvider, modelFor, rewrite } from '@rematch/agents';
 *
 * const result = await rewrite(
 *   {
 *     summary,                       // summarizeReplay() of the round just won
 *     round: 2,
 *     prevSource,                    // the strategy.js that lost
 *     providers: {
 *       analyst: anthropicProvider({ model: modelFor('analyst') }),
 *       coder: anthropicProvider({ model: modelFor('coder') }),
 *     },
 *   },
 *   (event) => sse.send(event),      // the four interlude beats, as they happen
 * );
 * if (!result.approved) shipFallback(result.reason);
 * ```
 *
 * The package never touches the filesystem except to read its own canned replays
 * and the `contract` package's docs, never starts a server, and never imports the
 * engine's internals — only its public types. Everything that decides whether a
 * strategy ships lives in `@rematch/harness`, which contains no LLM at all.
 */

export {
  AbortError,
  DEFAULT_MODEL,
  MODEL_ENV,
  anthropicProvider,
  collect,
  isAbortError,
  mockProvider,
  modelFor,
  type AgentKind,
  type AnthropicProviderOptions,
  type LLMEvent,
  type LLMMessage,
  type LLMProvider,
  type LLMRequest,
  type LLMRole,
  type LLMUsage,
  type MockCall,
  type MockProvider,
  type MockScript,
  type MockStep,
} from './provider.ts';

export {
  ARCHETYPES,
  TIMELINE_BUDGET,
  analystPrompt,
  cellCentre,
  coderPrompt,
  contractDoc,
  harnessRules,
  markdownSection,
  promptSize,
  renderDashRose,
  renderHeatGrid,
  renderHotCells,
  renderMeta,
  renderShotsDuring,
  renderSummary,
  renderTimeline,
  stripBlockComments,
  type Analysis,
  type AnalystContext,
  type CoderContext,
  type PlayerArchetype,
  type Prompt,
  type RenderSummaryOptions,
} from './context/index.ts';

export {
  ANALYST_MAX_TOKENS,
  extractJsonObject,
  parseAnalysis,
  runAnalyst,
  type AnalystInput,
  type AnalystOptions,
  type AnalystResult,
  type ParseResult,
} from './analyst.ts';

export {
  CODER_MAX_TOKENS,
  extractJsBlock,
  renderViolations,
  runCoder,
  type CoderInput,
  type CoderOptions,
  type CoderResult,
} from './coder.ts';

export {
  DEADLINE_MS,
  MAX_ATTEMPTS,
  readMeta,
  recorder,
  rewrite,
  unifiedDiff,
  type RewriteInput,
  type RewriteProviders,
} from './loop.ts';

export type {
  AttemptLog,
  Emit,
  FailureReason,
  RewriteEvent,
  RewriteResult,
} from './events.ts';

export {
  EVAL_ROUND,
  PASS_RATE_TARGET,
  formatEvalTable,
  runEval,
  selectCanned,
  writeEvalArtifact,
  type EvalOptions,
  type EvalReport,
  type EvalRun,
} from './eval.ts';

export {
  CANNED_NAMES,
  cannedPath,
  loadCanned,
  loadAllCanned,
  type CannedName,
  type CannedReplay,
} from './canned.ts';
