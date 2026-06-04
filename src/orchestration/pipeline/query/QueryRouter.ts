/**
 * @fileoverview QueryRouter — one-call grounded Q&A pipeline.
 *
 * @module @framers/agentos/query-router/QueryRouter
 *
 * Point a `QueryRouter` at one or more markdown directories, call
 * `route(question)`, and get back a fully-attributed answer:
 *
 * ```ts
 * const router = new QueryRouter({ knowledgeCorpus: ['./docs'] });
 * await router.init();
 * const result = await router.route('how do I configure a guardrail?');
 * //   result.answer          — grounded answer text
 * //   result.sources         — citations with title, URI, and snippet
 * //   result.classification  — { tier, strategy, confidence, reasoning }
 * //   result.tiersUsed       — which tiers actually fired
 * //   result.grounding       — per-claim verdicts when verifyCitations is on
 * ```
 *
 * Use it when you're building an in-product "ask the docs" feature, a support
 * copilot that answers from internal runbooks, an agent tool that needs to
 * ground responses in a specific corpus, or any other surface where you'd
 * otherwise hand-wire chunker + vector store + classifier + retriever + LLM
 * call + citation collector.
 *
 * Each `route()` call runs three stages in sequence:
 *
 * 1. **Classify** — {@link QueryClassifier} assigns a complexity tier
 *    (T0 trivial → T3 deep research) using an LLM prompt that sees the corpus
 *    topics, recent conversation history, and any registered tool names.
 * 2. **Dispatch** — {@link QueryDispatcher} retrieves only as much context as
 *    the tier requires: nothing for T0, vector search for T1, HyDE for T2,
 *    multi-source decomposition + reranking for T3.
 * 3. **Generate** — {@link QueryGenerator} produces a grounded answer from
 *    the retrieved chunks, attaching `SourceCitation[]` entries that point
 *    back at the source documents.
 *
 * Operational behaviour:
 * - Corpus loading from markdown files on disk (with the bundled 260-entry
 *   platform knowledge corpus merged in automatically)
 * - Vector embedding via EmbeddingManager + VectorStoreManager (in-memory by
 *   default; swap for Postgres pgvector or Qdrant in production)
 * - Graceful degradation to {@link KeywordFallback} when no embedding API key
 *   is configured — the router never fails for missing keys, it just labels
 *   the fallback in `result.fallbacksUsed`
 * - Event emission for full pipeline observability
 * - Lifecycle hooks (`onClassification`, `onRetrieval`) for consumer integration
 * - Optional post-generation citation verification via `verifyCitations: true`
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { QueryClassifier, heuristicClassify } from './QueryClassifier.js';
import { QueryDispatcher } from './QueryDispatcher.js';
import { QueryGenerator } from './QueryGenerator.js';
import { TopicExtractor } from './TopicExtractor.js';
import { KeywordFallback } from './KeywordFallback.js';
import { CitationVerifier } from '../../../cognition/rag/citation/CitationVerifier.js';
import {
  DEFAULT_QUERY_ROUTER_CONFIG,
  DEFAULT_STRATEGY_CONFIG,
  STRATEGY_TO_TIER,
  TIER_TO_STRATEGY,
} from './types.js';
import type {
  ClassificationResult,
  ClassifierMode,
  ConversationMessage,
  CorpusChunk,
  QueryResult,
  QueryRouterCorpusStats,
  QueryRouterConfig,
  QueryRouterEmbeddingStatus,
  QueryRouterEventUnion,
  QueryRouterRequestOptions,
  QueryRouterStrategyConfig,
  QueryTier,
  RetrievalResult,
  RetrievalStrategy,
  RetrievedChunk,
  SourceCitation,
  TopicEntry,
} from './types.js';
import type { VerifiedResponse, VerificationSource } from '../../../cognition/rag/citation/types.js';

// RAG module types — imported as types to keep the dependency graph light.
// The actual classes are dynamically imported in init() to stay optional.
import type { EmbeddingManager } from '../../../cognition/rag/EmbeddingManager.js';
import type { VectorStoreManager } from '../../../cognition/rag/VectorStoreManager.js';
import type { AIModelProviderManager } from '../../../core/llm/providers/AIModelProviderManager.js';
import type { VectorDocument } from '../../../core/vector-store/IVectorStore.js';

// ============================================================================
// Configuration
// ============================================================================

type QueryRouterResolvedConfig = Omit<
  Required<QueryRouterConfig>,
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
  | 'verifyCitations'
> &
  Pick<
    QueryRouterConfig,
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
    | 'verifyCitations'
  > & {
    /** Resolved strategy configuration with defaults applied. */
    strategyConfig: Required<Omit<QueryRouterStrategyConfig, 'forceStrategy' | 'classifierModel'>> & {
      forceStrategy: RetrievalStrategy | undefined;
      classifierModel: string | undefined;
    };
  };

/** Regex for splitting markdown by h1-h3 headings. */
const HEADING_REGEX = /^#{1,3}\s+(.+)/;

/** Maximum character length for a single corpus chunk. */
const MAX_CHUNK_CHARS = 6000;

/** Minimum content length for a chunk to be included. */
const MIN_CHUNK_CHARS = 20;

/** Supported markdown file extensions for corpus loading. */
const MARKDOWN_EXTENSIONS = new Set(['.md', '.mdx']);
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const GITHUB_EXTENSION_LOCAL_ENTRY_CANDIDATES = [
  resolve(
    MODULE_DIR,
    '../../../../packages/agentos-extensions/registry/curated/integrations/github/dist/index.js',
  ),
  resolve(
    MODULE_DIR,
    '../../../../apps/wunderland-sol/packages/agentos-extensions/registry/curated/integrations/github/dist/index.js',
  ),
];

interface GitHubExtensionModule {
  GitHubRepoIndexer: new (service: unknown) => {
    indexEcosystem(): Promise<
      Array<{
        repo: string;
        chunks: Array<{ heading: string; content: string; sourcePath: string }>;
        durationMs: number;
      }>
    >;
    indexRepo(
      owner: string,
      repo: string,
    ): Promise<{
      repo: string;
      chunks: Array<{ heading: string; content: string; sourcePath: string }>;
      durationMs: number;
    }>;
  };
  GitHubService: new (token: string) => {
    initialize(): Promise<void>;
  };
}

// ============================================================================
// QueryRouter
// ============================================================================

/**
 * Main orchestrator that wires together the QueryClassifier, QueryDispatcher,
 * and QueryGenerator into a complete classify -> dispatch -> generate pipeline.
 *
 * @example
 * ```typescript
 * const router = new QueryRouter({
 *   knowledgeCorpus: ['./docs'],
 *   generationModel: 'gpt-4o-mini',
 *   generationModelDeep: 'gpt-4o',
 *   generationProvider: 'openai',
 * });
 *
 * await router.init();
 * const result = await router.route('How does authentication work?');
 * console.log(result.answer);
 * console.log(result.sources);
 *
 * await router.close();
 * ```
 */
export class QueryRouter {
  /** Resolved configuration with defaults applied. */
  private readonly config: QueryRouterResolvedConfig;

  /** Loaded corpus chunks from disk. */
  private corpus: CorpusChunk[] = [];

  /** Topic entries extracted from the corpus. */
  private topics: TopicEntry[] = [];

  /** Keyword-based fallback search engine. */
  private keywordFallback: KeywordFallback | null = null;

  /** Chain-of-thought query classifier. */
  private classifier: QueryClassifier | null = null;

  /**
   * Optional capability discovery engine persisted across classifier rebuilds.
   *
   * The router recreates its classifier during `init()` and when background
   * GitHub indexing refreshes the topic list. Persist the attached discovery
   * engine so those classifier rebuilds do not silently drop capability-aware
   * planning.
   */
  private capabilityDiscoveryEngine:
    import('../../../cognition/discovery/CapabilityDiscoveryEngine.js').CapabilityDiscoveryEngine | null = null;

  /** Tier-routing dispatcher. */
  private dispatcher: QueryDispatcher | null = null;

  /** LLM answer generator. */
  private generator: QueryGenerator | null = null;

  /** Accumulated lifecycle events for observability. */
  private events: QueryRouterEventUnion[] = [];

  /** In-memory cache for completed route() results. */
  private routeResultCache = new Map<string, QueryResult>();

  /** Whether init() has been called successfully. */
  private initialized = false;

  /** Embedding manager for generating vector embeddings. Null if not available. */
  private embeddingManager: EmbeddingManager | null = null;

  /** Vector store manager for persisting and querying embeddings. Null if not available. */
  private vectorStoreManager: VectorStoreManager | null = null;

  /** AI model provider manager used by the embedding manager. Null if not available. */
  private providerManager: AIModelProviderManager | null = null;

  /** Embedding dimension for the configured model. Zero if embeddings unavailable. */
  private embeddingDimension = 0;

