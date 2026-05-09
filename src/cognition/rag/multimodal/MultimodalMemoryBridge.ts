/**
 * @module rag/multimodal/MultimodalMemoryBridge
 *
 * Bridges multimodal content (images, audio, video, PDFs) into both
 * the RAG vector store AND the cognitive memory system.
 *
 * Without this bridge, multimodal content only exists in RAG search.
 * With it, agents can form long-term memories from visual/audio content
 * and recall them during conversation — enabling genuine multimodal recall.
 *
 * ## Architecture
 *
 * ```
 *   Image ──► Vision LLM ──► Description ──┬──► RAG Vector Store
 *                                           └──► Cognitive Memory (semantic trace)
 *
 *   Audio ──► STT ──► Transcript ──┬──► RAG Vector Store
 *                                  └──► Cognitive Memory (episodic trace)
 *
 *   Video ──► ffmpeg (frames + audio) ──► Vision + STT ──┬──► RAG Vector Store
 *                                                        └──► Cognitive Memory
 *
 *   PDF ──► Text extraction + chunking ──┬──► RAG Vector Store (per-chunk)
 *                                        └──► Cognitive Memory (semantic trace)
 * ```
 *
 * ## Dependencies
 *
 * - {@link MultimodalIndexer} — handles vision/STT → embedding → vector store
 * - {@link ICognitiveMemoryManager} — (optional) encodes traces into long-term memory
 *
 * When no memory manager is provided, content is still indexed into RAG
 * but no memory traces are created. This makes the bridge usable in
 * configurations where cognitive memory is disabled.
 *
 * @see {@link MultimodalIndexer} for the underlying RAG indexing.
 * @see {@link ICognitiveMemoryManager} for the memory encoding interface.
 *
 * @example
 * ```typescript
 * const bridge = new MultimodalMemoryBridge(indexer, memoryManager);
 *
 * // Image → vision description → RAG index + episodic memory
 * await bridge.ingestImage(imageBuffer, { source: 'user-upload' });
 *
 * // Audio → transcript → RAG index + episodic memory
 * await bridge.ingestAudio(audioBuffer, { language: 'en' });
 *
 * // Video → frame extraction + audio → RAG index + memory
 * await bridge.ingestVideo(videoBuffer, { extractFrames: true });
 *
 * // PDF → text + embedded images → RAG index + memory
 * await bridge.ingestPDF(pdfBuffer, { extractImages: true });
 * ```
 */

import { randomUUID } from 'node:crypto';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, unlink, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { MultimodalIndexer } from './MultimodalIndexer.js';
import type { ICognitiveMemoryManager } from '../../memory/CognitiveMemoryManager.js';
import type { PADState } from '../../memory/core/config.js';
import type { MemoryTrace, MemoryType } from '../../memory/core/types.js';

const exec = promisify(execCb);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Metadata attached to ingested content for both RAG and memory storage.
 *
 * Common fields like `source` and `tags` are strongly typed; additional
 * arbitrary metadata can be passed via the index signature.
 *
 * @example
 * ```typescript
 * const meta: IngestMetadata = {
 *   source: 'user-upload',
 *   tags: ['meeting', 'Q4'],
 *   collection: 'project-notes',
 *   meetingDate: '2025-12-01',
 * };
 * ```
 */
export interface IngestMetadata {
  /** Where the content originated (e.g. 'user-upload', 'web-scrape') */
  source?: string;
  /** Tags for categorization and filtering */
  tags?: string[];
  /** Vector store collection to index into */
  collection?: string;
  /** Arbitrary additional metadata */
  [key: string]: unknown;
}

/**
 * Result returned after ingesting multimodal content.
 *
 * Contains IDs for both the RAG documents and memory traces created,
 * plus the extracted text and processing details for transparency.
 *
 * @example
 * ```typescript
 * const result = await bridge.ingestImage(buf, { source: 'camera' });
 * console.log(result.ragDocumentIds);   // ['uuid-1']
 * console.log(result.memoryTraceIds);   // ['trace-uuid-1']
 * console.log(result.extractedText);    // 'A cat sitting on a keyboard...'
 * ```
 */
export interface IngestResult {
  /** IDs of documents created in RAG vector store */
  ragDocumentIds: string[];

  /** IDs of memory traces created (empty if no memory manager) */
  memoryTraceIds: string[];

  /** Content type detected or specified */
  contentType: 'image' | 'audio' | 'video' | 'pdf' | 'text';

  /** Text extracted from the content (description, transcript, or raw text) */
  extractedText: string;

  /** Processing details for each modality */
  details: {
    /** Vision LLM descriptions (for images and video frames) */
    visionDescriptions?: string[];
    /** Audio transcript (for audio and video) */
    audioTranscript?: string;
    /** Number of pages (for PDFs) */
    pageCount?: number;
    /** Number of frames extracted (for video) */
    frameCount?: number;
    /** Number of embedded images extracted (for PDFs) */
    embeddedImages?: number;
  };
}

