/**
 * @module media/audio/__tests__/ReplicateAudioProvider.test
 *
 * Unit tests for {@link ReplicateAudioProvider} (Replicate predictions API).
 *
 * Uses mocked `fetch` and asserts the requests against Replicate's HTTP API
 * reference (https://replicate.com/docs/reference/http):
 *
 * - Community models (`meta/musicgen`, `sepal/audiogen`) run through
 *   `POST /v1/predictions` with a `version` of `{owner}/{name}:{version_id}`;
 *   the bare `{owner}/{name}` form is only accepted for official models.
 * - Official models (`stability-ai/stable-audio-2.5`) run through
 *   `POST /v1/models/{owner}/{name}/predictions` with an `input` body.
 * - The token is sent as `Authorization: Bearer <token>`.
 *
 * ## What is tested
 *
 * - Music generation pins the meta/musicgen version
 * - SFX generation pins the sepal/audiogen version (the retired `meta/audiogen`
 *   default resolves to it)
 * - An official model goes to the model predictions route
 * - A full `owner/name:version` or a bare version id is sent as given
 * - Output format and provider options reach the model input
 * - An explicitly versioned model is reported with its version
 * - Only the wav and mp3 output formats are sent, mapped per known model
 * - The seed reaches the models whose schema takes one
 * - elevenlabs/music gets its length as `music_length_ms`
 * - Provider options never replace the prompt, duration or output format
 * - Polling a prediction that did not finish inside the wait window
 * - supports() returns true for both music and sfx
 * - API errors are propagated with status codes
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ReplicateAudioProvider } from '../providers/ReplicateAudioProvider.js';

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

/** meta/musicgen's latest version on Replicate (stereo-large, 2024). */
const MUSICGEN_VERSION = '671ac645ce5e552cc63a54a2bbff63fcf798043055d2dac5fc9e36a837eedcfb';
/** sepal/audiogen's latest version on Replicate. */
const AUDIOGEN_VERSION = '154b3e5141493cb1b8cec976d9aa90f2b691137e39ad906d2421b74c2a8c52b8';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ReplicateAudioProvider', () => {
  let provider: ReplicateAudioProvider;
  let fetchSpy: FetchSpy;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    provider = new ReplicateAudioProvider();
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // -------------------------------------------------------------------------
  // Music generation
  // -------------------------------------------------------------------------

  it('runs meta/musicgen through /predictions with its pinned version', async () => {
    await provider.initialize({ apiKey: 'r8_audio_key', pollIntervalMs: 1 });

    fetchSpy.mockResolvedValueOnce(mockResponse({
      id: 'pred-music-1',
      status: 'succeeded',
      output: 'https://replicate.delivery/music.mp3',
    }));

    const result = await provider.generateMusic({
      prompt: 'Upbeat indie rock',
      durationSec: 30,
    });

    expect(result.audio).toHaveLength(1);
    expect(result.audio[0].url).toBe('https://replicate.delivery/music.mp3');
    expect(result.audio[0].mimeType).toBe('audio/mpeg');
    expect(result.providerId).toBe('replicate-audio');
    expect(result.modelId).toBe('meta/musicgen');

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.replicate.com/v1/predictions');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer r8_audio_key');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers.Prefer).toBe('wait=60');

    const body = JSON.parse(init.body);
    expect(body).toEqual({
      version: `meta/musicgen:${MUSICGEN_VERSION}`,
      input: { prompt: 'Upbeat indie rock', duration: 30 },
    });
    expect(body.model).toBeUndefined();
  });

  it('forwards the output format and provider options into the model input', async () => {
    await provider.initialize({ apiKey: 'r8_audio_key', pollIntervalMs: 1 });

    fetchSpy.mockResolvedValueOnce(mockResponse({
      id: 'pred-music-2',
      status: 'succeeded',
      output: 'https://replicate.delivery/music.wav',
    }));

    const result = await provider.generateMusic({
      prompt: 'Tense strings',
      durationSec: 20,
      outputFormat: 'wav',
      providerOptions: { model_version: 'stereo-large', normalization_strategy: 'peak' },
    });

    expect(result.audio[0].mimeType).toBe('audio/wav');
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.input).toEqual({
      prompt: 'Tense strings',
      duration: 20,
      output_format: 'wav',
      model_version: 'stereo-large',
      normalization_strategy: 'peak',
    });
  });

  it('runs an official model through the model predictions route', async () => {
    await provider.initialize({ apiKey: 'r8_audio_key', pollIntervalMs: 1 });

    fetchSpy.mockResolvedValueOnce(mockResponse({
      id: 'pred-sa-1',
      status: 'succeeded',
      output: 'https://replicate.delivery/ambience.mp3',
    }));

    const result = await provider.generateMusic({
      prompt: 'Rain on a cabin roof, low drone',
      modelId: 'stability-ai/stable-audio-2.5',
      durationSec: 45,
    });

    expect(result.modelId).toBe('stability-ai/stable-audio-2.5');
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.replicate.com/v1/models/stability-ai/stable-audio-2.5/predictions');
    expect(JSON.parse(init.body)).toEqual({
      input: { prompt: 'Rain on a cabin roof, low drone', duration: 45 },
    });
  });

  it('sends a full owner/name:version or a bare version id as given', async () => {
    await provider.initialize({ apiKey: 'r8_audio_key', pollIntervalMs: 1 });
    const done = { id: 'p', status: 'succeeded', output: 'https://replicate.delivery/a.mp3' };
    fetchSpy
      .mockResolvedValueOnce(mockResponse(done))
      .mockResolvedValueOnce(mockResponse(done));

    const custom = `someone/custom-musicgen:${'a'.repeat(64)}`;
    await provider.generateMusic({ prompt: 'x', modelId: custom });
    await provider.generateMusic({ prompt: 'y', modelId: 'b'.repeat(64) });

    expect(fetchSpy.mock.calls[0][0]).toBe('https://api.replicate.com/v1/predictions');
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body).version).toBe(custom);
    expect(fetchSpy.mock.calls[1][0]).toBe('https://api.replicate.com/v1/predictions');
    expect(JSON.parse(fetchSpy.mock.calls[1][1].body).version).toBe('b'.repeat(64));
  });

  it('reports an explicitly versioned model with its version', async () => {
    await provider.initialize({ apiKey: 'r8_audio_key', pollIntervalMs: 1 });
    const done = { id: 'p', status: 'succeeded', output: 'https://replicate.delivery/a.mp3' };
    fetchSpy
      .mockResolvedValueOnce(mockResponse(done))
      .mockResolvedValueOnce(mockResponse(done));

    const custom = `someone/custom-musicgen:${'a'.repeat(64)}`;
    const versioned = await provider.generateMusic({ prompt: 'x', modelId: custom });
    const bare = await provider.generateSFX({ prompt: 'y', modelId: 'b'.repeat(64) });

    expect(versioned.modelId).toBe(custom);
    expect(bare.modelId).toBe('b'.repeat(64));
  });

  it('sends only the wav and mp3 output formats the audio models accept', async () => {
    await provider.initialize({ apiKey: 'r8_audio_key', pollIntervalMs: 1 });
    const done = { id: 'p', status: 'succeeded', output: 'https://replicate.delivery/a.wav' };
    fetchSpy
      .mockResolvedValueOnce(mockResponse(done))
      .mockResolvedValueOnce(mockResponse(done))
      .mockResolvedValueOnce(mockResponse(done));

    // meta/musicgen and sepal/audiogen list output_format as enum ["wav", "mp3"].
    await provider.generateMusic({ prompt: 'a', outputFormat: 'flac' });
    await provider.generateSFX({ prompt: 'b', outputFormat: 'ogg' });
    await provider.generateMusic({ prompt: 'c', outputFormat: 'mp3' });

    expect(JSON.parse(fetchSpy.mock.calls[0][1].body).input).toEqual({ prompt: 'a' });
    expect(JSON.parse(fetchSpy.mock.calls[1][1].body).input).toEqual({ prompt: 'b' });
    expect(JSON.parse(fetchSpy.mock.calls[2][1].body).input).toEqual({ prompt: 'c', output_format: 'mp3' });
  });

  it('keeps the prompt, duration and output format when provider options name the same keys', async () => {
    await provider.initialize({ apiKey: 'r8_audio_key', pollIntervalMs: 1 });

    fetchSpy.mockResolvedValueOnce(mockResponse({
      id: 'pred-music-3',
      status: 'succeeded',
      output: 'https://replicate.delivery/music.wav',
    }));

    await provider.generateMusic({
      prompt: 'Tense strings',
      durationSec: 20,
      outputFormat: 'wav',
      providerOptions: { prompt: 'Polka', duration: 5, output_format: 'mp3', top_k: 250 },
    });

    expect(JSON.parse(fetchSpy.mock.calls[0][1].body).input).toEqual({
      prompt: 'Tense strings',
      duration: 20,
      output_format: 'wav',
      top_k: 250,
    });
  });

  it('sends the seed to the models whose schema takes one', async () => {
    await provider.initialize({ apiKey: 'r8_audio_key', pollIntervalMs: 1 });
    const done = { id: 'p', status: 'succeeded', output: 'https://replicate.delivery/a.wav' };
    fetchSpy
      .mockResolvedValueOnce(mockResponse(done))
      .mockResolvedValueOnce(mockResponse(done))
      .mockResolvedValueOnce(mockResponse(done));

    // meta/musicgen and stability-ai/stable-audio-2.5 list a `seed` input;
    // sepal/audiogen does not.
    await provider.generateMusic({ prompt: 'a', seed: 42 });
    await provider.generateSFX({ prompt: 'b', seed: 42 });
    await provider.generateMusic({ prompt: 'c', seed: 42, modelId: 'stability-ai/stable-audio-2.5' });

    expect(JSON.parse(fetchSpy.mock.calls[0][1].body).input).toEqual({ prompt: 'a', seed: 42 });
    expect(JSON.parse(fetchSpy.mock.calls[1][1].body).input).toEqual({ prompt: 'b' });
    expect(JSON.parse(fetchSpy.mock.calls[2][1].body).input).toEqual({ prompt: 'c', seed: 42 });
  });

  it('maps the output format to the values each known model accepts', async () => {
    await provider.initialize({ apiKey: 'r8_audio_key', pollIntervalMs: 1 });
    const done = { id: 'p', status: 'succeeded', output: 'https://replicate.delivery/a.wav' };
    fetchSpy
      .mockResolvedValueOnce(mockResponse(done))
      .mockResolvedValueOnce(mockResponse(done))
      .mockResolvedValueOnce(mockResponse(done));

    // elevenlabs/music takes mp3_standard, wav_cd_quality and similar values;
    // stability-ai/stable-audio-2.5 has no output_format input.
    await provider.generateMusic({ prompt: 'a', outputFormat: 'wav', modelId: 'elevenlabs/music' });
    await provider.generateMusic({ prompt: 'b', outputFormat: 'mp3', modelId: 'elevenlabs/music' });
    await provider.generateMusic({ prompt: 'c', outputFormat: 'wav', modelId: 'stability-ai/stable-audio-2.5' });

    expect(JSON.parse(fetchSpy.mock.calls[0][1].body).input).toEqual({ prompt: 'a', output_format: 'wav_cd_quality' });
    expect(JSON.parse(fetchSpy.mock.calls[1][1].body).input).toEqual({ prompt: 'b', output_format: 'mp3_standard' });
    expect(JSON.parse(fetchSpy.mock.calls[2][1].body).input).toEqual({ prompt: 'c' });
  });

  it('sends elevenlabs/music its length as music_length_ms', async () => {
    await provider.initialize({ apiKey: 'r8_audio_key', pollIntervalMs: 1 });
    fetchSpy.mockResolvedValueOnce(mockResponse({
      id: 'p',
      status: 'succeeded',
      output: 'https://replicate.delivery/a.mp3',
    }));

    // elevenlabs/music has no `duration` input; it takes `music_length_ms`.
    await provider.generateMusic({ prompt: 'Lo-fi beat', durationSec: 30, modelId: 'elevenlabs/music' });

    expect(JSON.parse(fetchSpy.mock.calls[0][1].body).input).toEqual({
      prompt: 'Lo-fi beat',
      music_length_ms: 30000,
    });
  });

  it('polls a prediction that did not finish inside the wait window', async () => {
    await provider.initialize({ apiKey: 'r8_audio_key', pollIntervalMs: 1 });

    fetchSpy
      .mockResolvedValueOnce(mockResponse({
        id: 'pred-slow',
        status: 'starting',
        urls: { get: 'https://api.replicate.com/v1/predictions/pred-slow' },
      }))
      .mockResolvedValueOnce(mockResponse({ id: 'pred-slow', status: 'processing' }))
      .mockResolvedValueOnce(mockResponse({
        id: 'pred-slow',
        status: 'succeeded',
        output: ['https://replicate.delivery/slow.mp3'],
      }));

    const result = await provider.generateMusic({ prompt: 'Long build' });

    expect(result.audio[0].url).toBe('https://replicate.delivery/slow.mp3');
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(fetchSpy.mock.calls[1][0]).toBe('https://api.replicate.com/v1/predictions/pred-slow');
    expect(fetchSpy.mock.calls[1][1].headers.Authorization).toBe('Bearer r8_audio_key');
  });

  // -------------------------------------------------------------------------
  // SFX generation
  // -------------------------------------------------------------------------

  it('runs SFX on sepal/audiogen with its pinned version', async () => {
    await provider.initialize({ apiKey: 'r8_audio_key', pollIntervalMs: 1 });

    fetchSpy.mockResolvedValueOnce(mockResponse({
      id: 'pred-sfx-1',
      status: 'succeeded',
      output: 'https://replicate.delivery/sfx.wav',
    }));

    const result = await provider.generateSFX({
      prompt: 'Glass shattering',
      durationSec: 3,
    });

    expect(result.audio).toHaveLength(1);
    expect(result.audio[0].url).toBe('https://replicate.delivery/sfx.wav');
    expect(result.audio[0].mimeType).toBe('audio/wav');
    expect(result.modelId).toBe('sepal/audiogen');

    expect(fetchSpy.mock.calls[0][0]).toBe('https://api.replicate.com/v1/predictions');
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body).toEqual({
      version: `sepal/audiogen:${AUDIOGEN_VERSION}`,
      input: { prompt: 'Glass shattering', duration: 3 },
    });
  });

  it('resolves the retired meta/audiogen id to sepal/audiogen', async () => {
    await provider.initialize({
      apiKey: 'r8_audio_key',
      pollIntervalMs: 1,
      defaultSfxModel: 'meta/audiogen',
    });

    fetchSpy.mockResolvedValueOnce(mockResponse({
      id: 'pred-sfx-2',
      status: 'succeeded',
      output: 'https://replicate.delivery/sfx.wav',
    }));

    const result = await provider.generateSFX({ prompt: 'Footsteps on gravel' });

    expect(result.modelId).toBe('sepal/audiogen');
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.version).toBe(`sepal/audiogen:${AUDIOGEN_VERSION}`);
  });

  it('applies a defaultModelId override to both capabilities', async () => {
    await provider.initialize({
      apiKey: 'r8_audio_key',
      pollIntervalMs: 1,
      defaultModelId: 'stability-ai/stable-audio-2.5',
    });
    const done = { id: 'p', status: 'succeeded', output: 'https://replicate.delivery/a.mp3' };
    fetchSpy
      .mockResolvedValueOnce(mockResponse(done))
      .mockResolvedValueOnce(mockResponse(done));

    await provider.generateMusic({ prompt: 'x' });
    await provider.generateSFX({ prompt: 'y' });

    const route = 'https://api.replicate.com/v1/models/stability-ai/stable-audio-2.5/predictions';
    expect(fetchSpy.mock.calls[0][0]).toBe(route);
    expect(fetchSpy.mock.calls[1][0]).toBe(route);
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
    await provider.initialize({ apiKey: 'r8_key', pollIntervalMs: 1 });

    fetchSpy.mockResolvedValueOnce(mockResponse({ detail: 'unauthorized' }, false, 401));

    await expect(
      provider.generateMusic({ prompt: 'test' }),
    ).rejects.toThrow(/submission failed \(401\)/);
  });

  it('should throw when the prediction fails', async () => {
    await provider.initialize({ apiKey: 'r8_key', pollIntervalMs: 1 });

    fetchSpy.mockResolvedValueOnce(mockResponse({
      id: 'pred-bad',
      status: 'failed',
      error: 'CUDA out of memory',
    }));

    await expect(
      provider.generateSFX({ prompt: 'test' }),
    ).rejects.toThrow(/CUDA out of memory/);
  });
});
