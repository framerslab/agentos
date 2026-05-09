/**
 * @fileoverview Core types for the QueryRouter module.
 * @module @framers/agentos/query-router/types
 *
 * Defines all interfaces, configuration, event types, and data structures
 * used by the intelligent query routing pipeline. The QueryRouter classifies
 * incoming queries by complexity tier, retrieves relevant context from vector
 * stores and knowledge graphs, and generates grounded answers with citations.
 *
 * Key concepts:
 * - QueryTier: Four-tier complexity classification (0 = trivial, 3 = research)
 * - ClassificationResult: Output of the query classifier with confidence scoring
 * - RetrievalResult: Aggregated chunks from vector, graph, and research sources
 * - QueryResult: Final answer with citations, timing, and tier metadata
 * - QueryRouterConfig: Public constructor config with sensible defaults
 * - Event system: Discriminated union of lifecycle events for observability
 */

import type { IVectorStore } from '../../../core/vector-store/IVectorStore.js';
import type {
  SkillRecommendation,
  ToolRecommendation,
  ExtensionRecommendation,
} from '../../../cognition/rag/unified/types.js';

// ============================================================================
// QUERY TIER
// ============================================================================

/**
 * Complexity tier assigned to an incoming query.
 *
 * - `0` — **Trivial**: Answered from conversation context or general knowledge
 *   (e.g., "What is TypeScript?"). No retrieval needed.
 * - `1` — **Simple lookup**: Single-source retrieval sufficient
 *   (e.g., "What port does the API run on?"). Vector search only.
 * - `2` — **Multi-source**: Requires combining information from multiple chunks
 *   or graph traversal (e.g., "How does auth flow from frontend to backend?").
 * - `3` — **Research**: Deep investigation across the entire corpus, possibly
 *   with iterative refinement (e.g., "Compare all caching strategies used in
 *   this codebase and recommend improvements.").
 */
export type QueryTier = 0 | 1 | 2 | 3;

// ============================================================================
// RETRIEVAL STRATEGY
// ============================================================================

/**
 * Retrieval strategy recommendation produced by the query classifier.
 *
 * The strategy controls whether HyDE (Hypothetical Document Embedding) is
 * engaged and at what depth the retrieval pipeline operates.
 *
 * - `'none'`     — Skip RAG entirely. The query is answerable from
 *                  conversation context or general knowledge alone.
 * - `'simple'`   — Direct embedding search. Fast and cheap. Suitable when the
 *                  query vocabulary closely matches stored document vocabulary.
 * - `'moderate'` — HyDE retrieval. Generates a hypothetical answer, embeds
 *                  *that* for search. Bridges vocabulary mismatch between
 *                  questions and stored answers. (Gao et al. 2023)
 * - `'complex'`  — HyDE + deep research. Decomposes multi-part queries into
 *                  sub-queries, runs HyDE per sub-query, then merges, deduplicates,
 *                  and ranks the combined results.
 *
 * @see ClassificationResult.strategy
 * @see QueryRouterStrategyConfig
 */
export type RetrievalStrategy = 'none' | 'simple' | 'moderate' | 'complex';

/**
 * Maps a {@link RetrievalStrategy} to the corresponding {@link QueryTier}
 * used by the dispatcher pipeline.
 *
 * This mapping is the canonical bridge between the LLM-as-judge strategy
 * decision and the existing tier-based dispatch infrastructure.
 */
export const STRATEGY_TO_TIER: Record<RetrievalStrategy, QueryTier> = {
  none: 0,
  simple: 1,
  moderate: 2,
  complex: 3,
};

/**
 * Maps a {@link QueryTier} back to the closest {@link RetrievalStrategy}.
 *
 * Used when the classifier operates in tier-only mode (legacy) and the
 * dispatcher needs to infer the intended strategy.
 */
export const TIER_TO_STRATEGY: Record<QueryTier, RetrievalStrategy> = {
  0: 'none',
  1: 'simple',
  2: 'moderate',
  3: 'complex',
};

// ============================================================================
// CLASSIFICATION
// ============================================================================

/**
 * Result of classifying a user query into a complexity tier.
 * Produced by the {@link QueryClassifier}.
 */
export interface ClassificationResult {
  /**
   * The assigned complexity tier.
   * @see QueryTier
   */
  tier: QueryTier;

  /**
   * Retrieval strategy recommendation from the LLM-as-judge classifier.
   *
   * When the classifier operates in strategy-aware mode, this field is
   * populated directly from the LLM's structured output. When the classifier
   * runs in legacy tier-only mode, the strategy is inferred from the tier
   * via {@link TIER_TO_STRATEGY}.
   *
   * @see RetrievalStrategy
   */
  strategy: RetrievalStrategy;

  /**
   * Confidence score for the classification (0 to 1).
   * A score below the configured threshold may trigger fallback behaviour.
   */
  confidence: number;

