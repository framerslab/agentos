/**
 * Barrel exports for the Cognitive Memory System.
 *
 * Organized into four tiers:
 * - **core/**: foundational types, config, encoding, decay, working memory, prompts
 * - **retrieval/**: store, graph, prospective memory, feedback
 * - **pipeline/**: consolidation, observation, context window management
 * - **io/**: ingestion, import/export, facade, tools, extensions, integration
 * - **mechanisms/**: optional cognitive mechanisms (reconsolidation, RIF, etc.)
 *
 * @module agentos/memory
 */

// ---------------------------------------------------------------------------
// Core Tier — types, config, encoding, decay, working, prompt
// ---------------------------------------------------------------------------

// --- Core types ---
export type {
  MemoryType,
  MemoryScope,
  MemorySourceType,
  MemoryProvenance,
  MemoryTrustPolicy,
  TrustCapability,
  EmotionalContext,
  ContentFeatures,
  MemoryTrace,
  WorkingMemorySlot,
  EncodingWeights,
  EncodingResult,
  CognitiveRetrievalOptions,
  ScoredMemoryTrace,
  PartiallyRetrievedTrace,
  CognitiveRetrievalResult,
  MemoryBudgetAllocation,
  AssembledMemoryContext,
  MemoryHealthReport,
} from './core/types.js';
export { DEFAULT_TRUST_POLICY_BY_SOURCE, canUseFor } from './core/types.js';

// --- Configuration ---
export type {
  CognitiveMemoryConfig,
  CognitiveMemoryPersonaConfig,
  PADState,
  HexacoTraits,
  EncodingConfig,
  DecayConfig,
  ObserverConfig,
  ReflectorConfig,
  MemoryGraphConfig,
  ConsolidationConfig,
} from './core/config.js';
export {
  DEFAULT_ENCODING_CONFIG,
  DEFAULT_DECAY_CONFIG,
  DEFAULT_BUDGET_ALLOCATION,
} from './core/config.js';

// --- Encoding ---
export {
  computeEncodingWeights,
  computeEncodingStrength,
  computeAttentionMultiplier,
  yerksDodson,
  moodCongruenceBoost,
  isFlashbulbMemory,
  buildEmotionalContext,
} from './core/encoding/EncodingModel.js';
export {
  createFeatureDetector,
  KeywordFeatureDetector,
  LlmFeatureDetector,
  HybridFeatureDetector,
} from './core/encoding/ContentFeatureDetector.js';
export type { IContentFeatureDetector } from './core/encoding/ContentFeatureDetector.js';

// --- Decay ---
export {
  computeCurrentStrength,
  updateOnRetrieval,
  computeInterference,
  findPrunableTraces,
} from './core/decay/DecayModel.js';
export type {
  RetrievalUpdateResult,
  InterferenceResult,
  InterferenceVictim,
} from './core/decay/DecayModel.js';
export {
  scoreAndRankTraces,
  detectPartiallyRetrieved,
  computeRecencyBoost,
  computeEmotionalCongruence,
  DEFAULT_SCORING_WEIGHTS,
} from './core/decay/RetrievalPriorityScorer.js';
export type {
  ScoringWeights,
  ScoringContext,
  CandidateTrace,
  SignalName,
} from './core/decay/RetrievalPriorityScorer.js';

// --- Working Memory ---
export { CognitiveWorkingMemory } from './core/working/CognitiveWorkingMemory.js';
export type { CognitiveWorkingMemoryConfig } from './core/working/CognitiveWorkingMemory.js';

// --- Prompt Assembly ---
export { assembleMemoryContext } from './core/prompt/MemoryPromptAssembler.js';
export type { MemoryAssemblerInput } from './core/prompt/MemoryPromptAssembler.js';
export { formatMemoryTrace, formatMemoryTraces } from './core/prompt/MemoryFormatters.js';
export type { FormattingStyle } from './core/prompt/MemoryFormatters.js';

// --- Persistent Markdown Working Memory ---
export { MarkdownWorkingMemory } from './core/working/MarkdownWorkingMemory.js';
export type { WriteResult } from './core/working/MarkdownWorkingMemory.js';
export { UpdateWorkingMemoryTool } from './core/working/UpdateWorkingMemoryTool.js';
export { ReadWorkingMemoryTool } from './core/working/ReadWorkingMemoryTool.js';

// ---------------------------------------------------------------------------
// Retrieval Tier — store, graph, prospective memory, feedback
// ---------------------------------------------------------------------------

// --- Store ---
export { MemoryStore } from './retrieval/store/MemoryStore.js';
export type { MemoryStoreConfig } from './retrieval/store/MemoryStore.js';

