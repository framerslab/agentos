import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { analyzeVideo } from '../analyzeVideo.js';

vi.mock('../../../io/vision/index.js', () => {
  const holder = {
    createVisionPipeline: vi.fn().mockResolvedValue({ process: vi.fn() }),
  };
  return {
    createVisionPipeline: (...args: unknown[]) => holder.createVisionPipeline(...args),
    __holder: holder,
  };
});

vi.mock('../../../io/media/video/VideoAnalyzer.js', () => {
  const holder = {
    constructorArgs: [] as unknown[],
    analyze: vi.fn(),
  };

  class MockVideoAnalyzer {
    constructor(deps: unknown) {
      holder.constructorArgs.push(deps);
    }

    analyze(...args: unknown[]) {
      return holder.analyze(...args);
    }
  }

  return {
    VideoAnalyzer: MockVideoAnalyzer,
    __holder: holder,
  };
});

vi.mock('../../../io/hearing/providers/OpenAIWhisperSpeechToTextProvider.js', () => {
  const holder = {
    constructorArgs: [] as unknown[],
  };

  class MockOpenAIWhisperSpeechToTextProvider {
    readonly id = 'openai-whisper';
    readonly displayName = 'OpenAI Whisper';
    readonly supportsStreaming = false;

    constructor(config: unknown) {
      holder.constructorArgs.push(config);
    }

    getProviderName(): string {
      return this.displayName;
    }

    async transcribe(): Promise<never> {
      throw new Error('Not implemented in test');
    }
  }

  return {
    OpenAIWhisperSpeechToTextProvider: MockOpenAIWhisperSpeechToTextProvider,
    __holder: holder,
  };
});

// Mock observability to avoid OTel dependencies
vi.mock('../../observability.js', () => ({
  attachUsageAttributes: vi.fn(),
  attachGenAiAttributes: vi.fn(),
  toTurnMetricUsage: vi.fn().mockReturnValue(undefined),
}));

vi.mock('../../../safety/evaluation/observability/otel.js', () => ({
  withAgentOSSpan: vi.fn((_name: string, fn: (span: null) => unknown) => fn(null)),
  recordAgentOSTurnMetrics: vi.fn(),
}));

vi.mock('../usageLedger.js', () => ({
  recordAgentOSUsage: vi.fn().mockResolvedValue(undefined),
}));

describe('analyzeVideo', () => {
  const originalEnv = process.env;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };

    const analyzerMod = await import('../../../io/media/video/VideoAnalyzer.js') as any;
    analyzerMod.__holder.constructorArgs.length = 0;
    analyzerMod.__holder.analyze.mockReset();

    const visionMod = await import('../../../io/vision/index.js') as any;
    visionMod.__holder.createVisionPipeline.mockClear();

    const sttMod = await import('../../../io/hearing/providers/OpenAIWhisperSpeechToTextProvider.js') as any;
    sttMod.__holder.constructorArgs.length = 0;
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.clearAllMocks();
  });

  it('wires the real analyzer with a vision pipeline and passes options through', async () => {
    const visionMod = await import('../../../io/vision/index.js') as any;
    const analyzerMod = await import('../../../io/media/video/VideoAnalyzer.js') as any;

    analyzerMod.__holder.analyze.mockResolvedValue({
      durationSec: 12,
      sceneCount: 2,
      scenes: [
        { index: 0, startSec: 0, endSec: 4, durationSec: 4, cutType: 'start', description: 'Intro', confidence: 1 },
        { index: 1, startSec: 4, endSec: 12, durationSec: 8, cutType: 'hard-cut', description: 'Demo', confidence: 0.9 },
      ],
      summary: 'The video shows a product intro followed by a demo.',
      fullTranscript: 'Hello and welcome.',
      ragChunkIds: ['chunk-1'],
      metadata: { frameCount: 8 },
    });

    const buffer = Buffer.from('fake-video-data');
    const result = await analyzeVideo({
      videoBuffer: buffer,
      prompt: 'Summarize the demo',
      model: 'gpt-4o',
      sceneThreshold: 0.4,
      maxFrames: 6,
      maxScenes: 3,
      transcribeAudio: false,
      indexForRAG: true,
    });

    expect(visionMod.__holder.createVisionPipeline).toHaveBeenCalledWith({
      cloudModel: 'gpt-4o',
    });
    expect(analyzerMod.__holder.constructorArgs[0]).toEqual({
      visionPipeline: expect.any(Object),
    });
    expect(analyzerMod.__holder.analyze).toHaveBeenCalledWith({
      video: buffer,
      prompt: 'Summarize the demo',
      sceneThreshold: 0.4,
      transcribeAudio: false,
      descriptionDetail: undefined,
      maxFrames: 6,
      maxScenes: 3,
      indexForRAG: true,
      onProgress: undefined,
    });
    expect(result.description).toBe('The video shows a product intro followed by a demo.');
    expect(result.provider).toBe('agentos-video-analyzer');
    expect(result.text).toEqual(['Hello and welcome.']);
    expect(result.fullTranscript).toBe('Hello and welcome.');
    expect(result.ragChunkIds).toEqual(['chunk-1']);
    expect(result.providerMetadata).toEqual({
      frameCount: 8,
      sttProviderId: undefined,
    });
  });

  it('throws when neither videoUrl nor videoBuffer is provided', async () => {
    await expect(
      analyzeVideo({} as any),
    ).rejects.toThrow(/Either videoUrl or videoBuffer is required/);
  });

  it('auto-wires OpenAI Whisper when transcription is enabled and OPENAI_API_KEY is set', async () => {
    process.env.OPENAI_API_KEY = 'test-openai-key';

    const analyzerMod = await import('../../../io/media/video/VideoAnalyzer.js') as any;
    const sttMod = await import('../../../io/hearing/providers/OpenAIWhisperSpeechToTextProvider.js') as any;

    analyzerMod.__holder.analyze.mockResolvedValue({
      durationSec: 5,
      sceneCount: 1,
      scenes: [],
      summary: 'Done.',
      metadata: {},
    });

    const result = await analyzeVideo({
      videoUrl: 'https://example.com/clip.mp4',
      transcribeAudio: true,
    });

    expect(sttMod.__holder.constructorArgs).toEqual([
      { apiKey: 'test-openai-key' },
    ]);
    expect(analyzerMod.__holder.constructorArgs[0]).toEqual({
      visionPipeline: expect.any(Object),
      sttProvider: expect.objectContaining({ id: 'openai-whisper' }),
    });
    expect(result.provider).toBe('agentos-video-analyzer');
  });
});