  /**
   * Human-readable reasoning explaining why this tier was chosen.
   * Useful for debugging and audit trails.
   */
  reasoning: string;

  /**
   * Whether the agent's internal knowledge is likely sufficient to answer
   * without any retrieval. When `true` and tier is 0, the router may skip
   * retrieval entirely.
   */
  internalKnowledgeSufficient: boolean;

  /**
   * Suggested source types to consult for this query.
   * @example ['vector', 'graph']
   */
  suggestedSources: Array<'vector' | 'graph' | 'research'>;

  /**
   * Tool names the classifier believes are needed to answer this query.
   * Empty array if no tools are required.
   */
  toolsNeeded: string[];
}

// ============================================================================
// RETRIEVAL
// ============================================================================

/**
 * A single chunk of content retrieved during the retrieval phase.
 */
export interface RetrievedChunk {
  /** Unique identifier for the chunk (typically from the vector store). */
  id: string;

  /** The text content of the chunk. */
  content: string;

  /** Section heading or title the chunk belongs to, if available. */
  heading: string;

  /** File path or document source path this chunk was extracted from. */
  sourcePath: string;

  /**
   * Relevance score (0 to 1) indicating how well this chunk matches
   * the query. Higher is better.
   */
  relevanceScore: number;

  /**
   * Which retrieval method produced this chunk.
   * - `'vector'` — Dense vector similarity search
   * - `'graph'` — Knowledge graph traversal (GraphRAG)
   * - `'research'` — Iterative deep research synthesis
   */
  matchType: 'vector' | 'graph' | 'research';
}

/**
 * A citation referencing a source used in generating the final answer.
 */
export interface SourceCitation {
  /** File path or document path of the cited source. */
  path: string;

  /** Section heading within the source, if applicable. */
  heading: string;

  /**
   * Relevance score of the cited source (0 to 1).
   * Inherited from the highest-scoring chunk from this source.
   */
  relevanceScore: number;

  /**
   * Which retrieval method produced the cited source.
   * @see RetrievedChunk.matchType
   */
  matchType: 'vector' | 'graph' | 'research';
}

/**
 * Aggregated result of the retrieval phase across all active retrieval
 * strategies (vector search, graph traversal, deep research).
 */
export interface RetrievalResult {
  /** Retrieved content chunks, sorted by relevance (highest first). */
  chunks: RetrievedChunk[];

  /**
   * Entities discovered via knowledge graph traversal.
   * Present only when graph retrieval was used (tier >= 2).
   */
  graphEntities?: Array<{ name: string; type: string; description: string }>;

  /**
   * Synthesized narrative from the deep research phase.
   * Present only when research retrieval was used (tier 3).
   */
  researchSynthesis?: string;

  /** Wall-clock duration of the retrieval phase in milliseconds. */
  durationMs: number;
}

// ============================================================================
// CONVERSATION
// ============================================================================

/**
 * A single message in the conversation history.
 * Used for providing conversational context to the classifier and generator.
 */
export interface ConversationMessage {
  /** The role of the message author. */
  role: 'user' | 'assistant';

  /** The text content of the message. */
  content: string;
}

// ============================================================================
// QUERY RESULT
// ============================================================================

/**
 * Final result returned by the QueryRouter after classification, retrieval,
 * and answer generation.
 *
 * This surface is intentionally provenance-oriented: it includes not only the
 * generated answer and citations, but also the tier path actually exercised and
 * the fallback names that were activated during routing.
 */
export interface QueryResult {
  /** The generated answer text, grounded in retrieved sources. */
  answer: string;

  /** The classification result that determined routing behaviour. */
  classification: ClassificationResult;

  /** Citations for the sources used in generating the answer. */
  sources: SourceCitation[];

  /**
   * Synthesized narrative from the deep research phase, when tier-3 routing
   * exercised external or host-provided research.
   */
  researchSynthesis?: string;

  /** Total wall-clock duration of the entire query pipeline in milliseconds. */
  durationMs: number;

  /**
   * Which tiers were actually exercised during this query.
   * @example [0] for trivial, [1, 2] for multi-source with fallback
   */
  tiersUsed: QueryTier[];

  /**
   * Names of fallback strategies that were activated during this query.
   * Empty array if no fallbacks were needed.
   * @example ['keyword-fallback', 'tier-escalation']
   */
  fallbacksUsed: string[];

  /**
   * Citation verification results produced by the router when
   * `verifyCitations` is enabled and verification can run.
   *
   * Hosts may also attach their own grounding metadata to this field.
   */
  grounding?: import('../../../cognition/rag/citation/types.js').VerifiedResponse;

