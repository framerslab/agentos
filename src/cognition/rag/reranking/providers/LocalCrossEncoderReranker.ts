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
import { importOptional } from '../../../../core/utils/importOptional.js';

/** Transformers.js 3.x, the preferred package. */
const TRANSFORMERS = '@huggingface/transformers';
/** Transformers.js 2.x, the fallback. */
const TRANSFORMERS_V2 = '@xenova/transformers';

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
   * Default: 'cross-encoder/ms-marco-MiniLM-L6-v2'
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
   * Maximum tokens per (query, document) pair. The tokenizer cuts a longer
   * pair at this many tokens, so it loses the end of the document and its
   * closing separator token (Transformers.js truncates every pair's token
   * arrays to the length). An answer late in a long document is then never
   * read: score such documents in pieces with `pieceMaxChars`.
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
   * Load the model's files from the cache alone (`cacheDir`, else Transformers.js's own), never the network, passed
   * to each load as `local_files_only`. A file the cache lacks fails the load. With a `revision`, Transformers.js
   * reads the files from `<cache>/<model id>/<revision>/`; without one, from `<cache>/<model id>/`.
   * Default: false (a file the cache lacks is downloaded)
   */
  localFilesOnly?: boolean;
  /**
   * The ONNX weights file to load from the model repository's `onnx/`
   * folder, for example `'model'` (full precision) or `'model_qint8_arm64'`.
   * A path in that folder or a name with the extension names the same file:
   * `'onnx/model_qint8_arm64.onnx'` and `'model_qint8_arm64.onnx'` load
   * `onnx/model_qint8_arm64.onnx` (a leading `onnx/` and a trailing `.onnx`
   * are dropped). Transformers.js 3.x appends the `dtype` suffix to it (none
   * for `fp32`).
   *
   * Default: the model's entry in {@link LOCAL_RERANKER_DEFAULT_WEIGHTS}
   * (for `cross-encoder/ms-marco-MiniLM-L6-v2`, `'model_quint8_avx2'`), else
   * `'model'` (`onnx/model.onnx`, full precision).
   */
  modelFileName?: string;
  /**
   * Transformers.js 3.x data type of the weights, which picks the suffix of
   * the file loaded. `'q8'` loads `onnx/<modelFileName>_quantized.onnx`, a
   * file the `cross-encoder/*` repositories do not hold: name their
   * quantized files with `modelFileName` instead.
   *
   * The provider always passes a dtype (`'fp32'` unless set). In a browser,
   * where Transformers.js 3.x would otherwise default the WASM backend to
   * `'q8'`, the file loaded is still `onnx/<modelFileName>.onnx` unless
   * `dtype` says otherwise. Transformers.js 2.x reads no dtype: it loads
   * `onnx/<modelFileName>_quantized.onnx` for `'q8'` and
   * `onnx/<modelFileName>.onnx` for any other value.
   * Default: 'fp32' (no suffix)
   */
  dtype?: LocalCrossEncoderDtype;
  /**
   * Threads onnxruntime runs one operator on, passed to the ONNX session as
   * `session_options.intraOpNumThreads`. A host on a CPU limit (a container's
   * cpuset or CPU quota, a share of a host other processes use) sets it to
   * the number of cores it may use; `1` runs each operator on the calling
   * thread.
   *
   * Unset, the session gets no thread count and onnxruntime sizes its pool
   * itself: onnxruntime-node 1.21 sizes it to the physical cores of the
   * whole machine (on Linux pinning a thread to each core), whatever CPU
   * limit the process runs under, so inside a limit its threads contend for
   * the few cores the process has. Read by onnxruntime-node (Transformers.js
   * 3.x on Node); onnxruntime-web and Transformers.js 2.x do not read it.
   *
   * A whole number from 1 (a fraction is rounded down); any other value
   * leaves the count to onnxruntime.
   * Default: unset
   */
  intraOpNumThreads?: number;
  /**
   * Threads onnxruntime may run independent operators on at once, passed to
   * the ONNX session as `session_options.interOpNumThreads`. onnxruntime
   * creates this pool only in its parallel execution mode, and the sessions
   * Transformers.js creates run in the default sequential mode, so the value
   * reaches the session without changing how it runs; set
   * `intraOpNumThreads` to bound the threads.
   *
   * A whole number from 1 (a fraction is rounded down); any other value
   * leaves it unset.
   * Default: unset
   */
  interOpNumThreads?: number;
  /**
   * Best-piece scoring, off unless set: the longest piece of a document, in
   * characters, scored as a pair of its own.
   *
   * A document longer than this is split into pieces of at most this many
   * characters (UTF-16 units, as `String.length` counts them; a character
   * outside the Basic Multilingual Plane is never split, so at 1 it is a
   * piece of 2): its sentences in order (a sentence ends at `.`, `!` or `?`
   * before a space, and at a line break), packed together while they fit and
   * joined by one space. A sentence longer than a piece is split between
   * words, and only a word longer than a piece is cut. A document of this
   * length or shorter is one piece, as given.
   *
   * Every piece of every document is a (query, piece) pair, scored in the
   * same batches of `batchSize` pairs, and a document's score is its best
   * piece's. The result's `content` is the whole document. Pick a length at
   * which a piece and the query fit in `maxSequenceLength` tokens. Each
   * piece is a pair, so pairs grow with a document's length: a
   * 1,024-character document at 300 is four pairs or more, a
   * 100,000-character one 334 or more. Cut documents that can run that long
   * before reranking them.
   *
   * A whole number from 1 (a fraction is rounded down); 0 or any other value
   * leaves scoring whole documents.
   * Default: unset (each document is one pair)
   */
  pieceMaxChars?: number;
}

