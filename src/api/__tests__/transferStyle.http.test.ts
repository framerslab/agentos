/**
 * @file transferStyle.http.test.ts
 * transferStyle through the real provider classes and fetch, against a local
 * server that answers as Replicate, Fal, Stability and OpenAI. Each case
 * checks the requests the call sent (method, path, headers and body), and
 * that it reached nothing but the server: a request no case expects is
 * answered 404 and fails the case, and a URL outside the server is refused.
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { deflateSync } from 'node:zlib';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { transferStyle, type TransferStyleOptions } from '../transferStyle.js';
import { clearDefaultProvider, setDefaultProvider } from '../runtime/global-default.js';
import { registerImageProviderFactory, unregisterImageProviderFactory } from '../../io/media/images/index.js';
import { ReplicateImageProvider } from '../../io/media/images/providers/ReplicateImageProvider.js';
import { bufferToBlobPart } from '../../io/media/images/blobPart.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** CRC-32 of a PNG chunk's type and data (ISO 3309, as PNG uses it). */
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** One PNG chunk: its length, type, data and CRC. */
function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A 64×64 RGB PNG of one colour: Stability's smallest side is 64 px. */
function solidPng(red: number, green: number, blue: number): Buffer {
  const side = 64;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(side, 0);
  header.writeUInt32BE(side, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  const rowBytes = side * 3 + 1;
  const pixels = Buffer.alloc(rowBytes * side);
  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) pixels.set([red, green, blue], y * rowBytes + 1 + x * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The source: a 64×64 PNG. */
const SOURCE = solidPng(200, 40, 40);
// The other formats are read by their signature alone, and the server decodes nothing.
const STYLE_JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('a JPEG style reference')]);
const STYLE_WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x20, 0, 0, 0]), Buffer.from('WEBPVP8 a WebP style')]);
const GIF = Buffer.from('GIF89a, a GIF image');
const UNKNOWN = Buffer.from('these bytes are not an image');

const dataUrl = (type: string, bytes: Buffer) => `data:${type};base64,${bytes.toString('base64')}`;

/** What OpenAI is told, by strength, before the caller's prompt. */
const OPENAI_FULL =
  "Restyle the first image in the style of the second image: keep the first image's subject, composition and pose, and take the second image's palette, brushwork, texture, lighting and medium.";
const OPENAI_LIGHT =
  "Restyle the first image lightly after the second image: keep the first image's subject, composition, pose and most of its own colours, and take the second image's texture, brushwork and lighting.";
/** What FLUX.2 is told at the default strength. */
const FLUX_FULL =
  "Restyle image 1 in the style of image 2: keep image 1's subject, composition and pose, and take image 2's palette, brushwork, texture, lighting and medium.";

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