// --- SQLite Storage ---
export { Brain } from './retrieval/store/Brain.js';
export { SqlKnowledgeGraph } from './retrieval/store/SqlKnowledgeGraph.js';
export { HnswSidecar, type HnswSidecarConfig, type HnswQueryResult } from './retrieval/store/HnswSidecar.js';
export { SqlMemoryGraph } from './retrieval/store/SqlMemoryGraph.js';

// --- Memory Graph ---
export type {
  IMemoryGraph,
  MemoryGraphNodeMeta,
  MemoryEdge,
  MemoryEdgeType,
  SpreadingActivationConfig,
  ActivatedNode,
  MemoryCluster,
} from './retrieval/graph/IMemoryGraph.js';
export { GraphologyMemoryGraph } from './retrieval/graph/GraphologyMemoryGraph.js';
export { KnowledgeGraphMemoryGraph } from './retrieval/graph/KnowledgeGraphMemoryGraph.js';
export { spreadActivation } from './retrieval/graph/SpreadingActivation.js';
export type { SpreadingActivationInput } from './retrieval/graph/SpreadingActivation.js';

// --- Heuristic entity extraction (Step 13) ---
export {
  extractEntities,
  slugifyEntityId,
} from './retrieval/graph/extraction/index.js';

// --- Prospective Memory ---
export { ProspectiveMemoryManager } from './retrieval/prospective/ProspectiveMemoryManager.js';
export type {
  ProspectiveMemoryItem,
  ProspectiveTriggerType,
} from './retrieval/prospective/ProspectiveMemoryManager.js';

// --- Retrieval Feedback ---
export { RetrievalFeedbackSignal } from './retrieval/feedback/index.js';
export type { RetrievalFeedback } from './retrieval/feedback/index.js';

// ---------------------------------------------------------------------------
// Pipeline Tier — consolidation, observation, context
// ---------------------------------------------------------------------------

// --- Ingest Enrichment (Contextual Retrieval) ---
// Session-level contextual retrieval (Anthropic Sep 2024 variant adapted
// for conversational memory). Generates a dense LLM summary of each
// session at ingest time; consumers prepend it to every chunk before
// embedding so the vector captures session-wide context each chunk
// would otherwise lack. Persistent on-disk cache mirrors CachedEmbedder.
export { SessionSummarizer } from './ingest/SessionSummarizer.js';
export type {
  SessionSummarizerInvoker,
  SessionSummarizerOptions,
  SummarizerStats,
} from './ingest/SessionSummarizer.js';

// --- Session-Level Hierarchical Retrieval (Step 2) ---
// Two-stage retriever (xMemory / TACITREE pattern, session-granularity
// variant). Stage 1 picks top-K sessions via summary similarity, Stage
// 2 runs a chunk-level query and post-filters to those sessions,
// taking top-M chunks each. Companion to SessionSummarizer (which
// generates the summaries indexed here).
export { SessionSummaryStore } from './retrieval/session/SessionSummaryStore.js';
export type {
  SessionSummaryStoreOptions,
  IndexSessionInput,
  QueriedSession,
} from './retrieval/session/SessionSummaryStore.js';
export { SessionRetriever } from './retrieval/session/SessionRetriever.js';
export type {
  SessionRetrieverOptions,
  SessionRetrieveOptions,
} from './retrieval/session/SessionRetriever.js';

// --- Hybrid BM25 + Dense Retrieval (Step 3) ---
// Rank-fusion retriever combining BM25 sparse search with cognitive-
// scored dense retrieval via Reciprocal Rank Fusion. Optional rerank
// applied to merged pool. Targets failure modes (exact-term matches,
// specific-value questions) that pure semantic embedding misses.
export { HybridRetriever } from './retrieval/hybrid/HybridRetriever.js';
export type {
  HybridRetrieverOptions,
  HybridRetrieveOptions,
} from './retrieval/hybrid/HybridRetriever.js';
export { reciprocalRankFusion } from './retrieval/hybrid/reciprocalRankFusion.js';
export type {
  RankedDoc,
  RRFOptions,
  RRFResult,
} from './retrieval/hybrid/reciprocalRankFusion.js';

// --- Fact-graph (Step 9, Mem0-style tuple extraction) ---
// Closed-schema LLM fact extraction + in-memory FactStore keyed by
// (scope, subject, predicate). Preserves literal object tokens where
// summary-based approaches (Steps 5, 7, 8) erased them.
export { FactStore, FactExtractor } from './retrieval/fact-graph/index.js';
export type {
  Fact,
  FactStoreEntry,
  FactExtractorOptions,
  FactExtractorSession,
} from './retrieval/fact-graph/index.js';
export {
  canonicalizeSubject,
  hashSubject,
  hashPredicate,
  isValidPredicate,
  PREDICATE_SCHEMA,
} from './retrieval/fact-graph/index.js';

