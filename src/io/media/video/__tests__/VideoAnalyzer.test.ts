/**
 * @module media/video/__tests__/VideoAnalyzer.test
 *
 * Unit tests for the {@link VideoAnalyzer} class.
 *
 * All external dependencies (ffmpeg/ffprobe, SceneDetector, VisionPipeline,
 * generateText) are mocked to enable fast, deterministic testing without
 * requiring actual video files or system binaries.
 *
 * ## Test cases
 *
 * 1. Analyzes a video buffer and returns a well-formed VideoAnalysisRich
 * 2. Each scene has description, timestamps, and cutType
 * 3. Generates a summary from all scene descriptions
 * 4. Throws a clear error when ffmpeg/ffprobe is missing
 * 5. Handles STT failure gracefully — scenes still have descriptions
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock node:child_process — vi.mock factories cannot reference outer scope
// variables because the call is hoisted above all declarations. Instead, we
// export a mutable holder that the factory and test code both reference.
// ---------------------------------------------------------------------------

vi.mock('node:child_process', () => {
  // Return a real function that delegates to a swappable impl
  const holder = { impl: (..._args: unknown[]) => {} };
  return {
    execFile: (...args: unknown[]) => holder.impl(...args),
    __holder: holder,
  };
});

vi.mock('node:fs/promises', () => {
  const holder = {
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn(),
    readdir: vi.fn(),
    mkdir: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
  };
  return {
    writeFile: (...args: unknown[]) => holder.writeFile(...args),
    readFile: (...args: unknown[]) => holder.readFile(...args),
    readdir: (...args: unknown[]) => holder.readdir(...args),
    mkdir: (...args: unknown[]) => holder.mkdir(...args),
    rm: (...args: unknown[]) => holder.rm(...args),
    __holder: holder,
  };
});

vi.mock('../../../../api/generateText.js', () => {
  const holder = { generateText: vi.fn() };
  return {
    generateText: (...args: unknown[]) => holder.generateText(...args),
    __holder: holder,
  };
});

vi.mock('../../../vision/index.js', () => {
  const holder = { createVisionPipeline: vi.fn() };
  return {
    createVisionPipeline: (...args: unknown[]) => holder.createVisionPipeline(...args),
    __holder: holder,
  };
});

vi.mock('sharp', () => {
  const holder = {
    toBuffer: vi.fn().mockResolvedValue({
      data: Buffer.from([1, 2, 3, 4, 5, 6]),
      info: { width: 1, height: 2, channels: 3 },
    }),
  };

  const sharp = vi.fn(() => ({
    removeAlpha: () => ({
      toColourspace: () => ({
        raw: () => ({
          toBuffer: (...args: unknown[]) => holder.toBuffer(...args),
        }),
      }),
    }),
  }));

  return {
    default: sharp,
    __holder: holder,
  };
});

// ---------------------------------------------------------------------------
// Import the module under test and the mocked modules to access holders
// ---------------------------------------------------------------------------

import { VideoAnalyzer } from '../VideoAnalyzer.js';
import { SceneDetector } from '../../../vision/SceneDetector.js';
import type { VisionPipeline } from '../../../vision/VisionPipeline.js';
import type { SpeechToTextProvider, SpeechTranscriptionResult } from '../../../speech/types.js';
import type { VisionResult } from '../../../vision/types.js';

// Access mock holders through dynamic imports
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cpHolder: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fsHolder: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let genTextHolder: any;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** A minimal 4-byte fake PNG buffer (magic bytes only). */
const FAKE_FRAME_BUFFER = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

/**
 * Build a mock VisionPipeline that returns canned descriptions.
 */
function makeMockVisionPipeline(): VisionPipeline {
  let callCount = 0;
  return {
    process: vi.fn().mockImplementation(async () => {
      callCount++;
      return {
        text: `Scene description ${callCount}`,
        confidence: 0.9,
        category: 'photograph',
        tiers: ['cloud-vision'],
        tierResults: [],
        durationMs: 50,
      } satisfies VisionResult;
    }),
  } as unknown as VisionPipeline;
}

/**
 * Build a mock SpeechToTextProvider that returns a canned transcript.
 */