interface Received {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

type Answer = { status?: number; type?: string; body: string | Buffer };

/** Every request the server received in the current case, in order. */
const received: Received[] = [];
/** The requests no route answered. */
const unexpected: string[] = [];
/** The URLs the call tried outside the server. */
const outside: string[] = [];
/** The current case's answers, by `METHOD /path`. */
let routes: Record<string, (request: Received) => Answer> = {};

let server: http.Server;
let origin: string;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', origin);
      const request: Received = { method: req.method ?? '', path: url.pathname, headers: req.headers, body: Buffer.concat(chunks) };
      received.push(request);
      const route = routes[`${request.method} ${request.path}`];
      if (!route) {
        unexpected.push(`${request.method} ${request.path}`);
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":"no such route in this case"}');
        return;
      }
      const answer = route(request);
      res.writeHead(answer.status ?? 200, { 'content-type': answer.type ?? 'application/json' });
      res.end(answer.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** The keys and base URLs the image providers read from the environment. */
const PROVIDER_ENV = [
  'REPLICATE_API_TOKEN',
  'FAL_API_KEY',
  'STABILITY_API_KEY',
  'OPENAI_API_KEY',
  'REPLICATE_BASE_URL',
  'FAL_BASE_URL',
  'STABILITY_BASE_URL',
  'OPENAI_BASE_URL',
  'STABLE_DIFFUSION_LOCAL_BASE_URL',
];

beforeEach(() => {
  received.length = 0;
  unexpected.length = 0;
  outside.length = 0;
  routes = {};
  for (const name of PROVIDER_ENV) vi.stubEnv(name, '');
  clearDefaultProvider();
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith(`${origin}/`)) {
      outside.push(url);
      return Promise.reject(new Error(`outside the test server: ${url}`));
    }
    return realFetch(input, init);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  clearDefaultProvider();
  expect(unexpected).toEqual([]);
  expect(outside).toEqual([]);
});

/** A multipart request's form, read with the platform's parser. */
function formOf(request: Received): Promise<FormData> {
  return new Response(bufferToBlobPart(request.body), {
    headers: { 'content-type': String(request.headers['content-type']) },
  }).formData();
}

/** A JSON request's body. */
function jsonOf(request: Received): Record<string, unknown> {
  return JSON.parse(request.body.toString('utf8')) as Record<string, unknown>;
}

/** A file part's media type, name and bytes. */
async function partOf(value: FormDataEntryValue | null): Promise<{ type: string; name: string; bytes: Buffer }> {
  const file = value as File;
  return { type: file.type, name: file.name, bytes: Buffer.from(await file.arrayBuffer()) };
}

const json = (value: unknown, status = 200): Answer => ({ status, body: JSON.stringify(value) });

/** Each provider's base URL, from its own variable, on the server: a call that names no provider may not pass `baseUrl`. */
function pointEveryProviderAtTheServer(): void {
  for (const name of ['REPLICATE_BASE_URL', 'FAL_BASE_URL', 'STABILITY_BASE_URL', 'OPENAI_BASE_URL']) vi.stubEnv(name, origin);
}

/** Answers for each provider's style transfer, every request succeeding at once. */
function answerEveryProvider(): void {
  routes['POST /models/black-forest-labs/flux-2-pro/predictions'] = () =>
    json({ id: 'p0', status: 'succeeded', output: ['https://replicate.delivery/out.png'] }, 201);
  routes['POST /fal-ai/flux-2-pro/edit'] = () =>
    json({ request_id: 'r0', status_url: `${origin}/queue/r0/status`, response_url: `${origin}/queue/r0` });
  routes['GET /queue/r0/status'] = () => json({ status: 'COMPLETED' });
  routes['GET /queue/r0'] = () => json({ images: [{ url: 'https://fal.media/out.jpg' }], seed: 1 });
  routes['POST /v2beta/stable-image/control/style-transfer'] = () => json({ image: 'c3R5bGVk', seed: 1 });
  routes['POST /images/edits'] = () => json({ created: 1, data: [{ b64_json: 'c3R5bGVk' }] });
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe('transferStyle against the providers', () => {
  it('sends Stability the source as init_image and the reference as style_image', async () => {
    routes['POST /v2beta/stable-image/control/style-transfer'] = () =>
      json({ image: Buffer.from('restyled').toString('base64'), seed: 7, finish_reason: 'SUCCESS' });

    const result = await transferStyle({
      provider: 'stability',
      apiKey: 'sk-stab',
      baseUrl: origin,
      image: SOURCE,
      styleReference: STYLE_JPEG,
      prompt: 'An oil painting.',
      negativePrompt: 'blurry',
      seed: 7,
      strength: 0.6,
      providerOptions: { stability: { outputFormat: 'jpg' } },
    });

    expect(received).toHaveLength(1);
    const [request] = received;
    expect(request.method).toBe('POST');
    expect(request.path).toBe('/v2beta/stable-image/control/style-transfer');
    expect(request.headers.authorization).toBe('Bearer sk-stab');
    expect(request.headers.accept).toBe('application/json');
    const form = await formOf(request);
    expect(await partOf(form.get('init_image'))).toEqual({ type: 'image/png', name: 'image.png', bytes: SOURCE });
    expect(await partOf(form.get('style_image'))).toEqual({ type: 'image/jpeg', name: 'style.jpg', bytes: STYLE_JPEG });
    expect(form.get('prompt')).toBe('An oil painting.');
    expect(form.get('negative_prompt')).toBe('blurry');
    expect(form.get('seed')).toBe('7');
    expect(form.get('style_strength')).toBe('0.6');
    expect(form.get('output_format')).toBe('jpeg');
    expect(form.has('model')).toBe(false);
    expect(result).toMatchObject({ provider: 'stability', model: 'stable-image-style-transfer' });
    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toMatchObject({ mimeType: 'image/jpeg', base64: Buffer.from('restyled').toString('base64') });
  });

  it('sends OpenAI both images as image[] parts, the source first, with the instruction for the strength', async () => {
    routes['POST /v1/images/edits'] = () => json({ created: 1, data: [{ b64_json: 'b3V0' }] });
    const call = (strength: number) =>
      transferStyle({
        provider: 'openai',
        apiKey: 'sk-openai',
        baseUrl: `${origin}/v1`,
        image: SOURCE,
        styleReference: STYLE_JPEG,
        prompt: 'Keep it calm.',
        strength,
        seed: 3,
        negativePrompt: 'blurry',
      });

    const light = await call(0.49);
    const full = await call(0.5);

    expect(received.map((request) => `${request.method} ${request.path}`)).toEqual([
      'POST /v1/images/edits',
      'POST /v1/images/edits',
    ]);
    const prompts: unknown[] = [];
    for (const request of received) {
      expect(request.headers.authorization).toBe('Bearer sk-openai');
      const form = await formOf(request);
      const images = form.getAll('image[]');
      expect(images).toHaveLength(2);
      expect(await partOf(images[0])).toEqual({ type: 'image/png', name: 'image.png', bytes: SOURCE });
      expect(await partOf(images[1])).toEqual({ type: 'image/jpeg', name: 'style.jpg', bytes: STYLE_JPEG });
      expect(form.get('model')).toBe('gpt-image-2.5-sunburst');
      for (const field of ['image', 'mask', 'strength', 'seed', 'negative_prompt']) expect(form.has(field)).toBe(false);
      prompts.push(form.get('prompt'));
    }
    expect(prompts).toEqual([`${OPENAI_LIGHT} Keep it calm.`, `${OPENAI_FULL} Keep it calm.`]);
    for (const result of [light, full]) {
      expect(result).toMatchObject({ provider: 'openai', model: 'gpt-image-2.5-sunburst' });
      expect(result.images[0].base64).toBe('b3V0');
    }
  });

  it('runs Replicate on FLUX.2 Pro with both images as input_images and polls a prediction still starting', async () => {
    routes['POST /models/black-forest-labs/flux-2-pro/predictions'] = () =>
      json({ id: 'p1', status: 'starting', urls: { get: `${origin}/predictions/p1` } }, 201);
    routes['GET /predictions/p1'] = () =>
      json({ id: 'p1', status: 'succeeded', output: ['https://replicate.delivery/restyled.png'] });

    const result = await transferStyle({
      provider: 'replicate',
      apiKey: 'r8-key',
      baseUrl: origin,
      image: SOURCE,
      styleReference: STYLE_WEBP,
      prompt: 'A watercolour.',
      negativePrompt: 'blurry',
    });

    expect(received.map((request) => `${request.method} ${request.path}`)).toEqual([
      'POST /models/black-forest-labs/flux-2-pro/predictions',
      'GET /predictions/p1',
    ]);
    for (const request of received) expect(request.headers.authorization).toBe('Token r8-key');
    expect(received[0].headers.prefer).toBe('wait=60');
    expect(jsonOf(received[0]).input).toEqual({
      prompt: `${FLUX_FULL} A watercolour.`,
      input_images: [dataUrl('image/png', SOURCE), dataUrl('image/webp', STYLE_WEBP)],
      aspect_ratio: 'match_input_image',
    });
    expect(result).toMatchObject({ provider: 'replicate', model: 'black-forest-labs/flux-2-pro' });
    expect(result.images.map((image) => image.url)).toEqual(['https://replicate.delivery/restyled.png']);
  });

  it('runs Fal on the FLUX.2 Pro edit endpoint and reads the status and result at the URLs the submit answer gives', async () => {
    routes['POST /fal-ai/flux-2-pro/edit'] = () =>
      json({ request_id: 'r1', status_url: `${origin}/queue/r1/status`, response_url: `${origin}/queue/r1` });
    routes['GET /queue/r1/status'] = () => json({ status: 'COMPLETED' });
    routes['GET /queue/r1'] = () =>
      json({ images: [{ url: 'https://fal.media/restyled.jpg', width: 64, height: 64, content_type: 'image/jpeg' }], seed: 5 });

    const result = await transferStyle({
      provider: 'fal',
      apiKey: 'fal-key',
      baseUrl: origin,
      image: SOURCE,
      styleReference: STYLE_JPEG,
      prompt: 'An ink drawing.',
      seed: 5,
    });

    expect(received.map((request) => `${request.method} ${request.path}`)).toEqual([
      'POST /fal-ai/flux-2-pro/edit',
      'GET /queue/r1/status',
      'GET /queue/r1',
    ]);
    for (const request of received) expect(request.headers.authorization).toBe('Key fal-key');
    expect(jsonOf(received[0])).toEqual({
      prompt: `${FLUX_FULL} An ink drawing.`,
      image_urls: [dataUrl('image/png', SOURCE), dataUrl('image/jpeg', STYLE_JPEG)],
      seed: 5,
    });
    expect(result).toMatchObject({ provider: 'fal', model: 'fal-ai/flux-2-pro/edit' });
    expect(result.images).toEqual([
      { url: 'https://fal.media/restyled.jpg', mimeType: 'image/jpeg', providerMetadata: { width: 64, height: 64, seed: 5 } },
    ]);
  });

  describe('with no provider named', () => {
    const style: TransferStyleOptions = { image: SOURCE, styleReference: STYLE_JPEG, prompt: 'Restyle it.' };

    /** How each provider's first request begins. */
    const firstRequest: Record<string, (path: string) => boolean> = {
      replicate: (path) => path.startsWith('/models/'),
      fal: (path) => path.startsWith('/fal-ai/'),
      stability: (path) => path.startsWith('/v2beta/'),
      openai: (path) => path === '/images/edits',
    };

    it.each<[string[], string]>([
      [['REPLICATE_API_TOKEN', 'FAL_API_KEY', 'STABILITY_API_KEY', 'OPENAI_API_KEY'], 'replicate'],
      [['FAL_API_KEY', 'STABILITY_API_KEY', 'OPENAI_API_KEY'], 'fal'],
      [['STABILITY_API_KEY', 'OPENAI_API_KEY'], 'stability'],
      [['OPENAI_API_KEY'], 'openai'],
    ])('with %j set, %s serves', async (keys, expected) => {
      for (const key of keys) vi.stubEnv(key, `${key.toLowerCase()}-from-env`);
      pointEveryProviderAtTheServer();
      answerEveryProvider();

      const result = await transferStyle(style);

      expect(result.provider).toBe(expected);
      expect(firstRequest[expected](received[0].path)).toBe(true);
    });

    it('passes over a provider whose factory is not registered', async () => {
      for (const key of ['REPLICATE_API_TOKEN', 'FAL_API_KEY', 'STABILITY_API_KEY', 'OPENAI_API_KEY']) vi.stubEnv(key, 'from-env');
      pointEveryProviderAtTheServer();
      answerEveryProvider();
      unregisterImageProviderFactory('replicate');
      try {
        const result = await transferStyle(style);
        expect(result.provider).toBe('fal');
      } finally {
        registerImageProviderFactory('replicate', () => new ReplicateImageProvider());
      }
    });

    it('fails when no style transfer provider has a key', async () => {
      await expect(transferStyle(style)).rejects.toThrow('No style transfer provider configured.');
      expect(received).toEqual([]);
    });

    it('refuses a baseUrl, which would reach the provider the environment picks with its key', async () => {
      vi.stubEnv('REPLICATE_API_TOKEN', 'r8-from-env');
      answerEveryProvider();

      await expect(transferStyle({ ...style, baseUrl: origin })).rejects.toThrow('a baseUrl needs `provider`');
      expect(received).toEqual([]);
    });

    it.each(['', ' \t\n '])('serves a baseUrl of %j as no baseUrl: unset, it names no endpoint and needs no provider', async (baseUrl) => {
      vi.stubEnv('OPENAI_API_KEY', 'openai_api_key-from-env');
      pointEveryProviderAtTheServer();
      answerEveryProvider();

      const result = await transferStyle({ ...style, baseUrl });

      expect(result.provider).toBe('openai');
      expect(received.map((request) => `${request.method} ${request.path}`)).toEqual(['POST /images/edits']);
      // OPENAI_BASE_URL applies, as it does with no baseUrl, and the key is OpenAI's own.
      expect(received[0].headers.authorization).toBe('Bearer openai_api_key-from-env');
    });
  });

  describe('with a global default provider', () => {
    it('uses its key and base URL for the provider it names, and not its model', async () => {
      routes['POST /v1/images/edits'] = () => json({ created: 1, data: [{ b64_json: 'b3V0' }] });
      setDefaultProvider({ provider: 'openai', model: 'gpt-image-2.5-flare', apiKey: 'sk-global', baseUrl: `${origin}/v1` });

      const result = await transferStyle({ provider: 'openai', image: SOURCE, styleReference: STYLE_JPEG, prompt: 'x' });

      expect(received).toHaveLength(1);
      expect(received[0].headers.authorization).toBe('Bearer sk-global');
      expect((await formOf(received[0])).get('model')).toBe('gpt-image-2.5-sunburst');
      expect(result.model).toBe('gpt-image-2.5-sunburst');
    });

    it('lends nothing to another provider', async () => {
      setDefaultProvider({ provider: 'openai', apiKey: 'sk-global', baseUrl: `${origin}/v1` });

      await expect(
        transferStyle({ provider: 'replicate', image: SOURCE, styleReference: STYLE_JPEG, prompt: 'x' }),
      ).rejects.toThrow('No API key for replicate');
      expect(received).toEqual([]);
    });
  });

  describe('the provider and the model', () => {
    it('runs on the provider a model prefix names, and refuses a key when provider names another', async () => {
      routes['POST /models/black-forest-labs/flux-2-pro/predictions'] = () =>
        json({ id: 'p5', status: 'succeeded', output: ['https://replicate.delivery/out.png'] }, 201);

      // The prefix wins over provider, so a key given with both would go to
      // the prefix's provider: refused before anything is read or sent.
      await expect(
        transferStyle({
          provider: 'openai',
          model: 'replicate:black-forest-labs/flux-2-pro',
          apiKey: 'sk-openai-key',
          baseUrl: origin,
          image: SOURCE,
          styleReference: STYLE_JPEG,
          prompt: 'x',
        }),
      ).rejects.toThrow("names provider 'replicate', not 'openai'");
      expect(received).toEqual([]);

      const result = await transferStyle({
        model: 'replicate:black-forest-labs/flux-2-pro',
        apiKey: 'r8-key',
        baseUrl: origin,
        image: SOURCE,
        styleReference: STYLE_JPEG,
        prompt: 'x',
      });

      expect(result.provider).toBe('replicate');
      expect(received.map((request) => request.path)).toEqual(['/models/black-forest-labs/flux-2-pro/predictions']);
    });

    it('gives a Fal FLUX.2 model named without /edit its edit endpoint', async () => {
      routes['POST /fal-ai/flux-2-max/edit'] = () =>
        json({ request_id: 'r3', status_url: `${origin}/queue/r3/status`, response_url: `${origin}/queue/r3` });
      routes['GET /queue/r3/status'] = () => json({ status: 'COMPLETED' });
      routes['GET /queue/r3'] = () => json({ images: [{ url: 'https://fal.media/max.jpg' }], seed: 1 });

      const result = await transferStyle({
        provider: 'fal',
        model: 'fal-ai/flux-2-max',
        apiKey: 'fal-key',
        image: SOURCE,
        styleReference: STYLE_JPEG,
        prompt: 'x',
        baseUrl: origin,
      });

      expect(result.model).toBe('fal-ai/flux-2-max/edit');
      expect(received[0].path).toBe('/fal-ai/flux-2-max/edit');
    });

    it('refuses a provider with no two-image call before looking for its key', async () => {
      await expect(transferStyle({ provider: 'bfl', image: SOURCE, styleReference: STYLE_JPEG, prompt: 'x' })).rejects.toThrow(
        'bfl has no style transfer that sends both images',
      );
      expect(received).toEqual([]);
    });
  });

  describe('refuses before reading or fetching either image', () => {
    // URLs on the server with no route: reading either would fail the case.
    const images = () => ({ image: `${origin}/images/source.png`, styleReference: `${origin}/images/style.jpg` });

    it('a provider with no style transfer that sends both images', async () => {
      await expect(
        transferStyle({ provider: 'stable-diffusion-local', baseUrl: origin, ...images(), prompt: 'x' }),
      ).rejects.toThrow('stable-diffusion-local has no style transfer that sends both images');
      expect(received).toEqual([]);
    });

    it('a model outside the provider list, on the provider own endpoint', async () => {
      await expect(
        transferStyle({ model: 'replicate:black-forest-labs/flux-redux-dev', apiKey: 'r8-key', ...images(), prompt: 'x' }),
      ).rejects.toThrow("Replicate's style transfer runs on black-forest-labs/flux-2-pro");
      await expect(
        transferStyle({ model: 'stability:sd3.5-large', apiKey: 'sk-stab', ...images(), prompt: 'x' }),
      ).rejects.toThrow("Stability's style transfer endpoint takes no model");
      await expect(
        transferStyle({ model: 'replicate:black-forest-labs/flux-2-pro:0123abcd', apiKey: 'r8-key', ...images(), prompt: 'x' }),
      ).rejects.toThrow('a pinned version is not taken');
      expect(received).toEqual([]);
    });

    it('a strength outside 0 to 1 and a prompt that is not a string', async () => {
      await expect(
        transferStyle({ provider: 'openai', apiKey: 'sk-openai', baseUrl: `${origin}/v1`, ...images(), prompt: 'x', strength: 1.5 }),
      ).rejects.toThrow('strength must be a number from 0 to 1');
      await expect(
        transferStyle({
          provider: 'openai',
          apiKey: 'sk-openai',
          baseUrl: `${origin}/v1`,
          ...images(),
          prompt: undefined as unknown as string,
        }),
      ).rejects.toThrow('prompt must be a string');
      expect(received).toEqual([]);
    });
  });

  describe('refuses before its request', () => {
    const on = (provider: string, extra: Partial<TransferStyleOptions> = {}): TransferStyleOptions => ({
      provider,
      apiKey: 'key',
      baseUrl: provider === 'openai' ? `${origin}/v1` : origin,
      image: SOURCE,
      styleReference: STYLE_JPEG,
      prompt: 'x',
      ...extra,
    });

    it('an image format the provider does not take', async () => {
      await expect(transferStyle(on('stability', { image: GIF }))).rejects.toThrow(
        "Stability's style transfer takes JPEG, PNG, WebP; the source is GIF.",
      );
      await expect(transferStyle(on('openai', { styleReference: GIF }))).rejects.toThrow(
        "OpenAI's style transfer takes PNG, WebP, JPEG; the style reference is GIF.",
      );
      await expect(transferStyle(on('replicate', { image: UNKNOWN }))).rejects.toThrow(
        "Replicate's style transfer takes JPEG, PNG, GIF, WebP; the source is not a JPEG, PNG, WebP or GIF image.",
      );
      expect(received).toEqual([]);
    });

    it('Replicate options that would replace the images or the model', async () => {
      await expect(
        transferStyle(on('replicate', { providerOptions: { replicate: { input: { input_images: ['https://example.com/x.png'] } } } })),
      ).rejects.toThrow('providerOptions.input may not set input_images');
      await expect(
        transferStyle(on('replicate', { providerOptions: { replicate: { extraBody: { version: 'abc123' } } } })),
      ).rejects.toThrow('providerOptions.extraBody');
      expect(received).toEqual([]);
    });

    it('a Stability request over 10 MiB, in one image or across both, and an OpenAI prompt over 32,000 characters', async () => {
      const large = Buffer.concat([SOURCE, Buffer.alloc(10 * 1024 * 1024)]);
      await expect(transferStyle(on('stability', { image: large }))).rejects.toThrow('Stability takes a request of up to 10 MiB');
      const half = Buffer.concat([SOURCE, Buffer.alloc(6 * 1024 * 1024)]);
      const halfStyle = Buffer.concat([STYLE_JPEG, Buffer.alloc(6 * 1024 * 1024)]);
      await expect(transferStyle(on('stability', { image: half, styleReference: halfStyle }))).rejects.toThrow(
        'Stability takes a request of up to 10 MiB',
      );
      await expect(transferStyle(on('openai', { prompt: 'a'.repeat(32_000) }))).rejects.toThrow(
        "OpenAI's edits take a prompt of at most 32,000 characters",
      );
      expect(received).toEqual([]);
    });
  });

  it('sends Stability its composition fidelity and change strength, and refuses them out of range', async () => {
    routes['POST /v2beta/stable-image/control/style-transfer'] = () => json({ image: 'c3R5bGVk', seed: 1 });
    const call = (stability: Record<string, number>) =>
      transferStyle({
        provider: 'stability',
        apiKey: 'sk-stab',
        baseUrl: origin,
        image: SOURCE,
        styleReference: STYLE_JPEG,
        prompt: 'x',
        providerOptions: { stability },
      });

    await call({ compositionFidelity: 0.95, changeStrength: 0.4 });
    const form = await formOf(received[0]);
    expect(form.get('composition_fidelity')).toBe('0.95');
    expect(form.get('change_strength')).toBe('0.4');

    await expect(call({ changeStrength: 0.05 })).rejects.toThrow("Stability's style transfer takes changeStrength from 0.1 to 1; it is 0.05.");
    await expect(call({ compositionFidelity: 1.5 })).rejects.toThrow('takes compositionFidelity from 0 to 1; it is 1.5.');
    expect(received).toHaveLength(1);
  });

  describe('fails on an answer without an image', () => {
    it('a Replicate prediction that fails when created, and one whose poll ends failed', async () => {
      const replicate = () =>
        transferStyle({ provider: 'replicate', apiKey: 'r8-key', baseUrl: origin, image: SOURCE, styleReference: STYLE_JPEG, prompt: 'x' });
      routes['POST /models/black-forest-labs/flux-2-pro/predictions'] = () =>
        json({ id: 'p3', status: 'failed', error: 'NSFW content detected' }, 201);
      await expect(replicate()).rejects.toThrow('Replicate style transfer failed: NSFW content detected');

      routes['POST /models/black-forest-labs/flux-2-pro/predictions'] = () =>
        json({ id: 'p4', status: 'processing', urls: { get: `${origin}/predictions/p4` } }, 201);
      routes['GET /predictions/p4'] = () => json({ id: 'p4', status: 'failed', error: 'out of memory' });
      await expect(replicate()).rejects.toThrow('Replicate style transfer failed: out of memory');
    });

    it('a Replicate prediction canceled with output', async () => {
      routes['POST /models/black-forest-labs/flux-2-pro/predictions'] = () =>
        json({ id: 'p2', status: 'canceled', output: ['https://replicate.delivery/partial.png'] }, 201);
      await expect(
        transferStyle({ provider: 'replicate', apiKey: 'r8-key', baseUrl: origin, image: SOURCE, styleReference: STYLE_JPEG, prompt: 'x' }),
      ).rejects.toThrow('Replicate style transfer was canceled.');
    });

    it('an OpenAI answer with no data', async () => {
      routes['POST /v1/images/edits'] = () => json({ created: 1, data: [] });
      await expect(
        transferStyle({ provider: 'openai', apiKey: 'sk-openai', baseUrl: `${origin}/v1`, image: SOURCE, styleReference: STYLE_JPEG, prompt: 'x' }),
      ).rejects.toThrow('OpenAI style transfer returned no image.');
    });

    it('a Fal failure as Fal reports it: a completed status that carries its error', async () => {
      // Fal's queue status is IN_QUEUE, IN_PROGRESS or COMPLETED; a failed
      // request completes with `error` and `error_type`
      // (https://fal.ai/docs/documentation/model-apis/inference/queue).
      routes['POST /fal-ai/flux-2-pro/edit'] = () =>
        json({ request_id: 'r2', status_url: `${origin}/queue/r2/status`, response_url: `${origin}/queue/r2` });
      routes['GET /queue/r2/status'] = () => json({ status: 'COMPLETED', error: 'image could not be read', error_type: 'image_load_error' });
      routes['GET /queue/r2'] = () => json({ detail: 'image could not be read', error_type: 'image_load_error' }, 422);
      await expect(
        transferStyle({ provider: 'fal', apiKey: 'fal-key', baseUrl: origin, image: SOURCE, styleReference: STYLE_JPEG, prompt: 'x' }),
      ).rejects.toThrow('image could not be read');
    });

    it('a Stability answer of zero bytes', async () => {
      routes['POST /v2beta/stable-image/control/style-transfer'] = () => ({ type: 'image/png', body: Buffer.alloc(0) });
      await expect(
        transferStyle({ provider: 'stability', apiKey: 'sk-stab', baseUrl: origin, image: SOURCE, styleReference: STYLE_JPEG, prompt: 'x' }),
      ).rejects.toThrow('Stability returned no image data.');
    });
  });

  it('sends a custom endpoint the model it names, outside the list', async () => {
    routes['POST /v1/images/edits'] = () => json({ created: 1, data: [{ b64_json: 'b3V0' }] });

    const result = await transferStyle({
      provider: 'openai',
      apiKey: 'sk-gateway',
      baseUrl: `${origin}/v1`,
      model: 'gateway-image',
      image: SOURCE,
      styleReference: STYLE_JPEG,
      prompt: 'x',
    });

    expect((await formOf(received[0])).get('model')).toBe('gateway-image');
    expect(result.model).toBe('gateway-image');
  });
});
