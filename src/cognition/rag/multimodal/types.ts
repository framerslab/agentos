/**
 * @module rag/multimodal/types
 *
 * Type definitions for the multimodal RAG indexing system.
 *
 * The multimodal indexer extends the text-only RAG pipeline to handle
 * non-text content (images, audio) by converting them to text
 * representations (descriptions, transcripts) and embedding those
 * representations into the shared vector store.
 *
 * ## Modality architecture
 *
 * Each indexed document carries a `modality` metadata field:
 * - `'text'` — standard text documents (existing RAG pipeline)
 * - `'image'` — vision LLM-generated descriptions of images
 * - `'audio'` — STT-generated transcripts of audio files
 *
 * During search, results can be filtered by modality or searched
 * across all modalities simultaneously.
 *
 * @see {@link MultimodalIndexer} for the implementation.
 * @see {@link IVectorStore} for the underlying storage.
 * @see {@link IEmbeddingManager} for embedding generation.
 */

// ---------------------------------------------------------------------------
// Content modality
// ---------------------------------------------------------------------------

/**
 * Supported content modalities in the multimodal RAG system.
 *
 * - `'text'` — Standard text content (documents, web pages, etc.)
 * - `'image'` — Visual content indexed via vision LLM descriptions
 * - `'audio'` — Audio content indexed via STT transcripts
 */
export type ContentModality = 'text' | 'image' | 'audio';

// ---------------------------------------------------------------------------
// Indexing options
// ---------------------------------------------------------------------------

/**
 * Options for indexing an image into the vector store.
 *
 * The image is described by a vision-capable LLM, then the description
 * is embedded and stored alongside the original image reference.
 *
 * @example
 * ```typescript
 * const result = await indexer.indexImage({
 *   image: fs.readFileSync('./photo.jpg'),
 *   metadata: { source: 'user-upload', fileName: 'photo.jpg' },
 *   collection: 'user-images',
 * });
 * ```
 */
export interface ImageIndexOptions {
  /**
   * Image data as a URL string (file:// or https://) or a raw Buffer.
   * - URL: Passed directly to the vision LLM for description.
   * - Buffer: Converted to a base64 data URL before passing to the LLM.
   */
  image: string | Buffer;

  /**
   * Optional metadata to attach to the indexed document.
   * Stored alongside the embedding for filtering during search.
   *
   * @example { source: 'upload', tags: ['landscape', 'nature'] }
   */
  metadata?: Record<string, unknown>;

  /**
   * Vector store collection to index into.
   * @default 'multimodal'
   */
  collection?: string;
}

/**
 * Options for indexing an audio file into the vector store.
 *
 * The audio is transcribed via an STT provider, then the transcript
 * is embedded and stored alongside the original audio reference.
 *
 * @example
 * ```typescript
 * const result = await indexer.indexAudio({
 *   audio: fs.readFileSync('./recording.wav'),
 *   metadata: { source: 'meeting', duration: 3600 },
 *   language: 'en',
 * });
 * ```
 */
export interface AudioIndexOptions {
  /**
   * Audio data as a raw Buffer (WAV, MP3, OGG, etc.).
   * The format must be supported by the configured STT provider.
   */
  audio: Buffer;

  /**
   * Optional metadata to attach to the indexed document.
   * Stored alongside the embedding for filtering during search.
   */
  metadata?: Record<string, unknown>;

  /**
   * Vector store collection to index into.
   * @default 'multimodal'
   */
  collection?: string;

  /**
   * BCP-47 language hint for the STT provider (e.g. 'en', 'es', 'ja').
   * Improves transcription accuracy for non-English audio.
   */
  language?: string;
}

/**
 * Options for indexing plain text into the multimodal vector store.
 *
 * This is primarily used by higher-level orchestrators like the
 * {@link MultimodalMemoryBridge} when extracted text from PDFs or other
 * rich content should land in the same multimodal retrieval pipeline.
 */
export interface TextIndexOptions {
  /**
   * Text to embed and store.
   */
  text: string;

  /**
   * Optional metadata to attach to the indexed document.
   * Stored alongside the embedding for filtering during search.
   */
  metadata?: Record<string, unknown>;

  /**
   * Vector store collection to index into.
   * @default 'multimodal'
   */
  collection?: string;
}

// ---------------------------------------------------------------------------
// Indexing results
// ---------------------------------------------------------------------------

/**
 * Result of indexing an image into the vector store.
 *
 * @see {@link ImageIndexOptions} for the input shape.
 */
export interface ImageIndexResult {
  /** Unique document ID in the vector store. */
  id: string;
  /** Vision LLM-generated description of the image. */
  description: string;
}

/**
 * Result of indexing an audio file into the vector store.
 *
 * @see {@link AudioIndexOptions} for the input shape.
 */
export interface AudioIndexResult {
  /** Unique document ID in the vector store. */
  id: string;
  /** STT-generated transcript of the audio. */
  transcript: string;
}

/**
 * Result of indexing plain text into the vector store.
 */
