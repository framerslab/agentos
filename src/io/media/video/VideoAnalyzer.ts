/**
 * @module media/video/VideoAnalyzer
 *
 * Wires {@link SceneDetector}, {@link VisionPipeline}, and an optional
 * {@link SpeechToTextProvider} into a structured video analysis pipeline.
 *
 * The analyzer replaces the monolithic `ingestVideo()` approach in
 * {@link MultimodalMemoryBridge} with a composable, progress-reporting
 * pipeline that produces rich scene descriptions, summaries, and optional
 * RAG-indexed chunks.
 *
 * ## Pipeline stages
 *
 * ```
 *   Video Buffer
 *     ↓
 *   1. Write to temp file
 *   2. ffprobe → duration
 *   3. ffmpeg  → 1fps PNG frames
 *   4. SceneDetector.detectScenes(frames)
 *   5. Per-scene: VisionPipeline.process(keyFrame)
 *   6. (optional) ffmpeg → WAV audio → STT → transcript segments
 *   7. generateText() LLM → overall summary
 *   8. (optional) RAG chunk indexing
 *   9. Clean up temp files
 * ```
 *
 * ## Usage
 *
 * ```typescript
 * import { VideoAnalyzer } from '@framers/agentos/media/video';
 *
 * const analyzer = new VideoAnalyzer();
 * const result = await analyzer.analyzeVideo({
 *   video: videoBuffer,
 *   transcribeAudio: true,
 *   onProgress: (evt) => console.log(`${evt.phase}: ${evt.progress}%`),
 * });
 *
 * for (const scene of result.scenes) {
 *   console.log(`[${scene.startSec}-${scene.endSec}s] ${scene.description}`);
 * }
 * ```
 *
 * @see {@link IVideoAnalyzer} for the base interface.
 * @see {@link SceneDetector} for scene boundary detection.
 * @see {@link VisionPipeline} for frame description.
 * @see {@link SpeechToTextProvider} for audio transcription.
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeFile,
  readFile,
  readdir,
  mkdir,
  rm,
} from 'node:fs/promises';

import type { IVideoAnalyzer } from './IVideoAnalyzer.js';
import type {
  VideoAnalyzeRequest,
  VideoAnalysis,
  VideoAnalyzeRequestRich,
  VideoAnalysisRich,
  VideoAnalysisProgressEvent,
  SceneDescription,
} from './types.js';

import { SceneDetector } from '../../vision/SceneDetector.js';
import type { VisionPipeline } from '../../vision/VisionPipeline.js';
import type { Frame, SceneBoundary } from '../../vision/types.js';
import type { SpeechToTextProvider } from '../../speech/types.js';

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Dependency injection shape
// ---------------------------------------------------------------------------

/**
 * Dependencies injected into the {@link VideoAnalyzer} constructor.
 *
 * All fields are optional — the analyzer will auto-create default
 * instances for {@link VisionPipeline} and {@link SceneDetector} when
 * they are not provided.
 */
export interface VideoAnalyzerDeps {
  /**
   * Vision pipeline for describing key frames.
   * When omitted, a default pipeline is auto-created via
   * {@link createVisionPipeline} on first use.
   */
  visionPipeline?: VisionPipeline;

  /**
   * Speech-to-text provider for audio transcription.
   * When omitted, the `transcribeAudio` option in analysis requests
   * is silently skipped (scenes will not have transcripts).
   */
  sttProvider?: SpeechToTextProvider;

  /**
   * Scene boundary detector for segmenting the video.
   * When omitted, a default {@link SceneDetector} with standard
   * thresholds is auto-created.
   */
  sceneDetector?: SceneDetector;
}

// ---------------------------------------------------------------------------
// VideoAnalyzer
// ---------------------------------------------------------------------------

