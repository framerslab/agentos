/**
 * @fileoverview Local cross-encoder reranker run in process through Transformers.js.
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
 * Transformers.js 3.x data types. The dtype picks the suffix Transformers.js
 * appends to the weights file name: `fp32` none, `fp16` `_fp16`, `q8`
 * `_quantized`, `int8` `_int8`, `uint8` `_uint8`, `q4` `_q4`, `bnb4` `_bnb4`,
 * `q4f16` `_q4f16`.
 */
export type LocalCrossEncoderDtype = 'fp32' | 'fp16' | 'q8' | 'int8' | 'uint8' | 'q4' | 'bnb4' | 'q4f16';

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
   * Device hint, reported in the diagnostics. Default 'cpu'. No value
   * selects a GPU: the model is loaded without a device option, so
   * Transformers.js picks the backend.
   * - 'gpu' sets Transformers.js's ONNX WASM backend to one thread
   *   (`env.backends.onnx.wasm.numThreads = 1`), a process-wide setting
   *   that every Transformers.js model in the process shares.
   * - 'cpu' and 'auto' change nothing.
   */
  device?: 'cpu' | 'gpu' | 'auto';
  /**
   * Maximum tokens per (query, document) pair; the tokenizer cuts the end of
   * a longer pair, which is the document's tail.
   * Default: 512
   */
  maxSequenceLength?: number;
  /**
   * Pairs scored in one forward pass of the model.
   * Default: 32
   */
  batchSize?: number;
  /**
   * Folder Transformers.js caches downloaded model files in, passed to each
   * load as `cache_dir`.
   * Default: Transformers.js's own cache (`env.cacheDir`)
   */
  cacheDir?: string;
  /**
   * The ONNX weights file to load from the model repository's `onnx/`
   * folder, without `.onnx`, for example `'model'` (full precision) or
   * `'model_qint8_arm64'`. Transformers.js 3.x appends the `dtype` suffix to
   * it (none for `fp32`).
   *
   * Default: the model's entry in {@link LOCAL_RERANKER_DEFAULT_WEIGHTS}
   * (for `cross-encoder/ms-marco-MiniLM-L-6-v2`, `'model_quint8_avx2'`), else
   * `'model'` (`onnx/model.onnx`, full precision).
   */
  modelFileName?: string;
  /**
   * Transformers.js 3.x data type of the weights, which picks the suffix of
   * the file loaded. `'q8'` loads `onnx/<modelFileName>_quantized.onnx`, a
   * file the `cross-encoder/*` repositories do not hold: name their
   * quantized files with `modelFileName` instead.
   * Default: 'fp32' (no suffix)
   */
  dtype?: LocalCrossEncoderDtype;
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
 * The weights file loaded for a model when the config names neither
 * `modelFileName` nor `dtype`. A model not listed here loads `onnx/model.onnx`
 * (full precision).
 *
 * `cross-encoder/ms-marco-MiniLM-L-6-v2` (and its new id,
 * `cross-encoder/ms-marco-MiniLM-L6-v2`) loads the repository's 8-bit
 * dynamically quantized `onnx/model_quint8_avx2.onnx` (22 MB, against 87 MB
 * for `onnx/model.onnx`). It ranks as the full-precision file does on a
 * query with one answering text in 20, and scores a batch in about half the
 * time on a 2-vCPU x86 host. The repository also holds
 * `onnx/model_qint8_arm64.onnx` (the same bytes as `model_qint8_avx512`) for
 * ARM hosts; name it with `modelFileName`.
 */
export const LOCAL_RERANKER_DEFAULT_WEIGHTS: Readonly<Record<string, string>> = Object.freeze({
  'cross-encoder/ms-marco-MiniLM-L-6-v2': 'model_quint8_avx2',
  'cross-encoder/ms-marco-MiniLM-L6-v2': 'model_quint8_avx2',
});

/** Labels that name the relevant class of a model with two or more logits. */
const POSITIVE_LABELS = new Set(['label_1', 'positive', '1', 'relevant', 'true', 'yes', 'entailment']);