export interface TextIndexResult {
  /** Unique document ID in the vector store. */
  id: string;
  /** Indexed text content after normalization. */
  text: string;
}

// ---------------------------------------------------------------------------
// Search options and results
// ---------------------------------------------------------------------------

/**
 * Options for cross-modal search.
 *
 * @example
 * ```typescript
 * const results = await indexer.search('cats playing', {
 *   topK: 10,
 *   modalities: ['image', 'text'],
 *   collection: 'user-content',
 * });
 * ```
 */
export interface MultimodalSearchOptions {
  /**
   * Maximum number of results to return.
   * @default 5
   */
  topK?: number;

  /**
   * Filter results to specific modalities. If omitted or empty,
   * all modalities are searched.
   */
  modalities?: ContentModality[];

  /**
   * Vector store collection to search in.
   * @default 'multimodal'
   */
  collection?: string;

  /**
   * HyDE (Hypothetical Document Embedding) configuration for this search.
   *
   * When enabled, a hypothetical answer is generated from the query via LLM
   * and embedded instead of the raw query. This produces embeddings that are
   * semantically closer to stored document representations, improving recall
   * for vague or exploratory queries.
   *
   * Requires a `HydeRetriever` to be set on the indexer via
   * {@link MultimodalIndexer.setHydeRetriever}.
   *
   * @example
   * ```typescript
   * const results = await indexer.search('architecture diagram', {
   *   hyde: { enabled: true },
   * });
   * ```
   */
  hyde?: {
    /** Whether to use HyDE for this search. @default false */
    enabled?: boolean;
    /** Pre-generated hypothesis text (skips the LLM call). */
    hypothesis?: string;
  };
}

/**
 * A single result from a multimodal search query.
 *
 * Extends the base vector store result with modality-specific fields
 * so the caller knows what kind of content matched and can render
 * it appropriately.
 */
export interface MultimodalSearchResult {
  /** Unique document ID in the vector store. */
  id: string;

  /**
   * The text content that was embedded and matched.
   * For images: the vision LLM description.
   * For audio: the STT transcript.
   * For text: the original text chunk.
   */
  content: string;

  /**
   * Cosine similarity score between the query and this result.
   * Higher is more relevant (typically 0.0 to 1.0).
   */
  score: number;

  /**
   * The content modality of this result.
   * Indicates whether the match came from text, image description,
   * or audio transcript.
   */
  modality: ContentModality;

  /**
   * Any metadata attached during indexing.
   * May include source URLs, file names, timestamps, etc.
   */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Provider interfaces for dependency injection
// ---------------------------------------------------------------------------

/**
 * Minimal interface for a vision LLM that can describe images.
 *
 * This is kept intentionally narrow to avoid coupling the multimodal
 * indexer to a specific LLM provider. Any service that can take an
 * image and return a text description satisfies this contract.
 *
 * @example
 * ```typescript
 * const visionProvider: IVisionProvider = {
 *   describeImage: async (image) => {
 *     const response = await openai.chat.completions.create({
 *       model: 'gpt-4o',
 *       messages: [{ role: 'user', content: [
 *         { type: 'text', text: 'Describe this image in detail.' },
 *         { type: 'image_url', image_url: { url: imageUrl } },
 *       ]}],
 *     });
 *     return response.choices[0].message.content!;
 *   },
 * };
 * ```
 */
export interface IVisionProvider {
  /**
   * Generate a text description of the provided image.
   *
   * @param image - Image as a URL string or base64 data URL.
   * @returns A detailed text description of the image content.
   */
  describeImage(image: string): Promise<string>;
}

/**
 * Minimal interface for a speech-to-text provider.
 *
 * This is kept intentionally narrow to avoid coupling the multimodal
 * indexer to a specific STT service. Any service that can transcribe
 * audio buffers satisfies this contract.
 *
 * @example
 * ```typescript
 * const sttProvider: ISpeechToTextProvider = {
 *   transcribe: async (audio, language) => {
 *     const response = await openai.audio.transcriptions.create({
 *       model: 'whisper-1',
 *       file: audio,
 *       language,
 *     });
 *     return response.text;
 *   },
 * };
 * ```
 */
export interface ISpeechToTextProvider {
  /**
   * Transcribe audio data to text.
   *
   * @param audio - Raw audio data as a Buffer.
   * @param language - Optional BCP-47 language code hint.
   * @returns The transcribed text.
   */
  transcribe(audio: Buffer, language?: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// Multimodal indexer configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the {@link MultimodalIndexer}.
 *
 * @example
 * ```typescript
 * const config: MultimodalIndexerConfig = {
 *   defaultCollection: 'knowledge-base',
 *   imageDescriptionPrompt: 'Describe this image for use in a search index.',
 * };
 * ```
 */
export interface MultimodalIndexerConfig {
  /**
   * Default vector store collection name for indexed content.
   * @default 'multimodal'
   */
  defaultCollection?: string;

  /**
   * Custom prompt template for the vision LLM when describing images.
   * If omitted, a sensible default prompt is used.
   */
  imageDescriptionPrompt?: string;
}
