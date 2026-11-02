/**
 * @module media/audio/__tests__/FalAudioProvider.test
 *
 * Unit tests for {@link FalAudioProvider} (fal queue API).
 *
 * Uses mocked `fetch` and asserts the requests against fal's queue reference
 * (https://fal.ai/docs/api-reference/inference-api/queue/submit.md and
 * .../queue/status.md) and the model pages:
 *
 * - `fal-ai/musicgen` takes `{ prompt, duration }` and returns `audio_url`
 *   (https://fal.ai/models/fal-ai/musicgen/api).
 * - `fal-ai/stable-audio` takes `{ prompt, seconds_total }` and returns
 *   `audio_file` (https://fal.ai/models/fal-ai/stable-audio/api).
 * - The submit response carries `status_url` and `response_url`; a failed
 *   request ends in `COMPLETED` with an `error` field.
 *
 * ## What is tested
 *
 * - Music runs on fal-ai/musicgen by default and reads `audio_url`
 * - SFX runs on fal-ai/stable-audio by default, sends `seconds_total` and
 *   reads `audio_file`
 * - The provider polls the `status_url` and reads the `response_url` it was given
 * - Those requests stay on a custom `baseURL`
 * - Provider options never replace the prompt, duration or seed
 * - A `defaultModelId` override still applies to both capabilities
 * - A COMPLETED status with an `error` is raised as a failure
 * - supports() returns true for both music and sfx
 * - API errors are propagated with status codes
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FalAudioProvider } from '../providers/FalAudioProvider.js';

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

/** A submit response in the documented shape for a model and request id. */
function submitted(model: string, requestId: string) {
  const base = `https://queue.fal.run/${model}/requests/${requestId}`;
  return {
    status: 'IN_QUEUE',
    request_id: requestId,
    status_url: `${base}/status`,
    response_url: base,
    cancel_url: `${base}/cancel`,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FalAudioProvider', () => {
  let provider: FalAudioProvider;
  let fetchSpy: FetchSpy;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    provider = new FalAudioProvider();
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // -------------------------------------------------------------------------
  // Music generation (full flow)
  // -------------------------------------------------------------------------

  it('runs music on fal-ai/musicgen and reads audio_url', async () => {
    await provider.initialize({ apiKey: 'fal_audio_key', pollIntervalMs: 1 });

    fetchSpy
      .mockResolvedValueOnce(mockResponse(submitted('fal-ai/musicgen', 'req-audio-1')))
      .mockResolvedValueOnce(mockResponse({ status: 'IN_PROGRESS', request_id: 'req-audio-1' }))
      .mockResolvedValueOnce(mockResponse({ status: 'COMPLETED', request_id: 'req-audio-1' }))
      .mockResolvedValueOnce(mockResponse({
        audio_url: {
          url: 'https://v3.fal.media/files/music.wav',
          content_type: 'audio/wav',
          file_name: 'music.wav',
        },
      }));

    const result = await provider.generateMusic({
      prompt: 'Ambient electronic soundscape',
      durationSec: 30,
    });

    expect(result.audio).toHaveLength(1);
    expect(result.audio[0].url).toBe('https://v3.fal.media/files/music.wav');
    expect(result.audio[0].mimeType).toBe('audio/wav');
    expect(result.providerId).toBe('fal-audio');
    expect(result.modelId).toBe('fal-ai/musicgen');
    expect(provider.defaultModelId).toBe('fal-ai/musicgen');
    expect(fetchSpy).toHaveBeenCalledTimes(4);

    const [submitUrl, submitOpts] = fetchSpy.mock.calls[0];
    expect(submitUrl).toBe('https://queue.fal.run/fal-ai/musicgen');
    expect(submitOpts.method).toBe('POST');
    expect(submitOpts.headers.Authorization).toBe('Key fal_audio_key');
    expect(JSON.parse(submitOpts.body)).toEqual({
      prompt: 'Ambient electronic soundscape',
      duration: 30,
    });

    expect(fetchSpy.mock.calls[1][0]).toBe(
      'https://queue.fal.run/fal-ai/musicgen/requests/req-audio-1/status',
    );
    expect(fetchSpy.mock.calls[3][0]).toBe('https://queue.fal.run/fal-ai/musicgen/requests/req-audio-1');
    expect(fetchSpy.mock.calls[3][1].headers.Authorization).toBe('Key fal_audio_key');
  });

  it('polls the status_url and reads the response_url the queue returned', async () => {
    await provider.initialize({ apiKey: 'fal_key', pollIntervalMs: 1 });

    // An endpoint path model: the queue answers with URLs on the app path.
    fetchSpy
      .mockResolvedValueOnce(mockResponse({
        request_id: 'req-path-1',
        status_url: 'https://queue.fal.run/fal-ai/stable-audio-25/requests/req-path-1/status',
        response_url: 'https://queue.fal.run/fal-ai/stable-audio-25/requests/req-path-1',
      }))
      .mockResolvedValueOnce(mockResponse({ status: 'COMPLETED', request_id: 'req-path-1' }))
      .mockResolvedValueOnce(mockResponse({
        audio: { url: 'https://v3.fal.media/files/sa25.wav', content_type: 'audio/wav' },
        seed: 3,
      }));

    const result = await provider.generateMusic({
      prompt: 'Lo-fi beat',
      modelId: 'fal-ai/stable-audio-25/text-to-audio',
      durationSec: 20,
    });

    expect(result.audio[0].url).toBe('https://v3.fal.media/files/sa25.wav');
    expect(result.audio[0].providerMetadata).toMatchObject({ seed: 3, requestId: 'req-path-1' });
    expect(fetchSpy.mock.calls[0][0]).toBe('https://queue.fal.run/fal-ai/stable-audio-25/text-to-audio');
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toEqual({
      prompt: 'Lo-fi beat',
      seconds_total: 20,
    });
    expect(fetchSpy.mock.calls[1][0]).toBe(
      'https://queue.fal.run/fal-ai/stable-audio-25/requests/req-path-1/status',
    );
    expect(fetchSpy.mock.calls[2][0]).toBe(
      'https://queue.fal.run/fal-ai/stable-audio-25/requests/req-path-1',
    );
  });

  it('builds the request URLs from the app path when the queue omits them', async () => {
    await provider.initialize({ apiKey: 'fal_key', pollIntervalMs: 1 });

    fetchSpy
      .mockResolvedValueOnce(mockResponse({ request_id: 'req-bare' }))
      .mockResolvedValueOnce(mockResponse({ status: 'COMPLETED' }))
      .mockResolvedValueOnce(mockResponse({ audio_url: { url: 'https://v3.fal.media/files/m.mp3' } }));

    const result = await provider.generateMusic({ prompt: 'March' });

    expect(result.audio[0].mimeType).toBe('audio/mpeg');
    expect(fetchSpy.mock.calls[1][0]).toBe('https://queue.fal.run/fal-ai/musicgen/requests/req-bare/status');
    expect(fetchSpy.mock.calls[2][0]).toBe('https://queue.fal.run/fal-ai/musicgen/requests/req-bare');
  });

  it('keeps the status and result requests on a custom baseURL', async () => {
    await provider.initialize({
      apiKey: 'fal_key',
      pollIntervalMs: 1,
      baseURL: 'https://gateway.example.com/fal',
    });

    // The queue answers with its own host; the polls must still go through the gateway.
    fetchSpy
      .mockResolvedValueOnce(mockResponse(submitted('fal-ai/musicgen', 'req-gw-1')))
      .mockResolvedValueOnce(mockResponse({ status: 'COMPLETED', request_id: 'req-gw-1' }))
      .mockResolvedValueOnce(mockResponse({ audio_url: { url: 'https://v3.fal.media/files/m.wav' } }));

    await provider.generateMusic({ prompt: 'March' });

    expect(fetchSpy.mock.calls[0][0]).toBe('https://gateway.example.com/fal/fal-ai/musicgen');
    expect(fetchSpy.mock.calls[1][0]).toBe(
      'https://gateway.example.com/fal/fal-ai/musicgen/requests/req-gw-1/status',
    );
    expect(fetchSpy.mock.calls[2][0]).toBe('https://gateway.example.com/fal/fal-ai/musicgen/requests/req-gw-1');
  });

  // -------------------------------------------------------------------------
  // SFX generation
  // -------------------------------------------------------------------------

  it('runs SFX on fal-ai/stable-audio with seconds_total and reads audio_file', async () => {
    await provider.initialize({ apiKey: 'fal_key', pollIntervalMs: 1 });

    fetchSpy
      .mockResolvedValueOnce(mockResponse(submitted('fal-ai/stable-audio', 'req-sfx-1')))
      .mockResolvedValueOnce(mockResponse({ status: 'COMPLETED', request_id: 'req-sfx-1' }))
      .mockResolvedValueOnce(mockResponse({
        audio_file: { url: 'https://v3.fal.media/files/sfx.wav', content_type: 'audio/wav' },
      }));

    const result = await provider.generateSFX({
      prompt: 'Explosion with debris',
      durationSec: 3,
    });

    expect(result.audio).toHaveLength(1);
    expect(result.audio[0].url).toBe('https://v3.fal.media/files/sfx.wav');
    expect(result.modelId).toBe('fal-ai/stable-audio');

    expect(fetchSpy.mock.calls[0][0]).toBe('https://queue.fal.run/fal-ai/stable-audio');
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toEqual({
      prompt: 'Explosion with debris',
      seconds_total: 3,
    });
  });

  it('keeps the prompt, duration and seed when provider options name the same keys', async () => {
    await provider.initialize({ apiKey: 'fal_key', pollIntervalMs: 1 });

    fetchSpy
      .mockResolvedValueOnce(mockResponse(submitted('fal-ai/musicgen', 'req-opt-1')))
      .mockResolvedValueOnce(mockResponse({ status: 'COMPLETED', request_id: 'req-opt-1' }))
      .mockResolvedValueOnce(mockResponse({ audio_url: { url: 'https://v3.fal.media/files/m.wav' } }))
      .mockResolvedValueOnce(mockResponse(submitted('fal-ai/stable-audio', 'req-opt-2')))
      .mockResolvedValueOnce(mockResponse({ status: 'COMPLETED', request_id: 'req-opt-2' }))
      .mockResolvedValueOnce(mockResponse({ audio_file: { url: 'https://v3.fal.media/files/s.wav' } }));

    await provider.generateMusic({
      prompt: 'Slow piano',
      durationSec: 30,
      seed: 7,
      providerOptions: { prompt: 'Polka', duration: 4, seed: 99, guidance: 3 },
    });
    await provider.generateSFX({
      prompt: 'Glass shatter',
      durationSec: 5,
      seed: 11,
      providerOptions: { prompt: 'Thunder', seconds_total: 40, seed: 99, steps: 50 },
    });

    expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toEqual({
      prompt: 'Slow piano',
      duration: 30,
      seed: 7,
      guidance: 3,
    });
    expect(JSON.parse(fetchSpy.mock.calls[3][1].body)).toEqual({
      prompt: 'Glass shatter',
      seconds_total: 5,
      seed: 11,
      steps: 50,
    });
  });

  it('applies a defaultModelId override to both capabilities', async () => {
    await provider.initialize({
      apiKey: 'fal_key',
      pollIntervalMs: 1,
      defaultModelId: 'fal-ai/stable-audio',
    });

    fetchSpy
      .mockResolvedValueOnce(mockResponse(submitted('fal-ai/stable-audio', 'req-o')))
      .mockResolvedValueOnce(mockResponse({ status: 'COMPLETED' }))
      .mockResolvedValueOnce(mockResponse({ audio_file: { url: 'https://v3.fal.media/files/o.wav' } }));

    const result = await provider.generateMusic({ prompt: 'Drone' });

    expect(result.modelId).toBe('fal-ai/stable-audio');
    expect(result.audio[0].mimeType).toBe('audio/wav');
    expect(fetchSpy.mock.calls[0][0]).toBe('https://queue.fal.run/fal-ai/stable-audio');
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
    await provider.initialize({ apiKey: 'fal_key' });

    fetchSpy.mockResolvedValueOnce(mockResponse({ error: 'unauthorized' }, false, 403));

    await expect(
      provider.generateMusic({ prompt: 'test' }),
    ).rejects.toThrow(/submission failed \(403\)/);
  });

  it('raises a COMPLETED status that carries an error', async () => {
    await provider.initialize({ apiKey: 'fal_key', pollIntervalMs: 1 });

    fetchSpy
      .mockResolvedValueOnce(mockResponse(submitted('fal-ai/musicgen', 'req-err')))
      .mockResolvedValueOnce(mockResponse({
        status: 'COMPLETED',
        request_id: 'req-err',
        error: 'Prompt was flagged by the safety checker',
        error_type: 'content_policy_violation',
      }));

    await expect(
      provider.generateMusic({ prompt: 'test' }),
    ).rejects.toThrow(/Prompt was flagged by the safety checker/);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