// --- Observation System ---
export { ObservationBuffer } from './pipeline/observation/ObservationBuffer.js';
export type { BufferedMessage, ObservationBufferConfig } from './pipeline/observation/ObservationBuffer.js';
export { MemoryObserver } from './pipeline/observation/MemoryObserver.js';
export type { ObservationNote } from './pipeline/observation/MemoryObserver.js';
export {
  MemoryReflector,
  REFLECTOR_PROMPT_HASH,
} from './pipeline/observation/MemoryReflector.js';
export type { MemoryReflectionResult } from './pipeline/observation/MemoryReflector.js';

// --- Observation Compression & Reflection ---
export { ObservationCompressor } from './pipeline/observation/ObservationCompressor.js';
export type {
  CompressedObservation,
  CompressionPriority,
} from './pipeline/observation/ObservationCompressor.js';
export { ObservationReflector } from './pipeline/observation/ObservationReflector.js';
export type { Reflection, ReflectionPatternType } from './pipeline/observation/ObservationReflector.js';

// --- Temporal Reasoning ---
export { relativeTimeLabel } from './pipeline/observation/temporal.js';
export type { TemporalMetadata } from './pipeline/observation/temporal.js';

// --- Consolidation Pipeline ---
export { ConsolidationPipeline } from './pipeline/consolidation/ConsolidationPipeline.js';
export type {
  ConsolidationResult,
  ConsolidationPipelineConfig,
} from './pipeline/consolidation/ConsolidationPipeline.js';

// --- Self-Improving Consolidation ---
export { ConsolidationLoop } from './pipeline/consolidation/index.js';

// --- Infinite Context Window ---
export { ContextWindowManager } from './pipeline/context/ContextWindowManager.js';
export type {
  ContextWindowManagerConfig,
  ContextWindowStats,
} from './pipeline/context/ContextWindowManager.js';
export { CompactionEngine } from './pipeline/context/CompactionEngine.js';
export { CompactionLog } from './pipeline/context/CompactionLog.js';
export type { CompactionLogStats } from './pipeline/context/CompactionLog.js';
export { RollingSummaryChain } from './pipeline/context/RollingSummaryChain.js';
export { SlidingSummaryStrategy } from './pipeline/context/strategies/SlidingSummaryStrategy.js';
export { HierarchicalStrategy } from './pipeline/context/strategies/HierarchicalStrategy.js';
export { HybridStrategy } from './pipeline/context/strategies/HybridStrategy.js';
export type {
  InfiniteContextConfig,
  CompactionStrategy,
  TransparencyLevel,
  ContextMessage,
  CompactionEntry,
  SummaryChainNode,
  CompactionInput,
  CompactionResult,
  ICompactionStrategy,
} from './pipeline/context/types.js';
export { DEFAULT_INFINITE_CONTEXT_CONFIG } from './pipeline/context/types.js';

// ---------------------------------------------------------------------------
// IO Tier — ingestion, import/export, facade, tools, extensions, integration
// ---------------------------------------------------------------------------

// --- High-level facade ---
export { AgentMemory } from './AgentMemory.js';
export type { RecallResult, RememberResult, SearchOptions } from './AgentMemory.js';

// --- Memory Facade (Phase 1: Ingestion + Self-Improving Graph) ---
export { Memory } from './io/facade/index.js';
export type { ScoredTrace } from './io/facade/index.js';
export { createOcrPdfLoader } from './io/ingestion/OcrPdfLoader.js';
export { createDoclingLoader } from './io/ingestion/DoclingLoader.js';
export type {
  MemoryConfig,
  EmbeddingConfig,
  ExtendedConsolidationConfig,
  IngestionConfig,
  RememberOptions,
  RecallOptions,
  IngestOptions,
  IngestResult,
  ExportOptions,
  ImportOptions,
  ImportResult,
  ConsolidationResult as MemoryConsolidationResult,
  MemoryHealth,
  LoadOptions,
  LoadedDocument,
  DocumentMetadata,
  DocumentChunk,
  ExtractedImage,
  ExtractedTable,
} from './io/facade/index.js';

// --- Document Ingestion ---
export type { IDocumentLoader } from './io/ingestion/IDocumentLoader.js';
export { TextLoader } from './io/ingestion/TextLoader.js';
export { MarkdownLoader } from './io/ingestion/MarkdownLoader.js';
export { HtmlLoader } from './io/ingestion/HtmlLoader.js';
export { PdfLoader } from './io/ingestion/PdfLoader.js';
export { DocxLoader } from './io/ingestion/DocxLoader.js';
export { LoaderRegistry } from './io/ingestion/LoaderRegistry.js';
export { FolderScanner } from './io/ingestion/FolderScanner.js';
export { ChunkingEngine } from './io/ingestion/ChunkingEngine.js';
export { MultimodalAggregator } from './io/ingestion/MultimodalAggregator.js';
export { UrlLoader } from './io/ingestion/UrlLoader.js';

