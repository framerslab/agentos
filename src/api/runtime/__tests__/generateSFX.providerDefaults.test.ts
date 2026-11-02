/**
 * @module api/runtime/__tests__/generateSFX.providerDefaults.test
 *
 * Drives {@link generateSFX} through the real Replicate and fal audio
 * providers with `fetch` stubbed, to prove that a call without `model` lands
 * on each provider's SFX model rather than the music model the provider
 * reports as its `defaultModelId`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { generateSFX } from '../../generateSFX.js';

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('generateSFX provider defaults', () => {
  const originalFetch = globalThis.fetch;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    for (const key of ['ELEVENLABS_API_KEY', 'STABILITY_API_KEY', 'REPLICATE_API_TOKEN', 'FAL_API_KEY']) {
      vi.stubEnv(key, '');
    }
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it('runs Replicate SFX on the audiogen model when no model is given', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({
      id: 'pred-1',
      status: 'succeeded',
      output: 'https://replicate.delivery/door.wav',
    }));

    const result = await generateSFX({
      provider: 'replicate-audio',
      apiKey: 'r8_test',
      prompt: 'Heavy door slam',
      durationSec: 2,
      providerPreferences: { blocked: ['audiogen-local'] },
    });

    expect(result.audio[0]?.url).toBe('https://replicate.delivery/door.wav');
    expect(result.model).toBe('sepal/audiogen');
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.version).toMatch(/^sepal\/audiogen:[0-9a-f]{64}$/);
  });

  it('runs fal SFX on fal-ai/stable-audio when no model is given', async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ request_id: 'req-1' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'COMPLETED' }))
      .mockResolvedValueOnce(jsonResponse({ audio_file: { url: 'https://v3.fal.media/files/s.wav' } }));

    const result = await generateSFX({
      provider: 'fal-audio',
      apiKey: 'fal_test',
      prompt: 'Thunder crack',
      durationSec: 4,
      providerPreferences: { blocked: ['audiogen-local'] },
    });

    expect(result.audio[0]?.url).toBe('https://v3.fal.media/files/s.wav');
    expect(result.model).toBe('fal-ai/stable-audio');
    expect(fetchSpy.mock.calls[0][0]).toBe('https://queue.fal.run/fal-ai/stable-audio');
  });
});
