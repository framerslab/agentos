/**
 * Barrel exports for the subset of AgentOS modules that external consumers
 * should generally import. Internal modules can still be reached via
 * `@framers/agentos/<path>` thanks to the workspace exports map.
 */

export * from './api/AgentOS.js';
export * from './api/runtime/AgentOSOrchestrator';
export * from './api/types/AgentOSInput';
export * from './api/types/AgentOSResponse';
export * from './api/types/AgentOSExternalToolRequest';
export * from './api/types/AgentOSToolResult';
export * from './cognition/substrate/IGMI';
export * from './cognition/substrate/GMIManager';
export type {
  ITool,
  ToolExecutionResult,
  ToolExecutionContext,
  JSONSchemaObject,
} from './core/tools/ITool';
export * from './core/llm/IPromptEngine';
export * from './core/config/ToolOrchestratorConfig';
export * from './core/tools/permissions/IToolPermissionManager';
export * from './core/conversation/ConversationManager';
export * from './core/conversation/IRollingSummaryMemorySink';
export * from './core/conversation/ILongTermMemoryRetriever';
export * from './core/conversation/LongTermMemoryPolicy';
export * from './core/streaming/StreamingManager';
export * from './core/llm/providers/AIModelProviderManager';
export * from './orchestration/turn-planner/TurnPlanner';
export * from './orchestration/turn-planner/SqlTaskOutcomeTelemetryStore';
export * from './orchestration/workflows/WorkflowTypes';
export * from './orchestration/workflows/IWorkflowEngine';
export * from './orchestration/workflows/storage/IWorkflowStore';
export { WorkflowEngine } from './orchestration/workflows/WorkflowEngine';
export { InMemoryWorkflowStore } from './orchestration/workflows/storage/InMemoryWorkflowStore';
// Agency (Multi-Agent Collectives)
export * from './agents/agency/AgencyTypes';
export { AgencyRegistry } from './agents/agency/AgencyRegistry';
export { AgencyMemoryManager } from './agents/agency/AgencyMemoryManager';
export type {
  AgencyMemoryIngestInput,
  AgencyMemoryChunk,
  AgencyMemoryQueryResult,
  AgencyMemoryStats,
} from './agents/agency/AgencyMemoryManager';
export { AgentCommunicationBus } from './agents/agency/AgentCommunicationBus';
export type {
  IAgentCommunicationBus,
  AgentMessage,
  AgentMessageType,
  AgentRequest,
  AgentResponse,
  HandoffContext,
  HandoffResult,
} from './agents/agency/IAgentCommunicationBus';
// Planning Engine
export * from './orchestration/planner';
// Human-in-the-Loop (HITL)
export * from './orchestration/hitl';
// Structured Outputs (JSON Schema, Function Calling)
export * from './api/structured/output';
// Code Execution Sandbox
export * from './safety/sandbox/executor';
// Observability & Tracing
export * from './safety/evaluation/observability';
// Evaluation Framework
export * from './safety/evaluation';
// Knowledge Graph
export * from './cognition/memory/retrieval/graph/index';
// Agent Marketplace
export * from './cognition/marketplace/store';
// Per-agent workspace helpers
export * from './cognition/marketplace/workspace';
export * from './cognition/substrate/personas/definitions';
export * from './cognition/substrate/personas/IPersonaDefinition';
export type { IPersonaLoader, PersonaLoaderConfig } from './cognition/substrate/personas/IPersonaLoader';
export { PersonaLoader } from './cognition/substrate/personas/PersonaLoader';
export type { FileSystemPersonaLoaderConfig } from './cognition/substrate/personas/PersonaLoader';
export { InMemoryPersonaLoader, assertInlinePersonaDefinitions, INLINE_PERSONA_LOADER_CONFIG } from './cognition/substrate/personas/InMemoryPersonaLoader';
export { normalizePersonaDefinition } from './cognition/substrate/personas/personaNormalization';
export * from './cognition/substrate/persona_overlays/PersonaOverlayTypes';
export { PersonaOverlayManager } from './cognition/substrate/persona_overlays/PersonaOverlayManager';
// Guardrails
export * from './safety/guardrails';
export * from './extensions';
// Messaging Channels (external platform adapters)
export * from './io/channels';
// Voice Calls (telephony providers)
export * from './io/channels/telephony';
// Meeting bots (the meeting-participant channel)
export * from './io/channels/meetings/index.js';
// Unified speech runtime (STT/TTS/VAD/wake-word)
export * from './io/speech';
// Unified image generation providers
export * from './io/media/images';
// Unified video generation, analysis, and scene detection
export * from './io/media/video/index.js';
// Unified audio generation (music + SFX) and provider registry
export * from './io/media/audio/index.js';
// Hearing module (audio processing + STT/VAD providers)
export * from './io/hearing';
// Media provider preference resolver (shared across image/video/audio)
export * from './io/media/ProviderPreferences.js';
// Unified vision pipeline (OCR + handwriting + document AI + CLIP + cloud)
export { VisionPipeline, createVisionPipeline, LLMVisionProvider, PipelineVisionProvider } from './io/vision/index.js';
export type {
  VisionPipelineConfig,
  VisionResult,
  VisionStrategy,
  VisionTier,
  VisionCloudTask,
  ContentCategory as VisionContentCategory,
  TierResult as VisionTierResult,
  FailedTier as VisionFailedTier,
  TextRegion as VisionTextRegion,
  DocumentLayout,
  DocumentPage,
  LayoutBlock,
  VisionPreprocessingConfig,
} from './io/vision/types.js';
export type { LLMVisionProviderConfig } from './io/vision/providers/LLMVisionProvider.js';
// Skills (SKILL.md prompt modules)
export * from './cognition/skills';
// Multilingual exports
export * from './cognition/nlp/language/interfaces';
export * from './cognition/nlp/language/LanguageService';
// NLP AI Utilities (classification, sentiment, similarity, keyword extraction, etc.)
export * from './cognition/nlp/ai_utilities/IUtilityAI';
export * from './cognition/nlp/ai_utilities/LLMUtilityAI';
export * from './cognition/nlp/ai_utilities/StatisticalUtilityAI';
export * from './cognition/nlp/ai_utilities/HybridUtilityAI';
export type { ILogger } from './core/logging/ILogger';
export { createLogger, setLoggerFactory, resetLoggerFactory } from './core/logging/loggerFactory';
// Rate limit types
export * from './core/rate-limiting/types';
// Storage adapters
export * from './core/storage';
// Usage & cost accounting
export * from './core/utils/usage/UsageLedger';
// RAG (Retrieval Augmented Generation)
export * from './cognition/rag';
export type {
  MemoryRetrievalPolicy,
  MemoryRetrievalProfile,
  ResolvedMemoryRetrievalPolicy,
} from './cognition/rag/unified/policy.js';
export {
  DEFAULT_MEMORY_RETRIEVAL_POLICY,
  buildRetrievalPlanFromPolicy,
  getCandidateLimit,
  resolveMemoryRetrievalPolicy,
} from './cognition/rag/unified/policy.js';
// Cognitive Memory System
export * from './cognition/memory';
// Two barrels above export an `isPublicAddress`: the memory barrel `guardedFetch`'s rule, and the meetings barrel the
// checked egress module's stricter rule, which the outbox delivery holds. The root exports `guardedFetch`'s.
export { isPublicAddress } from './cognition/memory';
// Memory Wiki — markdown-first long-term memory for soul-file agents
export {
  WikiMemoryStore,
  WikiCompiler,
  ensureMemoryDir,
  parsePage,
  serializePage,
  renderCatalog,
  extractWikiLinks,
  WIKI_PAGE_TYPES,
  isWikiPageType,
  InvalidWikiPageIdError,
  isWikiPageId,
  assertWikiPageId,
  MAX_WIKI_PAGE_ID_LENGTH,
} from './cognition/substrate/memory/wiki/index.js';
export type {
  WikiPage,
  WikiPageType,
  WikiPageIdProblem,
  MetaIndex,
  IndexResult as WikiIndexResult,
  CompileResult as WikiCompileResult,
  MemoryIndexPort,
  WikiMemoryStoreOptions,
  WikiCompilerOptions,
  WikiCompilerStorePort,
} from './cognition/substrate/memory/wiki/index.js';
export { attachMemoryWiki } from './cognition/memory/io/attachMemoryWiki.js';
export type {
  AttachMemoryWikiOptions,
  AttachMemoryWikiResult,
  WikiAttachableMemory,
} from './cognition/memory/io/attachMemoryWiki.js';
export { ReadMemoryPageTool } from './cognition/memory/io/tools/ReadMemoryPageTool.js';
// Query Router (classification, retrieval dispatch, grounded answer generation)
export {
  QueryClassifier,
  QueryDispatcher,
  QueryGenerator,
  QueryRouter,
  TopicExtractor,
  KeywordFallback,
} from './orchestration/pipeline/query/index.js';
export type {
  QueryTier,
  ClassificationResult,
  RetrievedChunk,
  SourceCitation,
  RetrievalResult,
  ConversationMessage,
  QueryRouterConfig,
  ClassifyStartEvent,
  ClassifyCompleteEvent,
  ClassifyErrorEvent,
  RetrieveStartEvent,
  RetrieveVectorEvent,
  RetrieveGraphEvent,
  RetrieveRerankEvent,
  RetrieveCompleteEvent,
  RetrieveFallbackEvent,
  ResearchStartEvent,
  ResearchPhaseEvent,
  ResearchCompleteEvent,
  GenerateStartEvent,
  GenerateCompleteEvent,
  RouteCompleteEvent,
  QueryRouterEventUnion,
  CorpusChunk,
  TopicEntry,
  QueryResult as QueryRouterResult,
  QueryRouterEmbeddingStatus,
  QueryRouterRetrievalMode,
  QueryRouterRuntimeMode,
  QueryRouterToggleableRuntimeMode,
  QueryRouterCorpusStats,
} from './orchestration/pipeline/query/types.js';
// Orchestration Layer (IR, Events, Checkpoint, Runtime)
export * from './orchestration/index.js';
// Provenance, Audit & Immutability
export * from './safety/provenance';
// Safety Primitives (circuit breaker, dedup, cost guard, stuck detection)
export * from './safety/runtime';
// Emergent Capability Engine (runtime tool creation)
export * from './cognition/emergent/index.js';
// Extension Secrets Catalog
export {
  EXTENSION_SECRET_DEFINITIONS,
  type ExtensionSecretDefinition,
  getSecretDefinition,
  resolveSecretForProvider,
} from './core/config/extensionSecrets.js';

