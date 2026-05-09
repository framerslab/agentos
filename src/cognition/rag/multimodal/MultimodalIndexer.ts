/**
 * @module rag/multimodal/MultimodalIndexer
 *
 * Indexes non-text content (images, audio) into the RAG vector store by
 * generating text representations and embedding them. This bridges the gap
 * between multimodal content and the text-embedding pipeline, enabling
 * cross-modal semantic search.
 *
 * ## Architecture
 *
 * ```
 *   Image ──► Vision LLM ──► Description ──► Embedding ──► Vector Store
 *   Audio ──► STT Provider ──► Transcript ──► Embedding ──► Vector Store
 *   Text ─────────────────────────────────► Embedding ──► Vector Store
 *                                                               │
 *   Query ─────────────────────────────────► Embedding ──► Search ◄──┘
 * ```
 *
 * Each indexed document carries a `modality` metadata field ('text', 'image',
 * or 'audio') enabling modality-filtered search.
 *
 * ## Dependencies
 *
 * The indexer receives its dependencies via constructor injection:
 * - {@link IEmbeddingManager} — generates vector embeddings from text
 * - {@link IVectorStore} — stores and queries document embeddings
 * - {@link IVisionProvider} — describes images as text (optional, required for images)
 * - {@link ISpeechToTextProvider} — transcribes audio to text (optional, required for audio)
 *
 * This decoupled design allows swapping vision (GPT-4o, Gemini, LLaVA)
 * or STT (Whisper, Deepgram, AssemblyAI) providers without touching the
 * indexer logic.
 *
 * @see {@link ContentModality} for supported modalities.
 * @see {@link MultimodalSearchResult} for search result shape.
 * @see {@link RetrievalAugmentor} for the text-only RAG pipeline.
 */

