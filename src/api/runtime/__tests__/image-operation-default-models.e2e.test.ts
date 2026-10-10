/**
 * @file image-operation-default-models.e2e.test.ts
 * A call that names a provider and no model runs each image operation on the
 * provider's own default for that operation, not on the provider's
 * text-to-image default.
 *
 * Drives editImage, upscaleImage and variateImage through the real provider
 * classes; only fetch is stubbed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { editImage } from '../editImage.js';
import { upscaleImage } from '../upscaleImage.js';
import { variateImage } from '../variateImage.js';

/** A minimal 1x1 PNG as a Buffer. */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

/** A finished Replicate prediction. */
const replicateDone = () => json({ id: 'p1', status: 'succeeded', output: ['https://replicate.delivery/out.png'] });

describe('an image operation with a provider and no model', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('upscales on Replicate with real-esrgan, not its text-to-image model', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => replicateDone());

    const result = await upscaleImage({ provider: 'replicate', apiKey: 'r8-key', image: TINY_PNG, scale: 4 });

    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe('https://api.replicate.com/v1/predictions');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      version: 'nightmareai/real-esrgan',
      input: { scale: 4 },
    });
    expect(result.model).toBe('nightmareai/real-esrgan');
  });

  it('edits on Replicate with SDXL pinned to a version, and inpaints with flux-fill-pro', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => replicateDone());

    await editImage({
      provider: 'replicate',
      apiKey: 'r8-key',
      image: TINY_PNG,
      prompt: 'Turn it into a watercolor painting.',
      strength: 0.6,
    });
    await editImage({
      provider: 'replicate',
      apiKey: 'r8-key',
      image: TINY_PNG,
      mask: TINY_PNG,
      prompt: 'Fill the gap with sky.',
      mode: 'inpaint',
    });

    // SDXL is not an official Replicate model, so it runs only by version.
    const [img2imgUrl, img2imgInit] = fetchSpy.mock.calls[0];
    expect(String(img2imgUrl)).toBe('https://api.replicate.com/v1/predictions');
    const img2img = JSON.parse(String(img2imgInit?.body));
    expect(img2img.version).toMatch(/^stability-ai\/sdxl:[0-9a-f]{64}$/);
    expect(img2img.input.prompt_strength).toBe(0.6);
    expect(img2img.input.strength).toBeUndefined();

    const [inpaintUrl, inpaintInit] = fetchSpy.mock.calls[1];
    expect(String(inpaintUrl)).toBe('https://api.replicate.com/v1/models/black-forest-labs/flux-fill-pro/predictions');
    expect(JSON.parse(String(inpaintInit?.body)).input.mask).toContain('data:image/png;base64,');
  });

  it('edits on Stability with its SD3 model, not its text-to-image model', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => json({ image: 'ZWRpdA==', seed: 1, finish_reason: 'SUCCESS' }));

    await editImage({
      provider: 'stability',
      apiKey: 'sk-stab',
      image: TINY_PNG,
      prompt: 'Turn it into a watercolor painting.',
    });

    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain('/v2beta/stable-image/generate/sd3');
    expect((init?.body as FormData).get('model')).toBe('sd3-medium');
  });

  it('makes a close variation on OpenAI when the variance is low', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => json({ created: 1, data: [{ b64_json: 'dmFy' }] }));

    const result = await variateImage({ provider: 'openai', apiKey: 'sk-openai', image: TINY_PNG, variance: 0.2 });

    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toMatch(/\/images\/edits$/);
    const form = init?.body as FormData;
    expect(form.get('model')).toBe('gpt-image-1');
    expect(String(form.get('prompt'))).toContain('close variation');
    expect(result.model).toBe('gpt-image-1');
    expect(result.images).toHaveLength(1);
  });

  it('keeps a model the call names', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => replicateDone());
    const pinned = `acme/upscaler:${'a'.repeat(64)}`;

    await upscaleImage({ model: `replicate:${pinned}`, apiKey: 'r8-key', image: TINY_PNG });

    expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body)).version).toBe(pinned);
  });
});