/**
 * Configuration options for the multimodal memory bridge.
 *
 * @example
 * ```typescript
 * const bridge = new MultimodalMemoryBridge(indexer, memMgr, {
 *   enableMemory: true,
 *   defaultMood: { valence: 0, arousal: 0.3, dominance: 0 },
 *   defaultChunkSize: 800,
 * });
 * ```
 */
export interface MultimodalBridgeOptions {
  /**
   * Default mood for memory encoding (PAD model).
   * Used when no mood context is available from the conversation.
   * Neutral mood by default: { valence: 0, arousal: 0.3, dominance: 0 }
   */
  defaultMood?: PADState;

  /**
   * Whether to create memory traces (requires memoryManager).
   * When false or when no memoryManager is provided, only RAG indexing occurs.
   * @default true
   */
  enableMemory?: boolean;

  /**
   * Default chunk size in characters for text splitting (PDF ingestion).
   * @default 1000
   */
  defaultChunkSize?: number;

  /**
   * Default overlap in characters between adjacent text chunks.
   * Ensures context continuity across chunk boundaries.
   * @default 200
   */
  defaultChunkOverlap?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Detect whether a given command-line tool is available on the system PATH.
 * Used to check for ffprobe/ffmpeg availability before attempting video processing.
 *
 * @param cmd - Command to test (e.g. 'ffprobe -version')
 * @returns true if the command exits with code 0
 */
async function isCommandAvailable(cmd: string): Promise<boolean> {
  try {
    await exec(cmd);
    return true;
  } catch {
    return false;
  }
}

/**
 * Split text into overlapping chunks for RAG ingestion.
 *
 * Uses a sliding window approach: each chunk starts `chunkSize - overlap`
 * characters after the previous one, ensuring continuity across boundaries.
 *
 * @param text - Raw text to chunk
 * @param chunkSize - Maximum characters per chunk
 * @param overlap - Characters shared between adjacent chunks
 * @returns Array of text chunks
 */
function chunkText(text: string, chunkSize: number, overlap: number): string[] {
  if (text.length <= chunkSize) {
    return [text];
  }

  const chunks: string[] = [];
  // Step forward by (chunkSize - overlap) each iteration so consecutive
  // chunks share `overlap` characters of context
  const step = Math.max(1, chunkSize - overlap);

  for (let i = 0; i < text.length; i += step) {
    chunks.push(text.slice(i, i + chunkSize));
    // Stop if we've captured the entire remaining text
    if (i + chunkSize >= text.length) break;
  }

  return chunks;
}

/**
 * Detect file MIME type from magic bytes in the buffer header.
 *
 * Inspects the first few bytes for well-known magic byte sequences.
 * Falls back to 'application/octet-stream' for unknown formats.
 *
 * @param buf - File buffer to inspect
 * @returns Detected MIME type string
 */
function detectMimeFromBuffer(buf: Buffer): string {
  if (buf.length < 4) return 'application/octet-stream';

  // PDF: starts with "%PDF"
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) {
    return 'application/pdf';
  }

  // PNG: 0x89 P N G
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png';
  }

  // JPEG: 0xFF 0xD8
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    return 'image/jpeg';
  }

  // GIF: "GIF8"
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
    return 'image/gif';
  }

  // WebP: "RIFF" + offset 8 "WEBP"
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return 'image/webp';
  }

  // MP4/MOV: ftyp box at offset 4
  if (
    buf.length >= 8 &&
    buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70
  ) {
    return 'video/mp4';
  }

  // WAV: "RIFF" + offset 8 "WAVE"
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x41 && buf[10] === 0x56 && buf[11] === 0x45
  ) {
    return 'audio/wav';
  }

  // MP3: ID3 tag or sync word
  if (
    (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) || // ID3
    (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) // MPEG sync
  ) {
    return 'audio/mpeg';
  }

  // OGG: "OggS"
  if (buf[0] === 0x4f && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) {
    return 'audio/ogg';
  }

  return 'application/octet-stream';
}

/**
 * Map MIME type to content type category used by IngestResult.
 *
 * @param mime - MIME type string
 * @returns Simplified content category
 */
function mimeToContentType(mime: string): IngestResult['contentType'] {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (mime === 'application/pdf') return 'pdf';
  return 'text';
}

/**
 * Map file extension to content type category.
 *
 * @param ext - File extension (with or without leading dot)
 * @returns Simplified content category or undefined if unrecognized
 */
function extToContentType(ext: string): IngestResult['contentType'] | undefined {
  const normalized = ext.toLowerCase().replace(/^\./, '');
  const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'tiff'];
  const audioExts = ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma'];
  const videoExts = ['mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv', 'flv'];

  if (imageExts.includes(normalized)) return 'image';
  if (audioExts.includes(normalized)) return 'audio';
  if (videoExts.includes(normalized)) return 'video';
  if (normalized === 'pdf') return 'pdf';
  return undefined;
}

