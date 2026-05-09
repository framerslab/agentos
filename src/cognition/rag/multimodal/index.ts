/**
 * @module rag/multimodal
 *
 * Multimodal RAG (Retrieval Augmented Generation) extension for AgentOS.
 *
 * Extends the text-only RAG pipeline to support indexing and searching
 * across images, audio, video, and PDF content by converting them to text
 * representations (vision LLM descriptions, STT transcripts, PDF text
 * extraction) before embedding into the vector store and cognitive memory.
 *
 * ## Provider sharing
 *
 * The {@link SpeechProviderAdapter} bridges the voice pipeline's
 * `SpeechToTextProvider` to the indexer's `ISpeechToTextProvider`, so
 * the same STT configuration (Whisper, Deepgram, etc.) powers both
 * real-time voice and offline audio indexing.
 *
 * The {@link LLMVisionAdapter} (re-exported from `vision/`) wraps
 * any vision-capable LLM as an `IVisionProvider`.
 *
 * The {@link createMultimodalIndexerFromResolver} factory wires
 * everything together from a `SpeechProviderResolver` + `VisionPipeline`.
 *
 * @example
 * ```typescript
 * import {
 *   MultimodalIndexer,
 *   MultimodalMemoryBridge,
 *   SpeechProviderAdapter,
 *   createMultimodalIndexerFromResolver,
 *   type MultimodalSearchResult,
 *   type ContentModality,
 *   type IngestResult,
 * } from '@framers/agentos/rag/multimodal';
 * ```
 */

export { MultimodalIndexer } from './MultimodalIndexer.js';
export { MultimodalMemoryBridge } from './MultimodalMemoryBridge.js';
export { SpeechProviderAdapter } from './SpeechProviderAdapter.js';
export { LLMVisionAdapter, type LLMVisionAdapterConfig } from './LLMVisionAdapter.js';
export {
  createMultimodalIndexerFromResolver,
  type MultimodalIndexerFromResolverOptions,
} from './createMultimodalIndexerFromResolver.js';

export type {
  ContentModality,
  ImageIndexOptions,
  ImageIndexResult,
  AudioIndexOptions,
  AudioIndexResult,
  TextIndexOptions,
  TextIndexResult,
  MultimodalSearchOptions,
  MultimodalSearchResult,
  IVisionProvider,
  ISpeechToTextProvider,
  MultimodalIndexerConfig,
} from './types.js';

export type {
  IngestMetadata,
  IngestResult,
  MultimodalBridgeOptions,
} from './MultimodalMemoryBridge.js';