import type { IEmbeddingManager, EmbeddingRequest } from '../IEmbeddingManager.js';
import type { IVectorStore, VectorDocument, MetadataValue } from '../IVectorStore.js';
import { uuidv4 } from '../../../core/utils/uuid.js';
import type {
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
import type { VisionPipeline } from '../../../io/vision/VisionPipeline.js';
import type { HydeRetriever } from '../HydeRetriever.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default collection name when none is specified. */
const DEFAULT_COLLECTION = 'multimodal';

/**
 * Default prompt sent to the vision LLM when describing images.
 * Designed to produce search-friendly descriptions that capture objects,
 * actions, colors, text, and spatial relationships.
 */
const DEFAULT_IMAGE_DESCRIPTION_PROMPT =
  'Describe this image in detail for use in a search index. ' +
  'Include objects, actions, colors, text, spatial relationships, ' +
  'and any notable characteristics. Be thorough but concise.';

const isNodeBuffer = (value: unknown): value is Buffer =>
  typeof Buffer !== 'undefined' && Buffer.isBuffer(value);

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Indexes non-text content (images, audio) into the vector store by
 * generating text descriptions and embeddings.
 *
 * ## Image indexing flow
 * 1. If the image is a Buffer, convert to base64 data URL.
 * 2. Send to the vision LLM to generate a text description.
 * 3. Embed the description via the embedding manager.
 * 4. Store in the vector store with `modality: 'image'` metadata.
 *
 * ## Audio indexing flow
 * 1. Send the audio buffer to the STT provider for transcription.
 * 2. Embed the transcript via the embedding manager.
 * 3. Store in the vector store with `modality: 'audio'` metadata.
 *
 * ## Cross-modal search
 * 1. Embed the text query via the embedding manager.
 * 2. Query the vector store with optional modality filters.
 * 3. Return results annotated with their source modality.
 *
 * @example
 * ```typescript
 * import { MultimodalIndexer } from '@framers/agentos/rag/multimodal';
 *
 * const indexer = new MultimodalIndexer({
 *   embeddingManager,
 *   vectorStore,
 *   visionProvider,
 *   sttProvider,
 * });
 *
 * // Index an image
 * const imgResult = await indexer.indexImage({
 *   image: fs.readFileSync('./photo.jpg'),
 *   metadata: { source: 'upload' },
 * });
 *
 * // Index audio
 * const audioResult = await indexer.indexAudio({
 *   audio: fs.readFileSync('./meeting.wav'),
 *   language: 'en',
 * });
 *
 * // Search across all modalities
 * const results = await indexer.search('cats on a beach');
 * ```
 */
export class MultimodalIndexer {
  // -------------------------------------------------------------------------
  // Dependencies
  // -------------------------------------------------------------------------

  /** Embedding manager for generating vector representations. */
  private readonly _embeddingManager: IEmbeddingManager;

  /** Vector store for persistent document storage and search. */
  private readonly _vectorStore: IVectorStore;

  /**
   * Vision LLM provider for generating image descriptions.
   * Optional — an error is thrown if image indexing is attempted without it.
   */
  private readonly _visionProvider?: IVisionProvider;

  /**
   * Speech-to-text provider for transcribing audio.
   * Optional — an error is thrown if audio indexing is attempted without it.
   */
  private readonly _sttProvider?: ISpeechToTextProvider;

  /** Resolved configuration. */
  private readonly _config: Required<MultimodalIndexerConfig>;

  /**
   * Optional HyDE retriever for hypothesis-driven multimodal search.
   *
   * When set, the `search()` method can accept `hyde: { enabled: true }`
   * in its options to embed a hypothetical answer instead of the raw query,
   * improving recall for exploratory or vague queries.
   *
   * @see HydeRetriever
   */
  private _hydeRetriever?: HydeRetriever;

  // -------------------------------------------------------------------------
  // Constructor
  // -------------------------------------------------------------------------

  /**
   * Create a new multimodal indexer.
   *
   * @param deps - Dependency injection container.
   * @param deps.embeddingManager - Manager for generating text embeddings.
   * @param deps.vectorStore - Vector store for document storage and search.
   * @param deps.visionProvider - Optional vision LLM for image description.
   * @param deps.visionPipeline - Optional full vision pipeline with OCR, handwriting,
   *   document understanding, CLIP embeddings, and cloud fallback. When provided,
   *   it is wrapped as an `IVisionProvider` via `PipelineVisionProvider`,
   *   overriding any `visionProvider` passed alongside it.
   * @param deps.sttProvider - Optional STT provider for audio transcription.
   * @param deps.config - Optional configuration overrides.
   *
   * @throws {Error} If embeddingManager or vectorStore is missing.
   *
   * @example
   * ```typescript
   * // With a simple vision LLM provider
   * const indexer = new MultimodalIndexer({
   *   embeddingManager,
   *   vectorStore,
   *   visionProvider: myVisionLLM,
   *   sttProvider: myWhisperService,
   *   config: { defaultCollection: 'knowledge' },
   * });
   *
   * // With the full vision pipeline (recommended)
   * const indexer = new MultimodalIndexer({
   *   embeddingManager,
   *   vectorStore,
   *   visionPipeline: myVisionPipeline,
   * });
   * ```
   */
  constructor(deps: {
    embeddingManager: IEmbeddingManager;
    vectorStore: IVectorStore;
    visionProvider?: IVisionProvider;
    visionPipeline?: VisionPipeline;
    sttProvider?: ISpeechToTextProvider;
    config?: MultimodalIndexerConfig;
  }) {
    if (!deps.embeddingManager) {
      throw new Error('MultimodalIndexer requires an IEmbeddingManager instance.');
    }
    if (!deps.vectorStore) {
      throw new Error('MultimodalIndexer requires an IVectorStore instance.');
    }

    this._embeddingManager = deps.embeddingManager;
    this._vectorStore = deps.vectorStore;
    this._sttProvider = deps.sttProvider;

    // If a full VisionPipeline is provided, wrap it as an IVisionProvider.
    // This gives the indexer access to the progressive OCR + vision pipeline
    // for image description, while maintaining backward compatibility with
    // the simpler IVisionProvider interface.
    if (deps.visionPipeline) {
      // Lazy import to avoid circular dependency at module load time.
      // PipelineVisionProvider is a thin adapter — safe to require synchronously.
      const {
        PipelineVisionProvider,
        // eslint-disable-next-line @typescript-eslint/no-require-imports
      } = require('../../vision/providers/PipelineVisionProvider.js');
      this._visionProvider = new PipelineVisionProvider(deps.visionPipeline);
    } else {
      this._visionProvider = deps.visionProvider;
    }

    this._config = {
      defaultCollection: deps.config?.defaultCollection ?? DEFAULT_COLLECTION,
      imageDescriptionPrompt:
        deps.config?.imageDescriptionPrompt ?? DEFAULT_IMAGE_DESCRIPTION_PROMPT,
    };
  }

  // -------------------------------------------------------------------------
  // HyDE configuration
  // -------------------------------------------------------------------------

  /**
   * Attach a HyDE retriever to enable hypothesis-driven multimodal search.
   *
   * Once set, pass `hyde: { enabled: true }` in the `search()` options to
   * activate HyDE for that query. The retriever generates a hypothetical
   * answer using an LLM, then embeds that answer instead of the raw query
   * text, which typically yields better recall for exploratory queries.
   *
   * @param retriever - A pre-configured HydeRetriever instance.
   *
   * @example
   * ```typescript
   * indexer.setHydeRetriever(new HydeRetriever({
   *   llmCaller: myLlmCaller,
   *   embeddingManager: myEmbeddingManager,
   *   config: { enabled: true },
   * }));
   *
   * const results = await indexer.search('cats on a beach', {
   *   hyde: { enabled: true },
   * });
   * ```
   */
  setHydeRetriever(retriever: HydeRetriever): void {
    this._hydeRetriever = retriever;
  }

  // -------------------------------------------------------------------------
  // Image indexing
  // -------------------------------------------------------------------------

  /**
   * Index an image by generating a text description via vision LLM,
   * then embedding and storing the description.
   *
   * @param opts - Image data, metadata, and collection options.
   * @returns The document ID and generated description.
   *
   * @throws {Error} If no vision provider is configured.
   * @throws {Error} If the vision LLM fails to describe the image.
   * @throws {Error} If embedding generation or vector store upsert fails.
   *
   * @example
   * ```typescript
   * const result = await indexer.indexImage({
   *   image: 'https://example.com/photo.jpg',
   *   metadata: { source: 'web-scrape', url: 'https://example.com' },
   * });
   * console.log(result.description); // "A golden retriever playing fetch..."
   * ```
   */
  async indexImage(opts: ImageIndexOptions): Promise<ImageIndexResult> {
    if (!this._visionProvider) {
      throw new Error(
        'MultimodalIndexer: cannot index image — no vision provider configured. ' +
          'Pass a visionProvider in the constructor.'
      );
    }

    // Convert Buffer to base64 data URL so the vision LLM can process it.
    // URL strings are passed through unchanged.
    let imageUrl: string;
    if (isNodeBuffer(opts.image)) {
      const base64 = opts.image.toString('base64');
      // Default to PNG MIME type since we don't inspect the magic bytes.
      // Most vision LLMs accept any common image format regardless of the
      // declared MIME type.
      imageUrl = `data:image/png;base64,${base64}`;
    } else {
      imageUrl = opts.image;
    }

    // Step 1: Generate text description of the image
    const description = await this._visionProvider.describeImage(imageUrl);

    if (!description || description.trim().length === 0) {
      throw new Error('MultimodalIndexer: vision provider returned empty description.');
    }

    // Step 2: Generate embedding from the description text
    const collection = opts.collection ?? this._config.defaultCollection;
    const docId = uuidv4();

    const embeddingRequest: EmbeddingRequest = {
      texts: [description],
    };
    const embeddingResponse = await this._embeddingManager.generateEmbeddings(embeddingRequest);

    if (
      !embeddingResponse.embeddings ||
      embeddingResponse.embeddings.length === 0 ||
      embeddingResponse.embeddings[0].length === 0
    ) {
      throw new Error(
        'MultimodalIndexer: embedding generation returned empty result for image description.'
      );
    }

    // Step 3: Store in vector store with image modality metadata
    const metadata: Record<string, MetadataValue> = {
      modality: 'image' as MetadataValue,
      ...(opts.metadata as Record<string, MetadataValue> | undefined),
    };

    const document: VectorDocument = {
      id: docId,
      embedding: embeddingResponse.embeddings[0],
      textContent: description,
      metadata,
    };

    await this._vectorStore.upsert(collection, [document]);

    return {
      id: docId,
      description,
    };
  }

  // -------------------------------------------------------------------------
  // Audio indexing
  // -------------------------------------------------------------------------

  /**
   * Index an audio file by transcribing via STT, then embedding and
   * storing the transcript.
   *
   * @param opts - Audio data, metadata, collection, and language options.
   * @returns The document ID and generated transcript.
   *
   * @throws {Error} If no STT provider is configured.
   * @throws {Error} If the STT provider fails to transcribe.
   * @throws {Error} If embedding generation or vector store upsert fails.
   *
   * @example
   * ```typescript
   * const result = await indexer.indexAudio({
   *   audio: fs.readFileSync('./podcast.mp3'),
   *   metadata: { source: 'podcast', episode: 42 },
   *   language: 'en',
   * });
   * console.log(result.transcript); // "Welcome to episode 42..."
   * ```
   */
  async indexAudio(opts: AudioIndexOptions): Promise<AudioIndexResult> {
    if (!this._sttProvider) {
      throw new Error(
        'MultimodalIndexer: cannot index audio — no STT provider configured. ' +
          'Pass an sttProvider in the constructor.'
      );
    }

    // Step 1: Transcribe audio to text
    const transcript = await this._sttProvider.transcribe(opts.audio, opts.language);

    if (!transcript || transcript.trim().length === 0) {
      throw new Error('MultimodalIndexer: STT provider returned empty transcript.');
    }

    // Step 2: Generate embedding from the transcript text
    const collection = opts.collection ?? this._config.defaultCollection;
    const docId = uuidv4();

    const embeddingRequest: EmbeddingRequest = {
      texts: [transcript],
    };
    const embeddingResponse = await this._embeddingManager.generateEmbeddings(embeddingRequest);

    if (
      !embeddingResponse.embeddings ||
      embeddingResponse.embeddings.length === 0 ||
      embeddingResponse.embeddings[0].length === 0
    ) {
      throw new Error(
        'MultimodalIndexer: embedding generation returned empty result for audio transcript.'
      );
    }

    // Step 3: Store in vector store with audio modality metadata
    const metadata: Record<string, MetadataValue> = {
      modality: 'audio' as MetadataValue,
      ...(opts.metadata as Record<string, MetadataValue> | undefined),
    };

    if (opts.language) {
      metadata.language = opts.language as MetadataValue;
    }

    const document: VectorDocument = {
      id: docId,
      embedding: embeddingResponse.embeddings[0],
      textContent: transcript,
      metadata,
    };

    await this._vectorStore.upsert(collection, [document]);

    return {
      id: docId,
      transcript,
    };
  }

  // -------------------------------------------------------------------------
  // Text indexing
  // -------------------------------------------------------------------------

  /**
   * Index plain text by embedding and storing it directly.
   *
   * This is used when higher-level multimodal pipelines already have text
   * extracted from rich content, such as PDF pages or OCR output, and need
   * to place that text into the multimodal vector store without going through
   * a vision or STT provider.
   *
   * @param opts - Text, metadata, and collection options.
   * @returns The document ID and normalized indexed text.
   *
   * @throws {Error} If the text is empty after trimming.
   * @throws {Error} If embedding generation or vector store upsert fails.
   */
  async indexText(opts: TextIndexOptions): Promise<TextIndexResult> {
    const text = opts.text.trim();
    if (!text) {
      throw new Error('MultimodalIndexer: cannot index empty text.');
    }

    const collection = opts.collection ?? this._config.defaultCollection;
    const docId = uuidv4();

    const embeddingRequest: EmbeddingRequest = {
      texts: [text],
    };
    const embeddingResponse = await this._embeddingManager.generateEmbeddings(embeddingRequest);

    if (
      !embeddingResponse.embeddings ||
      embeddingResponse.embeddings.length === 0 ||
      embeddingResponse.embeddings[0].length === 0
    ) {
      throw new Error(
        'MultimodalIndexer: embedding generation returned empty result for text.'
      );
    }

    const metadata: Record<string, MetadataValue> = {
      modality: 'text' as MetadataValue,
      ...(opts.metadata as Record<string, MetadataValue> | undefined),
    };

    const document: VectorDocument = {
      id: docId,
      embedding: embeddingResponse.embeddings[0],
      textContent: text,
      metadata,
    };

    await this._vectorStore.upsert(collection, [document]);

    return {
      id: docId,
      text,
    };
  }

  // -------------------------------------------------------------------------
  // Cross-modal search
  // -------------------------------------------------------------------------

  /**
   * Search across all modalities (text + image descriptions + audio transcripts).
   *
   * The query text is embedded, then the vector store is searched with
   * optional modality filtering. Results are returned with their source
   * modality indicated.
   *
   * @param query - Natural language search query.
   * @param opts - Optional search parameters (topK, modalities, collection).
   * @returns Array of search results sorted by relevance score (descending).
   *
   * @throws {Error} If embedding generation fails.
   *
   * @example
   * ```typescript
   * // Search only image descriptions
   * const imageResults = await indexer.search('cats playing', {
   *   modalities: ['image'],
   *   topK: 10,
   * });
   *
   * // Search across all modalities
   * const allResults = await indexer.search('machine learning tutorial');
   * ```
   */
  async search(query: string, opts?: MultimodalSearchOptions): Promise<MultimodalSearchResult[]> {
    const topK = opts?.topK ?? 5;
    const collection = opts?.collection ?? this._config.defaultCollection;

    // Step 1: Determine query embedding
    //
    // When HyDE is enabled and a HydeRetriever is available, we delegate
    // the full retrieve cycle to the retriever. This generates a hypothetical
    // answer, embeds it, and searches the vector store in one shot — including
    // adaptive threshold stepping for better recall.
    //
    // Otherwise we fall back to the standard direct-embedding path.
    if (opts?.hyde?.enabled && this._hydeRetriever) {
      const hydeResult = await this._hydeRetriever.retrieve({
        query,
        vectorStore: this._vectorStore,
        collectionName: collection,
        hypothesis: opts.hyde.hypothesis,
        queryOptions: {
          topK,
          includeMetadata: true,
          includeTextContent: true,
          // Modality filter is applied via metadata filter
          ...(opts.modalities && opts.modalities.length > 0
            ? {
                filter: opts.modalities.length === 1
                  ? { modality: opts.modalities[0] }
                  : { modality: { $in: opts.modalities } },
              }
            : {}),
        },
      });

      return hydeResult.queryResult.documents.map((doc) => ({
        id: doc.id,
        content: doc.textContent ?? '',
        score: doc.similarityScore,
        modality: (doc.metadata?.modality as ContentModality) ?? 'text',
        metadata: doc.metadata as Record<string, unknown> | undefined,
      }));
    }

    // Standard path: embed the raw query text directly.
    const embeddingRequest: EmbeddingRequest = {
      texts: [query],
    };
    const embeddingResponse = await this._embeddingManager.generateEmbeddings(embeddingRequest);

    if (
      !embeddingResponse.embeddings ||
      embeddingResponse.embeddings.length === 0 ||
      embeddingResponse.embeddings[0].length === 0
    ) {
      throw new Error(
        'MultimodalIndexer: embedding generation returned empty result for search query.'
      );
    }

    const queryEmbedding = embeddingResponse.embeddings[0];

    // Step 2: Build metadata filter for modality filtering.
    // When specific modalities are requested, we filter on the modality
    // metadata field using $in for multi-modality or $eq for single.
    const filter: Record<string, unknown> | undefined =
      opts?.modalities && opts.modalities.length > 0
        ? opts.modalities.length === 1
          ? { modality: opts.modalities[0] }
          : { modality: { $in: opts.modalities } }
        : undefined;

    // Step 3: Query the vector store
    const queryResult = await this._vectorStore.query(collection, queryEmbedding, {
      topK,
      filter: filter as any,
      includeMetadata: true,
      includeTextContent: true,
    });

    // Step 4: Map vector store results to multimodal search results
    return queryResult.documents.map((doc) => ({
      id: doc.id,
      content: doc.textContent ?? '',
      score: doc.similarityScore,
      modality: (doc.metadata?.modality as ContentModality) ?? 'text',
      metadata: doc.metadata as Record<string, unknown> | undefined,
    }));
  }

  // -------------------------------------------------------------------------
  // Memory bridge factory
  // -------------------------------------------------------------------------

  /**
   * Create a `MultimodalMemoryBridge` using this indexer's providers.
   *
   * The bridge extends this indexer's RAG capabilities with cognitive memory
   * integration, enabling multimodal content to be stored in both the vector
   * store (for search) and long-term memory (for recall during conversation).
   *
   * @param memoryManager - Optional cognitive memory manager for memory trace creation.
   *   When omitted, the bridge still indexes into RAG but creates no memory traces.
   * @param options - Bridge configuration overrides (mood, chunk sizes, etc.)
   * @returns A configured multimodal memory bridge instance.
   *
   * @example
   * ```typescript
   * const bridge = indexer.createMemoryBridge(memoryManager, {
   *   enableMemory: true,
   *   defaultChunkSize: 800,
   * });
   *
   * await bridge.ingestImage(imageBuffer, { source: 'user-upload' });
   * ```
   *
   * See `MultimodalMemoryBridge` for full documentation.
   */
  createMemoryBridge(
    memoryManager?: import('../../memory/CognitiveMemoryManager.js').ICognitiveMemoryManager,
    options?: import('./MultimodalMemoryBridge.js').MultimodalBridgeOptions
  ): import('./MultimodalMemoryBridge.js').MultimodalMemoryBridge {
    // Lazy import to avoid circular dependency at module load time.
    // The bridge depends on the indexer, and this factory lives on the indexer,
    // so we use a dynamic require pattern with the already-resolved class.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { MultimodalMemoryBridge } = require('./MultimodalMemoryBridge.js');
    return new MultimodalMemoryBridge(this, memoryManager, options);
  }
}