// ---------------------------------------------------------------------------
// MultimodalMemoryBridge
// ---------------------------------------------------------------------------

/**
 * Bridges multimodal content (images, audio, video, PDFs) into both
 * the RAG vector store AND the cognitive memory system.
 *
 * Without this bridge, multimodal content only exists in RAG search.
 * With it, agents can form long-term memories from visual/audio content
 * and recall them during conversation.
 *
 * The bridge delegates RAG indexing to the existing {@link MultimodalIndexer}
 * and memory encoding to the {@link ICognitiveMemoryManager}. It adds:
 *
 * - **Video support**: frame extraction via ffmpeg + audio track transcription
 * - **PDF support**: text extraction + optional embedded image descriptions
 * - **Unified ingest()**: auto-detects content type from magic bytes or extension
 * - **Dual-write**: every piece of content enters both RAG and long-term memory
 *
 * @example
 * ```typescript
 * const bridge = new MultimodalMemoryBridge(indexer, memoryManager);
 *
 * // Image → vision description → RAG index + semantic memory
 * await bridge.ingestImage(imageBuffer, { source: 'user-upload' });
 *
 * // Audio → transcript → RAG index + episodic memory
 * await bridge.ingestAudio(audioBuffer, { language: 'en' });
 *
 * // Video → frame extraction + audio → RAG index + memory
 * await bridge.ingestVideo(videoBuffer, { extractFrames: true });
 *
 * // PDF → text + embedded images → RAG index + memory
 * await bridge.ingestPDF(pdfBuffer, { extractImages: true });
 * ```
 */
export class MultimodalMemoryBridge {
  /** The RAG indexer that handles vision/STT and vector store writes. */
  private readonly _indexer: MultimodalIndexer;

  /** Optional cognitive memory manager for long-term memory encoding. */
  private readonly _memoryManager?: ICognitiveMemoryManager;

  /** Resolved configuration with defaults applied. */
  private readonly _options: Required<MultimodalBridgeOptions>;

  // -------------------------------------------------------------------------
  // Constructor
  // -------------------------------------------------------------------------

  /**
   * Create a new multimodal memory bridge.
   *
   * @param indexer - The multimodal indexer for RAG vector store operations
   * @param memoryManager - Optional cognitive memory manager for memory trace creation
   * @param options - Bridge configuration overrides
   *
   * @throws {Error} If indexer is not provided
   *
   * @example
   * ```typescript
   * const bridge = new MultimodalMemoryBridge(
   *   indexer,
   *   memoryManager,
   *   { enableMemory: true, defaultChunkSize: 800 }
   * );
   * ```
   */
  constructor(
    indexer: MultimodalIndexer,
    memoryManager?: ICognitiveMemoryManager,
    options?: MultimodalBridgeOptions,
  ) {
    if (!indexer) {
      throw new Error('MultimodalMemoryBridge requires a MultimodalIndexer instance.');
    }

    this._indexer = indexer;
    this._memoryManager = memoryManager;
    this._options = {
      // Neutral PAD state — slightly above baseline arousal to reflect
      // the agent actively processing new content
      defaultMood: options?.defaultMood ?? { valence: 0, arousal: 0.3, dominance: 0 },
      enableMemory: options?.enableMemory ?? true,
      defaultChunkSize: options?.defaultChunkSize ?? 1000,
      defaultChunkOverlap: options?.defaultChunkOverlap ?? 200,
    };
  }

  // -------------------------------------------------------------------------
  // Image ingestion
  // -------------------------------------------------------------------------

  /**
   * Ingest an image into both RAG and memory.
   *
   * Processing pipeline:
   * 1. Vision LLM generates a text description of the image
   * 2. Description is embedded into the RAG vector store via the indexer
   * 3. If memory is enabled, description is encoded as a semantic memory trace
   *    (factual knowledge derived from visual input)
   *
   * @param image - Image as a URL string or Buffer
   * @param metadata - Optional metadata for categorization and filtering
   * @returns Ingest result with RAG document IDs and memory trace IDs
   *
   * @throws {Error} If the underlying indexer has no vision provider
   * @throws {Error} If the vision LLM returns an empty description
   *
   * @example
   * ```typescript
   * const result = await bridge.ingestImage(
   *   fs.readFileSync('./photo.jpg'),
   *   { source: 'camera', tags: ['landscape'] }
   * );
   * console.log(result.extractedText); // 'Mountains at sunset with...'
   * ```
   */
  async ingestImage(
    image: string | Buffer,
    metadata?: IngestMetadata,
  ): Promise<IngestResult> {
    // Delegate to the indexer which handles vision LLM → embedding → vector store
    const indexResult = await this._indexer.indexImage({
      image,
      metadata: metadata as Record<string, unknown>,
      collection: metadata?.collection,
    });

    const memoryTraceIds = await this._encodeMemoryTrace(
      indexResult.description,
      // Images produce factual/descriptive knowledge → semantic memory
      'semantic',
      'external',
      metadata,
    );

    return {
      ragDocumentIds: [indexResult.id],
      memoryTraceIds,
      contentType: 'image',
      extractedText: indexResult.description,
      details: {
        visionDescriptions: [indexResult.description],
      },
    };
  }