// --- High-Level API (AI SDK style) ---
export {
  generateText,
  isRetryableError,
  isContentPolicyRefusal,
  buildFallbackChain,
  buildPolicyAwareFallbackChain,
} from './api/generateText.js';
export { CONTEXT_WINDOW_EXCEEDED_CODE } from './core/llm/providers/errors/errorCodes.js';
export { ContextWindowExceededError } from './core/llm/providers/errors/ContextWindowExceededError.js';
export { checkContextFit, type ContextFit, type ContextFitRequest } from './api/runtime/contextWindowFit.js';
export type {
  GenerateTextOptions,
  GenerateTextResult,
  FallbackProviderEntry,
  FallbackSignal,
  HostLLMPolicy,
  GenerationHookContext,
  GenerationHookResult,
  Message,
  ToolCallRecord,
  ToolCallHookInfo,
  TokenUsage,
  SystemContentBlock,
} from './api/generateText.js';
export type {
  AttemptOutcome,
  CacheDiagnostics,
  CacheMissReason,
} from './core/llm/providers/IProvider.js';
export { normalizeHostLLMPolicy } from './api/runtime/hostPolicy.js';
export { streamText, normalizeStreamFinishReason } from './api/streamText.js';
export type { StreamTextResult, StreamPart, StreamFinishReason } from './api/streamText.js';
export { createCompletionGateway, toolFormatFor } from './api/runtime/completionGateway.js';
export type {
  CompletionAttempt,
  CompletionGateway,
  CompletionHop,
  CompletionOutcome,
  CompletionResolution,
  CompletionRoute,
  LateAttemptUsage,
} from './api/runtime/completionGateway.js';
export { GatewayProviderManager } from './api/runtime/gatewayProviderManager.js';
export { agent } from './api/agent.js';
export { souledAgent } from './api/souledAgent.js';
export type { SouledAgentOptions, SouledAgent } from './api/souledAgent.js';
export type {
  Agent,
  AgentLearning,
  AgentSession,
  AgentSessionOptions,
  AgentOptions,
  AgentMemoryProvider,
  SessionSendOptions,
  SessionSendStructuredResult,
} from './api/agent.js';
export { gmi, createGmi } from './api/gmi.js';
export type { GmiOptions, GmiHandle } from './api/gmi.js';
export { resolveCognition } from './api/runtime/gmiCognition.js';
export type {
  CognitionProfile,
  CognitionConfig,
  CognitionInputs,
  MetapromptPreset,
  ResolvedCognition,
} from './api/runtime/gmiCognition.js';
export { personaFromAgentOptions } from './api/runtime/gmiPersona.js';
// Teams a gmi() agent launches from a turn (`agencies.launch` registers `launch_agency`), and persistent gmi()
// agents seated in an agency as themselves (`sessionSeat()`).
export { LAUNCH_AGENCY_TOOL_NAME } from './api/runtime/agencyLaunch/types.js';
export type {
  AgencyLaunchOptions,
  LaunchAgencyArgs,
  LaunchAgencyResult,
  LaunchRefusal,
  LaunchRefusalCode,
  LaunchSeatRecord,
  LaunchSeatSpec,
  LaunchStatus,
  LaunchUsage,
} from './api/runtime/agencyLaunch/types.js';
export { sessionSeat } from './api/runtime/agencyLaunch/sessionSeat.js';
export type { SeatHandle, SessionSeatOptions } from './api/runtime/agencyLaunch/sessionSeat.js';
// The rest of the launch surface (docs/AGENCIES.md): the runtime's `agencies` option, a launch tree's limits, the frame
// a seat's turns and tool calls carry, the live objects of the turn that made a tool call, a tool hook, and a launched
// team's registry record.
export type {
  AgencyLaunchFrame,
  CallerTurnContext,
  LaunchLimits,
  LaunchRecordMetadata,
  RuntimeAgencyLaunchOptions,
  ToolCallHook,
} from './api/runtime/agencyLaunch/index.js';
// The learning layer (docs/GMI.md, "Learning"): off unless a host sets its `learning` option.
export { createLearningLayer } from './cognition/learning/index.js';
export type {
  HostLoopName,
  ILearnerSession,
  ILearningLayer,
  LearnerContext,
  LearnerKey,
  LearningConfig,
  LearningLayerOptions,
  LearningLoopName,
  LearningMode,
  LearningProfile,
  LoopManifest,
  LoopName,
  LoopState,
  NoLearnerReason,
  ResolvedLearning,
  ToolLearningContext,
  TurnInputForLearning,
  TurnPreparation,
} from './cognition/learning/index.js';
// The trait map a learner context carries (`LearnerContext.authoredTraits`) and a learner session answers
// (`currentTraits()`).
export type { HexacoTraitValues } from './cognition/substrate/personas/hexaco.js';
export { createAgentCognitiveMemory } from './api/runtime/agentCognitiveMemory.js';
export type { AgentCognitiveMemory, AgentCognitiveMemoryOptions } from './api/runtime/agentCognitiveMemory.js';
export type { MemoryProviderHookOptions } from './api/runtime/memoryProviderHooks.js';
export type {
  IModelRouter,
  ModelRouteParams,
  ModelRouteResult,
} from './core/llm/routing/IModelRouter.js';
export { ModelRouter } from './core/llm/routing/ModelRouter.js';
export { agency, runPostApprovalGuardrails } from './api/agency.js';
export type { GuardrailHitlOverrideResult } from './api/agency.js';
export {
  exportAgentConfig,
  exportAgentConfigJSON,
  exportAgentConfigYAML,
  importAgent,
  importAgentFromJSON,
  importAgentFromYAML,
  validateAgentExport,
} from './api/agentExport.js';
export type {
  AgentExportConfig,
  ExportAgentConfigOptions,
  ImportAgentOptions,
  PrebuiltSeatMarker,
} from './api/agentExport.js';
export { hitl } from './api/hitl.js';
export type { HitlHandler } from './api/hitl.js';
export * from './api/runtime/processRequestWithExternalTools.js';
export * from './api/runtime/externalToolRegistry.js';
export * from './api/runtime/processRequestWithRegisteredTools.js';
export * from './api/runtime/resumeExternalToolRequestWithRegisteredTools.js';
export type {
  AgencyOptions,
  AgencySeatConfig,
  AgencyStrategy,
  AgencyConfigError as AgencyConfigErrorType,
  AgencyCallbacks,
  AgencyStreamResult,
  AgencyStreamPart,
  AgencyTraceEvent,
  AgentCallRecord,
  ApprovalRequest,
  ApprovalDecision,
  ResourceControls,
  HitlConfig,
  CompiledStrategy,
  CompiledStrategyStreamResult,
  Agency,
  SeatMetadata,
  ModelPoolEntry,
  SeatingConfig,
  PanelOptions,
  PanelSeatRecord,
  PanelSeatStatus,
  SeatingRecord,
  SeatingSeatRecord,
  PanelQuorumRecord,
  AgencyResult,
  PanelResult,
  PanelLedger,
  AgencyInstance,
  AgencyQuorumConfig,
} from './api/types.js';
export { AgencyConfigError, AgencyQuorumError, AgencyPanelError, AgencySeatingError } from './api/types.js';
export { vendorOf } from './api/runtime/pool/vendor.js';
export { generateImage } from './api/generateImage.js';
export type { GenerateImageOptions, GenerateImageResult } from './api/generateImage.js';
export { editImage } from './api/editImage.js';
export type { EditImageOptions, EditImageResult } from './api/editImage.js';
export { upscaleImage } from './api/upscaleImage.js';
export type { UpscaleImageOptions, UpscaleImageResult } from './api/upscaleImage.js';
export { variateImage } from './api/variateImage.js';
export type { VariateImageOptions, VariateImageResult } from './api/variateImage.js';
export { segment } from './api/segment.js';
export {
  maskToEditMask,
  cropRegion,
  ReplicateSegmentationProvider,
  registerSegmentationProvider,
  resolveSegmentationProvider,
  resetSegmentationProviders,
  SegmentationModeNotSupportedError,
  InvalidSegmentationPromptError,
  SegmentationProviderError,
} from './io/segmentation/index.js';
export type {
  SegmentOptions,
  SegmentationResult,
  SegmentMask,
  SegmentationMode,
  SegmentationBox,
  SegmentationPoint,
  SegmentationRequest,
  ISegmentationProvider,
  SegmentationProviderId,
  SegmentationProviderOptionBag,
  ReplicateSegmentationOptions,
} from './io/segmentation/index.js';
export { generateVideo } from './api/generateVideo.js';
export type { GenerateVideoOptions, GenerateVideoResult } from './api/generateVideo.js';
export { generateMusic } from './api/generateMusic.js';
export type { GenerateMusicOptions, GenerateMusicResult } from './api/generateMusic.js';
export { generateSFX } from './api/generateSFX.js';
export type { GenerateSFXOptions, GenerateSFXResult } from './api/generateSFX.js';
export { analyzeVideo } from './api/analyzeVideo.js';
export type { AnalyzeVideoOptions, AnalyzeVideoResult } from './api/analyzeVideo.js';
export { detectScenes } from './api/detectScenes.js';
export type { DetectScenesOptions } from './api/detectScenes.js';
export { performOCR } from './api/performOCR.js';
export type { PerformOCROptions, OCRResult } from './api/performOCR.js';
export { generateObject, ObjectGenerationError } from './api/generateObject.js';
export {
  resolveStructuredReply,
  resolveStructuredReplySpec,
  checkStructuredReply,
  recheckStructuredReply,
  structuredRepairMessage,
  StructuredReplyConfigError,
} from './api/runtime/structuredReply.js';
export type { StructuredReplySpec, StructuredOutputMeta, StructuredReplyOutput, IStructuredSchemaRegistry, ResolvedStructuredReply } from './api/runtime/structuredReply.js';
export type { GenerateObjectOptions, GenerateObjectResult } from './api/generateObject.js';
export { streamObject } from './api/streamObject.js';
export type { StreamObjectOptions, StreamObjectResult, StreamObjectElement, DeepPartial } from './api/streamObject.js';
export { embedText } from './api/embedText.js';
export type { EmbedTextOptions, EmbedTextResult } from './api/embedText.js';
export { SpendBudget, UnpricedModelError, asSpendBudget, costOfUsageUSD, estimateCallCostUSD } from './api/runtime/spendBudget.js';
export type { SpendBudgetOptions, SpendLimitInfo } from './api/runtime/spendBudget.js';
export { transferStyle } from './api/transferStyle.js';
// Convenience re-export: every meaningful generateObject / structured-output
// example uses Zod schemas, so consumers can `import { z } from '@framers/agentos'`
// without adding zod as a separate direct dependency. The pinned version
// matches the one agentos itself depends on.
export { z } from 'zod';
export { createTestAgentOSConfig } from './core/config/AgentOSConfig.js';
export {
  setDefaultProvider,
  getDefaultProvider,
  clearDefaultProvider,
  type GlobalDefaultProvider,
} from './api/runtime/global-default.js';
export {
  parseModelString,
  resolveProvider,
  resolveModelOption,
  shutdownProviderManagers,
  ProviderInitializationError,
} from './api/model.js';
export { PROVIDER_DEFAULTS, autoDetectProvider } from './api/runtime/provider-defaults.js';
export type { ProviderDefaults } from './api/runtime/provider-defaults.js';
export {
  setProviderPriority,
  getProviderPriority,
  clearProviderPriority,
} from './api/runtime/provider-priority.js';
export type { TaskType, ModelOption } from './api/model.js';
export { adaptTools, adaptToolsToMap, mergeAdaptableTools } from './api/runtime/toolAdapter.js';
export type { AdaptableToolInput, ToolDefinitionMap } from './api/runtime/toolAdapter.js';
export {
  getDefaultAgentOSUsageLedgerPath,
  resolveAgentOSUsageLedgerPath,
  readRecordedAgentOSUsageEvents,
  recordAgentOSUsage,
  getRecordedAgentOSUsage,
  clearRecordedAgentOSUsage,
} from './api/runtime/usageLedger.js';
export type {
  AgentOSUsageLedgerOptions,
  AgentOSUsageEvent,
  AgentOSUsageRecordInput,
  AgentOSUsageAggregate,
} from './api/runtime/usageLedger.js';
// JSON extraction (centralized LLM output parsing)
export { extractJson } from './safety/validation/extractJson.js';
// Global LLM usage observer (host-side cost telemetry hook). Hosts
// register a single callback at boot; every generateText / generateObject
// / streamText / streamObject call fires it once with the resolved
// provider / model / usage / source so downstream cost + billing
// systems don't need per-callsite wrappers.
export {
  setGlobalLlmObserver,
  getGlobalLlmObserver,
  fireLlmUsageObserver,
} from './api/observers.js';
export type { LlmUsageEvent, LlmUsageObserver } from './api/observers.js';
// CI retrigger
// API key pools: several keys per provider from one comma-separated string,
// failover to the next usable key when one is revoked, unpaid or throttled,
// probes before a failed key returns, and state a host may persist.
export {
  ApiKeyPool,
  keyFingerprint,
  keyPoolStrategyFromEnv,
  InMemoryKeyPoolStateStore,
  SqlKeyPoolStateStore,
  keyPoolStateDdl,
  KEY_POOL_STATE_DDL,
  classifyKeyFailure,
  isQuotaError,
  retryAfterMs as retryAfterHeaderMs,
} from './core/providers/index.js';
export { setKeyPoolDefaults, getKeyPoolDefaults } from './api/keyPoolDefaults.js';
export type { KeyPoolDefaults } from './api/keyPoolDefaults.js';
export type {
  ApiKeyPoolConfig,
  ProbeResult as KeyProbeResult,
  KeyPoolStateStore,
  KeyState,
  SqlKeyPoolStateStoreOptions,
  KeyFailureKind,
} from './core/providers/index.js';