  /**
   * Recommended skills, tools, and extensions based on query analysis.
   *
   * Populated when the plan-aware classifier (`classifyWithPlan`) produces
   * capability recommendations. When no recommendations are made (or the
   * plan-aware classifier is not used), this field is `undefined`.
   *
   * Each recommendation includes a confidence score (0-1) and a human-readable
   * reasoning string explaining why the capability was recommended.
   */
  recommendations?: {
    skills: Array<{ skillId: string; reasoning: string; confidence: number }>;
    tools: Array<{ toolId: string; reasoning: string; confidence: number }>;
    extensions: Array<{ extensionId: string; reasoning: string; confidence: number }>;
  };
}

// ============================================================================
// CORPUS STATS
// ============================================================================

/**
 * Retrieval backend mode currently available to the router.
 */
export type QueryRouterRetrievalMode = 'vector+keyword-fallback' | 'keyword-only';

/**
 * Vector embedding availability state for the corpus index.
 */
export type QueryRouterEmbeddingStatus = 'active' | 'disabled-no-key' | 'failed-init';

/**
 * Runtime mode for a branch that is always available in some form.
 *
 * - `heuristic` means AgentOS is using its built-in lightweight implementation
 * - `active` means the host injected or wired a stronger runtime implementation
 */
export type QueryRouterRuntimeMode = 'placeholder' | 'heuristic' | 'active';

/**
 * Runtime mode for a branch that may also be fully disabled in config.
 */
export type QueryRouterToggleableRuntimeMode = 'disabled' | QueryRouterRuntimeMode;

/**
 * Lightweight observability snapshot for router startup logs and host health
 * checks.
 *
 * Returned by `router.getCorpusStats()` after or before initialization.
 */
export interface QueryRouterCorpusStats {
  /** Whether `init()` has completed successfully. */
  initialized: boolean;

  /** Number of configured corpus directories. */
  configuredPathCount: number;

  /** Number of loaded markdown chunks in the in-memory corpus. */
  chunkCount: number;

  /** Number of extracted topic entries used by the classifier. */
  topicCount: number;

  /** Number of unique source files represented in the loaded corpus. */
  sourceCount: number;

  /** Counts for the bundled platform knowledge corpus currently loaded in memory. */
  platformKnowledge: {
    total: number;
    tools: number;
    skills: number;
    faq: number;
    api: number;
    troubleshooting: number;
  };

  /** Whether retrieval is vector-backed or keyword-only. */
  retrievalMode: QueryRouterRetrievalMode;

  /** Whether corpus embeddings are active, missing credentials, or failed during init. */
  embeddingStatus: QueryRouterEmbeddingStatus;

  /** Embedding dimension for the active vector index, or `0` when inactive. */
  embeddingDimension: number;

  /** Whether graph expansion is enabled in config. */
  graphEnabled: boolean;

  /** Whether deep research is enabled in config. */
  deepResearchEnabled: boolean;

  /** Runtime truth for graph expansion. */
  graphRuntimeMode: QueryRouterToggleableRuntimeMode;

  /** Runtime truth for reranking. */
  rerankRuntimeMode: QueryRouterRuntimeMode;

  /** Runtime truth for deep research. */
  deepResearchRuntimeMode: QueryRouterToggleableRuntimeMode;
}

// ============================================================================
// CONFIGURATION
// ============================================================================

/**
 * Public constructor configuration for the QueryRouter pipeline.
 *
 * `knowledgeCorpus` is required. All other fields are optional and default to
 * the values in {@link DEFAULT_QUERY_ROUTER_CONFIG}.
 *
 * @example
 * ```ts
 * const router = new QueryRouter({
 *   knowledgeCorpus: ['./docs', './packages/agentos/docs'],
 *   availableTools: ['web_search', 'deep_research'],
 *   maxTier: 3,
 * });
 * ```
 */
export interface QueryRouterConfig {
  /**
   * Directories containing `.md` / `.mdx` files to ingest as the knowledge
   * corpus.
   *
   * `init()` will throw if these paths resolve to zero readable markdown
   * sections, because a successful router init should imply a non-empty corpus.
   */
  knowledgeCorpus: string[];

  /**
   * Minimum confidence threshold for accepting a classification result.
   * If confidence falls below this, the router may escalate to a higher tier.
   * @default 0.7
   */
  confidenceThreshold?: number;

  /** LLM model for the classifier. @default 'gpt-4o-mini' */
  classifierModel?: string;

  /** LLM provider for the classifier. @default 'openai' */
  classifierProvider?: string;

  /** Maximum tier the classifier may assign. @default 3 */
  maxTier?: QueryTier;

  /** Embedding provider name. @default 'openai' */
  embeddingProvider?: string;

  /** Embedding model identifier. @default 'text-embedding-3-small' */
  embeddingModel?: string;

  /** LLM model for T0/T1 generation. @default 'gpt-4o-mini' */
  generationModel?: string;

  /** LLM model for T2/T3 generation (deep). @default 'gpt-4o' */
  generationModelDeep?: string;