/**
 * The local cross-encoder models AgentOS lists (Hugging Face model ids), each under a licence read at its
 * repository: apache-2.0, apache-2.0, mit. The provider loads any other id a host passes; checking that model's
 * licence is then the host's.
 */
export const LOCAL_RERANKER_MODELS = [
  'cross-encoder/ms-marco-MiniLM-L6-v2', // apache-2.0. The default: fast, good quality
  'cross-encoder/ms-marco-MiniLM-L12-v2', // apache-2.0. Better quality, slower
  'BAAI/bge-reranker-base', // mit
] as const;

export type LocalRerankerModel = (typeof LOCAL_RERANKER_MODELS)[number];

/**
 * The weights file loaded for a model when the config names neither
 * `modelFileName` nor `dtype`. A model not listed here loads `onnx/model.onnx`
 * (full precision).
 *
 * `cross-encoder/ms-marco-MiniLM-L6-v2` (and its earlier id,
 * `cross-encoder/ms-marco-MiniLM-L-6-v2`, which Hugging Face redirects to it) loads the repository's 8-bit
 * dynamically quantized `onnx/model_quint8_avx2.onnx` (22 MB, against 87 MB
 * for `onnx/model.onnx`). It ranks as the full-precision file does on a
 * query with one answering text in 20, and scores a batch in about half the
 * time on a 2-vCPU x86 host. It loads and runs on ARM hosts too; the
 * repository's `onnx/model_qint8_arm64.onnx` (the same bytes as
 * `model_qint8_avx512`) is the file quantized for ARM, which
 * `modelFileName` can name.
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

/** `value` rounded down when it is a finite number of at least 1, else `undefined`. */
const positiveInteger = (value: number | undefined): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : undefined;

