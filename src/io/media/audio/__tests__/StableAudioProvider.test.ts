/**
 * @module media/audio/__tests__/StableAudioProvider.test
 *
 * Unit tests for {@link StableAudioProvider} (Stability AI Stable Audio 2 API).
 *
 * Uses mocked `fetch` and asserts the request against the documented shape of
 * `POST /v2beta/audio/stable-audio-2/text-to-audio`
 * (https://docs.stability.ai/api-reference/stable-audio-2/text-to-audio):
 * a `multipart/form-data` body with `prompt`, `duration`, `model`,
 * `output_format` (and optional `seed`), an `authorization` header, and an
 * `accept: audio/*` header that returns the audio bytes.
 *
 * ## What is tested
 *
 * - Music generation posts a multipart form to the Stable Audio 2 endpoint
 * - The default model is `stable-audio-2.5`; a request model overrides it
 * - `outputFormat: 'wav'` reaches the form and the result's MIME type
 * - Seed and provider options reach the form as fields
 * - SFX generation uses the same endpoint
 * - supports() returns true for both music and sfx
 * - API errors are propagated with status codes
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StableAudioProvider } from '../providers/StableAudioProvider.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FetchSpy = ReturnType<typeof vi.fn>;

/**
 * Create a mock Response-like object for fetch.
 * @param body - Response body (ArrayBuffer for success, JSON for errors).
 * @param ok - Whether the response has a 2xx status.
 * @param status - HTTP status code.
 */
function mockResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    arrayBuffer: vi.fn(async () => body),
    json: vi.fn(async () => body),
    text: vi.fn(async () => typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

/** Return the multipart form the provider sent on the given fetch call. */
function sentForm(fetchSpy: FetchSpy, call = 0): FormData {
  const body = fetchSpy.mock.calls[call][1].body;
  expect(body).toBeInstanceOf(FormData);
  return body as FormData;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StableAudioProvider', () => {
  let provider: StableAudioProvider;
  let fetchSpy: FetchSpy;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    provider = new StableAudioProvider();
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // -------------------------------------------------------------------------
  // Music generation
  // -------------------------------------------------------------------------

  it('posts a multipart form to the Stable Audio 2 text-to-audio endpoint', async () => {
    await provider.initialize({ apiKey: 'sa_test_key' });

    const fakeAudio = new ArrayBuffer(128);
    fetchSpy.mockResolvedValueOnce(mockResponse(fakeAudio));

    const result = await provider.generateMusic({
      prompt: 'Upbeat electronic dance track',
      durationSec: 30,
    });

    expect(result.audio).toHaveLength(1);
    expect(result.audio[0].mimeType).toBe('audio/mpeg');
    expect(result.audio[0].base64).toBe(Buffer.from(fakeAudio).toString('base64'));
    expect(result.providerId).toBe('stable-audio');
    expect(result.modelId).toBe('stable-audio-2.5');
    expect(provider.defaultModelId).toBe('stable-audio-2.5');

    const [submitUrl, submitOpts] = fetchSpy.mock.calls[0];
    expect(submitUrl).toBe('https://api.stability.ai/v2beta/audio/stable-audio-2/text-to-audio');
    expect(submitOpts.method).toBe('POST');
    expect(submitOpts.headers.Authorization).toBe('Bearer sa_test_key');
    expect(submitOpts.headers.Accept).toBe('audio/*');
    // fetch sets the multipart boundary itself; a hand-set Content-Type breaks it.
    expect(submitOpts.headers['Content-Type']).toBeUndefined();

    const form = sentForm(fetchSpy);
    expect(form.get('prompt')).toBe('Upbeat electronic dance track');
    expect(form.get('duration')).toBe('30');
    expect(form.get('model')).toBe('stable-audio-2.5');
    expect(form.get('output_format')).toBe('mp3');
    expect(form.has('seed')).toBe(false);
  });

  it('sends the requested model, wav output, seed and provider options', async () => {
    await provider.initialize({ apiKey: 'sa_test_key' });
    fetchSpy.mockResolvedValueOnce(mockResponse(new ArrayBuffer(16)));

    const result = await provider.generateMusic({
      prompt: 'Slow ambient drone',
      modelId: 'stable-audio-2',
      outputFormat: 'wav',
      seed: 7,
      providerOptions: { steps: 50, cfg_scale: 7 },
    });

    expect(result.modelId).toBe('stable-audio-2');
    expect(result.audio[0].mimeType).toBe('audio/wav');

    const form = sentForm(fetchSpy);
    expect(form.get('model')).toBe('stable-audio-2');
    expect(form.get('output_format')).toBe('wav');
    expect(form.get('seed')).toBe('7');
    expect(form.get('steps')).toBe('50');
    expect(form.get('cfg_scale')).toBe('7');
    expect(form.has('duration')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // SFX generation
  // -------------------------------------------------------------------------

  it('should generate SFX using the same endpoint', async () => {
    await provider.initialize({ apiKey: 'sa_test_key' });

    const fakeAudio = new ArrayBuffer(64);
    fetchSpy.mockResolvedValueOnce(mockResponse(fakeAudio));

    const result = await provider.generateSFX({
      prompt: 'Door slamming shut',
      durationSec: 2,
    });

    expect(result.audio).toHaveLength(1);
    expect(result.providerId).toBe('stable-audio');
    expect(result.usage?.totalAudioClips).toBe(1);

    expect(fetchSpy.mock.calls[0][0]).toBe(
      'https://api.stability.ai/v2beta/audio/stable-audio-2/text-to-audio',
    );
    const form = sentForm(fetchSpy);
    expect(form.get('prompt')).toBe('Door slamming shut');
    expect(form.get('duration')).toBe('2');
  });

  // -------------------------------------------------------------------------
  // supports()
  // -------------------------------------------------------------------------

  it('should support both music and sfx capabilities', () => {
    expect(provider.supports('music')).toBe(true);
    expect(provider.supports('sfx')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  it('should throw on API error with status code', async () => {
    await provider.initialize({ apiKey: 'sa_test_key' });

    fetchSpy.mockResolvedValueOnce(mockResponse('Unauthorized', false, 401));

    await expect(
      provider.generateMusic({ prompt: 'test' }),
    ).rejects.toThrow(/Stable Audio generation failed \(401\)/);
  });
});