function makeMockSTTProvider(shouldFail = false): SpeechToTextProvider {
  return {
    id: 'mock-stt',
    displayName: 'Mock STT',
    supportsStreaming: false,
    getProviderName: () => 'mock-stt',
    transcribe: vi.fn().mockImplementation(async () => {
      if (shouldFail) {
        throw new Error('STT provider unavailable');
      }
      return {
        text: 'Hello world, this is a test video narration.',
        cost: 0,
        segments: [
          { text: 'Hello world,', startTime: 0, endTime: 3, confidence: 0.95 },
          { text: 'this is a test', startTime: 3, endTime: 6, confidence: 0.92 },
          { text: 'video narration.', startTime: 6, endTime: 10, confidence: 0.90 },
        ],
      } satisfies SpeechTranscriptionResult;
    }),
  };
}

/**
 * Configure the execFile mock with standard ffmpeg/ffprobe behaviour.
 */
function setupExecFileMock(opts?: { ffmpegMissing?: boolean }): void {
  cpHolder.impl = (
    cmd: string,
    args: string[],
    optionsOrCb: unknown,
    callback?: Function,
  ) => {
    // promisify wraps (cmd, args, opts) → (cmd, args, opts, cb)
    const cb = typeof callback === 'function' ? callback : typeof optionsOrCb === 'function' ? optionsOrCb : undefined;

    if (opts?.ffmpegMissing) {
      if (typeof cb === 'function') {
        cb(new Error('ENOENT: ffprobe not found'), { stdout: '', stderr: '' });
      }
      return;
    }

    if (cmd === 'ffprobe') {
      if (args.includes('-version')) {
        if (typeof cb === 'function') {
          cb(null, { stdout: 'ffprobe version 6.0', stderr: '' });
        }
      } else if (args.includes('-show_entries')) {
        if (typeof cb === 'function') {
          cb(null, { stdout: '10.5\n', stderr: '' });
        }
      }
      return;
    }

    if (cmd === 'ffmpeg') {
      // For frame extraction, set up readdir to return fake frame files
      if (args.includes('fps=1')) {
        fsHolder.readdir.mockResolvedValueOnce([
          'frame_0001.png',
          'frame_0002.png',
          'frame_0003.png',
          'frame_0004.png',
          'frame_0005.png',
          'frame_0006.png',
          'frame_0007.png',
          'frame_0008.png',
          'frame_0009.png',
          'frame_0010.png',
        ]);
        for (let i = 0; i < 10; i++) {
          fsHolder.readFile.mockResolvedValueOnce(FAKE_FRAME_BUFFER);
        }
      }

      // For audio extraction, set up readFile for the audio WAV
      if (args.includes('-vn')) {
        fsHolder.readFile.mockResolvedValueOnce(Buffer.alloc(32000, 0));
      }

      if (typeof cb === 'function') {
        cb(null, { stdout: '', stderr: '' });
      }
      return;
    }

    if (typeof cb === 'function') {
      cb(new Error(`Unknown command: ${cmd}`), { stdout: '', stderr: '' });
    }
  };
}

/**
 * Create a mock SceneDetector that yields deterministic scene boundaries.
 * Simulates 3 scenes: 0-3s, 3-7s, 7-10s.
 */