/** The DTYPE suffix Transformers.js 3.x appends to a weights file name. */
const DTYPE_SUFFIX: Record<LocalCrossEncoderDtype, string> = {
  fp32: '',
  fp16: '_fp16',
  q8: '_quantized',
  int8: '_int8',
  uint8: '_uint8',
  q4: '_q4',
  bnb4: '_bnb4',
  q4f16: '_q4f16',
};

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

/** A loaded model with its tokenizer, and the reranks using it. */
interface LoadedCrossEncoder {
  modelId: string;
  /** The weights file loaded, as `onnx/<name>.onnx`. */
  modelFile: string;
  tokenizer: any;
  model: any;
  /** The class index read as relevance for a model with two or more logits. */
  positiveIndex: number;
  /** Reranks scoring with this model right now. */
  active: number;
  /** Replaced or unloaded: disposed once `active` falls to 0. */
  retired: boolean;
  disposed: boolean;
}

/**
 * Local cross-encoder reranker.
 *
 * Runs cross-encoder models in process through Transformers.js
 * (`@huggingface/transformers`, else `@xenova/transformers` 2.x), with
 * `AutoTokenizer` and `AutoModelForSequenceClassification`. Scoring sends
 * nothing over the network: the query and documents stay in the process.
 *
 * Each batch of up to `batchSize` documents is tokenized as (query,
 * document) pairs, padded and truncated to `maxSequenceLength`, and scored in
 * one forward pass. A model with one logit (the `cross-encoder/*` and
 * `BAAI/bge-reranker-*` models) scores a pair with the sigmoid of that
 * logit; a model with two or more logits scores it with the softmax
 * probability of its relevant class (a label `LABEL_1`, `POSITIVE`,
 * `relevant` and the like in `id2label`, else class 1). Scores sit between 0
 * and 1 and keep the order of the logits, so they compare within one model,
 * not across models.
 *
 * What loads: the model's tokenizer files and one ONNX weights file, picked
 * by `modelFileName` and `dtype` (by default
 * `onnx/model_quint8_avx2.onnx` for the default model, `onnx/model.onnx` for
 * the others; see {@link LOCAL_RERANKER_DEFAULT_WEIGHTS}). Transformers.js
 * fetches them on the first load and reads them from its cache (`cacheDir`)
 * after that. The model loads once, for the model of the first `rerank()` or
 * `initialize()`; call `initialize(modelId)` to load another.
 *
 * @example
 * ```typescript
 * const reranker = new LocalCrossEncoderReranker({
 *   providerId: 'local',
 *   defaultModelId: 'cross-encoder/ms-marco-MiniLM-L-6-v2',
 *   batchSize: 32,
 * });
 *
 * await reranker.initialize(); // Downloads the model files if not cached
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
  /** The model reranks use; a rerank holds on to the one it started with. */
  private loaded: LoadedCrossEncoder | null = null;
  /** The tail of the queue that loads and unloads run in, one at a time. */
  private loadQueue: Promise<void> | null = null;

  constructor(config: LocalCrossEncoderConfig) {
    this.config = {
      ...config,
      defaultModelId: config.defaultModelId ?? 'cross-encoder/ms-marco-MiniLM-L-6-v2',
      device: config.device ?? 'cpu',
      maxSequenceLength: config.maxSequenceLength ?? 512,
      // A batch size that is not a positive number (0, NaN) falls back to the default.
      batchSize: Number.isFinite(config.batchSize) && config.batchSize! >= 1 ? Math.floor(config.batchSize!) : 32,
    };
  }

  /**
   * Load the tokenizer and model.
   * Call this before first use or let rerank() load them on its first call.
   * With a `modelId` other than the loaded one, loads that model instead.
   *
   * Loads run one at a time, in the order they were asked for, so concurrent
   * calls for different models never load at once and the last call's model
   * is the one left loaded. A rerank already running keeps scoring with the
   * model it started with; a model replaced while reranks use it is disposed
   * when the last of them finishes.
   */
  public async initialize(modelId?: string): Promise<void> {
    const target = modelId || this.config.defaultModelId!;
    if (!this.loadQueue && this.loaded?.modelId === target) {
      return;
    }
    await this.enqueue(async () => {
      if (this.loaded?.modelId === target) return;
      await this._doInitialize(target);
    });
  }

  /** Run `task` after every load or unload queued before it; a failed task does not stop the next. */
  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = (this.loadQueue ?? Promise.resolve()).catch(() => undefined).then(task);
    this.loadQueue = run;
    const clear = (): void => {
      if (this.loadQueue === run) this.loadQueue = null;
    };
    run.then(clear, clear);
    return run;
  }

  /** Mark `entry` replaced; dispose its model now if no rerank uses it, else when the last one finishes. */
  private async retire(entry: LoadedCrossEncoder): Promise<void> {
    entry.retired = true;
    if (entry.active === 0) await this.disposeEntry(entry);
  }

  private async disposeEntry(entry: LoadedCrossEncoder): Promise<void> {
    if (entry.disposed) return;
    entry.disposed = true;
    if (typeof entry.model?.dispose === 'function') {
      await entry.model.dispose();
    }
  }

  /** The weights file and dtype for `modelId`: the config's, else the model's default. */
  private weightsFor(modelId: string): { modelFileName: string; dtype: LocalCrossEncoderDtype } {
    if (this.config.modelFileName !== undefined || this.config.dtype !== undefined) {
      return { modelFileName: this.config.modelFileName ?? 'model', dtype: this.config.dtype ?? 'fp32' };
    }
    return { modelFileName: LOCAL_RERANKER_DEFAULT_WEIGHTS[modelId] ?? 'model', dtype: 'fp32' };
  }

  private async _doInitialize(modelId: string): Promise<void> {
    let transformers: any;
    try {
      // Dynamic import to avoid bundling issues and allow optional dependency.
      // Prefer `@huggingface/transformers` (Transformers.js v3+) but support `@xenova/transformers` for back-compat.
      transformers = await (async () => {
        try {
          return await import('@huggingface/transformers');
        } catch {
          return await import('@xenova/transformers');
        }
      })();
    } catch {
      throw new Error(
        'LocalCrossEncoderReranker: Transformers.js is not installed. ' +
          'Install it with: pnpm add @huggingface/transformers (preferred) ' +
          'or pnpm add @xenova/transformers',
      );
    }

    const { AutoTokenizer, AutoModelForSequenceClassification, env } = transformers;
    if (!AutoTokenizer?.from_pretrained || !AutoModelForSequenceClassification?.from_pretrained) {
      throw new Error(
        'LocalCrossEncoderReranker: the installed Transformers.js has no AutoTokenizer or ' +
          'AutoModelForSequenceClassification; install @huggingface/transformers 3.x.',
      );
    }

    // Configure device
    if (this.config.device === 'gpu' && env?.backends?.onnx?.wasm) {
      env.backends.onnx.wasm.numThreads = 1;
    }

    const { modelFileName, dtype } = this.weightsFor(modelId);
    const cacheOptions = this.config.cacheDir ? { cache_dir: this.config.cacheDir } : {};

    const [tokenizer, model] = await Promise.all([
      AutoTokenizer.from_pretrained(modelId, cacheOptions),
      AutoModelForSequenceClassification.from_pretrained(modelId, {
        ...cacheOptions,
        // Transformers.js 3.x: the file is onnx/<model_file_name><dtype suffix>.onnx.
        model_file_name: modelFileName,
        dtype,
        // Transformers.js 2.x (@xenova/transformers) reads `quantized` instead of `dtype`.
        quantized: dtype === 'q8',
      }),
    ]);

    const previous = this.loaded;
    this.loaded = {
      modelId,
      modelFile: `onnx/${modelFileName}${DTYPE_SUFFIX[dtype] ?? ''}.onnx`,
      tokenizer,
      model,
      positiveIndex: this.findPositiveIndex(model?.config?.id2label),
      active: 0,
      retired: false,
      disposed: false,
    };
    if (previous && previous.model !== model) {
      await this.retire(previous);
    }
  }

  /** The class index of the relevant label in `id2label`, else 1. */
  private findPositiveIndex(id2label: Record<string, string> | undefined): number {
    if (id2label && typeof id2label === 'object') {
      for (const [index, label] of Object.entries(id2label)) {
        if (typeof label === 'string' && POSITIVE_LABELS.has(label.toLowerCase())) {
          const i = Number(index);
          if (Number.isInteger(i) && i >= 0) return i;
        }
      }
    }
    return 1;
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

  /** Scores for one batch of documents: one forward pass over the (query, document) pairs. */
  private async scoreBatch(loaded: LoadedCrossEncoder, query: string, documents: string[]): Promise<number[]> {
    // Transformers.js takes the second text of each pair as the `text_pair` option.
    const inputs = loaded.tokenizer(new Array(documents.length).fill(query), {
      text_pair: documents,
      padding: true,
      truncation: true,
      max_length: this.config.maxSequenceLength,
    });
    const output = await loaded.model(inputs);
    const logits = output?.logits;
    const data: ArrayLike<number> | undefined = logits?.data;
    const dims: number[] = Array.isArray(logits?.dims) ? logits.dims : [];
    const classes = dims.length > 1 ? dims[dims.length - 1] : 1;
    if (!data || classes < 1 || data.length !== documents.length * classes) {
      throw new Error(
        `LocalCrossEncoderReranker: the model returned logits of shape [${dims.join(', ')}] ` +
          `for ${documents.length} pairs`,
      );
    }

    // A NaN or infinite logit has no rank: throw, so callers keep the order they had.
    for (let k = 0; k < data.length; k++) {
      if (!Number.isFinite(Number(data[k]))) {
        throw new Error(
          `LocalCrossEncoderReranker: the model returned a non-finite logit (${Number(data[k])}) ` +
            `for pair ${Math.floor(k / classes)} of ${documents.length}`,
        );
      }
    }

    const scores: number[] = [];
    for (let i = 0; i < documents.length; i++) {
      if (classes === 1) {
        scores.push(sigmoid(Number(data[i])));
        continue;
      }
      const row = Array.from({ length: classes }, (_, k) => Number(data[i * classes + k]));
      const max = Math.max(...row);
      const exps = row.map((x) => Math.exp(x - max));
      const sum = exps.reduce((a, b) => a + b, 0);
      const positive = loaded.positiveIndex < classes ? loaded.positiveIndex : classes - 1;
      scores.push(exps[positive] / sum);
    }
    return scores;
  }

  /**
   * Rerank documents using a local cross-encoder model.
   *
   * Throws when Transformers.js or the model cannot be loaded, a forward
   * pass fails, or the model returns a NaN or infinite logit;
   * `RerankerService` callers then keep the order they had.
   *
   * Every batch of one call is scored by the model loaded when the call
   * began, even if `initialize()` loads another model meanwhile.
   */
  public async rerank(
    input: RerankerInput,
    config: RerankerRequestConfig,
  ): Promise<RerankerOutput> {
    const startTime = Date.now();

    // Lazy initialization: load the request's model only when none is loaded.
    if (!this.loaded) {
      await this.initialize(config.modelId || this.config.defaultModelId!);
    }
    const loaded = this.loaded;
    if (!loaded) {
      throw new Error('LocalCrossEncoderReranker: the model was unloaded before scoring began');
    }
    const modelId = loaded.modelId;

    const batchSize = this.config.batchSize!;
    const scores: number[] = [];
    let forwardPasses = 0;
    loaded.active++;
    try {
      for (let i = 0; i < input.documents.length; i += batchSize) {
        const batch = input.documents.slice(i, i + batchSize).map((doc) => doc.content);
        scores.push(...(await this.scoreBatch(loaded, input.query, batch)));
        forwardPasses++;
      }
    } finally {
      loaded.active--;
      if (loaded.retired && loaded.active === 0) {
        await this.disposeEntry(loaded);
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
          batchSize,
          forwardPasses,
          modelFile: loaded.modelFile,
          device: this.config.device,
        },
      },
    };
  }

  /**
   * Unload the model from memory.
   * Call this when you're done with the reranker to free resources.
   * Runs after any load already queued; reranks already running finish on
   * the model first, and it is disposed when the last of them ends.
   */
  public async dispose(): Promise<void> {
    await this.enqueue(async () => {
      const entry = this.loaded;
      this.loaded = null;
      if (entry) await this.retire(entry);
    });
  }
}