/**
 * Structured video analysis pipeline that wires together scene detection,
 * vision description, audio transcription, and LLM summarization.
 *
 * Implements the base {@link IVideoAnalyzer} interface for simple analysis
 * requests, and exposes an `analyze()` method for rich analysis with
 * progress reporting, configurable detail levels, and optional RAG indexing.
 *
 * All ffmpeg/ffprobe invocations use `execFile` (not `exec`) for safety —
 * arguments are passed as arrays, preventing shell injection.
 */
export class VideoAnalyzer implements IVideoAnalyzer {
  /** Injected or auto-created vision pipeline. */
  private _visionPipeline?: VisionPipeline;

  /** Injected STT provider (may be undefined). */
  private readonly _sttProvider?: SpeechToTextProvider;

  /** Injected or auto-created scene detector. */
  private readonly _sceneDetector: SceneDetector;

  /** Whether the vision pipeline was user-supplied (vs auto-created). */
  private readonly _userSuppliedVision: boolean;

  // -------------------------------------------------------------------------
  // Constructor
  // -------------------------------------------------------------------------

  /**
   * Create a new VideoAnalyzer with optional injected dependencies.
   *
   * Missing dependencies are auto-created with sensible defaults:
   * - **VisionPipeline**: created lazily via `createVisionPipeline()` on first use
   * - **SceneDetector**: created immediately with default thresholds
   * - **SpeechToTextProvider**: left undefined — transcription skipped when missing
   *
   * @param deps - Optional dependency overrides.
   */
  constructor(deps?: VideoAnalyzerDeps) {
    this._visionPipeline = deps?.visionPipeline;
    this._sttProvider = deps?.sttProvider;
    this._sceneDetector = deps?.sceneDetector ?? new SceneDetector();
    this._userSuppliedVision = !!deps?.visionPipeline;
  }

  // -------------------------------------------------------------------------
  // IVideoAnalyzer — simple analysis
  // -------------------------------------------------------------------------

  /**
   * Analyse a video and return structured understanding results.
   *
   * This is the simple {@link IVideoAnalyzer} interface method. For richer
   * analysis with progress reporting and scene descriptions, use
   * {@link analyze} instead.
   *
   * @param request - The analysis parameters (video source + optional prompt).
   * @returns Structured analysis including description, scenes, and duration.
   */
  async analyzeVideo(request: VideoAnalyzeRequest): Promise<VideoAnalysis> {
    // Resolve video buffer from URL or direct buffer
    let videoBuffer: Buffer;
    if (request.videoBuffer) {
      videoBuffer = request.videoBuffer;
    } else if (request.videoUrl) {
      const response = await fetch(request.videoUrl);
      videoBuffer = Buffer.from(await response.arrayBuffer());
    } else {
      throw new Error(
        'VideoAnalyzer.analyzeVideo: either videoUrl or videoBuffer must be provided.',
      );
    }

    const rich = await this.analyze({
      video: videoBuffer,
      prompt: request.prompt,
      transcribeAudio: false,
      descriptionDetail: 'brief',
      maxFrames: request.maxFrames,
    });

    return {
      description: rich.summary,
      scenes: rich.scenes.map((s) => ({
        startSec: s.startSec,
        endSec: s.endSec,
        description: s.description,
      })),
      text: rich.fullTranscript ? [rich.fullTranscript] : undefined,
      durationSec: rich.durationSec,
      modelId: request.modelId,
      providerId: 'agentos-video-analyzer',
      providerMetadata: rich.metadata,
    };
  }

  // -------------------------------------------------------------------------
  // Rich analysis — main pipeline
  // -------------------------------------------------------------------------

