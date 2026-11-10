/**
 * @fileoverview Local cross-encoder reranker using transformers.js or ONNX runtime.
 * Runs reranking models locally without external API calls.
 *
 * @module backend/agentos/rag/reranking/providers/LocalCrossEncoderReranker
 */

import type {
  IRerankerProvider,
  RerankerInput,
  RerankerOutput,
  RerankerRequestConfig,
  RerankerProviderConfig,
} from '../IRerankerService';

/**
 * Local reranker configuration.
 */
export interface LocalCrossEncoderConfig extends RerankerProviderConfig {
  providerId: 'local';
  /**
   * Model ID from Hugging Face Hub.
   * Default: 'cross-encoder/ms-marco-MiniLM-L-6-v2'
   */
  defaultModelId?: string;
  /**
   * Device hint, reported in the diagnostics. Default 'cpu'.
   * - 'gpu' sets Transformers.js's ONNX WASM backend to one thread
   *   (`env.backends.onnx.wasm.numThreads = 1`); the pipeline is created
   *   without a device option, so Transformers.js picks the backend.
   * - 'cpu' and 'auto' change nothing.
   */
  device?: 'cpu' | 'gpu' | 'auto';
  /**
   * Maximum sequence length for the model.
   * Default: 512
   */
  maxSequenceLength?: number;
  /**
   * Batch size for inference.
   * Default: 32
   */
  batchSize?: number;
  /**
   * Path to cache downloaded models.
   * Default: system cache directory
   */
  cacheDir?: string;
}

/**
 * Available local cross-encoder models (Hugging Face model IDs).
 */
export const LOCAL_RERANKER_MODELS = [
  'cross-encoder/ms-marco-MiniLM-L-6-v2',      // Fast, good quality
  'cross-encoder/ms-marco-MiniLM-L-12-v2',     // Better quality, slower
  'BAAI/bge-reranker-base',                     // BGE reranker (smaller)
  'BAAI/bge-reranker-large',                    // BGE reranker (larger, better)
  'sentence-transformers/ce-ms-marco-TinyBERT-L-4', // Tiny, fastest
] as const;

export type LocalRerankerModel = (typeof LOCAL_RERANKER_MODELS)[number];

/**
 * Local cross-encoder reranker.
 *
 * Runs cross-encoder models in process through Transformers.js
 * (`@huggingface/transformers`, else `@xenova/transformers`). Scoring sends
 * nothing over the network: the query and documents stay in the process.
 *
 * **Note**: Transformers.js fetches the model's files on first load and
 * reads them from its cache (`cacheDir`) after that. The pipeline loads once,
 * for the model of the first `rerank()` or `initialize()`; call
 * `initialize(modelId)` to load another.
 *
 * @example
 * ```typescript
 * const reranker = new LocalCrossEncoderReranker({
 *   providerId: 'local',
 *   defaultModelId: 'cross-encoder/ms-marco-MiniLM-L-6-v2',
 *   device: 'cpu',
 *   batchSize: 32
 * });
 *
 * await reranker.initialize(); // Downloads model if not cached
 *
 * const result = await reranker.rerank(
 *   { query: 'machine learning', documents: [...] },
 *   { providerId: 'local', modelId: 'cross-encoder/ms-marco-MiniLM-L-6-v2' }
 * );
 * ```
 */
export class LocalCrossEncoderReranker implements IRerankerProvider {
  public readonly providerId = 'local' as const;

  private readonly config: LocalCrossEncoderConfig;
  private pipeline: any = null;
  private isInitialized = false;
  private initializationPromise: Promise<void> | null = null;

  constructor(config: LocalCrossEncoderConfig) {
    this.config = {
      ...config,
      defaultModelId: config.defaultModelId ?? 'cross-encoder/ms-marco-MiniLM-L-6-v2',
      device: config.device ?? 'cpu',
      maxSequenceLength: config.maxSequenceLength ?? 512,
      batchSize: config.batchSize ?? 32,
    };
  }

  /**
   * Initialize the model pipeline.
   * Call this before first use or let rerank() handle lazy initialization.
   */
  public async initialize(modelId?: string): Promise<void> {
    if (this.isInitialized && !modelId) {
      return;
    }

    // Prevent multiple concurrent initializations
    if (this.initializationPromise) {
      await this.initializationPromise;
      return;
    }

    this.initializationPromise = this._doInitialize(modelId ?? this.config.defaultModelId!);
    await this.initializationPromise;
    this.initializationPromise = null;
  }

