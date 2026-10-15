/**
 * @fileoverview The library's browser entry: what a page may import. Nothing here reaches a Node module or a
 * package; a test walks its import graph. Nothing here reaches the DOM either, but for IndexedDB, which the
 * key-value store reaches only when it is opened.
 * @module agentos/cognition/library/browser
 */

export { lexicalTokens, snippetAround, type Snippet } from './tokens.js';
export { chunkTurns, type ChunkTurnsOptions, type LibraryTurn, type TurnChunk } from './chunkTurns.js';
export {
  LexicalIndex,
  type BM25Result,
  type BM25Stats,
  type LexicalIndexConfig,
  type LexicalIndexJSON,
  type LexicalSearchOptions,
} from '../rag/search/LexicalIndex.js';
export {
  FuzzyIndex,
  withinOneEdit,
  type FuzzyDocument,
  type FuzzyHit,
  type FuzzyIndexConfig,
  type FuzzyIndexJSON,
  type FuzzySearchOptions,
  type FuzzyToken,
  type FuzzyTokenizer,
  type Marked,
} from '../rag/search/FuzzyIndex.js';
// A page's storage: the key-value store, the outbox and the comparison of a server's list with the device's cache.
export * from '../../core/storage/browser/index.js';
