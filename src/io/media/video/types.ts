/**
 * @file types.ts
 * Core type definitions for the video generation and analysis subsystem.
 *
 * These types are consumed by {@link IVideoGenerator}, {@link IVideoAnalyzer},
 * and {@link FallbackVideoProxy} to provide a unified video pipeline across
 * multiple provider backends (Runway, Pika, Kling, Luma, etc.).
 */

// ---------------------------------------------------------------------------
// Common enums / branded types
// ---------------------------------------------------------------------------

/** Well-known video provider identifiers. Extensible via `(string & {})`. */
export type VideoProviderId =
  | 'runway'
  | 'replicate'
  | 'fal'
  | (string & {});

/** Output container format for generated videos. */
export type VideoOutputFormat = 'mp4' | 'webm' | 'gif';

/** Aspect ratio presets commonly supported by video generation APIs. */
export type VideoAspectRatio =
  | '1:1'
  | '16:9'
  | '9:16'
  | '4:3'
  | '3:4'
  | '21:9'
  | (string & {});

// ---------------------------------------------------------------------------
// Provider metadata
// ---------------------------------------------------------------------------

/** Describes a video model exposed by a provider. */
export interface VideoModelInfo {
  /** Unique model identifier (e.g. `'gen-3-alpha'`). */
  modelId: string;
  /** Provider that hosts this model. */
  providerId: string;
  /** Human-readable display name. */
  displayName?: string;
  /** Short description of the model's capabilities. */
  description?: string;
  /** Maximum output duration in seconds. */
  maxDurationSec?: number;
  /** Supported generation capabilities. */
  capabilities?: Array<'text-to-video' | 'image-to-video'>;
}

/** Aggregated usage / billing counters for a video generation session. */
export interface VideoProviderUsage {
  /** Number of videos generated in this session. */
  totalVideos: number;
  /** Total cost in USD, if the provider reports it. */
  totalCostUSD?: number;
  /** Total processing time in milliseconds. */
  processingTimeMs?: number;
}

// ---------------------------------------------------------------------------
// Generation requests
// ---------------------------------------------------------------------------

/**
 * Request payload for text-to-video generation.
 *
 * Passed to {@link IVideoGenerator.generateVideo} by the high-level
 * orchestration layer after normalising user input.
 */
export interface VideoGenerateRequest {
  /** Model identifier to use for generation (e.g. `'gen-3-alpha'`). */
  modelId?: string;
  /** Text prompt describing the desired video content. */
  prompt: string;
  /** Negative prompt describing content to avoid. */
  negativePrompt?: string;
  /** Desired output duration in seconds. */
  durationSec?: number;
  /** Desired aspect ratio (e.g. `'16:9'`). */
  aspectRatio?: VideoAspectRatio;
  /** Desired output resolution (e.g. `'1280x720'`). */
  resolution?: string;
  /** Output container format. Defaults to `'mp4'`. */
  outputFormat?: VideoOutputFormat;
  /** Frames per second for the output video. */
  fps?: number;
  /** Seed for reproducible output. */
  seed?: number;
  /** Number of videos to generate. Defaults to `1`. */
  n?: number;
  /** Identifier of the requesting user (for billing / rate limiting). */
  userId?: string;
  /** Arbitrary provider-specific options. */
  providerOptions?: Record<string, unknown>;
}

/**
 * Request payload for image-to-video generation.
 *
 * Passed to {@link IVideoGenerator.imageToVideo} by the high-level
 * orchestration layer. Requires a source image that serves as the first
 * frame (or style reference) for the generated video.
 */
