/**
 * @fileoverview The library module: an index of sources over any vector store, a transcript's chunker, the word
 * rule of the lexical legs with a search hit's snippet, and a lexical index a device can hold.
 * @module agentos/cognition/library
 */

export { lexicalTokens, snippetAround, type Snippet } from './tokens.js';
export { chunkTurns, type ChunkTurnsOptions, type LibraryTurn, type TurnChunk } from './chunkTurns.js';
export {
  LibraryIndex,
  type LibraryIndexOptions,
  type LibraryPassage,
  type LibraryScope,
  type LibrarySearch,
  type LibrarySource,
} from './LibraryIndex.js';
export { LexicalIndex, type LexicalIndexConfig, type LexicalIndexJSON, type LexicalSearchOptions } from '../rag/search/LexicalIndex.js';