  /**
   * Run the full video analysis pipeline with scene detection, vision
   * descriptions, optional audio transcription, and LLM summarization.
   *
   * The pipeline executes these stages sequentially:
   *
   * 1. **Extract frames** — decode video at 1fps via ffmpeg
   * 2. **Detect scenes** — run SceneDetector over extracted frames
   * 3. **Describe scenes** — send key frames to VisionPipeline
   * 4. **Transcribe audio** — (optional) extract audio and run STT
   * 5. **Summarize** — generate overall summary via LLM
   *
   * Progress events are emitted at each phase transition when
   * `onProgress` is provided.
   *
   * @param request - Rich analysis parameters.
   * @returns Rich analysis result with scenes, summary, and optional RAG chunks.
   *
   * @throws {Error} If ffprobe/ffmpeg are not installed on the system.
   * @throws {Error} If the video buffer is empty or invalid.
   */
  async analyze(request: VideoAnalyzeRequestRich): Promise<VideoAnalysisRich> {
    // Resolve video buffer
    const videoBuffer = Buffer.isBuffer(request.video)
      ? request.video
      : await this._downloadVideo(request.video);

    if (!videoBuffer || videoBuffer.length === 0) {
      throw new Error('VideoAnalyzer.analyze: video buffer is empty.');
    }

    // Create a unique temp directory for all intermediate files
    const tmpBase = join(tmpdir(), `agentos-video-${randomUUID()}`);
    await mkdir(tmpBase, { recursive: true });

    const videoPath = join(tmpBase, 'input.mp4');
    const framesDir = join(tmpBase, 'frames');
    const audioPath = join(tmpBase, 'audio.wav');

    try {
      // Write video to temp file
      await writeFile(videoPath, videoBuffer);

      // -----------------------------------------------------------------------
      // Stage 1: Probe duration
      // -----------------------------------------------------------------------
      await this._assertFfprobeAvailable();

      const durationSec = await this._probeDuration(videoPath);

      // -----------------------------------------------------------------------
      // Stage 2: Extract frames at 1fps
      // -----------------------------------------------------------------------
      this._emitProgress(request.onProgress, 'extracting-frames', 0, 'Extracting frames at 1fps');
      await mkdir(framesDir, { recursive: true });

      let frames = await this._extractFrames(videoPath, framesDir);
      const extractedFrameCount = frames.length;

      if (request.maxFrames !== undefined && request.maxFrames > 0 && frames.length > request.maxFrames) {
        frames = this._downsampleFrames(frames, request.maxFrames);
      }

      this._emitProgress(request.onProgress, 'extracting-frames', 100,
        frames.length === extractedFrameCount
          ? `Extracted ${frames.length} frames`
          : `Extracted ${extractedFrameCount} frames and sampled ${frames.length}`);

      // -----------------------------------------------------------------------
      // Stage 3: Detect scenes
      // -----------------------------------------------------------------------
      this._emitProgress(request.onProgress, 'detecting-scenes', 0, 'Detecting scene boundaries');

      const sceneBoundaries = await this._detectScenes(
        frames,
        request.sceneThreshold,
        request.maxScenes,
      );

      this._emitProgress(request.onProgress, 'detecting-scenes', 100,
        `Detected ${sceneBoundaries.length} scenes`);

      // -----------------------------------------------------------------------
      // Stage 4: Describe scenes via VisionPipeline
      // -----------------------------------------------------------------------
      this._emitProgress(request.onProgress, 'describing', 0, 'Describing scenes');

      const visionPipeline = await this._ensureVisionPipeline();
      const sceneDescriptions: SceneDescription[] = [];

      for (let i = 0; i < sceneBoundaries.length; i++) {
        const boundary = sceneBoundaries[i];

        // Select key frame: the frame closest to the midpoint of the scene
        const midTimeSec = (boundary.startTimeSec + boundary.endTimeSec) / 2;
        const keyFrame = this._selectKeyFrame(frames, midTimeSec);

        let description = '';
        let keyFrameBase64: string | undefined;

        if (keyFrame) {
          try {
            const visionResult = await visionPipeline.process(keyFrame.sourceBuffer ?? keyFrame.buffer);
            description = visionResult.text || 'No description available.';
            keyFrameBase64 = (keyFrame.sourceBuffer ?? keyFrame.buffer).toString('base64');
          } catch {
            description = 'Vision analysis failed for this scene.';
          }
        }

        sceneDescriptions.push({
          index: i,
          startSec: boundary.startTimeSec,
          endSec: boundary.endTimeSec,
          durationSec: boundary.durationSec,
          cutType: i === 0 ? 'start' : boundary.cutType as SceneDescription['cutType'],
          description,
          confidence: boundary.confidence,
          keyFrame: keyFrameBase64,
        });

        this._emitProgress(request.onProgress, 'describing',
          Math.round(((i + 1) / sceneBoundaries.length) * 100),
          `Described scene ${i + 1}/${sceneBoundaries.length}`,
          i);
      }

      // -----------------------------------------------------------------------
      // Stage 5: Transcribe audio (optional)
      // -----------------------------------------------------------------------
      let fullTranscript: string | undefined;
      const shouldTranscribe = request.transcribeAudio !== false && this._sttProvider;

      if (shouldTranscribe) {
        this._emitProgress(request.onProgress, 'transcribing', 0, 'Extracting audio');

        try {
          const audioBuffer = await this._extractAudio(videoPath, audioPath);

          if (audioBuffer && audioBuffer.length > 0) {
            this._emitProgress(request.onProgress, 'transcribing', 30, 'Transcribing audio');

            // Per-scene transcripts need segment timestamps. The OpenAI
            // provider returns them only for verbose_json (served by
            // whisper-1); the other providers ignore the field.
            const sttResult = await this._sttProvider!.transcribe(
              { data: audioBuffer, mimeType: 'audio/wav', sampleRate: 16000 },
              { responseFormat: 'verbose_json' },
            );

            fullTranscript = sttResult.text;

            // Map transcript segments to scenes by time range
            if (sttResult.segments && sttResult.segments.length > 0) {
              for (const scene of sceneDescriptions) {
                const overlapping = sttResult.segments.filter(
                  (seg) => seg.startTime < scene.endSec && seg.endTime > scene.startSec,
                );
                if (overlapping.length > 0) {
                  scene.transcript = overlapping.map((s) => s.text).join(' ').trim();
                }
              }
            }
          }

          this._emitProgress(request.onProgress, 'transcribing', 100, 'Transcription complete');
        } catch (err) {
          // STT failure is non-fatal — scenes still have visual descriptions
          console.warn(
            '[VideoAnalyzer] Audio transcription failed:',
            (err as Error).message,
          );
          this._emitProgress(request.onProgress, 'transcribing', 100,
            'Transcription failed (non-fatal)');
        }
      }

      // -----------------------------------------------------------------------
      // Stage 6: Generate summary via LLM
      // -----------------------------------------------------------------------
      this._emitProgress(request.onProgress, 'summarizing', 0, 'Generating summary');

      const summary = await this._generateSummary(
        sceneDescriptions,
        fullTranscript,
        request.prompt,
      );

      this._emitProgress(request.onProgress, 'summarizing', 100, 'Summary complete');

      // -----------------------------------------------------------------------
      // Stage 7: Optional RAG indexing
      // -----------------------------------------------------------------------
      let ragChunkIds: string[] | undefined;
      if (request.indexForRAG) {
        ragChunkIds = this._buildRagChunkIds(sceneDescriptions, summary);
      }

      return {
        durationSec,
        sceneCount: sceneDescriptions.length,
        scenes: sceneDescriptions,
        summary,
        fullTranscript,
        ragChunkIds,
        metadata: {
          frameCount: frames.length,
          extractedFrameCount,
          maxFrames: request.maxFrames,
          sceneThreshold: request.sceneThreshold ?? 0.3,
          descriptionDetail: request.descriptionDetail ?? 'detailed',
          transcribeAudio: request.transcribeAudio !== false,
        },
      };
    } finally {
      // Clean up all temp files
      try {
        rm(tmpBase, { recursive: true, force: true }).catch(() => {});
      } catch {
        // Cleanup failure is non-fatal
      }
    }
  }