export interface ImageToVideoRequest {
  /** Model identifier to use for generation. */
  modelId?: string;
  /** Source image as a raw `Buffer`. */
  image: Buffer;
  /** Text prompt describing the desired motion / narrative. */
  prompt: string;
  /** Negative prompt describing content to avoid. */
  negativePrompt?: string;
  /** Desired output duration in seconds. */
  durationSec?: number;
  /** Desired aspect ratio. */
  aspectRatio?: VideoAspectRatio;
  /** Output container format. Defaults to `'mp4'`. */
  outputFormat?: VideoOutputFormat;
  /** Frames per second for the output video. */
  fps?: number;
  /** Seed for reproducible output. */
  seed?: number;
  /** Identifier of the requesting user. */
  userId?: string;
  /** Arbitrary provider-specific options. */
  providerOptions?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Generation results
// ---------------------------------------------------------------------------

/** A single generated video artifact. */
export interface GeneratedVideo {
  /** Public URL where the video can be downloaded. */
  url?: string;
  /** Base64-encoded video data. */
  base64?: string;
  /** MIME type of the video (e.g. `'video/mp4'`). */
  mimeType?: string;
  /** Duration of the generated video in seconds. */
  durationSec?: number;
  /** Width in pixels. */
  width?: number;
  /** Height in pixels. */
  height?: number;
  /** Thumbnail / poster image URL. */
  thumbnailUrl?: string;
  /** Provider-specific metadata (job ID, generation params, etc.). */
  providerMetadata?: Record<string, unknown>;
}

/**
 * Result envelope returned by {@link IVideoGenerator.generateVideo} and
 * {@link IVideoGenerator.imageToVideo}.
 */
export interface VideoResult {
  /** Unix timestamp (ms) when the result was created. */
  created: number;
  /** Model identifier that produced the result. */
  modelId: string;
  /** Provider identifier that produced the result. */
  providerId: string;
  /** The generated video(s). */
  videos: GeneratedVideo[];
  /** Usage / billing information, if available. */
  usage?: VideoProviderUsage;
}

// ---------------------------------------------------------------------------
// Analysis requests & results
// ---------------------------------------------------------------------------

/**
 * Request payload for video analysis / understanding.
 *
 * Passed to {@link IVideoAnalyzer.analyzeVideo}.
 */
export interface VideoAnalyzeRequest {
  /** URL of the video to analyse. Mutually exclusive with `videoBuffer`. */
  videoUrl?: string;
  /** Raw video bytes. Mutually exclusive with `videoUrl`. */
  videoBuffer?: Buffer;
  /** Text prompt / question to guide the analysis. */
  prompt?: string;
  /** Model identifier to use for analysis. */
  modelId?: string;
  /** Maximum number of frames to sample for analysis. */
  maxFrames?: number;
  /** Arbitrary provider-specific options. */
  providerOptions?: Record<string, unknown>;
}

/** Structured result from video analysis. */
export interface VideoAnalysis {
  /** Free-form textual description / answer from the analyser. */
  description: string;
  /** Detected scene segments with timestamps. */
  scenes?: VideoScene[];
  /** Detected objects / entities across the video. */
  objects?: string[];
  /** Detected on-screen or spoken text (OCR / ASR). */
  text?: string[];
  /** Overall duration of the analysed video in seconds. */
  durationSec?: number;
  /** Model that produced the analysis. */
  modelId?: string;
  /** Provider that produced the analysis. */
  providerId?: string;
  /** Provider-specific metadata. */
  providerMetadata?: Record<string, unknown>;
}

/** A single scene / segment detected during video analysis. */
export interface VideoScene {
  /** Start time of the scene in seconds. */
  startSec: number;
  /** End time of the scene in seconds. */
  endSec: number;
  /** Human-readable description of what happens in this scene. */
  description: string;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Output resolution for generated or analyzed video.
 *
 * Higher resolutions increase generation time and cost but produce
 * sharper output. Not all providers support all resolutions — the
 * adapter will fall back to the closest supported resolution.
 */
export type VideoResolution = '480p' | '720p' | '1080p';

// ---------------------------------------------------------------------------
// Typed progress events
// ---------------------------------------------------------------------------

/**
 * Typed progress event emitted during video generation.
 *
 * The generation lifecycle flows through these statuses in order:
 * `queued` -> `processing` -> `downloading` -> `complete` (or `failed`
 * at any point).
 */
export interface VideoProgressEvent {
  /**
   * Current status of the generation job.
   *
   * - `'queued'`      — Request accepted, waiting for GPU slot
   * - `'processing'`  — Actively generating frames
   * - `'downloading'` — Generation complete, downloading result
   * - `'complete'`    — Fully done, result available
   * - `'failed'`      — Terminal error, see {@link message}
   */
  status: 'queued' | 'processing' | 'downloading' | 'complete' | 'failed';