  /** LLM provider for generation. @default 'openai' */
  generationProvider?: string;

  /**
   * Whether to enable GraphRAG-based retrieval for tier >= 2 queries.
   * Requires a configured GraphRAG engine.
   * @default true
   */
  graphEnabled?: boolean;

  /**
   * Whether to enable deep research mode for tier 3 queries.
   * Research mode performs iterative multi-pass retrieval and synthesis.
   * @default true
   */
  deepResearchEnabled?: boolean;

  /**
   * Number of recent conversation messages to include as context
   * for classification and generation.
   * @default 5
   */
  conversationWindowSize?: number;

  /**
   * Maximum estimated tokens to allocate for documentation context.
   * @default 4000
   */
  maxContextTokens?: number;

  /**
   * Whether to cache query results.
   *
   * When enabled, `route()` caches completed `QueryResult` objects in memory
   * and reuses them for identical query/history/request-option inputs until
   * router state changes (for example corpus refresh or retriever swap).
   *
   * @default true
   */
  cacheResults?: boolean;

  /**
   * Optional tool/capability names exposed to the classifier prompt so it can
   * reason about what the runtime can actually do.
   * @default []
   */
  availableTools?: string[];

  /**
   * Optional host-provided graph expansion callback.
   *
   * Provide this to replace the built-in placeholder `graphExpand()` branch
   * with a real GraphRAG or relationship-expansion implementation.
   */
  graphExpand?: (seedChunks: RetrievedChunk[]) => Promise<RetrievedChunk[]>;

  /**
   * Optional host-provided reranker callback.
   *
   * Provide this to replace the built-in lexical heuristic reranker with a
   * provider-backed or cross-encoder reranker.
   */
  rerank?: (
    query: string,
    chunks: RetrievedChunk[],
    topN: number,
  ) => Promise<RetrievedChunk[]>;

  /**
   * Enable post-generation citation verification when the router has an active
   * embedding path and retrieved source chunks.
   *
   * When enabled, `route()` runs `CitationVerifier` over the generated answer
   * and retrieved sources, then attaches the result to `QueryResult.grounding`.
   * If embeddings are unavailable or no sources were retrieved, verification is
   * skipped gracefully.
   */
  verifyCitations?: boolean;

  /**
   * Optional host-provided deep research callback.
   *
   * Provide this to replace the built-in placeholder research branch with a
   * real multi-source research runtime. The `sources` argument receives
   * normalized research-source hints such as `web`, `docs`, or `media`,
   * not raw classifier retrieval labels.
   */
  deepResearch?: (
    query: string,
    sources: string[],
  ) => Promise<{ synthesis: string; sources: RetrievedChunk[] }>;

  /**
   * Hook called after classification completes.
   * Receives the ClassificationResult for consumer integration.
   */
  onClassification?: (result: ClassificationResult) => void;

  /**
   * Hook called after retrieval completes.
   * Receives the RetrievalResult for consumer integration.
   */
  onRetrieval?: (result: RetrievalResult) => void;

  /**
   * Optional API key override for classifier and generator LLM calls.
   *
   * When omitted, QueryRouter prefers `OPENAI_API_KEY` and falls back to
   * `OPENROUTER_API_KEY` with the OpenRouter compatibility base URL.
   */
  apiKey?: string;

  /**
   * Optional base URL override for classifier and generator LLM providers.
   *
   * When omitted, QueryRouter auto-selects the OpenRouter compatibility URL
   * only when `OPENROUTER_API_KEY` is being used implicitly.
   */
  baseUrl?: string;

  /**
   * Optional API key override for embeddings only.
   *
   * When omitted, embeddings fall back to `apiKey`, then `OPENAI_API_KEY`,
   * then `OPENROUTER_API_KEY`.
   * This is useful when generation uses an OpenAI-compatible endpoint like
   * OpenRouter but embeddings should stay on a direct OpenAI key.
   */
  embeddingApiKey?: string;

  /**
   * Optional base URL override for embeddings only.
   *
   * When omitted, embeddings inherit `baseUrl` unless `embeddingApiKey` is
   * explicitly set, in which case the embedding path assumes the provider's
   * default endpoint. If neither override is set and QueryRouter falls back to
   * `OPENROUTER_API_KEY`, it automatically uses the OpenRouter compatibility
   * URL for embeddings as well.
   */
  embeddingBaseUrl?: string;

  /**
   * Configuration for background GitHub repository indexing.
   *
   * When provided, the router will asynchronously index GitHub repos after
   * `init()` completes and merge the resulting chunks into the corpus.
   */
  githubRepos?: RepoIndexConfig;

  /**
   * Retrieval strategy configuration for the HyDE-aware query router.
   *
   * Controls how the classifier selects between `none`, `simple`, `moderate`
   * (HyDE), and `complex` (HyDE + decompose) retrieval strategies.
   *
   * @see QueryRouterStrategyConfig
   */
  strategyConfig?: QueryRouterStrategyConfig;

