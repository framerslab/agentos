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
export * from './cognition/substrate/persona_overlays/PersonaOverlayTypes';
export { PersonaOverlayManager } from './cognition/substrate/persona_overlays/PersonaOverlayManager';
// Guardrails
export * from './safety/guardrails';
export * from './extensions';
// Messaging Channels (external platform adapters)
export * from './io/channels';
// Voice Calls (telephony providers)
export * from './io/channels/telephony';
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
  ContentCategory as VisionContentCategory,
  TierResult as VisionTierResult,
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
} from './cognition/substrate/memory/wiki/index.js';
export type {
  WikiPage,
  WikiPageType,
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
export type {
  GenerateTextOptions,
  GenerateTextResult,
  FallbackProviderEntry,
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
  CacheDiagnostics,
  CacheMissReason,
} from './core/llm/providers/IProvider.js';
export { normalizeHostLLMPolicy } from './api/runtime/hostPolicy.js';
export { streamText, normalizeStreamFinishReason } from './api/streamText.js';
export type { StreamTextResult, StreamPart, StreamFinishReason } from './api/streamText.js';
export { agent } from './api/agent.js';
export { souledAgent } from './api/souledAgent.js';
export type { SouledAgentOptions, SouledAgent } from './api/souledAgent.js';
export type {
  Agent,
  AgentSession,
  AgentOptions,
  AgentMemoryProvider,
  SessionSendOptions,
  SessionSendStructuredResult,
} from './api/agent.js';
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
export type { AgentExportConfig } from './api/agentExport.js';
export { hitl } from './api/hitl.js';
export type { HitlHandler } from './api/hitl.js';
export * from './api/runtime/processRequestWithExternalTools.js';
export * from './api/runtime/externalToolRegistry.js';
export * from './api/runtime/processRequestWithRegisteredTools.js';
export * from './api/runtime/resumeExternalToolRequestWithRegisteredTools.js';
export type {
  AgencyOptions,
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
} from './api/types.js';
export { AgencyConfigError } from './api/types.js';
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
export type { GenerateObjectOptions, GenerateObjectResult } from './api/generateObject.js';
export { streamObject } from './api/streamObject.js';
export type { StreamObjectOptions, StreamObjectResult, DeepPartial } from './api/streamObject.js';
export { embedText } from './api/embedText.js';
export type { EmbedTextOptions, EmbedTextResult } from './api/embedText.js';
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
export { parseModelString, resolveProvider, resolveModelOption } from './api/model.js';
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
