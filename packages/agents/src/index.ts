/**
 * `@rematch/agents` — the Analyst, the Coder, and the loop that puts them under
 * the harness's back pressure (spec §6.3, §8).
 *
 * ```ts
 * import { rewrite, selectProvider } from '@rematch/agents';
 *
 * const selection = selectProvider();          // REMATCH_PROVIDER: anthropic | openai | auto
 * if (selection.vendor === null) shipFallback(selection.reason);
 *
 * const result = await rewrite(
 *   {
 *     summary,                       // summarizeReplay() of the round just won
 *     round: 2,
 *     prevSource,                    // the strategy.js that lost
 *     providers: selection.create(), // one Analyst provider, one Coder provider
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
  EFFORT_ENV,
  EFFORT_OFF,
  MODEL_ENV,
  OPENAI_DEFAULT_EFFORT,
  OPENAI_DEFAULT_MODEL,
  PROVIDER_ENV,
  REASONING_HEADROOM_TOKENS,
  VENDOR_DEFAULT_MODEL,
  VENDOR_KEY_ENV,
  VENDOR_PREFERENCE,
  anthropicProvider,
  collect,
  isAbortError,
  isUnsupportedParamError,
  mockProvider,
  modelFor,
  openaiError,
  openaiProvider,
  selectProvider,
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
  type OpenAIProviderOptions,
  type OpenAIResponsesLike,
  type OpenAIStreamEvent,
  type ProviderPair,
  type ProviderSelection,
  type ProviderVendor,
} from './provider.ts';

export {
  ADAPT_DIALS,
  ARCHETYPES,
  DIALS,
  TIMELINE_BUDGET,
  analystPrompt,
  adaptDials,
  blendDials,
  bracketHint,
  cellCentre,
  coderPrompt,
  correctionHint,
  contractDoc,
  dialFor,
  harnessHints,
  harnessRules,
  renderBotRates,
  renderCandidateTable,
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
  type BotRates,
  type CandidateOutcome,
  type CoderBracket,
  type CoderContext,
  type CoderDial,
  type CoderRejection,
  type PlayerArchetype,
  type Prompt,
  type RenderSummaryOptions,
} from './context/index.ts';

export {
  ANALYST_MAX_TOKENS,
  analysisGate,
  extractFencedJson,
  extractJsonObject,
  parseAnalysis,
  proseSentences,
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

export { extractMeta } from './meta.ts';

export {
  CANDIDATES_ENV,
  CANDIDATE_GATE_RESERVE_MS,
  DEADLINE_MS,
  DEFAULT_CANDIDATES,
  MAX_ATTEMPTS,
  MAX_CANDIDATES,
  PROGRESS_MIN_GAP_MS,
  STRAGGLER_GRACE_MS,
  balanceRates,
  bracketOf,
  chooseCandidate,
  panelRate,
  readMeta,
  recorder,
  resolveCandidates,
  rewrite,
  tagOf,
  unifiedDiff,
  type RewriteInput,
  type RewriteProviders,
} from './loop.ts';

export type {
  AttemptLog,
  CandidateLog,
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
  workersPerRun,
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