  /** Current embedding availability state for corpus retrieval. */
  private embeddingStatus: QueryRouterEmbeddingStatus = 'disabled-no-key';

  /**
   * Optional UnifiedRetriever for plan-based retrieval.
   *
   * When set via {@link setUnifiedRetriever}, the `route()` method uses
   * the UnifiedRetriever instead of the legacy QueryDispatcher for the
   * retrieval phase. The UnifiedRetriever executes a structured
   * {@link RetrievalPlan} across all available sources in parallel.
   *
   * @see setUnifiedRetriever
   */
  private unifiedRetriever: import('../../../cognition/rag/unified/UnifiedRetriever.js').UnifiedRetriever | null = null;

  /**
   * The data source ID used for corpus embeddings in the vector store.
   * Matches the collection name configured during init().
   */
  private readonly corpusDataSourceId = 'query-router-corpus';

  /**
   * Creates a new QueryRouter instance.
   *
   * Merges user-supplied configuration over {@link QUERY_ROUTER_DEFAULTS}.
   * The router is NOT ready to use until {@link init} is called.
   *
   * @param config - Partial configuration; `knowledgeCorpus` is required.
   */
  constructor(config: QueryRouterConfig) {
    this.config = {
      ...DEFAULT_QUERY_ROUTER_CONFIG,
      ...config,
      deepResearchEnabled: config.deepResearchEnabled ?? Boolean(process.env.SERPER_API_KEY),
      availableTools: config.availableTools ?? [...DEFAULT_QUERY_ROUTER_CONFIG.availableTools],
      strategyConfig: {
        ...DEFAULT_STRATEGY_CONFIG,
        ...config.strategyConfig,
      },
    };
  }

  // ==========================================================================
  // UNIFIED RETRIEVER INTEGRATION
  // ==========================================================================

  /**
   * Attach a {@link UnifiedRetriever} for plan-based retrieval.
   *
   * When set, the `route()` method uses the UnifiedRetriever instead of
   * the legacy QueryDispatcher for the retrieval phase. The classifier
   * automatically produces a {@link RetrievalPlan} via `classifyWithPlan()`
   * and the retriever executes it across all available sources in parallel.
   *
   * Pass `null` to revert to the legacy QueryDispatcher pipeline.
   *
   * @param retriever - A configured UnifiedRetriever instance, or `null` to disable.
   *
   * @example
   * ```typescript
   * const retriever = new UnifiedRetriever({
   *   hybridSearcher, raptorTree, graphEngine, memoryManager,
   * });
   * router.setUnifiedRetriever(retriever);
   * // Now route() uses plan-based retrieval automatically
   * ```
   */
  setUnifiedRetriever(
    retriever: import('../../../cognition/rag/unified/UnifiedRetriever.js').UnifiedRetriever | null,
  ): void {
    this.unifiedRetriever = retriever;
    this.clearRouteResultCache();
  }

  /**
   * Get the attached UnifiedRetriever, or `null` if not configured.
   *
   * @returns The UnifiedRetriever instance, or `null`.
   */
  getUnifiedRetriever(): import('../../../cognition/rag/unified/UnifiedRetriever.js').UnifiedRetriever | null {
    return this.unifiedRetriever;
  }

  // ==========================================================================
  // CAPABILITY DISCOVERY INTEGRATION
  // ==========================================================================

  /**
   * Attach a {@link CapabilityDiscoveryEngine} for capability-aware classification.
   *
   * When set, the classifier injects Tier 0 capability summaries (~150 tokens)
   * into its LLM prompt, enabling it to recommend which skills, tools, and
   * extensions should be activated for each query. The recommendations are
   * included in the {@link ExecutionPlan} returned by `classifyWithPlan()`.
   *
   * Pass `null` to detach and revert to keyword-based heuristic capability
   * selection.
   *
   * @param engine - A configured and initialized CapabilityDiscoveryEngine, or `null` to detach.
   *
   * @example
   * ```typescript
   * const engine = new CapabilityDiscoveryEngine(embeddingManager, vectorStore);
   * await engine.initialize({ tools, skills, extensions, channels });
   * router.setCapabilityDiscoveryEngine(engine);
   * // Now route() includes skill/tool/extension recommendations in the execution plan
   * ```
   */
  setCapabilityDiscoveryEngine(
    engine: import('../../../cognition/discovery/CapabilityDiscoveryEngine.js').CapabilityDiscoveryEngine | null,
  ): void {
    this.capabilityDiscoveryEngine = engine;
    if (this.classifier) {
      this.classifier.setCapabilityDiscoveryEngine(engine);
    }
    this.clearRouteResultCache();
  }

  // ==========================================================================
  // PUBLIC API
  // ==========================================================================