function makeMockSceneDetector(): SceneDetector {
  const detector = new SceneDetector({ hardCutThreshold: 0.01, gradualThreshold: 0.005 });

  vi.spyOn(detector, 'detectScenes').mockImplementation(
    async function* () {
      yield {
        index: 0,
        startFrame: 0,
        endFrame: 2,
        startTimeSec: 0,
        endTimeSec: 3,
        durationSec: 3,
        cutType: 'hard-cut' as const,
        confidence: 0.95,
        diffScore: 0.8,
      };
      yield {
        index: 1,
        startFrame: 3,
        endFrame: 6,
        startTimeSec: 3,
        endTimeSec: 7,
        durationSec: 4,
        cutType: 'dissolve' as const,
        confidence: 0.7,
        diffScore: 0.4,
      };
      yield {
        index: 2,
        startFrame: 7,
        endFrame: 9,
        startTimeSec: 7,
        endTimeSec: 10,
        durationSec: 3,
        cutType: 'hard-cut' as const,
        confidence: 0.85,
        diffScore: 0.6,
      };
    },
  );

  return detector;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VideoAnalyzer', () => {
  beforeEach(async () => {
    vi.clearAllMocks();

    // Grab the __holder objects from the mocked modules
    const cpMod = await import('node:child_process') as any;
    cpHolder = cpMod.__holder;

    const fsMod = await import('node:fs/promises') as any;
    fsHolder = fsMod.__holder;

    const genTextMod = await import('../../../../api/generateText.js') as any;
    genTextHolder = genTextMod.__holder;

    // Default generateText mock returns a summary
    genTextHolder.generateText.mockResolvedValue({
      text: 'This video shows three distinct scenes with varying visual content.',
      usage: { promptTokens: 100, completionTokens: 30, totalTokens: 130 },
      toolCalls: [],
      finishReason: 'stop',
      provider: 'openai',
      model: 'gpt-4o',
    });
  });

  // -------------------------------------------------------------------------
  // Test 1: Full analysis pipeline returns well-formed VideoAnalysisRich
  // -------------------------------------------------------------------------

  it('analyzes a video buffer and returns a well-formed VideoAnalysisRich', async () => {
    setupExecFileMock();
    const visionPipeline = makeMockVisionPipeline();
    const sceneDetector = makeMockSceneDetector();

    const analyzer = new VideoAnalyzer({
      visionPipeline,
      sceneDetector,
    });

    const result = await analyzer.analyze({
      video: Buffer.alloc(1024, 0),
      transcribeAudio: false,
    });

    // Verify top-level structure
    expect(result.durationSec).toBe(10.5);
    expect(result.sceneCount).toBe(3);
    expect(result.scenes).toHaveLength(3);
    expect(typeof result.summary).toBe('string');
    expect(result.summary.length).toBeGreaterThan(0);
    expect(result.metadata).toBeDefined();
    expect(result.metadata.frameCount).toBe(10);
  });

  // -------------------------------------------------------------------------
  // Test 2: Each scene has description, timestamps, and cutType
  // -------------------------------------------------------------------------

  it('produces scenes with description, timestamps, and cutType', async () => {
    setupExecFileMock();
    const visionPipeline = makeMockVisionPipeline();
    const sceneDetector = makeMockSceneDetector();

    const analyzer = new VideoAnalyzer({
      visionPipeline,
      sceneDetector,
    });

    const result = await analyzer.analyze({
      video: Buffer.alloc(1024, 0),
      transcribeAudio: false,
    });

    // Check each scene has required fields
    for (const scene of result.scenes) {
      expect(typeof scene.description).toBe('string');
      expect(scene.description.length).toBeGreaterThan(0);
      expect(typeof scene.startSec).toBe('number');
      expect(typeof scene.endSec).toBe('number');
      expect(scene.endSec).toBeGreaterThanOrEqual(scene.startSec);
      expect(typeof scene.durationSec).toBe('number');
      expect(typeof scene.cutType).toBe('string');
      expect(typeof scene.confidence).toBe('number');
      expect(typeof scene.index).toBe('number');
    }

    // First scene should have cutType 'start'
    expect(result.scenes[0].cutType).toBe('start');

    // Subsequent scenes should have detected cut types
    expect(result.scenes[1].cutType).toBe('dissolve');
    expect(result.scenes[2].cutType).toBe('hard-cut');

    // Verify timestamps match the mock detector output
    expect(result.scenes[0].startSec).toBe(0);
    expect(result.scenes[0].endSec).toBe(3);
    expect(result.scenes[1].startSec).toBe(3);
    expect(result.scenes[1].endSec).toBe(7);
    expect(result.scenes[2].startSec).toBe(7);
    expect(result.scenes[2].endSec).toBe(10);
  });

  // -------------------------------------------------------------------------
  // Test 3: Generates summary from all scene descriptions
  // -------------------------------------------------------------------------

  it('generates a summary from all scene descriptions via LLM', async () => {
    setupExecFileMock();
    const visionPipeline = makeMockVisionPipeline();
    const sceneDetector = makeMockSceneDetector();

    const analyzer = new VideoAnalyzer({
      visionPipeline,
      sceneDetector,
    });

    const result = await analyzer.analyze({
      video: Buffer.alloc(1024, 0),
      transcribeAudio: false,
    });

    // generateText should have been called once for the summary
    expect(genTextHolder.generateText).toHaveBeenCalledTimes(1);

    // The prompt should contain scene descriptions
    const callArgs = genTextHolder.generateText.mock.calls[0][0];
    expect(callArgs.prompt).toContain('Scene 1');
    expect(callArgs.prompt).toContain('Scene 2');
    expect(callArgs.prompt).toContain('Scene 3');

    // Summary should come from the mock
    expect(result.summary).toBe(
      'This video shows three distinct scenes with varying visual content.',
    );
  });

  // -------------------------------------------------------------------------
  // Test 4: Throws clear error when ffmpeg/ffprobe is missing
  // -------------------------------------------------------------------------

  it('throws a clear error when ffprobe is not installed', async () => {
    setupExecFileMock({ ffmpegMissing: true });

    const analyzer = new VideoAnalyzer({
      visionPipeline: makeMockVisionPipeline(),
      sceneDetector: makeMockSceneDetector(),
    });

    await expect(
      analyzer.analyze({ video: Buffer.alloc(1024, 0) }),
    ).rejects.toThrow(/ffprobe.*installed.*PATH/i);
  });

  // -------------------------------------------------------------------------
  // Test 5: Handles STT failure gracefully — scenes still have descriptions
  // -------------------------------------------------------------------------

  it('handles STT failure gracefully, scenes still have visual descriptions', async () => {
    setupExecFileMock();
    const visionPipeline = makeMockVisionPipeline();
    const sceneDetector = makeMockSceneDetector();
    const failingSTT = makeMockSTTProvider(/* shouldFail */ true);

    const analyzer = new VideoAnalyzer({
      visionPipeline,
      sceneDetector,
      sttProvider: failingSTT,
    });

    // Suppress console.warn for the STT failure message
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await analyzer.analyze({
      video: Buffer.alloc(1024, 0),
      transcribeAudio: true,
    });

    // Analysis should succeed despite STT failure
    expect(result.sceneCount).toBe(3);
    expect(result.scenes).toHaveLength(3);

    // Each scene should still have a visual description
    for (const scene of result.scenes) {
      expect(typeof scene.description).toBe('string');
      expect(scene.description.length).toBeGreaterThan(0);
      // Transcript should be undefined due to STT failure
      expect(scene.transcript).toBeUndefined();
    }

    // Full transcript should be undefined
    expect(result.fullTranscript).toBeUndefined();

    // Summary should still be generated from visual descriptions
    expect(typeof result.summary).toBe('string');
    expect(result.summary.length).toBeGreaterThan(0);

    // A warning should have been logged
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('keeps encoded frames for vision analysis while passing raw RGB frames to scene detection', async () => {
    setupExecFileMock();

    const visionPipeline = {
      process: vi.fn().mockResolvedValue({
        text: 'Scene description 1',
        confidence: 0.9,
        category: 'photograph',
        tiers: ['cloud-vision'],
        tierResults: [],
        durationMs: 50,
      }),
    } as unknown as VisionPipeline;

    const sceneDetector = new SceneDetector({ hardCutThreshold: 0.01, gradualThreshold: 0.005 });
    vi.spyOn(sceneDetector, 'detectScenes').mockImplementation(
      async function* (frames) {
        let inspected = false;

        for await (const frame of frames) {
          expect(frame.buffer.equals(Buffer.from([1, 2, 3, 4, 5, 6]))).toBe(true);
          expect(frame.sourceBuffer?.equals(FAKE_FRAME_BUFFER)).toBe(true);
          inspected = true;
          break;
        }

        expect(inspected).toBe(true);

        yield {
          index: 0,
          startFrame: 0,
          endFrame: 0,
          startTimeSec: 0,
          endTimeSec: 0,
          durationSec: 0,
          cutType: 'hard-cut' as const,
          confidence: 1,
          diffScore: 1,
        };
      },
    );

    const analyzer = new VideoAnalyzer({
      visionPipeline,
      sceneDetector,
    });

    await analyzer.analyze({
      video: Buffer.alloc(1024, 0),
      transcribeAudio: false,
    });

    expect(visionPipeline.process).toHaveBeenCalledWith(FAKE_FRAME_BUFFER);
  });
});
