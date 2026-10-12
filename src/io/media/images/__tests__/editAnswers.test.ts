/**
 * @file editAnswers.test.ts
 * What the image providers' edits send and accept: each image part goes with
 * its own type, and an answer that holds no image, a canceled prediction or
 * one that runs with no URL to poll fails instead of counting as a result.
 * `fetch` is stubbed: no API is called.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FalImageProvider } from '../providers/FalImageProvider.js';
import { OpenAIImageProvider } from '../providers/OpenAIImageProvider.js';
import { ReplicateImageProvider } from '../providers/ReplicateImageProvider.js';
import { StabilityImageProvider } from '../providers/StabilityImageProvider.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** The multipart body of the fetch call at `index`. */
const formAt = (spy: { mock: { calls: unknown[][] } }, index = 0) =>
  (spy.mock.calls[index][1] as RequestInit | undefined)?.body as FormData;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OpenAI edits', () => {
  async function provider() {
    const openai = new OpenAIImageProvider();
    await openai.initialize({ apiKey: 'sk-openai' });
    return openai;
  }

  it('sends a JPEG source as a JPEG part', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ created: 1, data: [{ b64_json: 'b3V0' }] }));

    await (await provider()).editImage({ modelId: '', image: JPEG, prompt: 'Add a hat.' });

    const part = formAt(spy).get('image') as File;
    expect(part.type).toBe('image/jpeg');
    expect(part.name).toBe('image.jpg');
  });

  it('fails on an answer with no image instead of returning none', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ created: 1, data: [] }));

    await expect((await provider()).editImage({ modelId: '', image: PNG, prompt: 'Add a hat.' })).rejects.toThrow(
      'OpenAI image edit returned no image.',
    );
  });
});

describe('Replicate predictions', () => {
  async function provider() {
    const replicate = new ReplicateImageProvider();
    await replicate.initialize({ apiKey: 'r8-key' });
    return replicate;
  }

  it('fails on a canceled edit, whatever output it carries', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json({ id: 'p1', status: 'canceled', output: ['https://replicate.delivery/partial.png'] }, 201),
    );

    await expect(
      (await provider()).editImage({ modelId: 'black-forest-labs/flux-kontext-pro', image: PNG, prompt: 'x' }),
    ).rejects.toThrow('Replicate image edit was canceled.');
  });

  it('fails on a prediction still running that gives no URL to poll', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ id: 'p2', status: 'starting', output: null }, 201));

    await expect(
      (await provider()).editImage({ modelId: 'black-forest-labs/flux-kontext-pro', image: PNG, prompt: 'x' }),
    ).rejects.toThrow('Replicate image edit is starting and gave no URL to poll.');
  });

  it('fails on a canceled upscale and on a generation that ends without a status', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ id: 'p3', status: 'canceled', output: ['https://replicate.delivery/up.png'] }, 201))
      .mockResolvedValueOnce(json({ id: 'p4', output: ['https://replicate.delivery/gen.png'] }, 201));
    const replicate = await provider();

    await expect(replicate.upscaleImage({ modelId: '', image: PNG, scale: 2 })).rejects.toThrow(
      'Replicate image upscale was canceled.',
    );
    await expect(replicate.generateImage({ prompt: 'a lighthouse' })).rejects.toThrow(
      'Replicate image generation ended without a status.',
    );
  });
});

describe('Stability edits', () => {
  async function provider() {
    const stability = new StabilityImageProvider();
    await stability.initialize({ apiKey: 'sk-stab' });
    return stability;
  }

  it('sends a JPEG source as a JPEG part', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ image: 'b3V0', seed: 1 }));

    await (await provider()).editImage({ modelId: '', image: JPEG, prompt: 'x' });

    const part = formAt(spy).get('image') as File;
    expect(part.type).toBe('image/jpeg');
    expect(part.name).toBe('image.jpg');
  });

  it('fails on an answer of zero bytes, for an edit and for an upscale', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response(new Uint8Array(0), { status: 200, headers: { 'Content-Type': 'image/png' } }),
    );
    const stability = await provider();

    await expect(stability.editImage({ modelId: '', image: PNG, prompt: 'x' })).rejects.toThrow(
      'Stability returned no image data.',
    );
    await expect(stability.upscaleImage({ modelId: '', image: PNG })).rejects.toThrow('Stability returned no image data.');
  });
});

describe('Fal edits', () => {
  it('fails on a result whose images have no URL', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/status')) return json({ status: 'COMPLETED' });
      if (url.endsWith('/requests/r1')) return json({ images: [{ url: '' }], seed: 1 });
      return json({ request_id: 'r1' });
    });
    const fal = new FalImageProvider();
    await fal.initialize({ apiKey: 'fal-key' });

    await expect(fal.editImage({ modelId: '', image: PNG, prompt: 'x' })).rejects.toThrow(
      'Fal.ai edit completed but returned no images.',
    );
  });
});