  /**
   * Initialise the router: load corpus from disk, extract topics, build
   * keyword fallback index, embed the corpus into a vector store, and
   * instantiate classifier/dispatcher/generator.
   *
   * Must be called before `classify()`, `retrieve()`, or `route()`.
   *
   * The embedding step uses real EmbeddingManager + VectorStoreManager when
   * an LLM provider is available (e.g., OPENAI_API_KEY is set). If embedding
   * initialisation fails for any reason, the router falls back gracefully to
   * KeywordFallback for all retrieval.
   */
  async init(): Promise<void> {
    // 1. Load corpus chunks from the configured knowledge directories
    this.corpus = this.loadCorpus(this.config.knowledgeCorpus);

    // 1b. Load bundled platform knowledge (tools, skills, FAQ, API, troubleshooting)
    if (this.config.includePlatformKnowledge !== false) {
      const platformChunks = this.loadPlatformKnowledge();
      if (platformChunks.length > 0) {
        this.corpus.push(...platformChunks);
      }
    }

    if (this.corpus.length === 0) {
      throw new Error(this.buildEmptyCorpusError(this.config.knowledgeCorpus));
    }

    // 2. Extract topics for the classifier's system prompt
    const topicExtractor = new TopicExtractor();
    this.topics = topicExtractor.extract(this.corpus);
    const topicList = topicExtractor.formatForPrompt(this.topics);

    // 3. Build keyword fallback index
    this.keywordFallback = new KeywordFallback(this.corpus);

    // 4. Attempt to embed corpus chunks into a real vector store.
    //    This is wrapped in a try/catch so failure is non-fatal — keyword
    //    fallback will still work for all retrieval operations.
    await this.embedCorpus();

    // 5. Instantiate the classifier
    this.classifier = this.createClassifier(topicList);

    // 6. Instantiate the generator
    this.generator = new QueryGenerator({
      model: this.config.generationModel,
      modelDeep: this.config.generationModelDeep,
      provider: this.config.generationProvider,
      apiKey: this.getLlmApiKey(),
      baseUrl: this.getLlmBaseUrl(),
      maxContextTokens: this.config.maxContextTokens,
    });

    // 7. Instantiate the dispatcher with callback dependencies
    this.dispatcher = new QueryDispatcher({
      vectorSearch: (query: string, topK: number) => this.vectorSearch(query, topK),
      hydeSearch: (query: string, topK: number) => this.hydeSearch(query, topK),
      decompose: (query: string, maxSubQueries: number) => this.decomposeQuery(query, maxSubQueries),
      graphExpand: (seeds: RetrievedChunk[]) =>
        this.config.graphExpand ? this.config.graphExpand(seeds) : this.graphExpand(seeds),
      rerank: (query: string, chunks: RetrievedChunk[], topN: number) =>
        this.config.rerank
          ? this.config.rerank(query, chunks, topN)
          : this.rerank(query, chunks, topN),
      deepResearch: (query: string, sources: string[]) =>
        this.config.deepResearch
          ? this.config.deepResearch(query, sources)
          : this.deepResearch(query, sources),
      emit: (event: QueryRouterEventUnion) => this.emit(event),
      graphEnabled: this.config.graphEnabled,
      deepResearchEnabled: this.config.deepResearchEnabled,
      maxSubQueries: this.config.strategyConfig.maxSubQueries,
    });

    this.initialized = true;

    // ----------------------------------------------------------------
    // Background GitHub repo indexing (non-blocking, opt-in)
    // ----------------------------------------------------------------
    // Runs after the router is fully initialized so that query routing
    // is available immediately. Indexed chunks are merged into the
    // corpus, then the live retrieval/classification state is refreshed
    // once indexing completes.
    //
    // Opt-in: callers must set `githubRepos.includeEcosystem: true` or
    // provide an explicit `githubRepos.repos` list. The ecosystem index
    // requires the optional peer dependency `@framers/agentos-ext-github`,
    // so we no longer auto-fire it on every router init.
    const repoConfig = this.config.githubRepos ?? {};
    const includeEcosystem = repoConfig.includeEcosystem === true;

    if (includeEcosystem || (repoConfig.repos && repoConfig.repos.length > 0)) {
      Promise.resolve().then(async () => {
        try {
          const { GitHubRepoIndexer, GitHubService } = await this.loadGitHubExtensionModule();
          const indexedChunks: Array<{ heading: string; content: string; sourcePath: string }> = [];

          const token = repoConfig.token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
          const service = new GitHubService(token);
          // initialize() creates the Octokit and validates auth.
          // If the token is empty/invalid, Octokit is still created before
          // the auth check throws, so public-only API access still works.
          try { await service.initialize(); } catch { /* public-only mode */ }

          const indexer = new GitHubRepoIndexer(service);

          if (includeEcosystem) {
            const results = await indexer.indexEcosystem();
            const totalChunks = results.reduce((s, r) => s + r.chunks.length, 0);
            for (const result of results) {
              indexedChunks.push(...result.chunks);
              this.emit({
                type: 'github:index:complete',
                repo: result.repo,
                chunksTotal: result.chunks.length,
                durationMs: result.durationMs,
                timestamp: Date.now(),
              });
            }
            console.log(
              `[QueryRouter] GitHub ecosystem indexed: ${results.length} repos, ${totalChunks} chunks`,
            );
          }

          if (repoConfig.repos?.length) {
            for (const { owner, repo } of repoConfig.repos) {
              try {
                const result = await indexer.indexRepo(owner, repo);
                indexedChunks.push(...result.chunks);
                this.emit({
                  type: 'github:index:complete',
                  repo: result.repo,
                  chunksTotal: result.chunks.length,
                  durationMs: result.durationMs,
                  timestamp: Date.now(),
                });
              } catch (err) {
                this.emit({
                  type: 'github:index:error',
                  repo: `${owner}/${repo}`,
                  error: err instanceof Error ? err.message : String(err),
                  timestamp: Date.now(),
                });
              }
            }
          }
          await this.syncIndexedCorpusChunks(indexedChunks);

        } catch (err) {
          console.warn(
            `[QueryRouter] GitHub indexing failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      });
    }
  }

  private async loadGitHubExtensionModule(): Promise<GitHubExtensionModule> {
    const specifiers = [
      '@framers/agentos-ext-github',
      ...GITHUB_EXTENSION_LOCAL_ENTRY_CANDIDATES
        .filter((candidate) => existsSync(candidate))
        .map((candidate) => pathToFileURL(candidate).href),
    ];
    const failures: string[] = [];

    for (const specifier of specifiers) {
      try {
        const module = (await import(/* @vite-ignore */ specifier)) as Partial<GitHubExtensionModule>;
        if (module.GitHubRepoIndexer && module.GitHubService) {
          return module as GitHubExtensionModule;
        }
        failures.push(`${specifier} loaded without GitHubRepoIndexer/GitHubService exports`);
      } catch (error) {
        failures.push(
          `${specifier}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    throw new Error(
      `Unable to load GitHub extension runtime for QueryRouter indexing. ${failures.join(
        ' | ',
      )}`,
    );
  }

  /**
   * Classify a query into a complexity tier without dispatching or generating.
   *
   * Useful when consumers want to inspect the classification before deciding
   * whether to proceed with the full pipeline.
   *
   * @param query - The user's natural-language query.
   * @param conversationHistory - Optional recent conversation messages.
   * @returns The classification result with tier, confidence, and reasoning.
   * @throws If the router has not been initialised via {@link init}.
   */
  async classify(
    query: string,
    conversationHistory?: ConversationMessage[],
    options?: QueryRouterRequestOptions,
  ): Promise<ClassificationResult> {
    this.ensureInitialized();

    const start = Date.now();
    this.emit({
      type: 'classify:start',
      query,
      timestamp: start,
    });

    const trimmedHistory = this.trimConversationHistory(conversationHistory);

    const result = await this.classifier!.classify(query, trimmedHistory, options);

    if (result.reasoning.startsWith('Classification failed;')) {
      this.emit({
        type: 'classify:error',
        error: new Error(result.reasoning),
        timestamp: Date.now(),
      });
    }

    this.emit({
      type: 'classify:complete',
      result,
      durationMs: Date.now() - start,
      timestamp: Date.now(),
    });

    return result;
  }

  /**
   * Retrieve context at a specific tier, bypassing the classifier.
   *
   * Useful when the caller already knows the appropriate retrieval depth
   * and wants to skip classification overhead.
   *
   * @param query - The user's natural-language query.
   * @param tier - The complexity tier to retrieve at (0-3).
   * @returns The retrieval result with chunks and optional graph/research data.
   * @throws If the router has not been initialised via {@link init}.
   */
  async retrieve(query: string, tier: QueryTier): Promise<RetrievalResult> {
    this.ensureInitialized();
    return this.dispatcher!.dispatch(query, tier);
  }

  /**
   * Full end-to-end pipeline: classify -> dispatch -> generate.
   *
   * This is the primary method for answering user queries. It:
   * 1. Classifies the query to determine retrieval depth.
   * 2. Dispatches retrieval at the classified tier.
   * 3. Generates a grounded answer from the retrieved context.
   * 4. Emits lifecycle events throughout for observability.
   *
   * @param query - The user's natural-language query.
   * @param conversationHistory - Optional recent conversation messages.
   * @returns The final query result with answer, classification, sources, and timing.
   * @throws If the router has not been initialised via {@link init}.
   */
  async route(
    query: string,
    conversationHistory?: ConversationMessage[],
    options?: QueryRouterRequestOptions,
  ): Promise<QueryResult> {
    this.ensureInitialized();

    const routeStart = Date.now();
    const trimmedHistory = this.trimConversationHistory(conversationHistory);
    const cacheKey = this.buildRouteCacheKey(query, trimmedHistory, options);

    if (this.config.cacheResults !== false) {
      const cached = this.routeResultCache.get(cacheKey);
      if (cached) {
        const cachedResult = this.cloneQueryResult(cached);
        this.emit({
          type: 'route:complete',
          result: cachedResult,
          durationMs: Date.now() - routeStart,
          timestamp: Date.now(),
        });
        return cachedResult;
      }
    }

    // --- Phase 1: Classification ---
    const classifyStart = Date.now();
    this.emit({
      type: 'classify:start',
      query,
      timestamp: classifyStart,
    });

    const [classification, executionPlan] = await this.classifier!.classifyWithPlan(
      query,
      trimmedHistory,
      options,
    );

    if (classification.reasoning.startsWith('Classification failed;')) {
      this.emit({
        type: 'classify:error',
        error: new Error(classification.reasoning),
        timestamp: Date.now(),
      });
    }

    this.emit({
      type: 'classify:complete',
      result: classification,
      durationMs: Date.now() - classifyStart,
      timestamp: Date.now(),
    });

    // Fire the onClassification hook if configured
    if (this.config.onClassification) {
      this.config.onClassification(classification);
    }

    // The router recommends capabilities but does not activate them. Emit the
    // suggestion event for both legacy and unified retrieval paths so hosts can
    // honor recommendations consistently.
    if (
      executionPlan.skills.length > 0 ||
      executionPlan.tools.length > 0 ||
      executionPlan.extensions.length > 0
    ) {
      this.emit({
        type: 'capabilities:activate',
        skills: executionPlan.skills,
        tools: executionPlan.tools,
        extensions: executionPlan.extensions,
        timestamp: Date.now(),
      });
    }

    // --- Phase 2: Retrieval (with capability recommendations) ---
    // When a UnifiedRetriever is attached, use plan-based retrieval with
    // full ExecutionPlan (including skill/tool/extension recommendations).
    // Otherwise fall back to the legacy QueryDispatcher pipeline.
    const retrievalEventStart = this.events.length;
    let retrieval: RetrievalResult;

    if (this.unifiedRetriever && this.classifier) {
      // Plan-based retrieval via UnifiedRetriever
      const unifiedResult = await this.unifiedRetriever.retrieve(query, executionPlan);
      retrieval = {
        chunks: unifiedResult.chunks,
        researchSynthesis: unifiedResult.researchSynthesis,
        durationMs: unifiedResult.durationMs,
      };
    } else {
      // Legacy dispatcher pipeline (HyDE-aware strategy or tier-based)
      retrieval = classification.strategy
        ? await this.dispatcher!.dispatchByStrategy(
            query,
            classification.strategy,
            classification.suggestedSources,
          )
        : await this.dispatcher!.dispatch(
            query,
            classification.tier,
            classification.suggestedSources,
          );
    }

    const retrievalEvents = this.events.slice(retrievalEventStart);
    const fallbacksUsed = this.collectFallbacks(classification, retrievalEvents);
    const tiersUsed = this.collectTiersUsed(classification, fallbacksUsed);

    // Fire the onRetrieval hook if configured
    if (this.config.onRetrieval) {
      this.config.onRetrieval(retrieval);
    }

    // --- Phase 3: Generation ---
    this.emit({
      type: 'generate:start',
      contextChunkCount: retrieval.chunks.length,
      timestamp: Date.now(),
    });

    const generateResult = await this.generator!.generate(
      query,
      classification.tier,
      retrieval.chunks,
      retrieval.researchSynthesis,
    );

    // Build source citations from the retrieved chunks
    const sources: SourceCitation[] = retrieval.chunks.map((chunk) => ({
      path: chunk.sourcePath,
      heading: chunk.heading,
      relevanceScore: chunk.relevanceScore,
      matchType: chunk.matchType,
    }));

    this.emit({
      type: 'generate:complete',
      answerLength: generateResult.answer.length,
      citationCount: sources.length,
      durationMs: Date.now() - routeStart,
      timestamp: Date.now(),
    });

    // --- Assemble final result ---
    const totalDuration = Date.now() - routeStart;

    // Surface capability recommendations from the execution plan into the
    // QueryResult so consumers (bots, CLI, API) can access them directly.
    const recommendations =
      executionPlan.skills.length > 0 ||
      executionPlan.tools.length > 0 ||
      executionPlan.extensions.length > 0
        ? {
            skills: executionPlan.skills.map((s) => ({
              skillId: s.skillId,
              reasoning: s.reasoning,
              confidence: s.confidence,
            })),
            tools: executionPlan.tools.map((t) => ({
              toolId: t.toolId,
              reasoning: t.reasoning,
              confidence: t.confidence,
            })),
            extensions: executionPlan.extensions.map((e) => ({
              extensionId: e.extensionId,
              reasoning: e.reasoning,
              confidence: e.confidence,
            })),
          }
        : undefined;

    const grounding = await this.verifyGeneratedCitations(
      generateResult.answer,
      retrieval.chunks,
    );

    const result: QueryResult = {
      answer: generateResult.answer,
      classification,
      sources,
      researchSynthesis: retrieval.researchSynthesis,
      durationMs: totalDuration,
      tiersUsed,
      fallbacksUsed,
      grounding,
      recommendations,
    };

    if (this.config.cacheResults !== false) {
      this.routeResultCache.set(cacheKey, this.cloneQueryResult(result));
    }

    // Log recommendations in verbose mode for observability
    if (result.recommendations) {
      const r = result.recommendations;
      const parts: string[] = [];
      if (r.skills.length) parts.push(`skills: ${r.skills.map((s) => s.skillId).join(', ')}`);
      if (r.tools.length) parts.push(`tools: ${r.tools.map((t) => t.toolId).join(', ')}`);
      if (r.extensions.length) parts.push(`extensions: ${r.extensions.map((e) => e.extensionId).join(', ')}`);
      if (parts.length) console.log(`[QueryRouter] recommendations | ${parts.join(' | ')}`);
    }

    this.emit({
      type: 'route:complete',
      result,
      durationMs: totalDuration,
      timestamp: Date.now(),
    });

    return result;
  }

  /**
   * Tear down resources and release references.
   *
   * Shuts down embedding and vector store managers if they were initialised,
   * then nulls out all component references. Safe to call multiple times.
   * After close(), the router must be re-initialised via {@link init} before
   * further use.
   */
  async close(): Promise<void> {
    // Shut down RAG modules if they were initialised
    try {
      if (this.embeddingManager && typeof (this.embeddingManager as any).shutdown === 'function') {
        await this.embeddingManager.shutdown();
      }
    } catch { /* best-effort cleanup */ }
    try {
      if (this.vectorStoreManager) {
        await this.vectorStoreManager.shutdownAllProviders();
      }
    } catch { /* best-effort cleanup */ }
    try {
      if (this.providerManager) {
        await this.providerManager.shutdown();
      }
    } catch { /* best-effort cleanup */ }

    this.embeddingManager = null;
    this.vectorStoreManager = null;
    this.providerManager = null;
    this.embeddingDimension = 0;
    this.embeddingStatus = 'disabled-no-key';
    this.classifier = null;
    this.dispatcher = null;
    this.generator = null;
    this.keywordFallback = null;
    this.corpus = [];
    this.topics = [];
    this.events = [];
    this.clearRouteResultCache();
    this.initialized = false;
  }

  /**
   * Return lightweight corpus/index stats for observability and host startup
   * logs.
   *
   * Useful after {@link init} so callers can confirm the router loaded a real
   * corpus instead of only knowing that initialisation completed.
   */
  getCorpusStats(): QueryRouterCorpusStats {
    const vectorActive = Boolean(this.embeddingManager && this.vectorStoreManager);
    const platformKnowledge = this.getPlatformKnowledgeCounts();
    const graphRuntimeMode = this.config.graphEnabled
      ? (this.hasLiveGraphRuntime() ? 'active' : this.hasHeuristicGraphRuntime() ? 'heuristic' : 'placeholder')
      : 'disabled';
    const deepResearchRuntimeMode = this.config.deepResearchEnabled
      ? (this.hasLiveDeepResearchRuntime()
          ? 'active'
          : this.hasHeuristicDeepResearchRuntime()
            ? 'heuristic'
            : 'placeholder')
      : 'disabled';
    return {
      initialized: this.initialized,
      configuredPathCount: this.config.knowledgeCorpus.length,
      chunkCount: this.corpus.length,
      topicCount: this.topics.length,
      sourceCount: new Set(this.corpus.map((chunk) => chunk.sourcePath)).size,
      platformKnowledge,
      retrievalMode: vectorActive ? 'vector+keyword-fallback' : 'keyword-only',
      embeddingStatus: vectorActive ? 'active' : this.embeddingStatus,
      embeddingDimension: vectorActive ? this.embeddingDimension : 0,
      graphEnabled: this.config.graphEnabled,
      deepResearchEnabled: this.config.deepResearchEnabled,
      graphRuntimeMode,
      rerankRuntimeMode: this.hasLiveRerankerRuntime()
        ? 'active'
        : this.hasHeuristicRerankerRuntime()
          ? 'heuristic'
          : 'placeholder',
      deepResearchRuntimeMode,
    };
  }

  private getPlatformKnowledgeCounts(): QueryRouterCorpusStats['platformKnowledge'] {
    const counts: QueryRouterCorpusStats['platformKnowledge'] = {
      total: 0,
      tools: 0,
      skills: 0,
      faq: 0,
      api: 0,
      troubleshooting: 0,
    };

    for (const chunk of this.corpus) {
      if (!chunk.sourcePath.startsWith('platform:')) continue;
      counts.total += 1;
      if (chunk.sourcePath.startsWith('platform:tools/')) counts.tools += 1;
      else if (chunk.sourcePath.startsWith('platform:skills/')) counts.skills += 1;
      else if (chunk.sourcePath.startsWith('platform:faq/')) counts.faq += 1;
      else if (chunk.sourcePath.startsWith('platform:api/')) counts.api += 1;
      else if (chunk.sourcePath.startsWith('platform:troubleshooting/')) counts.troubleshooting += 1;
    }

    return counts;
  }

  // ==========================================================================
  // PRIVATE — Corpus loading
  // ==========================================================================

  /**
   * Load and chunk markdown files from the configured corpus directories.
   *
   * Recursively walks each directory, reads .md and .mdx files, and splits
   * their content by h1-h3 headings. Each heading section becomes a
   * CorpusChunk (capped at {@link MAX_CHUNK_CHARS} characters, minimum
   * {@link MIN_CHUNK_CHARS} to filter out trivially small sections).
   *
   * @param paths - Array of directory paths to scan for markdown files.
   * @returns Array of CorpusChunk objects ready for indexing.
   */
  private loadCorpus(paths: string[]): CorpusChunk[] {
    const chunks: CorpusChunk[] = [];
    let chunkIndex = 0;

    for (const dirPath of paths) {
      if (!existsSync(dirPath)) {
        continue;
      }

      this.walkDir(dirPath, (filePath: string) => {
        const ext = extname(filePath);
        if (!MARKDOWN_EXTENSIONS.has(ext)) {
          return;
        }

        try {
          const content = readFileSync(filePath, 'utf-8');
          const sections = this.splitByHeadings(content, filePath);

          for (const section of sections) {
            if (section.content.length < MIN_CHUNK_CHARS) {
              continue;
            }

            chunks.push({
              id: `chunk_${chunkIndex++}`,
              heading: section.heading,
              content: section.content.slice(0, MAX_CHUNK_CHARS),
              sourcePath: filePath,
            });
          }
        } catch {
          // Skip unreadable files gracefully
        }
      });
    }

    return chunks;
  }

  /**
   * Build a clear init-time error for empty or unreadable corpora.
   *
   * The router can technically operate with keyword fallback only, but it
   * should not silently mark itself ready when no corpus content was loaded
   * at all. Callers usually interpret a successful `init()` as "docs loaded".
   *
   * @param paths - Configured knowledge corpus directory paths.
   * @returns Human-readable error message for throwing from {@link init}.
   */
  private buildEmptyCorpusError(paths: string[]): string {
    return (
      'QueryRouter init failed: no readable markdown corpus chunks were loaded. ' +
      `Checked paths: ${paths.join(', ')}. ` +
      'Make sure at least one configured directory exists and contains readable ' +
      '.md or .mdx files with non-trivial section content.'
    );
  }

  /**
   * Load the bundled platform knowledge corpus that ships with @framers/agentos.
   *
   * The corpus file (`knowledge/platform-corpus.json`) is generated at build
   * time by `scripts/build-knowledge-corpus.mjs` and contains tool reference
   * entries, skill summaries, FAQ, API reference, and troubleshooting guides.
   *
   * Falls back gracefully if the file is missing (e.g., in development before
   * the knowledge build step has run).
   *
   * @returns Loaded platform corpus chunks, or empty array if unavailable.
   */
  private loadPlatformKnowledge(): CorpusChunk[] {
    const candidates = [
      // Current layout: this module sits at {src,dist}/orchestration/pipeline/query/,
      // so the package-root knowledge/ directory is four levels up.
      join(MODULE_DIR, '../../../../knowledge/platform-corpus.json'),
      // Legacy shallower layouts, kept as fallbacks.
      join(MODULE_DIR, '../../../knowledge/platform-corpus.json'),
      join(MODULE_DIR, '../../knowledge/platform-corpus.json'),
    ];

    for (const corpusPath of candidates) {
      if (!existsSync(corpusPath)) continue;

      try {
        const raw = readFileSync(corpusPath, 'utf-8');
        const entries: Array<{
          id: string;
          heading: string;
          content: string;
          category: string;
        }> = JSON.parse(raw);

        const chunks: CorpusChunk[] = entries.map((entry) => ({
          id: entry.id,
          heading: entry.heading,
          content: entry.content,
          sourcePath: `platform:${entry.category}/${entry.id}`,
        }));

        console.log(`[QueryRouter] Loaded ${chunks.length} platform knowledge entries`);
        return chunks;
      } catch {
        // Platform corpus not parseable — skip silently
      }
    }

    return [];
  }

  /**
   * Recursively walk a directory tree, invoking a callback for each file.
   *
   * @param dir - The directory to walk.
   * @param callback - Function called with the absolute path of each file.
   */
  private walkDir(dir: string, callback: (filePath: string) => void): void {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          this.walkDir(fullPath, callback);
        } else if (entry.isFile()) {
          callback(fullPath);
        }
      }
    } catch {
      // Skip inaccessible directories gracefully
    }
  }

  /**
   * Split markdown content into sections by h1-h3 headings.
   *
   * Each section captures the heading text and the content between it and
   * the next heading (or end of file). Content before the first heading is
   * assigned a heading of "(intro)".
   *
   * @param content - The raw markdown file content.
   * @param sourcePath - File path (used for the section's sourcePath field).
   * @returns Array of sections with heading and content fields.
   */
  private splitByHeadings(
    content: string,
    sourcePath: string,
  ): Array<{ heading: string; content: string }> {
    const lines = content.split('\n');
    const sections: Array<{ heading: string; content: string }> = [];
    let currentHeading = '(intro)';
    let currentLines: string[] = [];

    for (const line of lines) {
      const match = line.match(HEADING_REGEX);

      if (match) {
        // Flush the previous section
        if (currentLines.length > 0) {
          sections.push({
            heading: currentHeading,
            content: currentLines.join('\n').trim(),
          });
        }

        currentHeading = match[1].trim();
        currentLines = [];
      } else {
        currentLines.push(line);
      }
    }

    // Flush the final section
    if (currentLines.length > 0) {
      sections.push({
        heading: currentHeading,
        content: currentLines.join('\n').trim(),
      });
    }

    return sections;
  }

  // ==========================================================================
  // PRIVATE — Corpus embedding
  // ==========================================================================

  /**
   * Embed all loaded corpus chunks into the vector store using real
   * EmbeddingManager and VectorStoreManager instances.
   *
   * The method dynamically imports the RAG modules to keep them optional —
   * if the imports fail or initialisation fails (e.g., no API key), the error
   * is caught and logged as a warning. The router will continue to function
   * using the KeywordFallback engine for all retrieval.
   *
   * Steps:
   * 1. Dynamic-import AIModelProviderManager, EmbeddingManager, VectorStoreManager
   * 2. Initialise the provider manager with the configured embedding provider
   * 3. Initialise the embedding manager with the configured model
   * 4. Initialise the vector store manager with an in-memory provider
   * 5. Create a collection with the correct dimension
   * 6. Embed all corpus chunks in batches of 50
   * 7. Upsert the resulting VectorDocuments into the vector store
   * 8. Cache embeddings on CorpusChunk.embedding for potential reuse
   */
  private async embedCorpus(): Promise<void> {
    if (this.corpus.length === 0) {
      return;
    }

    // Quick check: bail out early if there's obviously no API key configured.
    // This avoids the overhead of dynamic imports and provider initialization
    // in test environments and when no embedding provider is available.
    const embeddingApiKey = this.getEmbeddingApiKey();
    if (!embeddingApiKey) {
      this.disableVectorRetrieval('disabled-no-key');
      console.debug(
        '[QueryRouter] No embedding API key configured; skipping vector store embedding (keyword fallback active).',
      );
      return;
    }

    try {
      // --- Dynamic imports to keep RAG modules optional ---
      const [
        { AIModelProviderManager: AIModelProviderManagerClass },
        { EmbeddingManager: EmbeddingManagerClass },
        { VectorStoreManager: VectorStoreManagerClass },
      ] = await Promise.all([
        import('../../../core/llm/providers/AIModelProviderManager.js'),
        import('../../../cognition/rag/EmbeddingManager.js'),
        import('../../../cognition/rag/VectorStoreManager.js'),
      ]);

      // --- 1. Initialise the AI model provider manager ---
      const pm = new AIModelProviderManagerClass();
      await pm.initialize({
        providers: [
          {
            providerId: this.config.embeddingProvider,
            enabled: true,
            config: {
              apiKey: embeddingApiKey,
              ...(this.getEmbeddingBaseUrl() ? { baseUrl: this.getEmbeddingBaseUrl() } : {}),
            },
            isDefault: true,
          },
        ],
      });
      this.providerManager = pm;

      // --- 2. Initialise the embedding manager ---
      const em = new EmbeddingManagerClass();
      const embeddingModelId = this.config.embeddingModel;
      const embeddingProviderId = this.config.embeddingProvider;

      // Determine dimension: use a known dimension for common models, or
      // try to derive it by generating a single test embedding.
      let dimension = this.getKnownDimension(embeddingModelId);

      await em.initialize(
        {
          embeddingModels: [
            {
              modelId: embeddingModelId,
              providerId: embeddingProviderId,
              dimension: dimension || 1536, // initial guess; corrected below if needed
              isDefault: true,
            },
          ],
          defaultModelId: embeddingModelId,
          defaultBatchSize: 50,
        },
        pm,
      );
      this.embeddingManager = em;

      // If dimension was unknown, generate a probe embedding to discover it
      if (!dimension) {
        const probe = await em.generateEmbeddings({ texts: ['dimension probe'] });
        if (probe.embeddings.length > 0 && probe.embeddings[0].length > 0) {
          dimension = probe.embeddings[0].length;
        } else {
          dimension = 1536; // safe fallback for OpenAI models
        }
      }
      this.embeddingDimension = dimension;
      this.embeddingStatus = 'active';

      // --- 3. Initialise the vector store manager (in-memory) ---
      const vsm = new VectorStoreManagerClass();
      const collectionName = this.corpusDataSourceId;
      await vsm.initialize(
        {
          managerId: 'query-router-vsm',
          providers: [{ id: 'mem', type: 'in_memory' }],
          defaultProviderId: 'mem',
        },
        [
          {
            dataSourceId: collectionName,
            displayName: 'QueryRouter Corpus',
            vectorStoreProviderId: 'mem',
            actualNameInProvider: collectionName,
            embeddingDimension: dimension,
          },
        ],
      );
      this.vectorStoreManager = vsm;

      // --- 4. Create the collection ---
      const { store, collectionName: resolvedName } =
        await vsm.getStoreForDataSource(collectionName);

      if (typeof store.createCollection === 'function') {
        await store.createCollection(resolvedName, dimension);
      }

      // --- 5. Embed corpus chunks in batches of 50 ---
      const BATCH_SIZE = 50;
      const allDocuments: VectorDocument[] = [];

      for (let i = 0; i < this.corpus.length; i += BATCH_SIZE) {
        const batch = this.corpus.slice(i, i + BATCH_SIZE);
        const texts = batch.map((c) => c.content);

        const result = await em.generateEmbeddings({ texts });

        for (let j = 0; j < batch.length; j++) {
          const embedding = result.embeddings[j];
          if (!embedding || embedding.length === 0) {
            continue; // skip chunks that failed to embed
          }

          // Cache embedding on the CorpusChunk for potential later reuse
          batch[j].embedding = embedding;

          allDocuments.push({
            id: batch[j].id,
            embedding,
            textContent: batch[j].content,
            metadata: {
              heading: batch[j].heading,
              sourcePath: batch[j].sourcePath,
            },
          });
        }
      }

      // --- 6. Upsert into vector store ---
      if (allDocuments.length > 0) {
        await store.upsert(resolvedName, allDocuments);
      }

      console.log(
        `[QueryRouter] Embedded ${allDocuments.length} chunks into vector store (dim=${dimension})`,
      );
    } catch (error: unknown) {
      // Non-fatal: warn and continue — keyword fallback still works
      const message =
        error instanceof Error ? error.message : String(error);
      console.warn(
        `[QueryRouter] Embedding initialisation failed, falling back to keyword search: ${message}`,
      );
      this.disableVectorRetrieval('failed-init');
    }
  }

  private async syncIndexedCorpusChunks(
    chunks: Array<{ heading: string; content: string; sourcePath: string }>,
  ): Promise<void> {
    if (chunks.length === 0) {
      return;
    }

    const appendedChunks = this.appendCorpusChunks(chunks);
    await this.indexAdditionalCorpusChunks(appendedChunks);
    this.rebuildCorpusSearchState();
  }

  private appendCorpusChunks(
    chunks: Array<{ heading: string; content: string; sourcePath: string }>,
  ): CorpusChunk[] {
    const existingKeys = new Set(
      this.corpus.map((chunk) => `${chunk.sourcePath}\u0000${chunk.heading}\u0000${chunk.content}`),
    );
    const filteredChunks = chunks
      .map((chunk) => ({
        heading: chunk.heading,
        sourcePath: chunk.sourcePath,
        content: chunk.content.slice(0, MAX_CHUNK_CHARS).trim(),
      }))
      .filter((chunk) => {
        if (chunk.content.length < MIN_CHUNK_CHARS) {
          return false;
        }

        const dedupeKey = `${chunk.sourcePath}\u0000${chunk.heading}\u0000${chunk.content}`;
        if (existingKeys.has(dedupeKey)) {
          return false;
        }

        existingKeys.add(dedupeKey);
        return true;
      });
    const startIndex = this.corpus.length;
    const appendedChunks = filteredChunks.map((chunk, index) => ({
      id: `gh_${startIndex + index}`,
      heading: chunk.heading,
      content: chunk.content,
      sourcePath: chunk.sourcePath,
    }));

    this.corpus.push(...appendedChunks);
    return appendedChunks;
  }

  private rebuildCorpusSearchState(): void {
    this.keywordFallback = new KeywordFallback(this.corpus);

    const topicExtractor = new TopicExtractor();
    this.topics = topicExtractor.extract(this.corpus);

    if (this.classifier) {
      this.classifier = this.createClassifier(topicExtractor.formatForPrompt(this.topics));
    }

    this.clearRouteResultCache();
  }

  private createClassifier(topicList: string): QueryClassifier {
    const classifier = new QueryClassifier({
      model: this.config.classifierModel,
      provider: this.config.classifierProvider,
      confidenceThreshold: this.config.confidenceThreshold,
      maxTier: this.config.maxTier,
      topicList,
      toolList: this.formatToolList(this.config.availableTools),
      apiKey: this.getLlmApiKey(),
      baseUrl: this.getLlmBaseUrl(),
    });

    if (this.capabilityDiscoveryEngine) {
      classifier.setCapabilityDiscoveryEngine(this.capabilityDiscoveryEngine);
    }

    return classifier;
  }

  private trimConversationHistory(
    conversationHistory?: ConversationMessage[],
  ): ConversationMessage[] | undefined {
    return conversationHistory?.slice(-this.config.conversationWindowSize);
  }

  private buildRouteCacheKey(
    query: string,
    conversationHistory?: ConversationMessage[],
    options?: QueryRouterRequestOptions,
  ): string {
    return JSON.stringify({
      query,
      conversationHistory: conversationHistory ?? null,
      excludedCapabilityIds: [...(options?.excludedCapabilityIds ?? [])].sort(),
      hasUnifiedRetriever: Boolean(this.unifiedRetriever),
      verifyCitations: this.config.verifyCitations === true,
    });
  }

  private clearRouteResultCache(): void {
    this.routeResultCache.clear();
  }

  private cloneQueryResult(result: QueryResult): QueryResult {
    if (typeof structuredClone === 'function') {
      return structuredClone(result);
    }
    return JSON.parse(JSON.stringify(result)) as QueryResult;
  }

  private async verifyGeneratedCitations(
    answer: string,
    chunks: RetrievedChunk[],
  ): Promise<VerifiedResponse | undefined> {
    if (this.config.verifyCitations !== true) {
      return undefined;
    }

    if (!this.embeddingManager || chunks.length === 0) {
      return undefined;
    }

    const sources: VerificationSource[] = chunks
      .filter((chunk) => chunk.content.trim().length > 0)
      .map((chunk) => ({
        content: chunk.content,
        title: chunk.heading,
        url: chunk.sourcePath,
      }));

    if (sources.length === 0) {
      return undefined;
    }

    try {
      const verifier = new CitationVerifier({
        embedFn: async (texts: string[]) => {
          const result = await this.embeddingManager!.generateEmbeddings({ texts });
          return result.embeddings;
        },
      });
      return await verifier.verify(answer, sources);
    } catch {
      return undefined;
    }
  }

  private async indexAdditionalCorpusChunks(chunks: CorpusChunk[]): Promise<void> {
    if (
      chunks.length === 0 ||
      !this.embeddingManager ||
      !this.vectorStoreManager ||
      this.embeddingStatus !== 'active'
    ) {
      return;
    }

    try {
      const { store, collectionName } =
        await this.vectorStoreManager.getStoreForDataSource(this.corpusDataSourceId);
      const BATCH_SIZE = 50;
      const allDocuments: VectorDocument[] = [];

      for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
        const batch = chunks.slice(i, i + BATCH_SIZE);
        const result = await this.embeddingManager.generateEmbeddings({
          texts: batch.map((chunk) => chunk.content),
        });

        for (let j = 0; j < batch.length; j++) {
          const embedding = result.embeddings[j];
          if (!embedding || embedding.length === 0) {
            continue;
          }

          batch[j].embedding = embedding;
          allDocuments.push({
            id: batch[j].id,
            embedding,
            textContent: batch[j].content,
            metadata: {
              heading: batch[j].heading,
              sourcePath: batch[j].sourcePath,
            },
          });
        }
      }

      if (allDocuments.length > 0) {
        await store.upsert(collectionName, allDocuments);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[QueryRouter] Incremental GitHub corpus embedding failed; falling back to keyword search: ${message}`,
      );
      this.disableVectorRetrieval('failed-init');
    }
  }

  private disableVectorRetrieval(status: Exclude<QueryRouterEmbeddingStatus, 'active'>): void {
    this.embeddingManager = null;
    this.vectorStoreManager = null;
    this.providerManager = null;
    this.embeddingDimension = 0;
    this.embeddingStatus = status;
  }

  /**
   * Resolve API key for embedding calls.
   * Falls back through embedding-specific → global → env var scan.
   */
  private getEmbeddingApiKey(): string {
    if (this.config.embeddingApiKey) return this.config.embeddingApiKey;
    // Fall through to general LLM key resolver
    return this.getLlmApiKey();
  }

  private getEmbeddingBaseUrl(): string | undefined {
    if (this.config.embeddingBaseUrl !== undefined) {
      return this.config.embeddingBaseUrl as string;
    }

    if (this.config.embeddingApiKey !== undefined) {
      return undefined;
    }

    if (this.config.baseUrl !== undefined) {
      return this.config.baseUrl as string;
    }

    if (this.config.apiKey !== undefined) {
      return undefined;
    }

    if (process.env.OPENAI_API_KEY) {
      return undefined;
    }

    if (process.env.OPENROUTER_API_KEY) {
      return 'https://openrouter.ai/api/v1';
    }

    return undefined;
  }

  /**
   * Resolve API key for LLM calls.
   *
   * Checks config override first, then scans all provider env vars in priority
   * order. Returns empty string for keyless providers (claude-code-cli, gemini-cli)
   * which is fine — generateText() handles them via CLISubprocessBridge.
   */
  private getLlmApiKey(): string {
    if (this.config.apiKey) return this.config.apiKey;

    // Check all providers in priority order.
    // Direct provider keys (OpenAI, Anthropic, etc.) take precedence over
    // aggregator keys (OpenRouter) so that the native endpoint is used when
    // both are configured.
    const envKeys = [
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'GEMINI_API_KEY',
      'GROQ_API_KEY',
      'TOGETHER_API_KEY',
      'MISTRAL_API_KEY',
      'XAI_API_KEY',
      'OPENROUTER_API_KEY',
    ];

    for (const key of envKeys) {
      if (process.env[key]) return process.env[key]!;
    }

    // Keyless providers (CLI) don't need an API key — empty string is fine
    return '';
  }

  /**
   * Resolve base URL for LLM calls.
   *
   * Only OpenRouter and Ollama need custom base URLs. All other providers
   * (including CLI) use their default endpoints via generateText() resolution.
   */
  private getLlmBaseUrl(): string | undefined {
    if (this.config.baseUrl !== undefined) {
      return this.config.baseUrl as string;
    }

    // If user provided an explicit API key, don't override the URL
    if (this.config.apiKey !== undefined) {
      return undefined;
    }

    // Direct provider keys don't need a custom base URL — only fall through
    // to OpenRouter when no direct key is present.
    const directKeys = [
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'GEMINI_API_KEY',
      'GROQ_API_KEY',
      'TOGETHER_API_KEY',
      'MISTRAL_API_KEY',
      'XAI_API_KEY',
    ];
    if (directKeys.some((k) => process.env[k])) {
      return undefined;
    }

    // OpenRouter needs a custom base URL
    if (process.env.OPENROUTER_API_KEY) {
      return 'https://openrouter.ai/api/v1';
    }

    // Ollama needs its base URL
    if (process.env.OLLAMA_BASE_URL) {
      return process.env.OLLAMA_BASE_URL;
    }

    return undefined;
  }

  /**
   * Return a known embedding dimension for common models.
   *
   * This avoids an extra API call when the dimension can be statically
   * determined from the model identifier.
   *
   * @param modelId - The embedding model identifier.
   * @returns The known dimension, or 0 if unknown.
   */
  private getKnownDimension(modelId: string): number {
    const KNOWN_DIMENSIONS: Record<string, number> = {
      'text-embedding-3-small': 1536,
      'text-embedding-3-large': 3072,
      'text-embedding-ada-002': 1536,
    };
    return KNOWN_DIMENSIONS[modelId] ?? 0;
  }

  /**
   * Whether graph expansion is backed by a live implementation.
   *
   * Hosts should not treat `graphEnabled` as meaning GraphRAG is actually live.
   * `active` is reserved for a host-injected or future provider-backed graph
   * runtime rather than the built-in heuristic.
   */
  private hasLiveGraphRuntime(): boolean {
    return typeof this.config.graphExpand === 'function';
  }

  /**
   * Whether graph expansion is backed by the built-in heuristic expansion.
   */
  private hasHeuristicGraphRuntime(): boolean {
    return true;
  }

  /**
   * Whether reranking is backed by a live implementation.
   *
   * `active` is reserved for a host-injected or future provider-backed
   * reranker rather than the built-in lexical heuristic.
   */
  private hasLiveRerankerRuntime(): boolean {
    return typeof this.config.rerank === 'function';
  }

  /**
   * Whether reranking is backed by the built-in lexical reranker.
   */
  private hasHeuristicRerankerRuntime(): boolean {
    return true;
  }

  /**
   * Whether deep research is backed by a live implementation.
   *
   * `deepResearchEnabled` only means the branch may be attempted by config.
   * `active` is reserved for a host-injected or future provider-backed
   * research runtime rather than the built-in local-corpus heuristic.
   */
  private hasLiveDeepResearchRuntime(): boolean {
    return typeof this.config.deepResearch === 'function';
  }

  /**
   * Whether deep research is backed by the built-in corpus-only heuristic.
   */
  private hasHeuristicDeepResearchRuntime(): boolean {
    return true;
  }

  // ==========================================================================
  // PRIVATE — Retrieval callbacks (injected into QueryDispatcher)
  // ==========================================================================

  /**
   * HyDE (Hypothetical Document Embeddings) search callback for the dispatcher.
   *
   * Generates a hypothetical answer to the query using the LLM, then searches
   * for documents similar to that hypothetical answer. Falls back to standard
   * vector search if no generation provider is available.
   *
   * @param query - The user's query string.
   * @param topK - Maximum number of chunks to return.
   * @returns Promise resolving to an array of matched chunks.
   */
  private async hydeSearch(query: string, topK: number): Promise<RetrievedChunk[]> {
    // HyDE falls back to standard vector search in the built-in implementation.
    // A host-injected HyDE retriever would generate a hypothetical document first.
    return this.vectorSearch(query, topK);
  }

  /**
   * Query decomposition callback for the dispatcher.
   *
   * Splits a complex multi-part query into independent sub-queries.
   * The built-in implementation uses simple sentence splitting as a heuristic.
   * A host-injected decomposer would use an LLM for semantic decomposition.
   *
   * @param query - The original multi-part user query.
   * @param maxSubQueries - Maximum number of sub-queries to generate.
   * @returns Array of decomposed sub-query strings.
   */
  private async decomposeQuery(query: string, maxSubQueries: number): Promise<string[]> {
    // Built-in heuristic: split on sentence boundaries or question marks.
    const parts = query
      .split(/[?.!]\s+/)
      .map(s => s.trim())
      .filter(s => s.length > 0);

    if (parts.length <= 1) return [query];
    return parts.slice(0, maxSubQueries);
  }

  /**
   * Vector search callback for the dispatcher.
   *
   * When the EmbeddingManager and VectorStoreManager are available, this method
   * embeds the query, queries the vector store, and maps the results to
   * RetrievedChunk objects. If the RAG modules are not available (e.g., embedding
   * init failed), it falls back to the KeywordFallback engine and emits a
   * retrieve:fallback event.
   *
   * @param query - The user's query string.
   * @param topK - Maximum number of chunks to return.
   * @returns Promise resolving to an array of matched chunks.
   */
  private async vectorSearch(query: string, topK: number): Promise<RetrievedChunk[]> {
    // --- Real vector search when RAG modules are available ---
    if (this.embeddingManager && this.vectorStoreManager) {
      try {
        // Embed the query
        const queryResult = await this.embeddingManager.generateEmbeddings({
          texts: [query],
        });

        const queryEmbedding = queryResult.embeddings[0];
        if (!queryEmbedding || queryEmbedding.length === 0) {
          // Embedding failed for the query — fall through to keyword fallback
          throw new Error('Query embedding returned empty vector');
        }

        // Query the vector store
        const { store, collectionName } =
          await this.vectorStoreManager.getStoreForDataSource(this.corpusDataSourceId);

        const searchResults = await store.query(collectionName, queryEmbedding, {
          topK,
          includeTextContent: true,
          includeMetadata: true,
        });

        // Map retrieved vector documents to RetrievedChunk[]
        return searchResults.documents.map((doc: { id: string; textContent?: string; metadata?: Record<string, unknown>; similarityScore?: number }) => ({
          id: doc.id,
          content: doc.textContent ?? '',
          heading: (doc.metadata?.heading as string) ?? '',
          sourcePath: (doc.metadata?.sourcePath as string) ?? '',
          relevanceScore: doc.similarityScore ?? 0,
          matchType: 'vector' as const,
        }));
      } catch (error: unknown) {
        // On any error during vector search, fall back to keyword search
        const message =
          error instanceof Error ? error.message : String(error);
        console.warn(
          `[QueryRouter] Vector search failed, falling back to keyword search: ${message}`,
        );
        this.emit({
          type: 'retrieve:fallback',
          strategy: 'keyword-fallback',
          reason: `Vector search error: ${message}`,
          timestamp: Date.now(),
        });
      }
    } else {
      // RAG modules not available — emit a fallback event
      this.emit({
        type: 'retrieve:fallback',
        strategy: 'keyword-fallback',
        reason: 'Embeddings unavailable; using keyword search',
        timestamp: Date.now(),
      });
    }

    // --- Keyword fallback ---
    if (!this.keywordFallback) {
      return [];
    }
    return this.keywordFallback.search(query, topK);
  }

  /**
   * Graph expansion callback for the dispatcher.
   *
   * Built-in heuristic graph expansion over the loaded corpus.
   *
   * This is not yet a true GraphRAG engine. It expands from seed chunks by
   * preferring:
   * - chunks from the same source document
   * - heading overlap with seed headings/content
   * - content overlap with seed headings/content
   *
   * @param seeds - Seed chunks to expand from.
   * @returns Promise resolving to related chunks marked as `graph`.
   */
  private async graphExpand(seeds: RetrievedChunk[]): Promise<RetrievedChunk[]> {
    if (seeds.length === 0 || this.corpus.length === 0) {
      return [];
    }

    const seedIds = new Set(seeds.map((seed) => seed.id));
    const seedSourcePaths = new Set(seeds.map((seed) => seed.sourcePath));
    const seedTerms = new Set<string>();

    for (const seed of seeds) {
      for (const term of this.tokenizeForRerank(`${seed.heading} ${seed.content}`)) {
        seedTerms.add(term);
      }
    }

    const scored = this.corpus
      .filter((chunk) => !seedIds.has(chunk.id))
      .map((chunk, index) => {
        const sameSourceBoost = seedSourcePaths.has(chunk.sourcePath) ? 0.48 : 0;
        const headingOverlap = this.computeTermOverlap(
          seedTerms,
          this.tokenizeForRerank(chunk.heading),
        );
        const contentOverlap = this.computeTermOverlap(
          seedTerms,
          this.tokenizeForRerank(chunk.content),
        );
        const score = sameSourceBoost + headingOverlap * 0.32 + contentOverlap * 0.2;

        return { chunk, index, score };
      })
      .filter((entry) => entry.score >= 0.18);

    scored.sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.index - right.index;
    });

    return scored.slice(0, 8).map(({ chunk, score }) => ({
      id: chunk.id,
      heading: chunk.heading,
      content: chunk.content,
      sourcePath: chunk.sourcePath,
      relevanceScore: Math.min(0.99, score),
      matchType: 'graph' as const,
    }));
  }

  /**
   * Reranking callback for the dispatcher.
   *
   * Built-in heuristic reranker.
   *
   * This is not yet a cross-encoder. It reorders candidate chunks by combining:
   * - original retrieval score
   * - heading term overlap
   * - content term overlap
   * - exact phrase containment
   *
   * This gives tier-2 routing a real second-pass ranking step today without
   * pretending the deeper reranker service is already wired.
   *
   * @param query - The user's query.
   * @param chunks - Candidate chunks to rerank.
   * @param topN - Maximum number of chunks to keep.
   * @returns Promise resolving to the best-ranked chunks.
   */
  private async rerank(
    query: string,
    chunks: RetrievedChunk[],
    topN: number,
  ): Promise<RetrievedChunk[]> {
    if (chunks.length <= 1) {
      return chunks.slice(0, topN);
    }

    const queryTerms = this.tokenizeForRerank(query);
    const normalizedQuery = this.normalizeForRerank(query);

    const scored = chunks.map((chunk, index) => {
      const headingTerms = this.tokenizeForRerank(chunk.heading);
      const contentTerms = this.tokenizeForRerank(chunk.content);
      const headingOverlap = this.computeTermOverlap(queryTerms, headingTerms);
      const contentOverlap = this.computeTermOverlap(queryTerms, contentTerms);
      const normalizedText = this.normalizeForRerank(`${chunk.heading} ${chunk.content}`);
      const exactPhraseBoost =
        normalizedQuery.length >= 4 && normalizedText.includes(normalizedQuery) ? 0.2 : 0;
      const score =
        chunk.relevanceScore * 0.55 +
        headingOverlap * 0.25 +
        contentOverlap * 0.2 +
        exactPhraseBoost;

      return { chunk, index, score };
    });

    scored.sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      if (right.chunk.relevanceScore !== left.chunk.relevanceScore) {
        return right.chunk.relevanceScore - left.chunk.relevanceScore;
      }
      return left.index - right.index;
    });

    return scored.slice(0, topN).map((entry) => entry.chunk);
  }

  /**
   * Deep research callback for the dispatcher.
   *
   * Built-in corpus-only research heuristic.
   *
   * This is not web-backed research. It runs a few local keyword-based passes
   * over the loaded corpus using slightly different query formulations, merges
   * the results, and returns a compact synthesis built from the top findings.
   *
   * @param query - The user's query.
   * @param sources - Normalized research-source hints used to broaden local
   *                  matching.
   * @returns Promise resolving to synthesized local-corpus findings.
   */
  private async deepResearch(
    query: string,
    sources: string[],
  ): Promise<{ synthesis: string; sources: RetrievedChunk[] }> {
    if (!this.keywordFallback || this.corpus.length === 0) {
      return { synthesis: '', sources: [] };
    }

    const normalizedSourceHints = sources
      .map((source) => this.normalizeForRerank(source))
      .filter(Boolean);
    const queryTerms = [...this.tokenizeForRerank(query)];
    const narrowedTerms = queryTerms.slice(0, 4).join(' ');

    const researchQueries = [
      query,
      [query, normalizedSourceHints.join(' ')].filter(Boolean).join(' ').trim(),
      [query, 'architecture tradeoffs details'].join(' ').trim(),
      narrowedTerms,
    ].filter(Boolean);

    const merged = new Map<string, RetrievedChunk>();

    for (const researchQuery of researchQueries) {
      const hits = this.keywordFallback.search(researchQuery, 4);
      for (const hit of hits) {
        const existing = merged.get(hit.id);
        const researchChunk: RetrievedChunk = {
          ...hit,
          relevanceScore: Math.min(0.99, hit.relevanceScore),
          matchType: 'research',
        };

        if (!existing || researchChunk.relevanceScore > existing.relevanceScore) {
          merged.set(researchChunk.id, researchChunk);
        }
      }
    }

    const researchChunks = [...merged.values()]
      .sort((left, right) => right.relevanceScore - left.relevanceScore)
      .slice(0, 5);

    if (researchChunks.length === 0) {
      return { synthesis: '', sources: [] };
    }

    const synthesis = researchChunks
      .map((chunk, index) => `${index + 1}. ${chunk.heading}: ${this.firstSentence(chunk.content)}`)
      .join('\n');

    return { synthesis, sources: researchChunks };
  }

  /**
   * Format available tools for the classifier prompt.
   */
  private formatToolList(availableTools: string[]): string {
    return availableTools.length > 0 ? availableTools.join(', ') : '(none available)';
  }

  /**
   * Normalize text for simple lexical reranking.
   */
  private normalizeForRerank(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  /**
   * Tokenize text for lexical reranking.
   */
  private tokenizeForRerank(text: string): Set<string> {
    const STOP_WORDS = new Set([
      'a',
      'an',
      'and',
      'are',
      'as',
      'at',
      'be',
      'by',
      'for',
      'from',
      'how',
      'in',
      'is',
      'it',
      'of',
      'on',
      'or',
      'that',
      'the',
      'this',
      'to',
      'what',
      'when',
      'where',
      'which',
      'why',
      'with',
    ]);

    return new Set(
      this.normalizeForRerank(text)
        .split(/\s+/)
        .filter((term) => term.length >= 2 && !STOP_WORDS.has(term)),
    );
  }

  /**
   * Compute overlap ratio between query terms and candidate terms.
   */
  private computeTermOverlap(queryTerms: Set<string>, candidateTerms: Set<string>): number {
    if (queryTerms.size === 0 || candidateTerms.size === 0) {
      return 0;
    }

    let matches = 0;
    for (const term of queryTerms) {
      if (candidateTerms.has(term)) {
        matches += 1;
      }
    }

    return matches / queryTerms.size;
  }

  /**
   * Extract a short first-sentence style summary from a chunk for synthesis.
   */
  private firstSentence(text: string): string {
    const normalized = text.replace(/\s+/g, ' ').trim();
    const sentence = normalized.match(/^(.{1,220}?[.!?])(?:\s|$)/);
    return sentence?.[1] ?? normalized.slice(0, 220);
  }

  /**
   * Derive fallback strategy names from classification + retrieval events.
   */
  private collectFallbacks(
    classification: ClassificationResult,
    events: QueryRouterEventUnion[],
  ): string[] {
    const fallbacks = new Set<string>();

    if (classification.confidence < this.config.confidenceThreshold) {
      fallbacks.add('low-confidence-classification');
    }

    for (const event of events) {
      if (event.type === 'retrieve:fallback') {
        fallbacks.add(event.strategy);
      }
    }

    return Array.from(fallbacks);
  }

  /**
   * Approximate the tiers actually exercised when fallback strategies fired.
   */
  private collectTiersUsed(
    classification: ClassificationResult,
    fallbacksUsed: string[],
  ): QueryTier[] {
    const tiers = new Set<QueryTier>([classification.tier]);

    for (const fallback of fallbacksUsed) {
      if (fallback === 'research-skip') {
        tiers.add(2);
      }

      if (fallback === 'graph-skip' || fallback === 'keyword-fallback' || fallback === 'rerank-skip') {
        tiers.add(1);
      }
    }

    return Array.from(tiers).sort((a, b) => a - b) as QueryTier[];
  }

  // ==========================================================================
  // PRIVATE — Event emission
  // ==========================================================================

  /**
   * Store a lifecycle event and emit a structured console log.
   *
   * Events are accumulated in the `events` array for later inspection
   * and also logged to the console with a `[QueryRouter]` prefix for
   * real-time observability.
   *
   * @param event - The typed lifecycle event to emit.
   */
  private emit(event: QueryRouterEventUnion): void {
    this.events.push(event);
  }

  // ==========================================================================
  // PRIVATE — Guards
  // ==========================================================================

  /**
   * Assert that the router has been initialised via {@link init}.
   *
   * @throws Error if `init()` has not been called.
   */
  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error(
        'QueryRouter has not been initialised. Call init() before classify/retrieve/route.',
      );
    }
  }
}