  // -------------------------------------------------------------------------
  // Private — ffprobe / ffmpeg helpers
  // -------------------------------------------------------------------------

  /**
   * Assert that ffprobe is available on the system PATH.
   *
   * Attempts to run `ffprobe -version` and throws a descriptive error
   * if the command fails or is not found.
   *
   * @throws {Error} With installation instructions when ffprobe is missing.
   */
  private async _assertFfprobeAvailable(): Promise<void> {
    try {
      await execFile('ffprobe', ['-version']);
    } catch {
      throw new Error(
        'VideoAnalyzer requires ffprobe (part of ffmpeg) to be installed and on your PATH. ' +
        'Install it with: brew install ffmpeg (macOS), apt install ffmpeg (Debian/Ubuntu), ' +
        'or download from https://ffmpeg.org/download.html',
      );
    }
  }

  /**
   * Probe the duration of a video file using ffprobe.
   *
   * Runs `ffprobe -v error -show_entries format=duration -of csv=p=0`
   * and parses the output as a floating-point number of seconds.
   *
   * @param videoPath - Absolute path to the video file.
   * @returns Duration in seconds.
   * @throws {Error} If ffprobe cannot determine the duration.
   */
  private async _probeDuration(videoPath: string): Promise<number> {
    const { stdout } = await execFile('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'csv=p=0',
      videoPath,
    ]);