  /**
   * Load bundled platform knowledge (tools, skills, FAQ, API reference,
   * troubleshooting) into the corpus during `init()`.
   *
   * When enabled, the router ships with instant knowledge about every
   * AgentOS capability — no external docs required for platform questions.
   *
   * @default true
   */
  includePlatformKnowledge?: boolean;
}

/**
 * Optional per-request overrides for QueryRouter classification and routing.
 */
export interface QueryRouterRequestOptions {
  /**
   * Skill capability IDs or aliases to suppress from capability-summary prompts
   * and plan-aware capability recommendations for this request.
   */
  excludedCapabilityIds?: string[];
}

/**
 * Configuration for GitHub repo indexing in QueryRouter.
 *
 * Controls which repositories are indexed in the background after `init()`
 * and merged into the knowledge corpus for retrieval.
 */
export interface RepoIndexConfig {
  /** Repos to index. Defaults to ecosystem repos when includeEcosystem is true. */
  repos?: Array<{ owner: string; repo: string }>;
  /** Include AgentOS ecosystem repos. @default true */
  includeEcosystem?: boolean;
  /** GitHub PAT for private repos and higher rate limits. Falls back to GITHUB_TOKEN env. */
  token?: string;
  /** Max doc files to fetch per repo. @default 50 */
  maxFilesPerRepo?: number;
}

// ============================================================================
// STRATEGY CONFIGURATION
// ============================================================================

/**
 * Classifier mode that controls how the retrieval strategy is decided.
 *
 * - `'llm'`       — Use the LLM-as-judge classifier exclusively. Requires an
 *                   LLM API key. Falls back to heuristic on LLM failure.
 * - `'heuristic'` — Use the rule-based heuristic classifier only. No LLM call
 *                   overhead; suitable for offline / cost-constrained scenarios.
 * - `'hybrid'`    — Run both classifiers; prefer the LLM result when available,
 *                   fall back to heuristic on error. This is the default mode.
 */
export type ClassifierMode = 'llm' | 'heuristic' | 'hybrid';

/**
 * Configuration for the HyDE-aware retrieval strategy classifier.
 *
 * This config controls how the {@link QueryRouter} decides between `none`,
 * `simple`, `moderate` (HyDE), and `complex` (HyDE + decompose) retrieval
 * pipelines for each incoming query.
 *
 * @example
 * ```typescript
 * const router = new QueryRouter({
 *   knowledgeCorpus: ['./docs'],
 *   strategyConfig: {
 *     classifierMode: 'hybrid',
 *     defaultStrategy: 'simple',
 *   },
 * });
 * ```
 */
export interface QueryRouterStrategyConfig {
  /**
   * Default strategy when the classifier is unavailable or fails.
   *
   * When classification produces no result (LLM down, heuristic indeterminate),
   * this fallback strategy is used instead of stalling the pipeline.
   *
   * @default 'simple'
   */
  defaultStrategy?: RetrievalStrategy;

  /**
   * Force a specific strategy, bypassing the classifier entirely.
   *
   * When set, every query uses this strategy regardless of complexity.
   * Useful for testing, debugging, or cost-constrained environments.
   *
   * @default undefined (auto-classify)
   */
  forceStrategy?: RetrievalStrategy;

  /**
   * How the classifier selects the retrieval strategy.
   *
   * @default 'hybrid'
   * @see ClassifierMode
   */
  classifierMode?: ClassifierMode;

  /**
   * LLM model identifier for the strategy classifier.
   *
   * Overrides the top-level `classifierModel` for the strategy-selection
   * prompt only. Useful when you want a cheaper model for tier classification
   * but a more capable one for strategy selection (or vice versa).
   *
   * @default undefined (inherits top-level classifierModel)
   */
  classifierModel?: string;

  /**
   * Maximum number of sub-queries when decomposing a `complex` query.
   *
   * The decomposition LLM call is instructed to produce at most this many
   * sub-queries. Higher values improve coverage but increase latency and cost.
   *
   * @default 5
   */
  maxSubQueries?: number;
}

/**
 * Default values for {@link QueryRouterStrategyConfig}.
 */
export const DEFAULT_STRATEGY_CONFIG: Required<Omit<QueryRouterStrategyConfig, 'forceStrategy' | 'classifierModel'>> & {
  forceStrategy: undefined;
  classifierModel: undefined;
} = {
  defaultStrategy: 'simple',
  forceStrategy: undefined,
  classifierMode: 'hybrid',
  classifierModel: undefined,
  maxSubQueries: 5,
};

/**
 * Default configuration values for the QueryRouter.
 * @see QueryRouterConfig
 */
