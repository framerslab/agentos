/**
 * @fileoverview The library module: an index of sources over any vector store, a transcript's chunker, the word
 * rule of the lexical legs with a search hit's snippet, a lexical index and a fuzzy index a device can hold, readers
 * of transcript files from other notetakers, the plan of an archive's entries, readers of an HTML page and a CSV file
 * into Markdown, the delivery policy of results derived from private sources, and their durable store with deletion
 * fences on PostgreSQL.
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
export {
  createSourceDerivation,
  canDeliverSourceDerivation,
  type SourceDependency,
  type SourceDependencyState,
  type SourceDerivation,
  type SourceDeliverySurface,
  type SourceDeliveryContext,
} from './SourceDerivations.js';
export { sourceDerivationSchema } from './sourceDerivationSchema.js';
export {
  readTranscript,
  readWordTranscript,
  transcriptFormatOf,
  TranscriptReadError,
  type ExtractRawText,
  type ReadTranscript,
  type ReadWordTranscriptOptions,
  type TranscriptFileLabel,
  type TranscriptFileTurn,
  type TranscriptFormat,
} from './transcripts/index.js';
export {
  planEntries,
  sha256Hex,
  type PlanEntryInput,
  type PlannedEntry,
  type PlannedKind,
  type PlanRules,
  type PlanSkipReason,
} from './planEntries.js';
export { readHtml, type HtmlRead, type ReadHtmlOptions } from './readers/html.js';
export type { HtmlDocumentLike, HtmlNodeLike } from './readers/dom.js';
export { readCsv, type CsvRead, type CsvSeparator, type ReadCsvOptions } from './readers/csv.js';
export {
  SqlSourceDerivationStore,
  type SourceOwnerScope,
  type SourceFenceTicket,
  type SourceInvalidation,
  type SourceDeletionTombstone,
  type SourceDerivationBindings,
  type SourceDerivationStoreOptions,
  type SourceFencedResult,
} from './SqlSourceDerivationStore.js';
