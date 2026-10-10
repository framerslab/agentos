/**
 * @fileoverview Hybrid search module combining dense vector search with BM25 sparse retrieval.
 *
 * Exports:
 * - {@link BM25Index} — Sparse keyword index using BM25 ranking
 * - {@link HybridSearcher} — Fuses dense + sparse results via RRF or other strategies
 * - {@link LexicalIndex}: the BM25 engine over a caller's tokenizer, with no import, saved and restored as JSON
 *
 * @module agentos/rag/search
 */

export { BM25Index, type BM25Config, type BM25Document, type BM25Result, type BM25Stats } from './BM25Index.js';
export { HybridSearcher, type HybridSearcherConfig, type HybridResult } from './HybridSearcher.js';
export { LexicalIndex, type LexicalIndexConfig, type LexicalIndexJSON, type LexicalSearchOptions } from './LexicalIndex.js';
