/**
 * @fileoverview BM25 sparse keyword index for hybrid retrieval.
 *
 * Dense embeddings excel at semantic similarity but miss exact keyword matches
 * (e.g., error codes, function names, product IDs). BM25 catches these by
 * scoring documents based on term frequency, inverse document frequency,
 * and document length normalization.
 *
 * Used alongside vector search in a hybrid fusion strategy:
 * - Vector search handles semantic "what does this mean?" queries
 * - BM25 handles lexical "find this exact thing" queries
 * - Reciprocal Rank Fusion (RRF) merges both result sets
 *
 * The BM25 ranking function is:
 * ```
 * score(D, Q) = sum_{t in Q} IDF(t) * (tf(t,D) * (k1 + 1)) / (tf(t,D) + k1 * (1 - b + b * |D| / avgdl))
 * ```
 *
 * Where:
 * - `k1` controls term frequency saturation (default 1.2)
 * - `b` controls document length normalization (default 0.75)
 * - `IDF(t) = log((N - n(t) + 0.5) / (n(t) + 0.5) + 1)` (Robertson-Walker IDF)
 *
 * @module agentos/rag/search/BM25Index
 * @see HybridSearcher for combining BM25 with dense vector search
 */

import { getNaturalStopWords } from '../../nlp/filters/StopWordFilter';
import { LexicalIndex, type LexicalIndexJSON } from './LexicalIndex.js';

export type { BM25Document, BM25Result, BM25Stats } from './LexicalIndex.js';

/**
 * Configuration options for the BM25 index.
 *
 * @interface BM25Config
 * @property {number} [k1=1.2] - Term saturation parameter. Higher values increase
 *   the influence of term frequency. Range: 1.2-2.0 typical.
 * @property {number} [b=0.75] - Document length normalization factor.
 *   0 = no normalization, 1 = full normalization. Range: 0-1.
 * @property {Function} [tokenize] - A tokenizer used in place of `pipeline` and the built-in one.
 */
export interface BM25Config {
  /** Term saturation parameter. Default: 1.2. */
  k1?: number;
  /** Document length normalization factor. Default: 0.75. */
  b?: number;
  /**
   * Optional text processing pipeline for tokenization.
   * When provided, replaces the built-in regex tokenizer with configurable
   * stemming, lemmatization, and stop word handling.
   * @see createRagPipeline from nlp for the recommended default.
   */
  pipeline?: import('../../nlp/TextProcessingPipeline').TextProcessingPipeline;
  /** A tokenizer in place of the pipeline and the built-in one. When given, `pipeline` is not used. */
  tokenize?: (text: string) => string[];
}

/** The stop words of the built-in tokenizer, read on first use (natural's list when it is installed). */
let stopWords: ReadonlySet<string> | undefined;

/** The built-in tokenizer: lower case, split on white space and punctuation, stop words and one-letter tokens dropped. */
function builtInTokenize(text: string): string[] {
  stopWords ??= getNaturalStopWords();
  const stops = stopWords;
  return text
    .toLowerCase()
    .split(/[\s\-_.,;:!?'"()[\]{}<>/\\|@#$%^&*~`+=]+/)
    .filter((token) => token.length >= 2 && !stops.has(token));
}

/**
 * BM25 sparse keyword index for hybrid retrieval.
 *
 * Dense embeddings excel at semantic similarity but miss exact keyword matches
 * (e.g., error codes, function names, product IDs). BM25 catches these by
 * scoring documents based on term frequency, inverse document frequency,
 * and document length normalization.
 *
 * It is a {@link LexicalIndex} with AgentOS's tokenizer: the configured
 * `tokenize` or `pipeline`, else the built-in one, whose stop words are
 * `natural`'s English list when that package loads and `ENGLISH_STOP_WORDS`
 * otherwise, read on the first tokenization, not when the module is imported.
 * `toJSON()` saves it and {@link BM25Index.fromJSON} restores it.
 *
 * @example Basic usage
 * ```typescript
 * const index = new BM25Index({ k1: 1.5, b: 0.75 });
 *
 * index.addDocuments([
 *   { id: 'doc-1', text: 'TypeScript compiler error TS2304' },
 *   { id: 'doc-2', text: 'JavaScript runtime TypeError explanation' },
 *   { id: 'doc-3', text: 'Fix error TS2304 by adding type declarations' },
 * ]);
 *
 * const results = index.search('error TS2304', 5);
 * // results[0].id === 'doc-3' (exact match on "error" + "TS2304")
 * // results[1].id === 'doc-1' (exact match on "error" + "TS2304")
 * ```
 *
 * @example Combined with HybridSearcher
 * ```typescript
 * const hybrid = new HybridSearcher(vectorStore, embeddingManager, bm25Index, {
 *   denseWeight: 0.7,
 *   sparseWeight: 0.3,
 * });
 * const results = await hybrid.search('What does error TS2304 mean?');
 * ```
 */
export class BM25Index extends LexicalIndex {
  /**
   * Creates a new BM25 index.
   *
   * @param {BM25Config} [config] - Optional BM25 tuning parameters and tokenizer.
   * @param {number} [config.k1=1.2] - Term saturation parameter.
   * @param {number} [config.b=0.75] - Document length normalization.
   *
   * @example
   * ```typescript
   * // Use defaults (k1=1.2, b=0.75)
   * const index = new BM25Index();
   *
   * // Custom parameters for short documents
   * const shortDocIndex = new BM25Index({ k1: 1.5, b: 0.5 });
   * ```
   */
  constructor(config?: BM25Config) {
    const pipeline = config?.pipeline;
    super({
      k1: config?.k1,
      b: config?.b,
      tokenize: config?.tokenize ?? (pipeline ? (text: string) => pipeline.processToStrings(text) : builtInTokenize),
    });
  }

  /**
   * A saved index restored; give the configuration it was made with. Its k1 and b come from the saved index, and
   * its tokenizer from `config`, which must read text as the one the index was made with.
   */
  static override fromJSON(json: LexicalIndexJSON, config?: BM25Config): BM25Index {
    const index = new BM25Index(config);
    index.restore(json);
    return index;
  }
}