/**
 * Resolve the default provider dynamically from environment.
 *
 * Priority: autoDetectProvider() → 'openai' fallback.
 * Supports all 16 AgentOS providers including CLI (claude-code-cli, gemini-cli).
 */
function resolveDefaultProvider(): string {
  try {
    // Lazy check env vars in priority order (same as autoDetectProvider but synchronous)
    const envMap: ReadonlyArray<readonly [string, string]> = [
      ['OPENROUTER_API_KEY', 'openrouter'],
      ['OPENAI_API_KEY', 'openai'],
      ['ANTHROPIC_API_KEY', 'anthropic'],
      ['GEMINI_API_KEY', 'gemini'],
      ['GROQ_API_KEY', 'groq'],
      ['TOGETHER_API_KEY', 'together'],
      ['MISTRAL_API_KEY', 'mistral'],
      ['XAI_API_KEY', 'xai'],
    ];
    for (const [envKey, id] of envMap) {
      if (process.env[envKey]) return id;
    }
  } catch {
    // Browser or restricted env — fall back
  }
  return 'openai';
}

/** Provider → cheap model mapping for classifier/T0-T1 generation. */
const CHEAP_MODELS: Record<string, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-haiku-4-5-20251001',
  openrouter: 'openai/gpt-4o-mini',
  gemini: 'gemini-2.0-flash',
  groq: 'gemma2-9b-it',
  together: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo',
  mistral: 'mistral-small-latest',
  xai: 'grok-2-mini',
  ollama: 'llama3.2',
  'claude-code-cli': 'claude-haiku-4-5-20251001',
  'gemini-cli': 'gemini-2.0-flash-lite',
};

/** Provider → strong model mapping for T2/T3 deep generation. */
const STRONG_MODELS: Record<string, string> = {
  openai: 'gpt-4o',
  anthropic: 'claude-sonnet-4-20250514',
  openrouter: 'openai/gpt-4o',
  gemini: 'gemini-2.5-flash',
  groq: 'llama-3.3-70b-versatile',
  together: 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo',
  mistral: 'mistral-large-latest',
  xai: 'grok-2',
  ollama: 'llama3.2',
  'claude-code-cli': 'claude-sonnet-4-20250514',
  'gemini-cli': 'gemini-2.5-flash',
};

export const DEFAULT_QUERY_ROUTER_CONFIG = {
  confidenceThreshold: 0.7,
  classifierModel: CHEAP_MODELS[resolveDefaultProvider()] ?? 'gpt-4o-mini',
  classifierProvider: resolveDefaultProvider(),
  maxTier: 3 as QueryTier,
  embeddingProvider: resolveDefaultProvider(),
  embeddingModel: 'text-embedding-3-small',
  generationModel: CHEAP_MODELS[resolveDefaultProvider()] ?? 'gpt-4o-mini',
  generationModelDeep: STRONG_MODELS[resolveDefaultProvider()] ?? 'gpt-4o',
  generationProvider: resolveDefaultProvider(),
  graphEnabled: true,
  deepResearchEnabled: Boolean(process.env.SERPER_API_KEY),
  conversationWindowSize: 5,
  maxContextTokens: 4000,
  cacheResults: true,
  availableTools: [] as string[],
  includePlatformKnowledge: true,
  verifyCitations: false,
} satisfies Omit<
  Required<QueryRouterConfig>,
  | 'knowledgeCorpus'
  | 'graphExpand'
  | 'rerank'
  | 'deepResearch'
  | 'onClassification'
  | 'onRetrieval'
  | 'apiKey'
  | 'baseUrl'
  | 'embeddingApiKey'
  | 'embeddingBaseUrl'
  | 'githubRepos'
  | 'strategyConfig'
>;

// ============================================================================
// EVENTS — Observability lifecycle events
// ============================================================================

/**
 * Emitted when query classification begins.
 */
export interface ClassifyStartEvent {
  type: 'classify:start';
  /** The raw user query being classified. */
  query: string;
  /** Timestamp when classification started. */
  timestamp: number;
}

/**
 * Emitted when query classification completes successfully.
 */
export interface ClassifyCompleteEvent {
  type: 'classify:complete';
  /** The classification result. */
  result: ClassificationResult;
  /** Duration of classification in milliseconds. */
  durationMs: number;
  /** Timestamp when classification completed. */
  timestamp: number;
}

/**
 * Emitted when query classification fails.
 */
export interface ClassifyErrorEvent {
  type: 'classify:error';
  /** The error that caused classification to fail. */
  error: Error;
  /** Timestamp when the error occurred. */
  timestamp: number;
}

/**
 * Emitted when the retrieval phase begins.
 */
export interface RetrieveStartEvent {
  type: 'retrieve:start';
  /** The assigned tier driving retrieval strategy. */
  tier: QueryTier;
  /** Timestamp when retrieval started. */
  timestamp: number;
}

/**
 * Emitted when vector search results are available.
 */
