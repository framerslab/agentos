/**
 * Reranking module for the AgentOS RAG pipeline.
 *
 * `RerankerService` holds any number of providers and calls the one a request names. Three ship
 * with the package: `local` (`LocalCrossEncoderReranker`, a cross-encoder run in process through
 * Transformers.js), `cohere` (`CohereReranker`, Cohere's rerank API) and `llm-judge`
 * (`LlmJudgeReranker`, a model you call through your own `llmCallFn`). A remote provider receives
 * the query and the candidate texts. See docs/text/RERANKING.md.
 *
 * @module @framers/agentos/cognition/rag/reranking
 *
 * @example Basic usage with local model
 * ```typescript
 * import { RerankerService, LocalCrossEncoderReranker } from '@framers/agentos/cognition/rag/reranking';
 *
 * const service = new RerankerService({
 *   config: {
 *     providers: [{ providerId: 'local' }],
 *     defaultProviderId: 'local'
 *   }
 * });
 *
 * service.registerProvider(new LocalCrossEncoderReranker({
 *   providerId: 'local',
 *   defaultModelId: 'cross-encoder/ms-marco-MiniLM-L-6-v2'
 * }));
 *
 * const reranked = await service.rerankChunks(query, chunks);
 * ```
 *
 * @example Using Cohere API
 * ```typescript
 * import { RerankerService, CohereReranker } from '@framers/agentos/cognition/rag/reranking';
 *
 * const service = new RerankerService({
 *   config: {
 *     providers: [{ providerId: 'cohere', apiKey: process.env.COHERE_API_KEY }],
 *     defaultProviderId: 'cohere'
 *   }
 * });
 *
 * service.registerProvider(new CohereReranker({
 *   providerId: 'cohere',
 *   apiKey: process.env.COHERE_API_KEY!
 * }));
 *
 * const reranked = await service.rerankChunks(query, chunks, {
 *   modelId: 'rerank-v3.5',
 *   topN: 5
 * });
 * ```
 *
 * @example Using an LLM as the judge
 * ```typescript
 * import { generateText, PROVIDER_DEFAULTS } from '@framers/agentos';
 * import { RerankerService, LlmJudgeReranker } from '@framers/agentos/cognition/rag/reranking';
 *
 * const service = new RerankerService({
 *   config: { providers: [{ providerId: 'llm-judge' }], defaultProviderId: 'llm-judge' }
 * });
 *
 * const provider = 'openai'; // any provider generateText serves
 * service.registerProvider(new LlmJudgeReranker({
 *   // The judge passes scoringModel or rankingModel as `model`; it has no model of its own.
 *   // fallbackProviders: [] keeps every call on `provider` instead of falling back to other configured providers.
 *   llmCallFn: async (system, prompt, model) =>
 *     (await generateText({ provider, model, system, prompt, fallbackProviders: [] })).text,
 *   scoringModel: PROVIDER_DEFAULTS[provider].cheap,
 *   rankingModel: PROVIDER_DEFAULTS[provider].cheap
 * }));
 *
 * const reranked = await service.rerankChunks(query, chunks, { topN: 5 });
 * ```
 */

// Types and interfaces
export type {
  IRerankerProvider,
  RerankerInput,
  RerankerOutput,
  RerankerDocument,
  RerankedDocument,
  RerankerRequestConfig,
  RerankerProviderConfig,
  RerankerServiceConfig,
  RerankerDiagnostics,
} from './IRerankerService';

// Main service
export { RerankerService, type RerankerServiceOptions } from './RerankerService';

// Providers
export {
  CohereReranker,
  type CohereRerankerConfig,
  COHERE_RERANKER_MODELS,
  type CohereRerankerModel,
} from './providers/CohereReranker';

export {
  LocalCrossEncoderReranker,
  type LocalCrossEncoderConfig,
  LOCAL_RERANKER_MODELS,
  LOCAL_RERANKER_DEFAULT_WEIGHTS,
  type LocalRerankerModel,
  type LocalCrossEncoderDtype,
} from './providers/LocalCrossEncoderReranker';

export {
  LlmJudgeReranker,
  type LlmJudgeRerankerConfig,
} from './providers/LlmJudgeReranker';

export type { RerankChainStage } from './IRerankerService';