    const duration = parseFloat(stdout.trim());
    if (isNaN(duration) || duration <= 0) {
      throw new Error(
        `VideoAnalyzer: ffprobe returned invalid duration "${stdout.trim()}" for video.`,
      );
    }

    return duration;
  }

  /**
   * Extract frames from a video at 1fps using ffmpeg.
   *
   * Writes PNG frames to the given output directory as `frame_0001.png`,
   * `frame_0002.png`, etc. Then reads them back into {@link Frame} objects
   * with timestamps derived from the frame index (1fps → index = seconds).
   *
   * @param videoPath - Absolute path to the input video.
   * @param framesDir - Directory to write extracted frames into.
   * @returns Array of Frame objects sorted by timestamp.
   */
  private async _extractFrames(
    videoPath: string,
    framesDir: string,
  ): Promise<Frame[]> {
    // Extract at 1fps — each frame represents one second of video
    await execFile('ffmpeg', [
      '-i', videoPath,
      '-vf', 'fps=1',
      '-f', 'image2',
      join(framesDir, 'frame_%04d.png'),
      '-y',
    ], { timeout: 120_000 });

    // Read extracted frames
    const files = await readdir(framesDir);
    const frameFiles = files
      .filter((f) => f.startsWith('frame_') && f.endsWith('.png'))
      .sort();

    const frames: Frame[] = [];
    for (let i = 0; i < frameFiles.length; i++) {
      const sourceBuffer = await readFile(join(framesDir, frameFiles[i]));
      const buffer = await this._decodeFrameToRgb(sourceBuffer);
      frames.push({
        buffer,
        sourceBuffer,
        // At 1fps, frame index = seconds
        timestampSec: i,
        index: i,
      });
    }

    return frames;
  }

  /**
   * Run the SceneDetector over a sequence of frames and collect
   * all scene boundaries.
   *
   * Converts the Frame array into an async iterable for the detector's
   * streaming API, then collects all yielded boundaries.
   *
   * @param frames - Extracted video frames in time order.
   * @param threshold - Optional scene change threshold override.
   * @param maxScenes - Maximum number of scenes to detect.
   * @returns Array of SceneBoundary objects.
   */
  private async _detectScenes(
    frames: Frame[],
    threshold?: number,
    maxScenes?: number,
  ): Promise<SceneBoundary[]> {
    // Build an async iterable from the frames array
    async function* toAsyncIterable(): AsyncGenerator<Frame> {
      for (const frame of frames) {
        yield frame;
      }
    }

    // If a custom threshold was provided, create a temporary detector
    const detector = threshold !== undefined
      ? new SceneDetector({
          hardCutThreshold: threshold,
          gradualThreshold: threshold * 0.5,
        })
      : this._sceneDetector;

    const boundaries: SceneBoundary[] = [];
    const limit = maxScenes ?? 100;

    for await (const boundary of detector.detectScenes(toAsyncIterable())) {
      boundaries.push(boundary);
      if (boundaries.length >= limit) break;
    }

    return boundaries;
  }

  /**
   * Select the frame closest to a given timestamp from the frame array.
   *
   * Uses a simple linear search — frame counts are typically low
   * (one per second of video) so this is efficient enough.
   *
   * @param frames - Array of extracted frames.
   * @param targetSec - Target timestamp in seconds.
   * @returns The frame closest to the target timestamp, or undefined if empty.
   */
  private _selectKeyFrame(frames: Frame[], targetSec: number): Frame | undefined {
    if (frames.length === 0) return undefined;

    let closest = frames[0];
    let minDelta = Math.abs(frames[0].timestampSec - targetSec);

    for (let i = 1; i < frames.length; i++) {
      const delta = Math.abs(frames[i].timestampSec - targetSec);
      if (delta < minDelta) {
        closest = frames[i];
        minDelta = delta;
      }
    }

    return closest;
  }

  /**
   * Extract the audio track from a video file as 16-bit PCM WAV.
   *
   * Uses ffmpeg with:
   * - `-vn`: skip video stream
   * - `-acodec pcm_s16le`: 16-bit PCM output
   * - `-ar 16000`: 16kHz sample rate (standard for STT)
   * - `-ac 1`: mono channel
   *
   * @param videoPath - Absolute path to the input video.
   * @param audioPath - Absolute path for the output WAV file.
   * @returns Audio buffer, or undefined if extraction fails.
   */
  private async _extractAudio(
    videoPath: string,
    audioPath: string,
  ): Promise<Buffer | undefined> {
    try {
      await execFile('ffmpeg', [
        '-i', videoPath,
        '-vn',
        '-acodec', 'pcm_s16le',
        '-ar', '16000',
        '-ac', '1',
        audioPath,
        '-y',
      ], { timeout: 60_000 });

      return await readFile(audioPath);
    } catch {
      return undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Private — LLM summary generation
  // -------------------------------------------------------------------------

  /**
   * Generate an overall video summary from scene descriptions and optional
   * transcript using an LLM via generateText().
   *
   * The summary captures the narrative arc, key visual elements, and any
   * spoken content across all scenes.
   *
   * @param scenes - Array of rich scene descriptions.
   * @param transcript - Optional full transcript of the video.
   * @returns Generated summary text.
   */
  private async _generateSummary(
    scenes: SceneDescription[],
    transcript?: string,
    userPrompt?: string,
  ): Promise<string> {
    // Build the context from scene descriptions
    const sceneLines = scenes.map((s) => {
      let line = `Scene ${s.index + 1} [${s.startSec.toFixed(1)}s - ${s.endSec.toFixed(1)}s]: ${s.description}`;
      if (s.transcript) {
        line += `\n  Spoken: "${s.transcript}"`;
      }
      return line;
    });

    const prompt = [
      'You are analyzing a video. Below are descriptions of each scene detected in the video.',
      userPrompt
        ? `\nUser request:\n${userPrompt}`
        : '',
      transcript ? `\nFull transcript:\n${transcript}` : '',
      '\nScene descriptions:',
      ...sceneLines,
      userPrompt
        ? '\nAnswer the user request using the observable scene and transcript evidence.'
        : '\nProvide a concise summary (2-4 sentences) of the overall video content,',
      userPrompt
        ? 'If the request cannot be answered fully, say what is directly supported by the video.'
        : 'capturing the narrative arc, key visual elements, and any important spoken content.',
    ].filter(Boolean).join('\n');

    try {
      const { generateText } = await import('../../../api/generateText.js');

      const result = await generateText({
        prompt,
        temperature: 0.3,
        maxTokens: 500,
      });

      return result.text || 'Unable to generate summary.';
    } catch {
      // Fallback: concatenate scene descriptions if LLM is unavailable
      return scenes.map((s) => s.description).join(' ');
    }
  }

  // -------------------------------------------------------------------------
  // Private — RAG chunk ID generation
  // -------------------------------------------------------------------------

  /**
   * Build placeholder RAG chunk IDs for each scene plus the summary.
   *
   * In a full implementation these IDs would correspond to actual vector
   * store documents. For now, they serve as stable identifiers that a
   * downstream RAG indexer can use to create or reference chunks.
   *
   * @param scenes - Scene descriptions to create chunk IDs for.
   * @param summary - Overall summary to create a chunk ID for.
   * @returns Array of generated chunk ID strings.
   */
  private _buildRagChunkIds(scenes: SceneDescription[], summary: string): string[] {
    const ids: string[] = [];

    // One chunk per scene
    for (const scene of scenes) {
      ids.push(`video-scene-${scene.index}-${randomUUID().slice(0, 8)}`);
    }

    // One chunk for the summary
    if (summary) {
      ids.push(`video-summary-${randomUUID().slice(0, 8)}`);
    }

    return ids;
  }

  // -------------------------------------------------------------------------
  // Private — utilities
  // -------------------------------------------------------------------------

  /**
   * Download a video from a URL into a Buffer.
   *
   * @param url - Video URL to download.
   * @returns Video content as a Buffer.
   */
  private async _downloadVideo(url: string): Promise<Buffer> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`VideoAnalyzer: failed to download video from ${url}: ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  /**
   * Ensure the vision pipeline is available, creating one lazily if needed.
   *
   * When no vision pipeline was injected via the constructor, this method
   * dynamically imports the factory and creates a default pipeline.
   *
   * @returns The resolved VisionPipeline instance.
   */
  private async _ensureVisionPipeline(): Promise<VisionPipeline> {
    if (!this._visionPipeline) {
      const { createVisionPipeline } = await import('../../vision/index.js');
      this._visionPipeline = await createVisionPipeline();
    }
    return this._visionPipeline;
  }

  /**
   * Decode an extracted frame image into a raw RGB buffer for scene detection.
   *
   * When decoding is unavailable, the original encoded bytes are returned so
   * callers still get a best-effort diff signal instead of a hard failure.
   */
  private async _decodeFrameToRgb(buffer: Buffer): Promise<Buffer> {
    try {
      const sharpModule = await import('sharp');
      const sharp = sharpModule.default;
      const { data } = await sharp(buffer)
        .removeAlpha()
        .toColourspace('rgb')
        .raw()
        .toBuffer({ resolveWithObject: true });
      return Buffer.from(data);
    } catch {
      return buffer;
    }
  }

  /**
   * Evenly downsample a frame list while preserving order and both endpoints.
   */
  private _downsampleFrames(frames: Frame[], maxFrames: number): Frame[] {
    if (maxFrames >= frames.length) return frames;
    if (maxFrames <= 1) return [frames[0]];

    const sampled: Frame[] = [];
    const lastIndex = frames.length - 1;

    for (let i = 0; i < maxFrames; i++) {
      const index = i === maxFrames - 1
        ? lastIndex
        : Math.floor((i * frames.length) / maxFrames);
      const frame = frames[index];

      if (sampled[sampled.length - 1] !== frame) {
        sampled.push(frame);
      }
    }

    return sampled;
  }

  /**
   * Emit a progress event to the caller's callback, if provided.
   *
   * @param callback - Optional progress callback from the request.
   * @param phase - Current pipeline phase.
   * @param progress - Progress percentage (0-100) within the phase.
   * @param message - Human-readable status message.
   * @param currentScene - 0-based scene index (for describing/transcribing phases).
   */
  private _emitProgress(
    callback: ((event: VideoAnalysisProgressEvent) => void) | undefined,
    phase: VideoAnalysisProgressEvent['phase'],
    progress: number,
    message: string,
    currentScene?: number,
  ): void {
    if (callback) {
      callback({ phase, progress, message, currentScene });
    }
  }
}