// --- Agent Memory Tools ---
export {
  MemoryAddTool,
  MemoryUpdateTool,
  MemoryDeleteTool,
  MemoryMergeTool,
  MemorySearchTool,
  MemoryReflectTool,
} from './io/tools/index.js';

// --- Extension ---
export { createCognitiveMemoryDescriptor } from './io/extension/CognitiveMemoryExtension.js';
export { createStandaloneMemoryDescriptor } from './io/extension/StandaloneMemoryExtension.js';
export {
  createMemoryToolDescriptors,
  createMemoryToolsPack,
} from './io/extension/MemoryToolsExtension.js';
export type { MemoryToolsExtensionOptions } from './io/extension/MemoryToolsExtension.js';
export type { StandaloneMemoryDescriptorOptions } from './io/extension/StandaloneMemoryExtension.js';

// --- Standalone Memory Bridges ---
export {
  buildStandaloneMemoryPersonaScopeId,
  createStandaloneMemoryLongTermRetriever,
  createStandaloneMemoryRollingSummarySink,
} from './io/integration/StandaloneMemoryBridge.js';
export type {
  StandaloneMemoryLongTermRetrieverOptions,
  StandaloneMemoryRollingSummarySinkOptions,
} from './io/integration/StandaloneMemoryBridge.js';

// --- Import/Export ---
export {
  JsonExporter,
  JsonImporter,
  MarkdownExporter,
  MarkdownImporter,
  ObsidianExporter,
  ObsidianImporter,
  // SqliteExporter and SqliteImporter omitted — require 'better-sqlite3' native module.
  // Import directly: await import('./io/SqliteImporter.js')
  ChatGptImporter,
  CsvImporter,
} from './io/index.js';

// ---------------------------------------------------------------------------
// Orchestrator (root level)
// ---------------------------------------------------------------------------

export { CognitiveMemoryManager } from './CognitiveMemoryManager.js';
export type { ICognitiveMemoryManager, FlushReflectionResult } from './CognitiveMemoryManager.js';

// ---------------------------------------------------------------------------
// Cognitive Mechanisms (optional)
// ---------------------------------------------------------------------------

export { CognitiveMechanismsEngine, DEFAULT_MECHANISMS_CONFIG } from './mechanisms/index.js';
export { resolveConfig as resolveMechanismsConfig } from './mechanisms/index.js';
export type {
  CognitiveMechanismsConfig,
  ResolvedMechanismsConfig,
  MetacognitiveSignal,
  MechanismMetadata,
  DriftEvent,
} from './mechanisms/index.js';
export {
  analyzePersonaDrift,
  DEFAULT_PERSONA_DRIFT_CONFIG,
} from './mechanisms/PersonaDriftMechanism.js';
export type {
  PersonaDriftConfig,
  PersonalityDriftProposal,
  RelationshipDriftInput,
  HEXACOTrait,
} from './mechanisms/PersonaDriftMechanism.js';

// Step-5: FactSupersession post-retrieval filter.
export { FactSupersession } from './retrieval/fact-supersession/index.js';
export type {
  FactSupersessionOptions,
  FactSupersessionInput,
  FactSupersessionResult,
} from './retrieval/fact-supersession/index.js';

// Stage E: Hindsight 4-network typed observer module. Re-exported here so
// consumers can `import { TypedNetworkStore } from '@framers/agentos/memory'`
// instead of going through the deep subpath (which has TS-bundler resolution
// quirks for downstream tsconfigs in some configurations).
export {
  BANK_IDS,
  EDGE_KINDS,
  isBankId,
  TypedNetworkStore,
  TypedNetworkObserver,
  TypedSpreadingActivation,
  TypedNetworkRetriever,
  rankByTemporalOverlap,
  fourWayRrf,
  TYPED_EXTRACTION_SYSTEM_PROMPT,
  buildExtractionUserPrompt,
  TypedExtractionSchema,
  TypedExtractionFactSchema,
  DEFAULT_EDGE_MULTIPLIERS,
  extractQueryEntities,
  typedFactToScoredTrace,
} from './retrieval/typed-network/index.js';
export type {
  BankId,
  EdgeKind,
  TypedFact,
  TypedEdge,
  FactTemporal,
  Participant,
  ITypedExtractionLLM,
  TypedNetworkObserverOptions,
  TypedSpreadingActivationOptions,
  SpreadOptions,
  FourWayRrfInput,
  FourWayRrfOptions,
  TypedExtractionOutput,
  TypedExtractionFact,
  TypedNetworkRetrieverOptions,
  TypedNetworkRetrieveOptions,
} from './retrieval/typed-network/index.js';
