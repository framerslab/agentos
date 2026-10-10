/**
 * @file variateImage.test.ts
 * Tests for the high-level variateImage API covering native variation
 * support (OpenAI), img2img-based fallback, and variance parameter mapping.
 *
 * All tests mock `globalThis.fetch` — no real API calls are made.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { variateImage } from '../variateImage.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A minimal 1x1 PNG as a Buffer. */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('variateImage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates N variations through the OpenAI edits endpoint, with a GPT image model and a variation prompt', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          created: 400,
          data: [
            { b64_json: 'dmFyMQ==' },
            { b64_json: 'dmFyMg==' },
            { b64_json: 'dmFyMw==' },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const result = await variateImage({
      provider: 'openai',
      image: TINY_PNG,
      n: 3,
      apiKey: 'test-key',
    });

    // OpenAI retired /images/variations: a variation is an edit by a GPT
    // image model whose prompt asks for one.
    const [url, requestInit] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(String(url)).toMatch(/\/images\/edits$/);
    const form = requestInit?.body as FormData;
    expect(form.get('model')).toBe('gpt-image-1');
    expect(String(form.get('prompt'))).toContain('variation of this image');
    expect(form.get('n')).toBe('3');
    expect(form.get('image')).toBeInstanceOf(Blob);

    expect(result.provider).toBe('openai');
    expect(result.images).toHaveLength(3);
    expect(result.images[0].base64).toBe('dmFyMQ==');
    expect(result.images[1].base64).toBe('dmFyMg==');
    expect(result.images[2].base64).toBe('dmFyMw==');
  });

  it('maps the variance parameter to strength for Stability img2img fallback', async () => {
    // Stability does not have a native variateImage method, so the high-level
    // API should fall back to editImage with strength = variance.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          image: 'dmFyaWF0aW9u',
          seed: 55,
          finish_reason: 'SUCCESS',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const result = await variateImage({
      model: 'stability:sd3-medium',
      image: TINY_PNG,
      variance: 0.3,
      apiKey: 'stab-key',
    });

    // The fallback uses the editImage path which calls the SD3 endpoint.
    const [url, requestInit] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(String(url)).toContain('/v2beta/stable-image/generate/sd3');

    const formData = requestInit?.body as FormData;
    // Variance should be forwarded as strength.
    expect(formData.get('strength')).toBe('0.3');

    expect(result.provider).toBe('stability');
    expect(result.images).toHaveLength(1);
  });

  it('falls back to img2img for the Stable Diffusion local provider', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : (url as Request).url;

      if (urlStr.includes('/sdapi/v1/sd-models')) {
        return new Response(
          JSON.stringify([{ model_name: 'sd-v1-5', title: 'sd-v1-5', filename: 'sd.safetensors' }]),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (urlStr.includes('/sdapi/v1/img2img')) {
        return new Response(
          JSON.stringify({
            images: ['dmFyMQ==', 'dmFyMg=='],
            parameters: {},
            info: '{}',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('Not Found', { status: 404 });
    });

    const result = await variateImage({
      model: 'stable-diffusion-local:sd-v1-5',
      image: TINY_PNG,
      n: 2,
      variance: 0.4,
      baseUrl: 'http://localhost:7860',
    });

    expect(result.provider).toBe('stable-diffusion-local');
    expect(result.images).toHaveLength(2);

    // Verify the img2img endpoint was used with low denoising_strength.
    const calls = vi.mocked(globalThis.fetch).mock.calls;
    const img2imgCall = calls.find((c) => String(c[0]).includes('/sdapi/v1/img2img'));
    expect(img2imgCall).toBeDefined();

    const body = JSON.parse(String((img2imgCall![1] as RequestInit).body));
    // Variance 0.4 maps to denoising_strength 0.4.
    expect(body.denoising_strength).toBe(0.4);
  });

  it('uses default variance of 0.5 when not specified', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          image: 'ZGVmYXVsdA==',
          seed: 1,
          finish_reason: 'SUCCESS',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await variateImage({
      model: 'stability:sd3-medium',
      image: TINY_PNG,
      apiKey: 'stab-key',
    });

    const [, requestInit] = vi.mocked(globalThis.fetch).mock.calls[0];
    const formData = requestInit?.body as FormData;
    // Default variance 0.5 forwarded as strength.
    expect(formData.get('strength')).toBe('0.5');
  });
});