  /**
   * Estimated progress percentage (0-100).
   * Not all providers report granular progress; may remain undefined
   * until the final status transition.
   */
  progress?: number;

  /**
   * Estimated time remaining in milliseconds.
   * Only available when the provider reports ETA information.
   */
  estimatedRemainingMs?: number;

  /** Human-readable status message or error description. */
  message?: string;
}

/**
 * Progress event emitted during video analysis.
 *
 * The analysis lifecycle flows through these phases in order:
 * `extracting-frames` -> `detecting-scenes` -> `describing` ->
 * `transcribing` -> `summarizing`.
 */
export interface VideoAnalysisProgressEvent {
  /**
   * Current phase of the analysis pipeline.
   *
   * - `'extracting-frames'` — Decoding video and extracting frames
   * - `'detecting-scenes'`  — Running scene boundary detection
   * - `'describing'`        — Sending key frames to vision LLM
   * - `'transcribing'`      — Running audio transcription via Whisper
   * - `'summarizing'`       — Generating overall video summary
   */
  phase:
    | 'extracting-frames'
    | 'detecting-scenes'
    | 'describing'
    | 'transcribing'
    | 'summarizing';

  /**
   * Estimated progress percentage (0-100) within the current phase.
   * Not always available — depends on the phase and provider.
   */
  progress?: number;

  /**
   * 0-based index of the scene currently being processed.
   * Only meaningful during the `'describing'` and `'transcribing'` phases.
   */
  currentScene?: number;

  /** Human-readable status message for the current phase. */
  message?: string;
}

// ---------------------------------------------------------------------------
// Rich scene description (used by the video analysis pipeline)
// ---------------------------------------------------------------------------

/**
 * A single scene detected within a video, with timestamps,
 * description, and optional transcript.
 *
 * Scenes are contiguous segments of video bounded by visual
 * discontinuities (hard cuts, dissolves, fades). The `SceneDetector`
 * class (exported from `@framers/agentos/io/vision`) identifies
 * boundaries, and a vision LLM describes the content of each scene.
 *
 * This is a richer version of the base {@link VideoScene} type that
 * includes cut-type classification, confidence, transcript, and key
 * frame data.
 */
export interface SceneDescription {
  /** 0-based scene index within the video. */
  index: number;

  /** Start time of the scene in seconds from video start. */
  startSec: number;

  /** End time of the scene in seconds from video start. */
  endSec: number;

  /** Duration of the scene in seconds (`endSec - startSec`). */
  durationSec: number;

  /**
   * Type of visual transition that marks the beginning of this scene.
   *
   * - `'hard-cut'`  — Abrupt frame-to-frame change
   * - `'dissolve'`  — Cross-dissolve / superimposition transition
   * - `'fade'`      — Fade from/to black or white
   * - `'wipe'`      — Directional wipe transition
   * - `'gradual'`   — Other gradual transition not fitting the above
   * - `'start'`     — First scene in the video (no preceding transition)
   */
  cutType: 'hard-cut' | 'dissolve' | 'fade' | 'wipe' | 'gradual' | 'start';

  /**
   * Natural-language description of the scene content, generated
   * by a vision LLM from the key frame.
   */
  description: string;

  /**
   * Transcript of speech/narration during this scene's time range.
   * Only populated when audio transcription is enabled.
   */
  transcript?: string;

  /**
   * Base64-encoded key frame image (JPEG) representative of the scene.
   * Typically the frame closest to the scene midpoint.
   */
  keyFrame?: string;