export interface RetrieveVectorEvent {
  type: 'retrieve:vector';
  /** Number of chunks returned by vector search. */
  chunkCount: number;
  /** Duration of vector retrieval in milliseconds. */
  durationMs: number;
  /** Timestamp of the event. */
  timestamp: number;
}

/**
 * Emitted when graph traversal results are available.
 */
export interface RetrieveGraphEvent {
  type: 'retrieve:graph';
  /** Number of entities discovered via graph traversal. */
  entityCount: number;
  /** Duration of graph retrieval in milliseconds. */
  durationMs: number;
  /** Timestamp of the event. */
  timestamp: number;
}

/**
 * Emitted when reranking of retrieved chunks completes.
 */
export interface RetrieveRerankEvent {
  type: 'retrieve:rerank';
  /** Number of chunks before reranking. */
  inputCount: number;
  /** Number of chunks after reranking (may be fewer due to threshold filtering). */
  outputCount: number;
  /** Duration of reranking in milliseconds. */
  durationMs: number;
  /** Timestamp of the event. */
  timestamp: number;
}

/**
 * Emitted when the entire retrieval phase completes.
 */
export interface RetrieveCompleteEvent {
  type: 'retrieve:complete';
  /** The aggregated retrieval result. */
  result: RetrievalResult;
  /** Timestamp when retrieval completed. */
  timestamp: number;
}

/**
 * Emitted when a retrieval fallback strategy is activated.
 */
export interface RetrieveFallbackEvent {
  type: 'retrieve:fallback';
  /** Name of the fallback strategy activated (e.g., 'keyword-fallback'). */
  strategy: string;
  /** Reason the fallback was triggered. */
  reason: string;
  /** Timestamp of the event. */
  timestamp: number;
}

/**
 * Emitted when deep research begins (tier 3 only).
 */
export interface ResearchStartEvent {
  type: 'research:start';
  /** The original query being researched. */
  query: string;
  /** Maximum number of research iterations configured. */
  maxIterations: number;
  /** Timestamp when research started. */
  timestamp: number;
}

/**
 * Emitted after each iteration of the research loop.
 */
export interface ResearchPhaseEvent {
  type: 'research:phase';
  /** Current iteration number (1-based). */
  iteration: number;
  /** Total configured iterations. */
  totalIterations: number;
  /** Number of new chunks discovered in this iteration. */
  newChunksFound: number;
  /** Timestamp of the event. */
  timestamp: number;
}

/**
 * Emitted when deep research completes.
 */
export interface ResearchCompleteEvent {
  type: 'research:complete';
  /** Total number of research iterations performed. */
  iterationsUsed: number;
  /** Total chunks gathered across all iterations. */
  totalChunks: number;
  /** Duration of the research phase in milliseconds. */
  durationMs: number;
  /** Timestamp when research completed. */
  timestamp: number;
}

/**
 * Emitted when answer generation begins.
 */
export interface GenerateStartEvent {
  type: 'generate:start';
  /** Number of context chunks provided to the generator. */
  contextChunkCount: number;
  /** Timestamp when generation started. */
  timestamp: number;
}

/**
 * Emitted when answer generation completes.
 */
export interface GenerateCompleteEvent {
  type: 'generate:complete';
  /** Length of the generated answer in characters. */
  answerLength: number;
  /** Number of source citations in the answer. */
  citationCount: number;
  /** Duration of generation in milliseconds. */
  durationMs: number;
  /** Timestamp when generation completed. */
  timestamp: number;
}

/**
 * Emitted when the entire query routing pipeline completes.
 */
export interface RouteCompleteEvent {
  type: 'route:complete';
  /** The final query result. */
  result: QueryResult;
  /** Total duration of the entire pipeline in milliseconds. */
  durationMs: number;
  /** Timestamp when routing completed. */
  timestamp: number;
}

/**
 * Emitted when background GitHub repository indexing begins.
 */
export interface GitHubIndexStartEvent {
  type: 'github:index:start';
  /** Full `owner/repo` slug being indexed. */
  repo: string;
  /** Estimated number of doc files that will be fetched. */
  filesEstimated: number;
  /** Timestamp when indexing started. */
  timestamp: number;
}

/**
 * Emitted when a single GitHub repository has been indexed successfully.
 */
export interface GitHubIndexCompleteEvent {
  type: 'github:index:complete';
  /** Full `owner/repo` slug that was indexed. */
  repo: string;
  /** Total number of chunks extracted from the repository. */
  chunksTotal: number;
  /** Wall-clock duration of the indexing run in milliseconds. */
  durationMs: number;
  /** Timestamp when indexing completed. */
  timestamp: number;
}

/**
 * Emitted when indexing a GitHub repository fails.
 */
export interface GitHubIndexErrorEvent {
  type: 'github:index:error';
  /** Full `owner/repo` slug that failed to index. */
  repo: string;
  /** Error message describing the failure. */
  error: string;
  /** Timestamp when the error occurred. */
  timestamp: number;
}

