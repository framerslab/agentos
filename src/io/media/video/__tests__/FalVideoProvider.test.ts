/**
 * @module media/video/__tests__/FalVideoProvider.test
 *
 * Unit tests for {@link FalVideoProvider} (Fal.ai queue API).
 *
 * Uses mocked `fetch` to simulate the Fal.ai three-step queue flow:
 * submit → poll status → fetch result.
 *
 * ## What is tested
 *
 * - Initialization with valid/invalid API keys and custom config
 * - Task submission sends correct URL, headers, and body
 * - Status polling retries until COMPLETED
 * - Result fetching returns correct video URL
 * - FAILED status during polling throws descriptive error
 * - Timeout during polling throws descriptive error
 * - Image-to-video passes image_url in request body
 * - Empty result throws descriptive error
 * - Uninitialized provider rejects calls
 * - supports() returns correct capabilities
 * - shutdown resets initialization state
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FalVideoProvider } from '../providers/FalVideoProvider.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FetchSpy = ReturnType<typeof vi.fn>;

/**
 * Create a mock Response-like object for fetch.
 * @param body - JSON-serialisable response body.
 * @param ok - Whether the response has a 2xx status.
 * @param status - HTTP status code.
 */
function mockResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: vi.fn(async () => body),
    text: vi.fn(async () => JSON.stringify(body)),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FalVideoProvider', () => {
  let provider: FalVideoProvider;
  let fetchSpy: FetchSpy;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    provider = new FalVideoProvider();
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  it('should initialize with a valid API key', async () => {
    await provider.initialize({ apiKey: 'fal_test_key' });
    expect(provider.isInitialized).toBe(true);
    expect(provider.providerId).toBe('fal');
    expect(provider.defaultModelId).toBe('fal-ai/kling-video/v2.5-turbo/pro/text-to-video');
  });

  it('should throw on initialize without API key', async () => {
    await expect(provider.initialize({})).rejects.toThrow(/requires apiKey/);
  });

  it('should throw on initialize with empty API key', async () => {
    await expect(provider.initialize({ apiKey: '' })).rejects.toThrow(/requires apiKey/);
  });

  it('should use custom defaultModelId when provided', async () => {
    await provider.initialize({ apiKey: 'key', defaultModelId: 'fal-ai/hunyuan-video' });
    expect(provider.defaultModelId).toBe('fal-ai/hunyuan-video');
  });

  it('should use custom baseURL and poll interval when provided', async () => {
    await provider.initialize({
      apiKey: 'key',
      baseURL: 'https://custom.fal.run',
      pollIntervalMs: 500,
      timeoutMs: 60000,
    });

    fetchSpy
      .mockResolvedValueOnce(mockResponse({ request_id: 'req-1' }))
      .mockResolvedValueOnce(mockResponse({ status: 'COMPLETED' }))
      .mockResolvedValueOnce(mockResponse({
        video: { url: 'https://fal.ai/output/video.mp4' },
      }));

    await provider.generateVideo({ modelId: 'kling-video/v1', prompt: 'test' });

    const [submitUrl] = fetchSpy.mock.calls[0];
    expect(submitUrl).toBe('https://custom.fal.run/kling-video/v1');
  });

  // -------------------------------------------------------------------------
  // Full generation flow (submit -> poll -> fetch)
  // -------------------------------------------------------------------------

  it('should complete the full submit -> poll -> fetch flow', async () => {
    await provider.initialize({ apiKey: 'fal_key_123', pollIntervalMs: 1 });

    // Call 1: Submit
    fetchSpy.mockResolvedValueOnce(mockResponse({ request_id: 'req-abc' }));
    // Call 2: Poll (IN_PROGRESS)
    fetchSpy.mockResolvedValueOnce(mockResponse({ status: 'IN_PROGRESS' }));
    // Call 3: Poll (COMPLETED)
    fetchSpy.mockResolvedValueOnce(mockResponse({ status: 'COMPLETED' }));
    // Call 4: Fetch result
    fetchSpy.mockResolvedValueOnce(mockResponse({
      video: {
        url: 'https://fal.ai/output/video.mp4',
        content_type: 'video/mp4',
        duration: 5,
      },
      seed: 42,
    }));

    const result = await provider.generateVideo({
      modelId: 'kling-video/v1',
      prompt: 'beautiful landscape timelapse',
    });

    expect(result.videos).toHaveLength(1);
    expect(result.videos[0].url).toBe('https://fal.ai/output/video.mp4');
    expect(result.videos[0].mimeType).toBe('video/mp4');
    expect(result.videos[0].durationSec).toBe(5);
    expect(result.modelId).toBe('kling-video/v1');
    expect(result.providerId).toBe('fal');
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  // -------------------------------------------------------------------------
  // Submission
  // -------------------------------------------------------------------------

  it('should submit with correct URL and auth header', async () => {
    await provider.initialize({ apiKey: 'fal_key_xyz', pollIntervalMs: 1 });

    fetchSpy
      .mockResolvedValueOnce(mockResponse({ request_id: 'req-1' }))
      .mockResolvedValueOnce(mockResponse({ status: 'COMPLETED' }))
      .mockResolvedValueOnce(mockResponse({
        video: { url: 'https://example.com/video.mp4' },
      }));

    await provider.generateVideo({
      modelId: 'fal-ai/hunyuan-video',
      prompt: 'test prompt',
      durationSec: 10,
      aspectRatio: '16:9',
      seed: 42,
    });

    const [submitUrl, submitOpts] = fetchSpy.mock.calls[0];
    expect(submitUrl).toBe('https://queue.fal.run/fal-ai/hunyuan-video');
    expect(submitOpts.headers.Authorization).toBe('Key fal_key_xyz');
    expect(submitOpts.headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(submitOpts.body);
    expect(body.prompt).toBe('test prompt');
    expect(body.duration).toBe(10);
    expect(body.aspect_ratio).toBe('16:9');
    expect(body.seed).toBe(42);
  });

  // -------------------------------------------------------------------------
  // Image-to-video
  // -------------------------------------------------------------------------

  it('should pass image_url in body for image-to-video', async () => {
    await provider.initialize({ apiKey: 'key', pollIntervalMs: 1 });

    fetchSpy
      .mockResolvedValueOnce(mockResponse({ request_id: 'req-i2v' }))
      .mockResolvedValueOnce(mockResponse({ status: 'COMPLETED' }))
      .mockResolvedValueOnce(mockResponse({
        video: { url: 'https://fal.ai/output/i2v.mp4' },
      }));

    const imageBuffer = Buffer.from('fake-image-data');

    const result = await provider.imageToVideo({
      modelId: 'kling-video/v1',
      prompt: 'animate this photo',
      image: imageBuffer,
      durationSec: 5,
    });

    expect(result.videos[0].url).toBe('https://fal.ai/output/i2v.mp4');

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.image_url).toContain('data:image/png;base64,');
    expect(body.prompt).toBe('animate this photo');
    // fal's Kling endpoints take duration as the string enum '5' | '10'.
    expect(body.duration).toBe('5');
  });

  it('should throw when imageToVideo called while not initialized', async () => {
    const imageBuffer = Buffer.from('fake-image-data');
    await expect(
      provider.imageToVideo({
        modelId: 'kling-video/v1',
        prompt: 'test',
        image: imageBuffer,
      }),
    ).rejects.toThrow(/not initialized/);
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  it('should throw on FAILED status during polling', async () => {
    await provider.initialize({ apiKey: 'key', pollIntervalMs: 1 });

    fetchSpy
      .mockResolvedValueOnce(mockResponse({ request_id: 'req-fail' }))
      .mockResolvedValueOnce(mockResponse({ status: 'FAILED' }));

    await expect(
      provider.generateVideo({ modelId: 'kling-video/v1', prompt: 'fail' }),
    ).rejects.toThrow(/Fal\.ai video generation failed/);
  });

  it('should throw on submission HTTP error', async () => {
    await provider.initialize({ apiKey: 'key' });

    fetchSpy.mockResolvedValueOnce(mockResponse({ error: 'unauthorized' }, false, 403));

    await expect(
      provider.generateVideo({ modelId: 'kling-video/v1', prompt: 'fail' }),
    ).rejects.toThrow(/submission failed \(403\)/);
  });

  it('should throw when not initialized', async () => {
    await expect(
      provider.generateVideo({ modelId: 'kling-video/v1', prompt: 'fail' }),
    ).rejects.toThrow(/not initialized/);
  });

  it('should throw on timeout', async () => {
    await provider.initialize({ apiKey: 'key', pollIntervalMs: 1, timeoutMs: 10 });

    fetchSpy
      .mockResolvedValueOnce(mockResponse({ request_id: 'req-slow' }))
      .mockResolvedValue(mockResponse({ status: 'IN_QUEUE' }));

    await expect(
      provider.generateVideo({ modelId: 'kling-video/v1', prompt: 'slow' }),
    ).rejects.toThrow(/timed out/);
  });

  it('should throw when result has no video', async () => {
    await provider.initialize({ apiKey: 'key', pollIntervalMs: 1 });

    fetchSpy
      .mockResolvedValueOnce(mockResponse({ request_id: 'req-empty' }))
      .mockResolvedValueOnce(mockResponse({ status: 'COMPLETED' }))
      .mockResolvedValueOnce(mockResponse({ video: null }));

    await expect(
      provider.generateVideo({ modelId: 'kling-video/v1', prompt: 'empty' }),
    ).rejects.toThrow(/no video output/);
  });

  it('should throw on polling HTTP error', async () => {
    await provider.initialize({ apiKey: 'key', pollIntervalMs: 1 });

    fetchSpy
      .mockResolvedValueOnce(mockResponse({ request_id: 'req-poll-err' }))
      .mockResolvedValueOnce(mockResponse({ error: 'server error' }, false, 500));

    await expect(
      provider.generateVideo({ modelId: 'kling-video/v1', prompt: 'poll error' }),
    ).rejects.toThrow(/polling failed \(500\)/);
  });

  it('should throw on result fetch HTTP error', async () => {
    await provider.initialize({ apiKey: 'key', pollIntervalMs: 1 });

    fetchSpy
      .mockResolvedValueOnce(mockResponse({ request_id: 'req-fetch-err' }))
      .mockResolvedValueOnce(mockResponse({ status: 'COMPLETED' }))
      .mockResolvedValueOnce(mockResponse({ error: 'not found' }, false, 404));

    await expect(
      provider.generateVideo({ modelId: 'kling-video/v1', prompt: 'fetch error' }),
    ).rejects.toThrow(/result fetch failed \(404\)/);
  });

  it('should throw when submission response missing request_id', async () => {
    await provider.initialize({ apiKey: 'key' });

    fetchSpy.mockResolvedValueOnce(mockResponse({}));

    await expect(
      provider.generateVideo({ modelId: 'kling-video/v1', prompt: 'no id' }),
    ).rejects.toThrow(/missing request_id/);
  });

  // -------------------------------------------------------------------------
  // supports()
  // -------------------------------------------------------------------------

  it('should report support for text-to-video', () => {
    expect(provider.supports('text-to-video')).toBe(true);
  });

  it('should report support for image-to-video', () => {
    expect(provider.supports('image-to-video')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // shutdown
  // -------------------------------------------------------------------------

  it('should reset initialization state on shutdown', async () => {
    await provider.initialize({ apiKey: 'key' });
    expect(provider.isInitialized).toBe(true);

    await provider.shutdown();
    expect(provider.isInitialized).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Request inputs, queue URLs and failures (captured request bodies)
// ---------------------------------------------------------------------------

/** The first eight bytes of a PNG file. */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
/** The first bytes of a JPEG file. */
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

describe('FalVideoProvider request inputs and queue URLs', () => {
  let provider: FalVideoProvider;
  let fetchSpy: FetchSpy;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    provider = new FalVideoProvider();
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await provider.initialize({ apiKey: 'fal_key', pollIntervalMs: 1 });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** Queue a submit response, one COMPLETED status and a result with a video. */
  function queueRun(submit: Record<string, unknown>): void {
    fetchSpy
      .mockResolvedValueOnce(mockResponse(submit))
      .mockResolvedValueOnce(mockResponse({ status: 'COMPLETED' }))
      .mockResolvedValueOnce(mockResponse({ video: { url: 'https://fal.media/out.mp4' } }));
  }

  /** The JSON body of the submit request. */
  function submitBody(): Record<string, unknown> {
    return JSON.parse(fetchSpy.mock.calls[0][1].body);
  }

  it('sends an image URL as given, with resolution, reference image URLs, negative prompt and provider options', async () => {
    queueRun({ request_id: 'req-1' });

    await provider.imageToVideo({
      modelId: 'fal-ai/minimax/hailuo-02/standard/image-to-video',
      prompt: 'the lantern swings',
      image: 'https://cdn.example.com/start.png',
      resolution: '768P',
      negativePrompt: 'blur',
      referenceImages: ['https://cdn.example.com/ref-a.png', PNG_BYTES],
      providerOptions: {
        end_image_url: 'https://cdn.example.com/end.png',
        prompt_optimizer: false,
        prompt: 'a provider option never replaces the prompt',
      },
    } as any);

    expect(submitBody()).toEqual({
      prompt: 'the lantern swings',
      image_url: 'https://cdn.example.com/start.png',
      resolution: '768P',
      negative_prompt: 'blur',
      reference_image_urls: [
        'https://cdn.example.com/ref-a.png',
        `data:image/png;base64,${PNG_BYTES.toString('base64')}`,
      ],
      end_image_url: 'https://cdn.example.com/end.png',
      prompt_optimizer: false,
    });
  });

  it('sends resolution and reference image URLs for text-to-video', async () => {
    queueRun({ request_id: 'req-t2v' });

    await provider.generateVideo({
      modelId: 'fal-ai/vidu/reference-to-video',
      prompt: 'two friends at a fair',
      resolution: '1080p',
      referenceImages: ['https://cdn.example.com/a.png', 'https://cdn.example.com/b.png'],
    } as any);

    expect(submitBody()).toEqual({
      prompt: 'two friends at a fair',
      resolution: '1080p',
      reference_image_urls: ['https://cdn.example.com/a.png', 'https://cdn.example.com/b.png'],
    });
  });

  it('sends a Buffer image as a data URL with its own MIME type', async () => {
    queueRun({ request_id: 'req-jpeg' });

    await provider.imageToVideo({
      modelId: 'fal-ai/wan-i2v',
      prompt: 'waves roll in',
      image: JPEG_BYTES,
    });

    expect(submitBody().image_url).toBe(`data:image/jpeg;base64,${JPEG_BYTES.toString('base64')}`);
  });

  it('takes only its own entry from a provider-keyed options bag', async () => {
    queueRun({ request_id: 'req-bag' });

    await provider.imageToVideo({
      modelId: 'fal-ai/kling-video/v2.5-turbo/pro/image-to-video',
      prompt: 'the door opens',
      image: 'https://cdn.example.com/door.png',
      providerOptions: {
        fal: { tail_image_url: 'https://cdn.example.com/door-open.png' },
        replicate: { start_image: 'https://cdn.example.com/other.png' },
      },
    } as any);

    expect(submitBody()).toEqual({
      prompt: 'the door opens',
      image_url: 'https://cdn.example.com/door.png',
      tail_image_url: 'https://cdn.example.com/door-open.png',
    });
  });

  it('sends duration as the string enum to Kling and MiniMax endpoints and as a number to others', async () => {
    queueRun({ request_id: 'req-k' });
    await provider.generateVideo({
      modelId: 'fal-ai/kling-video/v2.5-turbo/pro/text-to-video',
      prompt: 'k',
      durationSec: 10,
    });
    expect(submitBody().duration).toBe('10');

    fetchSpy.mockReset();
    queueRun({ request_id: 'req-m' });
    await provider.imageToVideo({
      modelId: 'fal-ai/minimax/hailuo-02/standard/image-to-video',
      prompt: 'm',
      image: 'https://cdn.example.com/m.png',
      durationSec: 6,
    } as any);
    expect(submitBody().duration).toBe('6');

    fetchSpy.mockReset();
    queueRun({ request_id: 'req-h' });
    await provider.generateVideo({ modelId: 'fal-ai/hunyuan-video', prompt: 'h', durationSec: 5 });
    expect(submitBody().duration).toBe(5);
  });

  it('polls the status_url and fetches the response_url the submit response gives', async () => {
    queueRun({
      request_id: 'req-urls',
      status_url: 'https://queue.fal.run/fal-ai/minimax/requests/req-urls/status',
      response_url: 'https://queue.fal.run/fal-ai/minimax/requests/req-urls',
    });

    const result = await provider.imageToVideo({
      modelId: 'fal-ai/minimax/hailuo-02/standard/image-to-video',
      prompt: 'p',
      image: 'https://cdn.example.com/p.png',
    } as any);

    expect(fetchSpy.mock.calls[0][0]).toBe('https://queue.fal.run/fal-ai/minimax/hailuo-02/standard/image-to-video');
    expect(fetchSpy.mock.calls[1][0]).toBe('https://queue.fal.run/fal-ai/minimax/requests/req-urls/status');
    expect(fetchSpy.mock.calls[2][0]).toBe('https://queue.fal.run/fal-ai/minimax/requests/req-urls');
    expect(result.videos[0].url).toBe('https://fal.media/out.mp4');
  });

  it('builds the queue URLs on the app path when the submit response omits them', async () => {
    queueRun({ request_id: 'req-app' });

    await provider.generateVideo({
      modelId: 'fal-ai/kling-video/v2.5-turbo/pro/text-to-video',
      prompt: 'p',
    });

    expect(fetchSpy.mock.calls[1][0]).toBe('https://queue.fal.run/fal-ai/kling-video/requests/req-app/status');
    expect(fetchSpy.mock.calls[2][0]).toBe('https://queue.fal.run/fal-ai/kling-video/requests/req-app');
  });

  it('keeps the status poll and the result fetch on a custom baseURL', async () => {
    await provider.initialize({ apiKey: 'fal_key', pollIntervalMs: 1, baseURL: 'https://gateway.example.com/fal' });
    queueRun({
      request_id: 'req-gw',
      status_url: 'https://queue.fal.run/fal-ai/kling-video/requests/req-gw/status',
      response_url: 'https://queue.fal.run/fal-ai/kling-video/requests/req-gw',
    });

    await provider.generateVideo({ modelId: 'fal-ai/kling-video/v2.5-turbo/pro/text-to-video', prompt: 'p' });

    expect(fetchSpy.mock.calls[0][0]).toBe('https://gateway.example.com/fal/fal-ai/kling-video/v2.5-turbo/pro/text-to-video');
    expect(fetchSpy.mock.calls[1][0]).toBe('https://gateway.example.com/fal/fal-ai/kling-video/requests/req-gw/status');
    expect(fetchSpy.mock.calls[2][0]).toBe('https://gateway.example.com/fal/fal-ai/kling-video/requests/req-gw');
  });

  it('raises the error of a request that ends COMPLETED with an error, without fetching a result', async () => {
    fetchSpy
      .mockResolvedValueOnce(mockResponse({ request_id: 'req-err' }))
      .mockResolvedValueOnce(mockResponse({
        status: 'COMPLETED',
        error: "Input should be '5' or '10'",
        error_type: 'validation_error',
      }));

    await expect(
      provider.generateVideo({ modelId: 'fal-ai/kling-video/v2.5-turbo/pro/text-to-video', prompt: 'p' }),
    ).rejects.toThrow(/Fal\.ai video generation failed for request req-err \[validation_error\]: Input should be '5' or '10'/);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('runs Kling 2.5 Turbo Pro by default: the text-to-video endpoint for a prompt, the image-to-video endpoint for an image', async () => {
    const fresh = new FalVideoProvider();
    await fresh.initialize({ apiKey: 'fal_key', pollIntervalMs: 1 });

    queueRun({ request_id: 'req-d1' });
    const t2v = await fresh.generateVideo({ prompt: 'p' });
    expect(fetchSpy.mock.calls[0][0]).toBe('https://queue.fal.run/fal-ai/kling-video/v2.5-turbo/pro/text-to-video');
    expect(t2v.modelId).toBe('fal-ai/kling-video/v2.5-turbo/pro/text-to-video');

    fetchSpy.mockReset();
    queueRun({ request_id: 'req-d2' });
    const i2v = await fresh.imageToVideo({ prompt: 'p', image: 'https://cdn.example.com/s.png' } as any);
    expect(fetchSpy.mock.calls[0][0]).toBe('https://queue.fal.run/fal-ai/kling-video/v2.5-turbo/pro/image-to-video');
    expect(i2v.modelId).toBe('fal-ai/kling-video/v2.5-turbo/pro/image-to-video');
  });
});