/** A weights file name as Transformers.js takes it: no leading `onnx/` folder and no `.onnx` extension. */
const bareWeightsName = (name: string): string => name.replace(/^(?:\.\/)?onnx\//, '').replace(/\.onnx$/i, '');

/**
 * A sentence's end: `.`, `!` or `?` (with any closing quotes or brackets after
 * it) and the spaces that follow. A line break ends a sentence too.
 */
const SENTENCE_END = /([.!?]["'\u2019\u201D)\]]*)\s+/g;

/** `text` split into its sentences, at each sentence end and line break. */
const sentencesOf = (text: string): string[] => text.replace(SENTENCE_END, '$1\n').split(/[\r\n]+/);

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/**
 * `word` cut into parts of at most `maxChars` UTF-16 units, never inside a
 * surrogate pair (a character outside the Basic Multilingual Plane): a cut
 * that would split one moves before it, or, when the part holds only the
 * pair's first half (`maxChars` 1), after it.
 */
function cutWord(word: string, maxChars: number): string[] {
  const parts: string[] = [];
  for (let start = 0; start < word.length; ) {
    let end = Math.min(start + maxChars, word.length);
    if (end < word.length && isHighSurrogate(word.charCodeAt(end - 1)) && isLowSurrogate(word.charCodeAt(end))) {
      end = end - start > 1 ? end - 1 : end + 1;
    }
    parts.push(word.slice(start, end));
    start = end;
  }
  return parts;
}

/**
 * Dispose `model` if it has a `dispose()`, swallowing a throw or a rejection.
 * It runs for a model whose load already failed: the caller holds that load's
 * error, the provider has no logger, and a session that fails to release is
 * nothing the caller can act on, so a disposal error is dropped on purpose.
 */
const disposeQuietly = (model: any): Promise<void> =>
  Promise.resolve()
    .then(() => (typeof model?.dispose === 'function' ? model.dispose() : undefined))
    .then(
      () => undefined,
      () => undefined,
    );

/**
 * The pieces `pieceMaxChars` scores: `text` itself when it has at most
 * `maxChars` characters, else its sentences packed in order into pieces of at
 * most `maxChars` characters, joined by one space. A sentence longer than a
 * piece is packed word by word, and a word longer than a piece is cut.
 */
function splitIntoPieces(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const pieces: string[] = [];
  let current = '';
  const flush = (): void => {
    if (current) pieces.push(current);
    current = '';
  };
  const append = (unit: string): void => {
    if (current && current.length + 1 + unit.length <= maxChars) {
      current += ` ${unit}`;
    } else {
      flush();
      current = unit;
    }
  };
  for (const sentence of sentencesOf(text)) {
    const words = sentence.split(/\s+/).filter((word) => word.length > 0);
    if (words.length === 0) continue;
    const joined = words.join(' ');
    if (joined.length <= maxChars) {
      append(joined);
      continue;
    }
    for (const word of words) {
      if (word.length <= maxChars) {
        append(word);
        continue;
      }
      flush();
      const parts = cutWord(word, maxChars);
      // A loop, not a spread: a very long word can be more parts than a call takes arguments.
      for (let k = 0; k < parts.length - 1; k++) pieces.push(parts[k]);
      current = parts[parts.length - 1];
    }
  }
  flush();
  // A text of whitespace alone has no words; it is still one (empty) piece.
  return pieces.length > 0 ? pieces : [''];
}

/**
 * The (document index, text) pairs to score, in order: one per document, or
 * one per piece of it with `pieceMaxChars`. Made one document at a time, so
 * no more than one document's pieces exist before they are scored.
 */
function* pairsOf(
  documents: ReadonlyArray<{ content: string }>,
  pieceMaxChars: number | undefined,
): Generator<{ owner: number; text: string }> {
  for (let owner = 0; owner < documents.length; owner++) {
    const content = documents[owner].content;
    for (const text of pieceMaxChars ? splitIntoPieces(content, pieceMaxChars) : [content]) yield { owner, text };
  }
}

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
 * one forward pass. With `pieceMaxChars`, a long document is split into
 * pieces, every piece is a pair in those batches, and the document scores its
 * best piece's score. A model with one logit (the `cross-encoder/*` and
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
 * after that; `revision` pins the commit of the model's repository they come
 * from, and `localFilesOnly` loads from the cache alone. The model loads once, for the model of the first `rerank()` or
 * `initialize()`; call `initialize(modelId)` to load another. The ONNX
 * session gets `intraOpNumThreads` and `interOpNumThreads` when they are set;
 * a host on a CPU limit sets `intraOpNumThreads` to its cores.
 *
 * @example
 * ```typescript
 * const reranker = new LocalCrossEncoderReranker({
 *   providerId: 'local',
 *   defaultModelId: 'cross-encoder/ms-marco-MiniLM-L6-v2',
 *   batchSize: 32,
 * });
 *
 * await reranker.initialize(); // Downloads the model files if not cached
 *
 * const result = await reranker.rerank(
 *   { query: 'machine learning', documents: [...] },
 *   { providerId: 'local', modelId: 'cross-encoder/ms-marco-MiniLM-L6-v2' }
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
  /** The disposal of a model that a failed load left loading; the next queued task waits for it. */
  private lateModelCleanup: Promise<void> | null = null;

  constructor(config: LocalCrossEncoderConfig) {
    this.config = {
      ...config,
      defaultModelId: config.defaultModelId ?? 'cross-encoder/ms-marco-MiniLM-L6-v2',
      device: config.device ?? 'cpu',
      maxSequenceLength: config.maxSequenceLength ?? 512,
      // A batch size that is not a positive number (0, NaN) falls back to the default.
      batchSize: positiveInteger(config.batchSize) ?? 32,
      // A thread count or piece length that is not a positive number is left unset.
      intraOpNumThreads: positiveInteger(config.intraOpNumThreads),
      interOpNumThreads: positiveInteger(config.interOpNumThreads),
      pieceMaxChars: positiveInteger(config.pieceMaxChars),
    };
  }

  /**
   * Load the tokenizer and model.
   * Call this before first use or let rerank() load them on its first call.
   * With a `modelId` other than the loaded one, loads that model instead.
   * With no `modelId`, the model is `defaultModelId`: a reranker holding
   * another model (from `initialize(otherModelId)` or the `modelId` of its
   * first `rerank()`) loads the default model in its place.
   *
   * A load that fails throws as soon as the tokenizer or the model fails,
   * and leaves the model that was loaded before it, if any. A model that
   * loads after its tokenizer failed finishes loading in the background, and
   * the provider then calls its `dispose()`, dropping any error the disposal
   * throws; the next load, unload or retry waits for that, so two loads never
   * overlap. A failed load is not remembered: with no model loaded, the next
   * `rerank()` tries the load once more. When `initialize(otherModelId)`
   * fails while a model is loaded, reranks go on with the loaded model;
   * call `initialize(otherModelId)` again to retry the replacement.
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

  /**
   * Run `task` after every load or unload queued before it; a failed task does not stop the next. The caller
   * gets the task's own outcome at once, but the next task waits, too, for the disposal of any model the
   * task's failed load left loading, so two model loads never overlap.
   */
  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = (this.loadQueue ?? Promise.resolve()).catch(() => undefined).then(task);
    const tail: Promise<void> = run
      .catch(() => undefined)
      .then(() => {
        const cleanup = this.lateModelCleanup;
        this.lateModelCleanup = null;
        return cleanup ?? undefined;
      });
    this.loadQueue = tail;
    const clear = (): void => {
      if (this.loadQueue === tail) this.loadQueue = null;
    };
    tail.then(clear, clear);
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
      return {
        modelFileName: bareWeightsName(this.config.modelFileName ?? 'model'),
        dtype: this.config.dtype ?? 'fp32',
      };
    }
    return { modelFileName: LOCAL_RERANKER_DEFAULT_WEIGHTS[modelId] ?? 'model', dtype: 'fp32' };
  }

  private async _doInitialize(modelId: string): Promise<void> {
    let transformers: any;
    /** Transformers.js 2.x (`@xenova/transformers`), which reads `quantized` and not `dtype`. */
    let version2 = false;
    try {
      // Loaded at run time by a specifier a bundler does not follow, so a host bundles this module without them.
      // Prefer `@huggingface/transformers` (Transformers.js v3+) but support `@xenova/transformers` for back-compat.
      transformers = await (async () => {
        try {
          return await importOptional(TRANSFORMERS);
        } catch {
          version2 = true;
          return await importOptional(TRANSFORMERS_V2);
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
    // What both loads share: the cache folder, the pinned revision, and whether a file the cache lacks may be fetched.
    const cacheOptions = {
      ...(this.config.cacheDir ? { cache_dir: this.config.cacheDir } : {}),
      ...(this.config.revision ? { revision: this.config.revision } : {}),
      ...(this.config.localFilesOnly ? { local_files_only: true } : {}),
    };

    // onnxruntime-node reads these session options; left out, onnxruntime sizes its thread pool for the machine.
    const sessionOptions: { intraOpNumThreads?: number; interOpNumThreads?: number } = {};
    if (this.config.intraOpNumThreads !== undefined) sessionOptions.intraOpNumThreads = this.config.intraOpNumThreads;
    if (this.config.interOpNumThreads !== undefined) sessionOptions.interOpNumThreads = this.config.interOpNumThreads;

    const tokenizerLoad: Promise<any> = AutoTokenizer.from_pretrained(modelId, cacheOptions);
    const modelLoad: Promise<any> = AutoModelForSequenceClassification.from_pretrained(modelId, {
      ...cacheOptions,
      // Transformers.js 3.x: the file is onnx/<model_file_name><dtype suffix>.onnx.
      model_file_name: modelFileName,
      dtype,
      // Transformers.js 2.x (@xenova/transformers) reads `quantized` instead of `dtype`.
      quantized: dtype === 'q8',
      ...(Object.keys(sessionOptions).length > 0 ? { session_options: sessionOptions } : {}),
    });
    let tokenizer: any;
    let model: any;
    try {
      [tokenizer, model] = await Promise.all([tokenizerLoad, modelLoad]);
    } catch (error) {
      // The load fails as soon as either half fails. A model that loaded, or loads later, has its dispose() called
      // when its load ends, and the next queued load waits for that (see enqueue); the caller gets the load's
      // error now, whatever the disposal does.
      this.lateModelCleanup = modelLoad.then(disposeQuietly, () => undefined);
      throw error;
    }

    const previous = this.loaded;
    this.loaded = {
      modelId,
      // The file the installed Transformers.js loads by its own naming rule: 2.x adds `_quantized` or nothing.
      modelFile: version2
        ? `onnx/${modelFileName}${dtype === 'q8' ? '_quantized' : ''}.onnx`
        : `onnx/${modelFileName}${DTYPE_SUFFIX[dtype] ?? ''}.onnx`,
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
      await importOptional(TRANSFORMERS);
      return true;
    } catch {
      try {
        await importOptional(TRANSFORMERS_V2);
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
   * pass fails, or the model returns a NaN or infinite logit.
   * `RerankerService.rerankChain()` and `RetrievalAugmentor` then keep the
   * order they had; `RerankerService.rerank()` and `rerankChunks()` log the
   * error and throw it on, so their caller keeps its order only if it
   * catches.
   *
   * Every batch of one call is scored by the model loaded when the call
   * began, even if `initialize()` loads another model meanwhile.
   *
   * With `pieceMaxChars`, each document longer than it is scored as its
   * pieces: every piece of every document is a pair in the same batches, and
   * a document's `relevanceScore` is its best piece's score.
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
    const pieceMaxChars = this.config.pieceMaxChars;
    // A document's score is the best of its pairs' scores; every document has at least one pair.
    const scores: number[] = new Array(input.documents.length).fill(Number.NEGATIVE_INFINITY);
    let forwardPasses = 0;
    let pairsScored = 0;
    // The batch being filled: pair k's text and the index of its document. Pairs are made as batches fill,
    // so a long document's pieces never all sit in memory with every other document's.
    let texts: string[] = [];
    let owners: number[] = [];
    const scorePending = async (): Promise<void> => {
      const batchScores = await this.scoreBatch(loaded, input.query, texts);
      batchScores.forEach((score, j) => {
        if (score > scores[owners[j]]) scores[owners[j]] = score;
      });
      forwardPasses++;
      pairsScored += texts.length;
      texts = [];
      owners = [];
    };
    loaded.active++;
    try {
      for (const { owner, text } of pairsOf(input.documents, pieceMaxChars)) {
        texts.push(text);
        owners.push(owner);
        if (texts.length === batchSize) await scorePending();
      }
      if (texts.length > 0) await scorePending();
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
          pairsScored,
          ...(pieceMaxChars ? { pieceMaxChars } : {}),
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
