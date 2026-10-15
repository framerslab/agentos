/**
 * @fileoverview Barrel exports for the Memory facade.
 *
 * The facade re-exports the `Memory` class (the unified public API) along
 * with all public types from `./types.ts`. Consumers should import from
 * this module rather than reaching into individual subsystem files.
 *
 * @module memory/facade
 */

export { Memory } from './Memory.js';
export type { ScoredTrace } from './Memory.js';

export type {
  MemoryConfig,
  EmbeddingConfig,
  ExtendedConsolidationConfig,
  IngestionConfig,
  RememberOptions,
  RecallOptions,
  IngestOptions,
  IngestResult,
  ExportOptions,
  ExportResult,
  RefusedExportTrace,
  ImportOptions,
  ImportResult,
  ConsolidationResult,
  MemoryHealth,
  LoadOptions,
  DocumentMetadata,
  DocumentChunk,
  ExtractedImage,
  ExtractedTable,
  LoadedDocument,
} from './types.js';
