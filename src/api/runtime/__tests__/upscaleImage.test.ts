/**
 * @file upscaleImage.test.ts
 * Tests for the high-level upscaleImage API covering 2x and 4x upscaling,
 * target dimensions, and unsupported-provider errors.
 *
 * All tests mock `globalThis.fetch` — no real API calls are made.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { upscaleImage } from '../upscaleImage.js';
import { ImageUpscaleNotSupportedError } from '../../../io/media/images/ImageOperationError.js';

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

describe('upscaleImage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('upscales via the Stability fast upscaler, which takes the image alone', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          image: 'dXBzY2FsZWQ=',
          seed: 1,
          finish_reason: 'SUCCESS',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const result = await upscaleImage({
      provider: 'stability',
      image: TINY_PNG,
      scale: 2,
      width: 3840,
      height: 2160,
      apiKey: 'stab-key',
    });

    // The conservative and creative upscalers require a prompt, and no
    // Stability upscaler takes a target size: the fast one gets the image.
    const [url, requestInit] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(String(url)).toMatch(/\/v2beta\/stable-image\/upscale\/fast$/);
    const formData = requestInit?.body as FormData;
    const fields: string[] = [];
    formData.forEach((_value, name) => fields.push(name));
    expect(fields).toEqual(['image']);
    expect(formData.get('image')).toBeInstanceOf(Blob);

    expect(result.provider).toBe('stability');
    expect(result.model).toBe('stable-image-upscale-fast');
    expect(result.image).toMatchObject({
      mimeType: 'image/png',
      base64: 'dXBzY2FsZWQ=',
    });
  });

  it('throws ImageUpscaleNotSupportedError for providers without upscaleImage', async () => {
    // OpenAI does not implement upscaleImage.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    await expect(
      upscaleImage({
        model: 'openai:gpt-image-1',
        image: TINY_PNG,
        scale: 2,
        apiKey: 'test-key',
      }),
    ).rejects.toThrow(ImageUpscaleNotSupportedError);
  });

  it('upscales via the Stable Diffusion local provider extras endpoint', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : (url as Request).url;

      if (urlStr.includes('/sdapi/v1/sd-models')) {
        return new Response(
          JSON.stringify([{ model_name: 'sd-v1-5', title: 'sd-v1-5', filename: 'sd.safetensors' }]),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (urlStr.includes('/sdapi/v1/extra-single-image')) {
        return new Response(
          JSON.stringify({ image: 'ZXh0cmFz', html_info: '' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('Not Found', { status: 404 });
    });

    const result = await upscaleImage({
      model: 'stable-diffusion-local:sd-v1-5',
      image: TINY_PNG,
      scale: 4,
      baseUrl: 'http://localhost:7860',
    });

    expect(result.provider).toBe('stable-diffusion-local');
    expect(result.image.base64).toBe('ZXh0cmFz');

    // Verify extras endpoint was called with correct scale.
    const calls = vi.mocked(globalThis.fetch).mock.calls;
    const extrasCall = calls.find((c) => String(c[0]).includes('/sdapi/v1/extra-single-image'));
    expect(extrasCall).toBeDefined();

    const body = JSON.parse(String((extrasCall![1] as RequestInit).body));
    expect(body.upscaling_resize).toBe(4);
  });

  it('upscales via the Replicate provider with real-esrgan', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'succeeded',
          output: ['https://replicate.delivery/upscaled.png'],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const result = await upscaleImage({
      model: 'replicate:nightmareai/real-esrgan',
      image: TINY_PNG,
      scale: 4,
      apiKey: 'replicate-token',
    });

    const [, requestInit] = vi.mocked(globalThis.fetch).mock.calls[0];
    const body = JSON.parse(String(requestInit?.body));
    expect(body.input.scale).toBe(4);

    expect(result.provider).toBe('replicate');
    expect(result.image.url).toBe('https://replicate.delivery/upscaled.png');
  });
});
