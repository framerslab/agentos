/**
 * @module media/video/__tests__/GeminiVideoProvider.test
 *
 * Tests for the Gemini video provider against captured request bodies.
 * `fetch` is replaced by a spy, so each test reads the exact URL, headers
 * and JSON body the provider sends to the Gemini Interactions API and feeds
 * back an interaction shaped as the API documents it
 * (https://ai.google.dev/gemini-api/docs/omni).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createVideoProvider } from '../index.js';

type FetchSpy = ReturnType<typeof vi.fn>;

/** A Response-like object for a JSON body. */
function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    headers: { get: () => 'application/json' },
    json: vi.fn(async () => body),
    text: vi.fn(async () => JSON.stringify(body)),
  };
}

/** A Response-like object for image bytes. */
function imageResponse(bytes: Buffer, contentType: string) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    arrayBuffer: vi.fn(async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
    text: vi.fn(async () => ''),
  };
}

/** A completed interaction whose model output holds `content`. */
function interaction(content: unknown[], status = 'completed') {
  return {
    id: 'int-1',
    object: 'interaction',
    model: 'gemini-omni-1.1-flash',
    status,
    steps: [
      { type: 'user_input', content: [{ type: 'text', text: 'prompt' }] },
      { type: 'thought' },
      { type: 'model_output', content },
    ],
  };
}

const VIDEO_B64 = Buffer.from('mp4-bytes').toString('base64');
/** The first bytes of a PNG file. */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
/** The first bytes of a JPEG file. */
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const INTERACTIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';

