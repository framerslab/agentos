/**
 * @module media/video/__tests__/RunwayVideoProvider.test
 *
 * Unit tests for {@link RunwayVideoProvider} (Runway Gen-3 Alpha API).
 *
 * Uses mocked `fetch` to simulate the Runway submit-then-poll flow.
 *
 * ## What is tested
 *
 * - Initialization with valid/invalid API keys and custom config
 * - Task submission sends correct URL, headers, and body
 * - Status polling retries until SUCCEEDED
 * - Timeout during polling throws descriptive error
 * - FAILED status during polling throws descriptive error
 * - Image-to-video uses correct endpoint and body
 * - Uninitialized provider rejects calls
 * - supports() returns correct capabilities
 * - shutdown resets initialization state
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RunwayVideoProvider } from '../providers/RunwayVideoProvider.js';

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

describe('RunwayVideoProvider', () => {
  let provider: RunwayVideoProvider;
  let fetchSpy: FetchSpy;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    provider = new RunwayVideoProvider();
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
    await provider.initialize({ apiKey: 'runway_test_key' });
    expect(provider.isInitialized).toBe(true);
    expect(provider.providerId).toBe('runway');
    expect(provider.defaultModelId).toBe('gen3a_turbo');
  });

  it('should throw on initialize without API key', async () => {
    await expect(provider.initialize({})).rejects.toThrow(/requires apiKey/);
  });

  it('should throw on initialize with empty API key', async () => {
    await expect(provider.initialize({ apiKey: '' })).rejects.toThrow(/requires apiKey/);
  });

  it('should use custom defaultModelId when provided', async () => {
    await provider.initialize({ apiKey: 'key', defaultModelId: 'gen3a' });
    expect(provider.defaultModelId).toBe('gen3a');
  });

  it('should use custom baseURL when provided', async () => {
    await provider.initialize({
      apiKey: 'key',
      baseURL: 'https://custom.runway.com/v1',
      pollIntervalMs: 1,
    });

    fetchSpy
      .mockResolvedValueOnce(mockResponse({ id: 'task-1' }))
      .mockResolvedValueOnce(mockResponse({
        id: 'task-1',
        status: 'SUCCEEDED',
        output: ['https://runway.com/video.mp4'],
      }));

    await provider.generateVideo({ modelId: 'gen3a_turbo', prompt: 'test' });

    const [submitUrl] = fetchSpy.mock.calls[0];
    expect(submitUrl).toBe('https://custom.runway.com/v1/text_to_video');
  });

  // -------------------------------------------------------------------------
  // Full generation flow (submit -> poll -> result)
  // -------------------------------------------------------------------------

  it('should complete the full submit -> poll -> result flow', async () => {
    await provider.initialize({ apiKey: 'runway_key_123', pollIntervalMs: 1 });

    // Call 1: Submit
    fetchSpy.mockResolvedValueOnce(mockResponse({ id: 'task-abc' }));
    // Call 2: Poll (PROCESSING)
    fetchSpy.mockResolvedValueOnce(mockResponse({ id: 'task-abc', status: 'PROCESSING' }));
    // Call 3: Poll (SUCCEEDED)
    fetchSpy.mockResolvedValueOnce(mockResponse({
      id: 'task-abc',
      status: 'SUCCEEDED',
      output: ['https://runway.com/output/video.mp4'],
    }));

    const result = await provider.generateVideo({
      modelId: 'gen3a_turbo',
      prompt: 'A cinematic sunrise',
      durationSec: 5,
      aspectRatio: '16:9',
    });

    expect(result.videos).toHaveLength(1);
    expect(result.videos[0].url).toBe('https://runway.com/output/video.mp4');
    expect(result.providerId).toBe('runway');
    expect(result.videos[0].mimeType).toBe('video/mp4');
    expect(result.videos[0].providerMetadata?.taskId).toBe('task-abc');
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  // -------------------------------------------------------------------------
  // Submission
  // -------------------------------------------------------------------------

  it('should submit text_to_video with correct URL, headers, and body', async () => {
    await provider.initialize({ apiKey: 'runway_key_xyz', pollIntervalMs: 1 });

    fetchSpy
      .mockResolvedValueOnce(mockResponse({ id: 'task-1' }))
      .mockResolvedValueOnce(mockResponse({
        id: 'task-1',
        status: 'SUCCEEDED',
        output: ['https://runway.com/video.mp4'],
      }));

    await provider.generateVideo({
      modelId: 'gen3a_turbo',
      prompt: 'test prompt',
      durationSec: 10,
      aspectRatio: '16:9',
    });

    const [submitUrl, submitOpts] = fetchSpy.mock.calls[0];
    expect(submitUrl).toBe('https://api.dev.runwayml.com/v1/text_to_video');
    expect(submitOpts.headers.Authorization).toBe('Bearer runway_key_xyz');
    expect(submitOpts.headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(submitOpts.body);
    expect(body.prompt).toBe('test prompt');
    expect(body.model).toBe('gen3a_turbo');
    expect(body.duration).toBe(10);
    expect(body.ratio).toBe('16:9');
  });

  // -------------------------------------------------------------------------
  // Polling
  // -------------------------------------------------------------------------

  it('should poll multiple times until SUCCEEDED', async () => {
    await provider.initialize({ apiKey: 'key', pollIntervalMs: 1 });

    fetchSpy
      .mockResolvedValueOnce(mockResponse({ id: 'task-1' }))
      .mockResolvedValueOnce(mockResponse({ id: 'task-1', status: 'PENDING' }))
      .mockResolvedValueOnce(mockResponse({ id: 'task-1', status: 'PROCESSING' }))
      .mockResolvedValueOnce(mockResponse({ id: 'task-1', status: 'PROCESSING' }))
      .mockResolvedValueOnce(mockResponse({
        id: 'task-1',
        status: 'SUCCEEDED',
        output: ['https://runway.com/video.mp4'],
      }));

    const result = await provider.generateVideo({ modelId: 'gen3a_turbo', prompt: 'poll test' });
    expect(result.videos[0].url).toBe('https://runway.com/video.mp4');
    expect(fetchSpy).toHaveBeenCalledTimes(5);
  });

  // -------------------------------------------------------------------------
  // Image-to-video
  // -------------------------------------------------------------------------

  it('should submit image_to_video with correct endpoint and body', async () => {
    await provider.initialize({ apiKey: 'key', pollIntervalMs: 1 });

    fetchSpy
      .mockResolvedValueOnce(mockResponse({ id: 'task-img' }))
      .mockResolvedValueOnce(mockResponse({
        id: 'task-img',
        status: 'SUCCEEDED',
        output: ['https://runway.com/i2v.mp4'],
      }));

    const imageBuffer = Buffer.from('fake-image-data');

    const result = await provider.imageToVideo({
      modelId: 'gen3a_turbo',
      prompt: 'animate this',
      image: imageBuffer,
      durationSec: 5,
      aspectRatio: '9:16',
    });

    expect(result.videos[0].url).toBe('https://runway.com/i2v.mp4');

    const [submitUrl, submitOpts] = fetchSpy.mock.calls[0];
    expect(submitUrl).toBe('https://api.dev.runwayml.com/v1/image_to_video');

    const body = JSON.parse(submitOpts.body);
    expect(body.prompt_image).toContain('data:image/png;base64,');
    expect(body.prompt).toBe('animate this');
    expect(body.duration).toBe(5);
    expect(body.ratio).toBe('9:16');
  });

  it('should send an image given as a URL as is', async () => {
    await provider.initialize({ apiKey: 'key', pollIntervalMs: 1 });

    fetchSpy
      .mockResolvedValueOnce(mockResponse({ id: 'task-url' }))
      .mockResolvedValueOnce(mockResponse({
        id: 'task-url',
        status: 'SUCCEEDED',
        output: ['https://runway.com/i2v.mp4'],
      }));

    await provider.imageToVideo({
      modelId: 'gen3a_turbo',
      prompt: 'animate this',
      image: 'https://cdn.example.com/still.jpg',
    } as any);

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.prompt_image).toBe('https://cdn.example.com/still.jpg');
  });

  it('should throw when imageToVideo called while not initialized', async () => {
    const imageBuffer = Buffer.from('fake-image-data');
    await expect(
      provider.imageToVideo({ modelId: 'gen3a_turbo', prompt: 'test', image: imageBuffer }),
    ).rejects.toThrow(/not initialized/);
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  it('should throw on FAILED status during polling', async () => {
    await provider.initialize({ apiKey: 'key', pollIntervalMs: 1 });

    fetchSpy
      .mockResolvedValueOnce(mockResponse({ id: 'task-fail' }))
      .mockResolvedValueOnce(mockResponse({
        id: 'task-fail',
        status: 'FAILED',
        failure: 'Content policy violation',
      }));

    await expect(
      provider.generateVideo({ modelId: 'gen3a_turbo', prompt: 'bad content' }),
    ).rejects.toThrow(/Runway video generation failed.*Content policy violation/);
  });

  it('should throw on submission HTTP error', async () => {
    await provider.initialize({ apiKey: 'key' });

    fetchSpy.mockResolvedValueOnce(mockResponse({ error: 'unauthorized' }, false, 401));

    await expect(
      provider.generateVideo({ modelId: 'gen3a_turbo', prompt: 'fail' }),
    ).rejects.toThrow(/submission failed \(401\)/);
  });

  it('should throw when not initialized', async () => {
    await expect(
      provider.generateVideo({ modelId: 'gen3a_turbo', prompt: 'fail' }),
    ).rejects.toThrow(/not initialized/);
  });

  it('should throw on timeout', async () => {
    await provider.initialize({ apiKey: 'key', pollIntervalMs: 1, timeoutMs: 10 });

    fetchSpy
      .mockResolvedValueOnce(mockResponse({ id: 'task-slow' }))
      .mockResolvedValue(mockResponse({ id: 'task-slow', status: 'PROCESSING' }));

    await expect(
      provider.generateVideo({ modelId: 'gen3a_turbo', prompt: 'slow' }),
    ).rejects.toThrow(/timed out/);
  });

  it('should throw when task succeeds but has no output', async () => {
    await provider.initialize({ apiKey: 'key', pollIntervalMs: 1 });

    fetchSpy
      .mockResolvedValueOnce(mockResponse({ id: 'task-empty' }))
      .mockResolvedValueOnce(mockResponse({
        id: 'task-empty',
        status: 'SUCCEEDED',
        output: [],
      }));

    await expect(
      provider.generateVideo({ modelId: 'gen3a_turbo', prompt: 'empty' }),
    ).rejects.toThrow(/no video output/);
  });

  it('should throw on polling HTTP error', async () => {
    await provider.initialize({ apiKey: 'key', pollIntervalMs: 1 });

    fetchSpy
      .mockResolvedValueOnce(mockResponse({ id: 'task-poll-err' }))
      .mockResolvedValueOnce(mockResponse({ error: 'server error' }, false, 500));

    await expect(
      provider.generateVideo({ modelId: 'gen3a_turbo', prompt: 'poll error' }),
    ).rejects.toThrow(/polling failed \(500\)/);
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
