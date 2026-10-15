/**
 * @file image-operation-default-models.e2e.test.ts
 * A call that names a provider and no model runs each image operation on the
 * provider's own default for that operation, not on the provider's
 * text-to-image default.
 *
 * Drives editImage, upscaleImage, variateImage and transferStyle through the
 * real provider classes; only fetch is stubbed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { editImage } from '../editImage.js';
import { generateImage } from '../generateImage.js';
import { transferStyle } from '../../transferStyle.js';
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
    vi.unstubAllEnvs();
  });

  it('generates on OpenAI with GPT Image 2.5 Flare, and sends DALL·E 3 settings as that model takes them', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => json({ created: 1, data: [{ b64_json: 'Z2Vu' }] }));

    const result = await generateImage({
      provider: 'openai',
      apiKey: 'sk-openai',
      prompt: 'A lighthouse at dusk.',
      size: '1792x1024',
      quality: 'hd',
      providerOptions: { openai: { style: 'vivid' } },
    });

    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toMatch(/\/images\/generations$/);
    const body = JSON.parse(String(init?.body));
    // OpenAI retired the DALL·E models and retires gpt-image-1 on 2026-10-23.
    expect(body.model).toBe('gpt-image-2.5-flare');
    // `hd` was DALL·E 3's name for `high`, and `style` was DALL·E 3's alone.
    expect(body.quality).toBe('high');
    expect(body).not.toHaveProperty('style');
    expect(body.size).toBe('1792x1024');
    expect(result.model).toBe('gpt-image-2.5-flare');
  });

  it('keeps the quality and the style a call gives a model that is not a GPT Image model', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => json({ created: 1, data: [{ url: 'https://images.example/out.png' }] }));

    await generateImage({
      provider: 'openai',
      model: 'gateway-image-model',
      apiKey: 'sk-gateway',
      baseUrl: 'https://gateway.example/v1',
      prompt: 'A lighthouse at dusk.',
      quality: 'hd',
      providerOptions: { openai: { style: 'natural' } },
    });

    const body = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body));
    expect(body).toMatchObject({ model: 'gateway-image-model', quality: 'hd', style: 'natural' });
  });

  it('edits and transfers a style on OpenAI with GPT Image 2.5 Sunburst', async () => {
    for (const name of ['REPLICATE_API_TOKEN', 'FAL_API_KEY', 'STABILITY_API_KEY']) vi.stubEnv(name, '');
    vi.stubEnv('OPENAI_API_KEY', 'sk-openai-env');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => json({ created: 1, data: [{ b64_json: 'ZWRpdA==' }] }));

    const style = { image: TINY_PNG, styleReference: TINY_PNG, prompt: 'In the style of the reference.' };
    const edited = await editImage({ provider: 'openai', apiKey: 'sk-openai', image: TINY_PNG, prompt: 'Add a hat.' });
    const named = await transferStyle({ provider: 'openai', apiKey: 'sk-openai', ...style });
    // With no provider named, style transfer walks its own list, and OpenAI
    // is the one with a key here.
    const found = await transferStyle(style);

    for (const [url, init] of fetchSpy.mock.calls) {
      expect(String(url)).toMatch(/\/images\/edits$/);
      expect((init?.body as FormData).get('model')).toBe('gpt-image-2.5-sunburst');
    }
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    // The edit sends one image; each style transfer sends the source and the reference.
    expect((fetchSpy.mock.calls[0][1]?.body as FormData).getAll('image')).toHaveLength(1);
    for (const [, init] of fetchSpy.mock.calls.slice(1)) {
      expect((init?.body as FormData).getAll('image[]')).toHaveLength(2);
    }
    for (const result of [edited, named, found]) expect(result.model).toBe('gpt-image-2.5-sunburst');
  });

  it('transfers a style on the Stability style-transfer endpoint, the provider named or found in the environment', async () => {
    for (const name of ['REPLICATE_API_TOKEN', 'FAL_API_KEY', 'OPENAI_API_KEY']) vi.stubEnv(name, '');
    vi.stubEnv('STABILITY_API_KEY', 'sk-stab-env');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => json({ image: 'c3R5bGVk', seed: 1, finish_reason: 'SUCCESS' }));

    const style = { image: TINY_PNG, styleReference: TINY_PNG, prompt: 'In the style of the reference.' };
    const named = await transferStyle({ provider: 'stability', apiKey: 'sk-stab', ...style });
    const found = await transferStyle(style);

    // The style-transfer endpoint takes the source and the reference, and no
    // model: the result reports the endpoint's id.
    for (const [url, init] of fetchSpy.mock.calls) {
      expect(String(url)).toMatch(/\/v2beta\/stable-image\/control\/style-transfer$/);
      const form = init?.body as FormData;
      expect(form.get('init_image')).toBeInstanceOf(Blob);
      expect(form.get('style_image')).toBeInstanceOf(Blob);
      expect(form.has('model')).toBe(false);
    }
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    for (const result of [named, found]) expect(result.model).toBe('stable-image-style-transfer');
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

  it("edits on Fal's Flux Dev image-to-image endpoint, and inpaints on its inpainting endpoint", async () => {
    // Fal's queue: the submit, the status, then the result.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/status')) return json({ status: 'COMPLETED' });
      if (/\/requests\/r\d$/.test(url)) return json({ images: [{ url: 'https://fal.media/out.png' }], seed: 7 });
      return json({ request_id: url.includes('inpainting') ? 'r2' : 'r1' });
    });

    const edited = await editImage({ provider: 'fal', apiKey: 'fal-key', image: TINY_PNG, prompt: 'Warmer light.', strength: 0.6 });
    const inpainted = await editImage({ provider: 'fal', apiKey: 'fal-key', image: TINY_PNG, mask: TINY_PNG, prompt: 'Fill with sky.' });

    const submits = fetchSpy.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(String(submits[0][0])).toBe('https://queue.fal.run/fal-ai/flux/dev/image-to-image');
    const img2img = JSON.parse(String(submits[0][1]?.body));
    expect(img2img).toMatchObject({ prompt: 'Warmer light.', strength: 0.6 });
    expect(img2img.image_url).toBe(`data:image/png;base64,${TINY_PNG.toString('base64')}`);
    expect(img2img).not.toHaveProperty('image');
    expect(edited.model).toBe('fal-ai/flux/dev/image-to-image');

    expect(String(submits[1][0])).toBe('https://queue.fal.run/fal-ai/flux-lora/inpainting');
    const inpaint = JSON.parse(String(submits[1][1]?.body));
    expect(inpaint.mask_url).toBe(`data:image/png;base64,${TINY_PNG.toString('base64')}`);
    expect(inpaint).not.toHaveProperty('mask');
    expect(inpainted.model).toBe('fal-ai/flux-lora/inpainting');
  });

  it('generates a Flux Redux variation from its reference as redux_image, with no prompt', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => replicateDone());

    await generateImage({
      provider: 'replicate',
      model: 'black-forest-labs/flux-redux-dev',
      apiKey: 'r8-key',
      prompt: 'A variation.',
      referenceImageUrl: 'https://images.example/reference.png',
    });

    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe('https://api.replicate.com/v1/models/black-forest-labs/flux-redux-dev/predictions');
    const { input } = JSON.parse(String(init?.body));
    expect(input.redux_image).toBe('https://images.example/reference.png');
    expect(input).not.toHaveProperty('prompt');
    expect(input).not.toHaveProperty('image');
  });

  it('edits on Stability in the SD3 route\'s image-to-image mode, with an SD3 model', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => json({ image: 'ZWRpdA==', seed: 1, finish_reason: 'SUCCESS' }));

    const result = await editImage({
      provider: 'stability',
      apiKey: 'sk-stab',
      image: TINY_PNG,
      prompt: 'Turn it into a watercolor painting.',
      strength: 0.4,
    });

    // The route's image and strength are valid only with mode=image-to-image,
    // and its model is an SD3 one, not the provider's text-to-image default.
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toMatch(/\/v2beta\/stable-image\/generate\/sd3$/);
    const form = init?.body as FormData;
    expect(form.get('mode')).toBe('image-to-image');
    expect(form.get('model')).toBe('sd3.5-medium');
    expect(form.get('strength')).toBe('0.4');
    expect(form.get('image')).toBeInstanceOf(Blob);
    expect(result.model).toBe('sd3.5-medium');
  });

  it('inpaints on Stability at the inpaint endpoint, with the mask as `mask`', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => json({ image: 'aW5wYWludA==', seed: 1, finish_reason: 'SUCCESS' }));

    await editImage({
      provider: 'stability',
      apiKey: 'sk-stab',
      image: TINY_PNG,
      mask: TINY_PNG,
      prompt: 'Fill the gap with sky.',
      strength: 0.4,
    });

    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toMatch(/\/v2beta\/stable-image\/edit\/inpaint$/);
    const form = init?.body as FormData;
    expect(form.get('mask')).toBeInstanceOf(Blob);
    // The inpaint endpoint takes no model, mode or strength.
    const fields: string[] = [];
    form.forEach((_value, name) => fields.push(name));
    expect(fields.sort()).toEqual(['image', 'mask', 'prompt']);
  });

  it('edits on a local A1111 with the checkpoint it has loaded, and reports that checkpoint', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
      String(url).endsWith('/sdapi/v1/sd-models')
        ? json([{ title: 'dreamshaper-8.safetensors', model_name: 'dreamshaper-8' }])
        : json({ images: ['ZWRpdA=='] }),
    );

    const result = await editImage({
      provider: 'stable-diffusion-local',
      baseUrl: 'http://127.0.0.1:7860',
      image: TINY_PNG,
      prompt: 'Turn it into a watercolor painting.',
    });

    // No checkpoint override: the provider's text-to-image default
    // (v1-5-pruned-emaonly) is a checkpoint this server may not have.
    const edit = fetchSpy.mock.calls.find(([url]) => String(url).endsWith('/sdapi/v1/img2img'));
    expect(JSON.parse(String(edit?.[1]?.body)).override_settings).toBeUndefined();
    expect(result.model).toBe('dreamshaper-8');
  });

  it('reports the checkpoint a local A1111 says it rendered with, when that is not the first one it lists', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
      String(url).endsWith('/sdapi/v1/sd-models')
        ? json([
            { title: 'v1-5-pruned-emaonly.safetensors', model_name: 'v1-5-pruned-emaonly' },
            { title: 'dreamshaper-8.safetensors', model_name: 'dreamshaper-8' },
          ])
        : json({ images: ['ZWRpdA=='], parameters: {}, info: JSON.stringify({ sd_model_name: 'dreamshaper-8', seed: 1 }) }),
    );

    const edited = await editImage({
      provider: 'stable-diffusion-local',
      baseUrl: 'http://127.0.0.1:7860',
      image: TINY_PNG,
      prompt: 'Turn it into a watercolor painting.',
    });

    expect(edited.model).toBe('dreamshaper-8');
  });

  it('makes a close variation on OpenAI when the variance is low', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => json({ created: 1, data: [{ b64_json: 'dmFy' }] }));

    const result = await variateImage({ provider: 'openai', apiKey: 'sk-openai', image: TINY_PNG, variance: 0.2 });

    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toMatch(/\/images\/edits$/);
    const form = init?.body as FormData;
    expect(form.get('model')).toBe('gpt-image-2.5-sunburst');
    expect(String(form.get('prompt'))).toContain('close variation');
    expect(result.model).toBe('gpt-image-2.5-sunburst');
    expect(result.images).toHaveLength(1);
  });

  it('keeps a model the call names', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => replicateDone());
    const pinned = `acme/upscaler:${'a'.repeat(64)}`;

    await upscaleImage({ model: `replicate:${pinned}`, apiKey: 'r8-key', image: TINY_PNG });

    expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body)).version).toBe(pinned);
  });
});

describe("an image operation's own key goes only to a provider the call names", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('refuses a key with no provider, which detection would hand to the first image vendor in the environment', async () => {
    vi.stubEnv('REPLICATE_API_TOKEN', 'r8-env-token');
    vi.stubEnv('OPENAI_API_KEY', '');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => replicateDone());
    const tenantKey = { apiKey: 'sk-tenant-openai' };

    await expect(generateImage({ ...tenantKey, prompt: 'A lighthouse at dusk.' })).rejects.toThrow(
      'an apiKey or baseUrl needs provider',
    );
    await expect(editImage({ ...tenantKey, image: TINY_PNG, prompt: 'Add a hat.' })).rejects.toThrow('needs provider');
    await expect(upscaleImage({ ...tenantKey, image: TINY_PNG })).rejects.toThrow('needs provider');
    await expect(variateImage({ ...tenantKey, image: TINY_PNG })).rejects.toThrow('needs provider');
    // A model with no provider prefix is still left to detection.
    await expect(editImage({ ...tenantKey, model: 'gpt-image-2.5-sunburst', image: TINY_PNG, prompt: 'x' })).rejects.toThrow(
      'needs provider',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends a mature-tier call the policy routes to another provider on that provider's own key", async () => {
    const { setDefaultProvider, clearDefaultProvider } = await import('../global-default.js');
    vi.stubEnv('REPLICATE_API_TOKEN', 'r8-env-token');
    setDefaultProvider({ provider: 'openai' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => replicateDone());
    try {
      // The default names OpenAI, so the tenant key passes; the policy router then picks Replicate.
      await generateImage({ apiKey: 'sk-tenant-openai', prompt: 'A lighthouse at dusk.', policyTier: 'mature' });
      await editImage({ apiKey: 'sk-tenant-openai', image: TINY_PNG, prompt: 'Add a hat.', policyTier: 'mature' });
    } finally {
      clearDefaultProvider();
    }

    const replicateCalls = fetchSpy.mock.calls.filter(([url]) => String(url).startsWith('https://api.replicate.com/'));
    expect(replicateCalls.length).toBeGreaterThanOrEqual(2);
    for (const [, init] of replicateCalls) {
      const authorization = new Headers(init?.headers).get('authorization') ?? '';
      expect(authorization).toContain('r8-env-token');
      expect(authorization).not.toContain('sk-tenant-openai');
    }
  });

  it("refuses a key whose provider and model prefix differ, since the prefix would take the key", async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => replicateDone());

    await expect(
      upscaleImage({ provider: 'openai', model: 'replicate:nightmareai/real-esrgan', apiKey: 'sk-openai-key', image: TINY_PNG }),
    ).rejects.toThrow("names provider 'replicate', not 'openai'");
    await expect(
      editImage({ provider: 'openai', model: 'stability:sd3', apiKey: 'sk-openai-key', image: TINY_PNG, prompt: 'x' }),
    ).rejects.toThrow("names provider 'stability', not 'openai'");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