describe('GeminiVideoProvider', () => {
  let provider: any;
  let fetchSpy: FetchSpy;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    provider = createVideoProvider('gemini');
    await provider.initialize({ apiKey: 'gk-test' });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** The call to the Interactions API (the last fetch). */
  function interactionCall(): [string, any] {
    const calls = fetchSpy.mock.calls;
    return calls[calls.length - 1] as [string, any];
  }

  it('posts a prompt to the Interactions API with the key in the x-goog-api-key header', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(interaction([{ type: 'video', mime_type: 'video/mp4', data: VIDEO_B64 }])),
    );

    const result = await provider.generateVideo({
      prompt: 'a marble rolls down a chain-reaction track',
      aspectRatio: '9:16',
      resolution: '1080p',
      durationSec: 8,
      negativePrompt: 'blur',
      seed: 3,
    });

    const [url, init] = interactionCall();
    expect(url).toBe(INTERACTIONS_URL);
    expect(url).not.toContain('key=');
    expect(init.method).toBe('POST');
    expect(init.headers['x-goog-api-key']).toBe('gk-test');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body)).toEqual({
      store: false,
      model: 'gemini-omni-1.1-flash',
      input: 'a marble rolls down a chain-reaction track',
      response_format: { type: 'video', aspect_ratio: '9:16', resolution: '1080p' },
    });

    expect(result.providerId).toBe('gemini');
    expect(result.modelId).toBe('gemini-omni-1.1-flash');
    expect(result.videos).toHaveLength(1);
    expect(result.videos[0]).toMatchObject({ base64: VIDEO_B64, mimeType: 'video/mp4' });
    expect(result.videos[0].url).toBeUndefined();
    expect(result.usage).toEqual({ totalVideos: 1 });
  });

  it('sends the source image first, then the reference images, then the prompt, as image-to-video', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(interaction([{ type: 'video', mime_type: 'video/mp4', data: VIDEO_B64 }])),
    );

    await provider.imageToVideo({
      prompt: 'the figure walks toward the camera',
      image: PNG_BYTES,
      referenceImages: ['data:image/webp;base64,UklGRgAAAABXRUJQ'],
    });

    const body = JSON.parse(interactionCall()[1].body);
    expect(body.input).toEqual([
      { type: 'image', data: PNG_BYTES.toString('base64'), mime_type: 'image/png' },
      { type: 'image', data: 'UklGRgAAAABXRUJQ', mime_type: 'image/webp' },
      { type: 'text', text: 'the figure walks toward the camera' },
    ]);
    expect(body.generation_config).toEqual({ video_config: { task: 'image_to_video' } });
  });

  it('fetches an image URL under the call deadline without the key, and sends a Files API URI as a uri', async () => {
    fetchSpy
      .mockResolvedValueOnce(imageResponse(JPEG_BYTES, 'image/jpeg; charset=binary'))
      .mockResolvedValueOnce(
        jsonResponse(interaction([{ type: 'video', mime_type: 'video/mp4', data: VIDEO_B64 }])),
      );

    await provider.imageToVideo({
      prompt: 'p',
      image: 'https://cdn.example.com/start.jpg',
      referenceImages: ['https://generativelanguage.googleapis.com/v1beta/files/abc123'],
    });

    const [imageUrl, imageInit] = fetchSpy.mock.calls[0];
    expect(imageUrl).toBe('https://cdn.example.com/start.jpg');
    expect(imageInit.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(imageInit.headers ?? {})).not.toContain('gk-test');

    const body = JSON.parse(interactionCall()[1].body);
    expect(body.input).toEqual([
      { type: 'image', data: JPEG_BYTES.toString('base64'), mime_type: 'image/jpeg' },
      { type: 'image', uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc123' },
      { type: 'text', text: 'p' },
    ]);
  });

  it('asks for reference-to-video when a prompt comes with reference images and no source image', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(interaction([{ type: 'video', mime_type: 'video/mp4', data: VIDEO_B64 }])),
    );

    await provider.generateVideo({ prompt: 'the cat plays with yarn', referenceImages: [JPEG_BYTES] });

    const body = JSON.parse(interactionCall()[1].body);
    expect(body.input).toEqual([
      { type: 'image', data: JPEG_BYTES.toString('base64'), mime_type: 'image/jpeg' },
      { type: 'text', text: 'the cat plays with yarn' },
    ]);
    expect(body.generation_config).toEqual({ video_config: { task: 'reference_to_video' } });
  });

  it('adds provider options without replacing the model, the input or the video format the call sets', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(interaction([{ type: 'video', mime_type: 'video/mp4', data: VIDEO_B64 }])),
    );

    await provider.generateVideo({
      prompt: 'p',
      aspectRatio: '9:16',
      providerOptions: {
        gemini: {
          model: 'not-this-model',
          input: 'not this input',
          store: true,
          response_format: { aspect_ratio: '16:9', delivery: 'uri' },
          generation_config: { seed: 7 },
        },
        fal: { end_image_url: 'https://cdn.example.com/end.png' },
      },
    });

    expect(JSON.parse(interactionCall()[1].body)).toEqual({
      store: true,
      model: 'gemini-omni-1.1-flash',
      input: 'p',
      response_format: { type: 'video', aspect_ratio: '9:16', delivery: 'uri' },
      generation_config: { seed: 7 },
    });
  });

  it('returns the URI of a video delivered by URI', async () => {
    const uri = 'https://generativelanguage.googleapis.com/v1beta/files/vid-9:download?alt=media';
    fetchSpy.mockResolvedValueOnce(jsonResponse(interaction([{ type: 'video', mime_type: 'video/mp4', uri }])));

    const result = await provider.generateVideo({ prompt: 'p' });

    expect(result.videos[0].url).toBe(uri);
    expect(result.videos[0].base64).toBeUndefined();
    expect(result.videos[0].providerMetadata).toMatchObject({ interactionId: 'int-1' });
  });

  it('runs a configured model', async () => {
    await provider.initialize({ apiKey: 'gk-test', defaultModelId: 'gemini-omni-flash-next' });
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(interaction([{ type: 'video', mime_type: 'video/mp4', data: VIDEO_B64 }])),
    );

    const result = await provider.generateVideo({ prompt: 'p' });

    expect(JSON.parse(interactionCall()[1].body).model).toBe('gemini-omni-flash-next');
    expect(result.modelId).toBe('gemini-omni-flash-next');
  });

  it('raises an interaction that ends without completing', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ ...interaction([]), status: 'failed', error: { message: 'blocked by policy' } }),
    );

    await expect(provider.generateVideo({ prompt: 'p' })).rejects.toThrow(
      /Gemini video generation ended with status failed: blocked by policy/,
    );
  });

  it('raises a completed interaction with no video', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(interaction([{ type: 'text', text: 'I cannot do that.' }])));

    await expect(provider.generateVideo({ prompt: 'p' })).rejects.toThrow(/returned no video/);
  });

  it('raises the HTTP status and body of a refused request', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ error: { message: 'quota' } }, false, 429));

    await expect(provider.generateVideo({ prompt: 'p' })).rejects.toThrow(
      /Gemini video generation request failed \(429\): .*quota/,
    );
  });

  it('aborts a request that outlives timeoutMs', async () => {
    await provider.initialize({ apiKey: 'gk-test', timeoutMs: 20 });
    fetchSpy.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('The operation was aborted.')));
        }),
    );

    await expect(provider.generateVideo({ prompt: 'p' })).rejects.toThrow(/timed out after 20ms/);
  });

  it('requires an API key', async () => {
    const fresh = createVideoProvider('gemini');
    await expect(fresh.initialize({})).rejects.toThrow(/requires apiKey/);
    await expect(fresh.initialize({ apiKey: '  ' })).rejects.toThrow(/requires apiKey/);
  });

  it('supports text-to-video and image-to-video', () => {
    expect(provider.providerId).toBe('gemini');
    expect(provider.defaultModelId).toBe('gemini-omni-1.1-flash');
    expect(provider.supports('text-to-video')).toBe(true);
    expect(provider.supports('image-to-video')).toBe(true);
  });

  it('rejects calls before initialize', async () => {
    const fresh = createVideoProvider('gemini');
    await expect(fresh.generateVideo({ prompt: 'p' })).rejects.toThrow(/not initialized/);
  });
});