/**
 * Emitted when the retrieval strategy has been selected for a query.
 *
 * Fires after classification but before dispatch, giving observers visibility
 * into which retrieval path was chosen and why (LLM decision, heuristic,
 * force-override, or fallback).
 */
export interface StrategySelectEvent {
  type: 'strategy:select';
  /** The selected retrieval strategy. */
  strategy: RetrievalStrategy;
  /**
   * How the strategy was determined.
   * - `'llm'`       — LLM classifier chose this strategy.
   * - `'heuristic'` — Rule-based heuristic chose this strategy.
   * - `'forced'`    — `forceStrategy` override was active.
   * - `'fallback'`  — Both classifiers failed; using defaultStrategy.
   */
  source: 'llm' | 'heuristic' | 'forced' | 'fallback';
  /** The query tier this strategy maps to. */
  tier: QueryTier;
  /** Timestamp of the event. */
  timestamp: number;
}

/**
 * Emitted when a complex query is decomposed into sub-queries.
 */
export interface DecomposeEvent {
  type: 'strategy:decompose';
  /** The original user query. */
  originalQuery: string;
  /** The generated sub-queries. */
  subQueries: string[];
  /** Duration of the decomposition LLM call in milliseconds. */
  durationMs: number;
  /** Timestamp of the event. */
  timestamp: number;
}

/**
 * Emitted when the execution plan recommends activating capabilities
 * (skills, tools, or extensions) for the current query.
 *
 * The router emits this event after classification to signal which
 * capabilities should be made available. The agent runtime is
 * responsible for deciding which recommendations to honor — the
 * router only recommends, it does not activate.
 *
 * @see ExecutionPlan
 */
export interface CapabilitiesActivateEvent {
  type: 'capabilities:activate';
  /** Recommended skills to activate (sorted by priority). */
  skills: SkillRecommendation[];
  /** Recommended tools to make available (sorted by priority). */
  tools: ToolRecommendation[];
  /** Recommended extensions to load (sorted by priority). */
  extensions: ExtensionRecommendation[];
  /** Timestamp when the recommendation was produced. */
  timestamp: number;
}

/**
 * Discriminated union of all QueryRouter lifecycle events.
 * The `type` field serves as the discriminant for exhaustive matching.
 *
 * @example
 * ```typescript
 * function handleEvent(event: QueryRouterEventUnion) {
 *   switch (event.type) {
 *     case 'classify:start':
 *       console.log(`Classifying: ${event.query}`);
 *       break;
 *     case 'retrieve:vector':
 *       console.log(`Vector search returned ${event.chunkCount} chunks`);
 *       break;
 *     case 'capabilities:activate':
 *       console.log(`Activating ${event.skills.length} skills, ${event.tools.length} tools`);
 *       break;
 *     case 'route:complete':
 *       console.log(`Done in ${event.durationMs}ms`);
 *       break;
 *   }
 * }
 * ```
 */
export type QueryRouterEventUnion =
  | ClassifyStartEvent
  | ClassifyCompleteEvent
  | ClassifyErrorEvent
  | CapabilitiesActivateEvent
  | RetrieveStartEvent
  | RetrieveVectorEvent
  | RetrieveGraphEvent
  | RetrieveRerankEvent
  | RetrieveCompleteEvent
  | RetrieveFallbackEvent
  | ResearchStartEvent
  | ResearchPhaseEvent
  | ResearchCompleteEvent
  | GenerateStartEvent
  | GenerateCompleteEvent
  | RouteCompleteEvent
  | StrategySelectEvent
  | DecomposeEvent
  | GitHubIndexStartEvent
  | GitHubIndexCompleteEvent
  | GitHubIndexErrorEvent;

// ============================================================================
// CORPUS DATA STRUCTURES
// ============================================================================

/**
 * A chunk of corpus content with optional pre-computed embedding.
 * Used during corpus ingestion into the vector store.
 */
export interface CorpusChunk {
  /** Unique identifier for the chunk. */
  id: string;

  /** The text content of the chunk. */
  content: string;

  /** Section heading or title the chunk belongs to. */
  heading: string;

  /** File path or document source path this chunk was extracted from. */
  sourcePath: string;

  /**
   * Pre-computed embedding vector. When present, the ingestion pipeline
   * can skip embedding generation for this chunk.
   */
  embedding?: number[];
}

/**
 * A topic extracted from a query or document for routing and filtering.
 * Used by the {@link TopicExtractor} to guide retrieval strategy.
 */
export interface TopicEntry {
  /** The topic name or phrase (e.g., "authentication", "database migrations"). */
  name: string;

  /**
   * Where this topic was derived from.
   * @example 'query', 'document', 'graph-entity'
   */
  source: string;
}