  private async _doInitialize(modelId: string): Promise<void> {
    try {
      // Dynamic import to avoid bundling issues and allow optional dependency.
      // Prefer `@huggingface/transformers` (Transformers.js v3+) but support `@xenova/transformers` for back-compat.
      const { pipeline, env } = await (async () => {
        try {
          return await import('@huggingface/transformers');
        } catch {
          return await import('@xenova/transformers');
        }
      })();

      // Configure cache directory if specified
      if (this.config.cacheDir) {
        env.cacheDir = this.config.cacheDir;
      }

      // Configure device
      if (this.config.device === 'gpu') {
        env.backends.onnx.wasm.numThreads = 1; // Use GPU
      }

      // Load the cross-encoder pipeline
      // For cross-encoders, we use 'text-classification' pipeline
      // since they output a relevance score
      this.pipeline = await pipeline('text-classification', modelId, {
        quantized: true, // Use quantized model for faster inference
      });

      this.isInitialized = true;
    } catch (error) {
      if (error instanceof Error && error.message.includes('Cannot find module')) {
        throw new Error(
          "LocalCrossEncoderReranker: Transformers.js is not installed. " +
            "Install it with: pnpm add @huggingface/transformers (preferred) " +
            "or pnpm add @xenova/transformers",
        );
      }
      throw error;
    }
  }

  /**
   * Check if the local reranker is available.
   */
  public async isAvailable(): Promise<boolean> {
    try {
      // Check if transformers.js is available
      await import('@huggingface/transformers');
      return true;
    } catch {
      try {
        await import('@xenova/transformers');
        return true;
      } catch {
        return false;
      }
    }
  }

  /**
   * Get supported local reranker models.
   */
  public getSupportedModels(): string[] {
    return [...LOCAL_RERANKER_MODELS];
  }

  /**
   * Rerank documents using a local cross-encoder model.
   */
  public async rerank(
    input: RerankerInput,
    config: RerankerRequestConfig,
  ): Promise<RerankerOutput> {
    const modelId = config.modelId || this.config.defaultModelId!;
    const startTime = Date.now();

    // Lazy initialization
    if (!this.isInitialized) {
      await this.initialize(modelId);
    }

    // Cross-encoders take query-document pairs and output relevance scores
    // Format: "query [SEP] document" or as separate inputs depending on model
    const pairs = input.documents.map((doc) => ({
      text: input.query,
      text_pair: doc.content,
    }));

    // Process in batches
    const batchSize = this.config.batchSize!;
    const scores: number[] = [];

    for (let i = 0; i < pairs.length; i += batchSize) {
      const batch = pairs.slice(i, i + batchSize);

      // Run inference
      // Most cross-encoders output a single score (or logits that we convert to score)
      for (const pair of batch) {
        try {
          // transformers.js text-classification returns array of {label, score}
          // For cross-encoders, we typically want the positive class score
          const result = await this.pipeline(`${pair.text} [SEP] ${pair.text_pair}`, {
            truncation: true,
            max_length: this.config.maxSequenceLength,
          });

          // Handle different output formats
          let score: number;
          if (Array.isArray(result) && result.length > 0) {
            // Standard text-classification output
            // For binary classifiers: find LABEL_1 or positive class
            const positiveResult = result.find(
              (r: any) => r.label === 'LABEL_1' || r.label === 'POSITIVE' || r.label === '1',
            );
            score = positiveResult?.score ?? result[0].score;
          } else if (typeof result === 'number') {
            score = result;
          } else {
            score = 0;
          }

          scores.push(score);
        } catch (error) {
          console.warn(`LocalCrossEncoderReranker: Error scoring document, using 0:`, error);
          scores.push(0);
        }
      }
    }

    const latencyMs = Date.now() - startTime;

    // Combine scores with documents and sort by score descending
    const scoredDocs = input.documents.map((doc, idx) => ({
      id: doc.id,
      content: doc.content,
      relevanceScore: scores[idx],
      originalScore: doc.originalScore,
      metadata: doc.metadata,
    }));

    scoredDocs.sort((a, b) => b.relevanceScore - a.relevanceScore);

    // Apply topN if specified
    const results = config.topN ? scoredDocs.slice(0, config.topN) : scoredDocs;

    return {
      results,
      diagnostics: {
        modelId,
        providerId: this.providerId,
        latencyMs,
        documentsProcessed: input.documents.length,
        providerMetrics: {
          batchSize: this.config.batchSize,
          device: this.config.device,
        },
      },
    };
  }

  /**
   * Unload the model from memory.
   * Call this when you're done with the reranker to free resources.
   */
  public async dispose(): Promise<void> {
    if (this.pipeline && typeof this.pipeline.dispose === 'function') {
      await this.pipeline.dispose();
    }
    this.pipeline = null;
    this.isInitialized = false;
  }
}