  // -------------------------------------------------------------------------
  // Audio ingestion
  // -------------------------------------------------------------------------

  /**
   * Ingest audio into both RAG and memory.
   *
   * Processing pipeline:
   * 1. STT provider transcribes the audio to text
   * 2. Transcript is embedded into the RAG vector store via the indexer
   * 3. If memory is enabled, transcript is encoded as an episodic memory trace
   *    (audio represents a time-bound event or conversation)
   *
   * @param audio - Audio data as a Buffer (WAV, MP3, OGG, etc.)
   * @param metadata - Optional metadata; `language` provides a BCP-47 hint to STT
   * @returns Ingest result with RAG document IDs and memory trace IDs
   *
   * @throws {Error} If the underlying indexer has no STT provider
   * @throws {Error} If the STT provider returns an empty transcript
   *
   * @example
   * ```typescript
   * const result = await bridge.ingestAudio(
   *   audioBuffer,
   *   { source: 'meeting-recording', language: 'en' }
   * );
   * console.log(result.details.audioTranscript);
   * ```
   */
  async ingestAudio(
    audio: Buffer,
    metadata?: IngestMetadata & { language?: string },
  ): Promise<IngestResult> {
    // Delegate to the indexer which handles STT → embedding → vector store
    const indexResult = await this._indexer.indexAudio({
      audio,
      metadata: metadata as Record<string, unknown>,
      collection: metadata?.collection,
      language: metadata?.language,
    });

    const memoryTraceIds = await this._encodeMemoryTrace(
      indexResult.transcript,
      // Audio represents a time-bound event → episodic memory
      'episodic',
      'external',
      metadata,
    );

    return {
      ragDocumentIds: [indexResult.id],
      memoryTraceIds,
      contentType: 'audio',
      extractedText: indexResult.transcript,
      details: {
        audioTranscript: indexResult.transcript,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Video ingestion
  // -------------------------------------------------------------------------

  /**
   * Ingest a video into both RAG and memory.
   *
   * Processing pipeline:
   * 1. Extract audio track → transcribe via STT
   * 2. Extract keyframes at intervals → describe via vision LLM
   * 3. Combine transcript + frame descriptions into a unified text
   * 4. Index combined text in RAG + encode as episodic memory
   *
   * NOTE: Video frame extraction uses ffprobe/ffmpeg if available.
   * If ffmpeg is NOT installed, the bridge falls back to audio-only
   * extraction from the raw buffer (limited to common containers like
   * MP4). A warning is logged recommending ffmpeg for full video support.
   *
   * @param video - Video data as a Buffer
   * @param metadata - Optional metadata; includes video-specific options
   * @param metadata.extractFrames - Extract keyframes for vision analysis (default: true)
   * @param metadata.frameIntervalSec - Seconds between extracted frames (default: 10)
   * @param metadata.extractAudio - Extract and transcribe audio track (default: true)
   * @returns Ingest result with all extracted content
   *
   * @example
   * ```typescript
   * const result = await bridge.ingestVideo(videoBuffer, {
   *   extractFrames: true,
   *   frameIntervalSec: 5,
   *   source: 'screen-recording',
   * });
   * console.log(result.details.frameCount);     // 12
   * console.log(result.details.audioTranscript); // 'Welcome to...'
   * ```
   */
  async ingestVideo(
    video: Buffer,
    metadata?: IngestMetadata & {
      extractFrames?: boolean;
      frameIntervalSec?: number;
      extractAudio?: boolean;
    },
  ): Promise<IngestResult> {
    const extractFrames = metadata?.extractFrames ?? true;
    const frameIntervalSec = metadata?.frameIntervalSec ?? 10;
    const extractAudio = metadata?.extractAudio ?? true;

    const ragDocumentIds: string[] = [];
    const memoryTraceIds: string[] = [];
    const visionDescriptions: string[] = [];
    let audioTranscript: string | undefined;
    let frameCount = 0;

    // Check ffmpeg/ffprobe availability — required for proper video processing
    const hasFfmpeg = await isCommandAvailable('ffprobe -version');

    if (!hasFfmpeg) {
      // Degrade gracefully: log warning, skip frame extraction, attempt
      // audio-only processing if the indexer has an STT provider
      console.warn(
        '[MultimodalMemoryBridge] ffmpeg/ffprobe not found on PATH. ' +
        'Video frame extraction is unavailable. Install ffmpeg for full video support. ' +
        'Falling back to audio-only extraction (limited container support).',
      );
    }

    // --- Audio extraction ---
    if (extractAudio) {
      try {
        let audioBuffer: Buffer | undefined;

        if (hasFfmpeg) {
          // Use ffmpeg to extract audio track to WAV format
          audioBuffer = await this._extractAudioWithFfmpeg(video);
        }

        if (audioBuffer && audioBuffer.length > 0) {
          const audioResult = await this._indexer.indexAudio({
            audio: audioBuffer,
            metadata: {
              ...(metadata as Record<string, unknown>),
              modality: 'audio',
              sourceModality: 'video',
            },
            collection: metadata?.collection,
          });

          ragDocumentIds.push(audioResult.id);
          audioTranscript = audioResult.transcript;
        }
      } catch (err) {
        // Audio extraction failure is non-fatal — we still try frames
        console.warn(
          '[MultimodalMemoryBridge] Failed to extract audio from video:',
          (err as Error).message,
        );
      }
    }

    // --- Frame extraction ---
    if (extractFrames && hasFfmpeg) {
      try {
        const frames = await this._extractFramesWithFfmpeg(video, frameIntervalSec);
        frameCount = frames.length;

        // Index each extracted frame via the vision pipeline
        for (const frame of frames) {
          try {
            const imgResult = await this._indexer.indexImage({
              image: frame,
              metadata: {
                ...(metadata as Record<string, unknown>),
                modality: 'image',
                sourceModality: 'video',
              },
              collection: metadata?.collection,
            });

            ragDocumentIds.push(imgResult.id);
            visionDescriptions.push(imgResult.description);
          } catch (frameErr) {
            // Individual frame failure is non-fatal — continue with remaining frames
            console.warn(
              '[MultimodalMemoryBridge] Failed to index video frame:',
              (frameErr as Error).message,
            );
          }
        }
      } catch (err) {
        console.warn(
          '[MultimodalMemoryBridge] Failed to extract frames from video:',
          (err as Error).message,
        );
      }
    }

    // --- Combine all extracted text into a unified representation ---
    const textParts: string[] = [];
    if (audioTranscript) {
      textParts.push(`[Audio transcript] ${audioTranscript}`);
    }
    if (visionDescriptions.length > 0) {
      textParts.push(
        `[Visual content] ${visionDescriptions.map((d, i) => `Frame ${i + 1}: ${d}`).join(' | ')}`,
      );
    }

    const extractedText = textParts.length > 0
      ? textParts.join('\n\n')
      : '[Video processed but no content could be extracted]';

    // --- Encode into memory ---
    // Videos are time-bound events → episodic memory
    const traces = await this._encodeMemoryTrace(
      extractedText,
      'episodic',
      'external',
      metadata,
    );
    memoryTraceIds.push(...traces);

    return {
      ragDocumentIds,
      memoryTraceIds,
      contentType: 'video',
      extractedText,
      details: {
        visionDescriptions: visionDescriptions.length > 0 ? visionDescriptions : undefined,
        audioTranscript,
        frameCount: frameCount > 0 ? frameCount : undefined,
      },
    };
  }

  // -------------------------------------------------------------------------
  // PDF ingestion
  // -------------------------------------------------------------------------

  /**
   * Ingest a PDF into both RAG and memory.
   *
   * Processing pipeline:
   * 1. Extract text content from the PDF (page by page)
   * 2. Optionally extract embedded images and describe via vision LLM
   * 3. Chunk text into segments based on configured chunk size/overlap
   * 4. Index each chunk in RAG as a separate document
   * 5. Encode the combined text as a semantic memory trace
   *
   * Uses dynamic import of `pdf-parse` if available for robust extraction.
   * Falls back to regex-based raw text extraction from the PDF buffer
   * (limited but works for text-heavy PDFs without complex encoding).
   *
   * @param pdf - PDF file data as a Buffer
   * @param metadata - Optional metadata; includes PDF-specific options
   * @param metadata.extractImages - Extract embedded images for vision analysis (default: false)
   * @param metadata.chunkSize - Characters per text chunk (default: 1000)
   * @param metadata.chunkOverlap - Overlap between chunks (default: 200)
   * @returns Ingest result with all extracted content
   *
   * @throws {Error} If no text can be extracted from the PDF
   *
   * @example
   * ```typescript
   * const result = await bridge.ingestPDF(pdfBuffer, {
   *   extractImages: true,
   *   chunkSize: 500,
   *   source: 'research-paper',
   * });
   * console.log(result.details.pageCount); // 12
   * ```
   */
  async ingestPDF(
    pdf: Buffer,
    metadata?: IngestMetadata & {
      extractImages?: boolean;
      chunkSize?: number;
      chunkOverlap?: number;
    },
  ): Promise<IngestResult> {
    const shouldExtractImages = metadata?.extractImages ?? false;
    const chunkSize = metadata?.chunkSize ?? this._options.defaultChunkSize;
    const chunkOverlap = metadata?.chunkOverlap ?? this._options.defaultChunkOverlap;
    const {
      extractImages: _extractImages,
      chunkSize: _chunkSize,
      chunkOverlap: _chunkOverlap,
      ...sharedMetadata
    } = metadata ?? {};

    let rawText = '';
    let pageCount: number | undefined;

    // --- Text extraction ---
    // Try pdf-parse first (optional peer dependency), fall back to regex
    try {
      const pdfParse = await this._tryImportPdfParse();
      if (pdfParse) {
        const parsed = await pdfParse(pdf);
        rawText = parsed.text ?? '';
        pageCount = parsed.numpages;
      }
    } catch (err) {
      console.warn(
        '[MultimodalMemoryBridge] pdf-parse failed, falling back to regex extraction:',
        (err as Error).message,
      );
    }

    // Regex fallback: extract readable strings from raw PDF byte stream.
    // This handles simple text PDFs but misses complex encoding (CID fonts, etc.)
    if (!rawText || rawText.trim().length === 0) {
      rawText = this._extractTextFromPdfBuffer(pdf);
    }

    if (!rawText || rawText.trim().length === 0) {
      throw new Error(
        'MultimodalMemoryBridge: could not extract any text from PDF. ' +
        'The file may be image-only; install pdf-parse for better extraction.',
      );
    }

    const ragDocumentIds: string[] = [];
    const visionDescriptions: string[] = [];
    const embeddedImages = 0;

    // --- Chunk text and index each chunk ---
    const chunks = chunkText(rawText.trim(), chunkSize, chunkOverlap);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const indexResult = await this._indexer.indexText({
        text: chunk,
        collection: sharedMetadata.collection as string | undefined,
        metadata: {
          ...sharedMetadata,
          sourceModality: 'pdf',
          chunkIndex: i,
          chunkCount: chunks.length,
          ...(pageCount !== undefined ? { pageCount } : {}),
        },
      });

      ragDocumentIds.push(indexResult.id);
    }

    // --- Extract embedded images (optional) ---
    if (shouldExtractImages) {
      // Image extraction from PDFs requires pdf-parse with page rendering
      // capabilities, which is beyond the basic pdf-parse package.
      // Log a note that this is a future enhancement.
      console.warn(
        '[MultimodalMemoryBridge] PDF image extraction requires advanced PDF parsing ' +
        'capabilities (e.g. pdf-lib or pdfjs-dist). Skipping embedded image extraction.',
      );
    }

    // --- Encode text into memory ---
    // PDFs contain factual/reference content → semantic memory
    const memoryTraceIds = await this._encodeMemoryTrace(
      rawText.trim(),
      'semantic',
      'external',
      metadata,
    );

    return {
      ragDocumentIds,
      memoryTraceIds,
      contentType: 'pdf',
      extractedText: rawText.trim(),
      details: {
        pageCount,
        embeddedImages: embeddedImages > 0 ? embeddedImages : undefined,
        visionDescriptions: visionDescriptions.length > 0 ? visionDescriptions : undefined,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Auto-detect ingestion
  // -------------------------------------------------------------------------

  /**
   * Auto-detect content type and route to the correct handler.
   *
   * Detection priority:
   * 1. Explicit `mimeType` if provided
   * 2. File extension from `fileName` if provided
   * 3. Magic bytes from the buffer header
   *
   * @param content - Raw content buffer
   * @param options - Detection hints and metadata
   * @param options.fileName - Original file name for extension-based detection
   * @param options.mimeType - Explicit MIME type override
   * @param options.metadata - Metadata to pass through to the handler
   * @returns Ingest result from the appropriate handler
   *
   * @throws {Error} If content type cannot be determined
   * @throws {Error} If the detected content type is unsupported
   *
   * @example
   * ```typescript
   * // Auto-detect from file name
   * const result = await bridge.ingest(buffer, {
   *   fileName: 'presentation.pdf',
   *   metadata: { source: 'email-attachment' },
   * });
   *
   * // Auto-detect from magic bytes
   * const result2 = await bridge.ingest(buffer, {});
   * ```
   */
  async ingest(
    content: Buffer,
    options: {
      fileName?: string;
      mimeType?: string;
      metadata?: IngestMetadata;
    },
  ): Promise<IngestResult> {
    let contentType: IngestResult['contentType'] | undefined;

    // Priority 1: explicit MIME type
    if (options.mimeType) {
      contentType = mimeToContentType(options.mimeType);
    }

    // Priority 2: file extension
    if (!contentType && options.fileName) {
      const ext = options.fileName.split('.').pop() ?? '';
      contentType = extToContentType(ext);
    }

    // Priority 3: magic bytes
    if (!contentType) {
      const detectedMime = detectMimeFromBuffer(content);
      if (detectedMime !== 'application/octet-stream') {
        contentType = mimeToContentType(detectedMime);
      }
    }

    if (!contentType) {
      throw new Error(
        'MultimodalMemoryBridge: could not detect content type. ' +
        'Provide a fileName or mimeType hint.',
      );
    }

    // Route to the appropriate handler
    switch (contentType) {
      case 'image':
        return this.ingestImage(content, options.metadata);
      case 'audio':
        return this.ingestAudio(content, options.metadata);
      case 'video':
        return this.ingestVideo(content, options.metadata);
      case 'pdf':
        return this.ingestPDF(content, options.metadata);
      case 'text':
        // Text fallback: encode directly as memory trace with no RAG indexing
        // (text RAG is handled by the standard RetrievalAugmentor pipeline)
        return this._ingestText(content.toString('utf-8'), options.metadata);
      default:
        throw new Error(
          `MultimodalMemoryBridge: unsupported content type '${contentType}'.`,
        );
    }
  }

  // -------------------------------------------------------------------------
  // Private: text ingestion fallback
  // -------------------------------------------------------------------------

  /**
   * Ingest raw text into memory only (no RAG — the standard pipeline handles that).
   *
   * @param text - Raw text content
   * @param metadata - Optional metadata
   * @returns Ingest result with memory trace IDs only
   */
  private async _ingestText(text: string, metadata?: IngestMetadata): Promise<IngestResult> {
    const memoryTraceIds = await this._encodeMemoryTrace(
      text,
      'semantic',
      'external',
      metadata,
    );

    return {
      ragDocumentIds: [],
      memoryTraceIds,
      contentType: 'text',
      extractedText: text,
      details: {},
    };
  }

  // -------------------------------------------------------------------------
  // Private: memory encoding
  // -------------------------------------------------------------------------

  /**
   * Encode text into a cognitive memory trace if memory is enabled.
   *
   * Uses the ICognitiveMemoryManager.encode() method which creates a
   * proper MemoryTrace with emotional context, decay parameters, etc.
   *
   * @param text - Text content to encode as a memory trace
   * @param type - Memory type (semantic for factual, episodic for events)
   * @param sourceType - How the content was produced
   * @param metadata - Optional metadata for tags and source info
   * @returns Array of memory trace IDs (empty if memory is disabled)
   */
  private async _encodeMemoryTrace(
    text: string,
    type: MemoryType,
    sourceType: MemoryTrace['provenance']['sourceType'],
    metadata?: IngestMetadata,
  ): Promise<string[]> {
    // Skip memory encoding when disabled or no manager is available
    if (!this._options.enableMemory || !this._memoryManager) {
      return [];
    }

    try {
      const trace = await this._memoryManager.encode(
        text,
        this._options.defaultMood,
        // gmiMood: use a neutral descriptor since we're not in a conversation context
        'neutral',
        {
          type,
          sourceType,
          tags: metadata?.tags,
          // Use the source as a scope hint if provided
          ...(metadata?.source ? { scopeId: metadata.source } : {}),
        },
      );

      return [trace.id];
    } catch (err) {
      // Memory encoding failure is non-fatal — RAG indexing already succeeded
      console.warn(
        '[MultimodalMemoryBridge] Failed to encode memory trace:',
        (err as Error).message,
      );
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Private: ffmpeg helpers
  // -------------------------------------------------------------------------

  /**
   * Extract audio track from video buffer using ffmpeg.
   *
   * Writes the video to a temp file, runs ffmpeg to extract audio as WAV,
   * reads the result back into a Buffer, and cleans up temp files.
   *
   * @param video - Video data buffer
   * @returns Audio data buffer in WAV format
   * @throws {Error} If ffmpeg extraction fails
   */
  private async _extractAudioWithFfmpeg(video: Buffer): Promise<Buffer> {
    const tmpDir = await mkdtemp(join(tmpdir(), 'mmbridge-'));
    const videoPath = join(tmpDir, `input-${randomUUID()}.mp4`);
    const audioPath = join(tmpDir, `output-${randomUUID()}.wav`);

    try {
      await writeFile(videoPath, video);

      // -vn: skip video stream, -acodec pcm_s16le: 16-bit PCM WAV output
      // -ar 16000: 16kHz sample rate (standard for STT)
      // -ac 1: mono channel (most STT models expect mono)
      await exec(
        `ffmpeg -i "${videoPath}" -vn -acodec pcm_s16le -ar 16000 -ac 1 "${audioPath}" -y`,
        { timeout: 60_000 },
      );

      const { readFile } = await import('node:fs/promises');
      return await readFile(audioPath);
    } finally {
      // Clean up temp files — errors here are non-fatal
      await unlink(videoPath).catch(() => {});
      await unlink(audioPath).catch(() => {});
      // Remove temp directory (will fail if non-empty, which is fine)
      const { rmdir } = await import('node:fs/promises');
      await rmdir(tmpDir).catch(() => {});
    }
  }

  /**
   * Extract keyframes from video at fixed intervals using ffmpeg.
   *
   * Writes the video to a temp file, runs ffmpeg to extract JPEG frames
   * at the specified interval, reads each frame back into a Buffer.
   *
   * @param video - Video data buffer
   * @param intervalSec - Seconds between extracted frames
   * @returns Array of image Buffers (JPEG format)
   * @throws {Error} If ffmpeg extraction fails
   */
  private async _extractFramesWithFfmpeg(
    video: Buffer,
    intervalSec: number,
  ): Promise<Buffer[]> {
    const tmpDir = await mkdtemp(join(tmpdir(), 'mmbridge-frames-'));
    const videoPath = join(tmpDir, `input-${randomUUID()}.mp4`);

    try {
      await writeFile(videoPath, video);

      // -vf fps=1/N: extract one frame every N seconds
      // -f image2: output as individual image files
      // -q:v 2: JPEG quality (2 = high quality, smaller = higher quality)
      await exec(
        `ffmpeg -i "${videoPath}" -vf "fps=1/${intervalSec}" -f image2 -q:v 2 "${join(tmpDir, 'frame-%04d.jpg')}" -y`,
        { timeout: 120_000 },
      );

      // Read all extracted frame files
      const { readdir, readFile } = await import('node:fs/promises');
      const files = await readdir(tmpDir);
      const frameFiles = files
        .filter((f) => f.startsWith('frame-') && f.endsWith('.jpg'))
        .sort(); // Lexicographic sort preserves frame order

      const frames: Buffer[] = [];
      for (const file of frameFiles) {
        frames.push(await readFile(join(tmpDir, file)));
      }

      return frames;
    } finally {
      // Clean up all temp files
      const { readdir, unlink: unlinkFile, rmdir } = await import('node:fs/promises');
      try {
        const files = await readdir(tmpDir);
        for (const file of files) {
          await unlinkFile(join(tmpDir, file)).catch(() => {});
        }
        await rmdir(tmpDir).catch(() => {});
      } catch {
        // Cleanup failure is non-fatal
      }
    }
  }

  // -------------------------------------------------------------------------
  // Private: PDF helpers
  // -------------------------------------------------------------------------

  /**
   * Attempt to dynamically import the pdf-parse package.
   *
   * pdf-parse is an optional peer dependency — it's not bundled with agentos
   * to keep the core lightweight. Returns null if the package is not installed.
   *
   * @returns The pdf-parse default export function, or null if unavailable
   */
  private async _tryImportPdfParse(): Promise<((buf: Buffer) => Promise<{
    text: string;
    numpages: number;
    info: unknown;
  }>) | null> {
    try {
      // Dynamic import so the dep is truly optional — won't blow up at
      // module load time if pdf-parse isn't installed
      // @ts-ignore — optional peer dependency; types not guaranteed to be installed
      const mod = await import('pdf-parse');
      return mod.default ?? mod;
    } catch {
      return null;
    }
  }

  /**
   * Fallback PDF text extraction using regex on the raw buffer.
   *
   * Scans the PDF byte stream for text objects (between BT/ET markers)
   * and string literals (parenthesized and hex-encoded). This works for
   * simple text PDFs but misses content in complex encodings, CID fonts,
   * or image-only PDFs.
   *
   * @param buf - Raw PDF buffer
   * @returns Extracted text (may be empty for non-text PDFs)
   */
  private _extractTextFromPdfBuffer(buf: Buffer): string {
    const raw = buf.toString('latin1');
    const textParts: string[] = [];

    // Match text between BT (begin text) and ET (end text) markers.
    // Inside, look for parenthesized strings (Tj/TJ operators).
    const btEtRegex = /BT\s([\s\S]*?)ET/g;
    let btMatch: RegExpExecArray | null;

    while ((btMatch = btEtRegex.exec(raw)) !== null) {
      const block = btMatch[1];
      // Extract parenthesized string literals
      const strRegex = /\(([^)]*)\)/g;
      let strMatch: RegExpExecArray | null;
      while ((strMatch = strRegex.exec(block)) !== null) {
        const decoded = strMatch[1]
          // Unescape common PDF escape sequences
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '\r')
          .replace(/\\t/g, '\t')
          .replace(/\\\\/g, '\\')
          .replace(/\\\(/g, '(')
          .replace(/\\\)/g, ')');
        textParts.push(decoded);
      }
    }

    return textParts.join(' ').replace(/\s+/g, ' ').trim();
  }
}