  /**
   * Confidence score (0-1) for the scene boundary detection.
   * Higher values indicate a more definitive visual discontinuity.
   */
  confidence: number;
}

// ---------------------------------------------------------------------------
// Rich analysis
// ---------------------------------------------------------------------------

/**
 * Detail level for scene descriptions produced during video analysis.
 *
 * - `'brief'`      — 1-2 sentences per scene, focusing on key action
 * - `'detailed'`   — Full paragraph per scene with lighting, composition, mood
 * - `'exhaustive'` — Multi-paragraph with frame-level details, objects, colors
 */
export type DescriptionDetail = 'brief' | 'detailed' | 'exhaustive';

/**
 * Rich video analysis request with scene detection, transcription,
 * and RAG indexing support.
 *
 * Extends the simpler {@link VideoAnalyzeRequest} pattern with
 * fine-grained control over scene detection thresholds, description
 * detail, and optional RAG indexing of analysis results.
 *
 * @example
 * ```typescript
 * const request: VideoAnalyzeRequestRich = {
 *   video: 'https://example.com/demo.mp4',
 *   sceneThreshold: 0.3,
 *   transcribeAudio: true,
 *   descriptionDetail: 'detailed',
 *   onProgress: (evt) => console.log(`${evt.phase}: ${evt.progress}%`),
 * };
 * ```
 */
export interface VideoAnalyzeRequestRich {
  /**
   * Video to analyze — either a URL string or a raw Buffer.
   * When a URL is provided, the pipeline downloads the video to a
   * temporary file before processing.
   */
  video: string | Buffer;

  /**
   * Optional analysis prompt or question that should guide the final answer.
   * When omitted, the analyzer produces a general-purpose summary.
   */
  prompt?: string;

  /**
   * Threshold for scene change detection (0-1).
   * Lower values detect more scene boundaries (more sensitive);
   * higher values only detect dramatic cuts.
   * @default 0.3
   */
  sceneThreshold?: number;

  /**
   * Whether to transcribe the audio track using Whisper.
   * When enabled, each scene's transcript is populated and a
   * full transcript is included in the analysis.
   * @default true
   */
  transcribeAudio?: boolean;

  /**
   * How detailed scene descriptions should be.
   * @default 'detailed'
   */
  descriptionDetail?: DescriptionDetail;

  /**
   * Maximum number of frames to sample from the extracted frame set.
   * When the extracted frame count exceeds this value, frames are
   * evenly downsampled before scene detection and description.
   */
  maxFrames?: number;

  /**
   * Maximum number of scenes to detect.
   * Prevents runaway analysis on very long videos with many cuts.
   * @default 100
   */
  maxScenes?: number;

  /**
   * Whether to index scene descriptions and transcripts into the
   * RAG vector store for later retrieval.
   * @default false
   */
  indexForRAG?: boolean;

  /**
   * Optional callback invoked as analysis progresses through phases.
   * Called with a {@link VideoAnalysisProgressEvent} at each phase
   * transition and when per-scene progress updates are available.
   */
  onProgress?: (event: VideoAnalysisProgressEvent) => void;
}

/**
 * Rich video analysis result with full scene descriptions, summary,
 * transcript, and optional RAG chunk references.
 *
 * This is a richer version of the base {@link VideoAnalysis} type that
 * includes {@link SceneDescription} scenes (with cut types, confidence,
 * key frames), a generated summary, and optional RAG indexing metadata.
 *
 * @example
 * ```typescript
 * const analysis: VideoAnalysisRich = await videoAnalyzer.analyze(request);
 *
 * console.log(`${analysis.sceneCount} scenes in ${analysis.durationSec}s`);
 * for (const scene of analysis.scenes) {
 *   console.log(`[${scene.startSec}s-${scene.endSec}s] ${scene.description}`);
 * }
 * ```
 */
export interface VideoAnalysisRich {
  /** Total video duration in seconds. */
  durationSec: number;

  /** Number of scenes detected. */
  sceneCount: number;

  /** Ordered list of all detected scenes with rich descriptions. */
  scenes: SceneDescription[];

  /**
   * Overall summary of the video content, generated by an LLM
   * from the scene descriptions and transcript.
   */
  summary: string;

  /**
   * Full transcript of all audio in the video, when transcription
   * was enabled. Concatenation of all scene transcripts with
   * timestamp markers.
   */
  fullTranscript?: string;

  /**
   * IDs of RAG vector store chunks created from this analysis.
   * Only populated when {@link VideoAnalyzeRequestRich.indexForRAG}
   * was enabled.
   */
  ragChunkIds?: string[];

  /**
   * Additional metadata about the analyzed video.
   * Provider-specific information that doesn't fit into the
   * structured fields above.
   */
  metadata: Record<string, unknown>;
}
