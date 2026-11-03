/**
 * @file removeBackground.http.test.ts
 * removeBackground through the real fal provider and fetch, against a local
 * server that answers as fal's synchronous endpoint (`POST
 * https://fal.run/fal-ai/birefnet/v2`). Each case checks the requests the
 * call sent (method, path, headers and body) and the result it read back. A
 * request no case expects is answered 404 and fails the case, and a URL
 * outside the server is refused.
 *
 * The request and answer shapes follow fal's schema for the endpoint
 * (https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/birefnet/v2)
 * and its synchronous API (https://fal.ai/docs/api-reference/inference-api/sync/run.md).
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FalBackgroundRemovalProvider,
  registerBackgroundRemovalProvider,
  removeBackground,
  resetBackgroundRemovalProviders,
  resolveBackgroundRemovalProvider,
  type BackgroundRemovalRequest,
  type IBackgroundRemovalProvider,
} from '../../index.js';

// ---------------------------------------------------------------------------
// The surface under test, from the package root
// ---------------------------------------------------------------------------

const api = {
  removeBackground,
  FalBackgroundRemovalProvider,
  registerBackgroundRemovalProvider,
  resolveBackgroundRemovalProvider,
  resetBackgroundRemovalProviders,
};

type CutOutRequest = BackgroundRemovalRequest;
type CutOutProvider = IBackgroundRemovalProvider;

// ---------------------------------------------------------------------------
// Fixtures: read by their signature alone; the server decodes nothing
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SPRITE_PNG = Buffer.concat([PNG_SIGNATURE, Buffer.from('a character on a flat fill')]);
const SPRITE_JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('a JPEG character')]);
const CUT_PNG = Buffer.concat([PNG_SIGNATURE, Buffer.from('the character on transparency')]);
const MASK_PNG = Buffer.concat([PNG_SIGNATURE, Buffer.from('white figure, black background')]);

const dataUrl = (type: string, bytes: Buffer) => `data:${type};base64,${bytes.toString('base64')}`;

const ENDPOINT = '/fal-ai/birefnet/v2';
const SOURCE_URL = 'https://cdn.example.com/sprites/hero.png';
const CUT_URL = 'https://v3.fal.media/files/rabbit/cut.png';

/** The body fal is sent for a call that sets nothing but the image. */
const DEFAULT_BODY = {
  model: 'General Use (Light)',
  operating_resolution: '1024x1024',
  output_format: 'png',
  refine_foreground: true,
};

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

interface Received {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

type Answer = { status?: number; type?: string; body: string | Buffer; delayMs?: number };

/** Every request the server received in the current case, in order. */
const received: Received[] = [];
/** The requests no route answered. */
const unexpected: string[] = [];
/** The URLs the call tried outside the server. */
const outside: string[] = [];
/** Answers the server holds back, cleared after each case. */
const held: NodeJS.Timeout[] = [];
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
        res.end('{"detail":"no such route in this case"}');
        return;
      }
      const answer = route(request);
      const send = () => {
        if (res.destroyed) return;
        res.writeHead(answer.status ?? 200, { 'content-type': answer.type ?? 'application/json' });
        res.end(answer.body);
      };
      if (answer.delayMs) held.push(setTimeout(send, answer.delayMs));
      else send();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  received.length = 0;
  unexpected.length = 0;
  outside.length = 0;
  routes = {};
  vi.stubEnv('FAL_API_KEY', '');
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
  for (const timer of held.splice(0)) clearTimeout(timer);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  api.resetBackgroundRemovalProviders();
  expect(unexpected).toEqual([]);
  expect(outside).toEqual([]);
});

/** A JSON request's body. */
function jsonOf(request: Received): Record<string, unknown> {
  return JSON.parse(request.body.toString('utf8')) as Record<string, unknown>;
}

const json = (value: unknown, status = 200): Answer => ({ status, body: JSON.stringify(value) });

/** fal's answer with one cut-out at `url`. */
function cutOutAnswer(url = CUT_URL, extra: Record<string, unknown> = {}): Answer {
  return json({
    image: { url, content_type: 'image/png', file_name: 'cut.png', file_size: 2048, width: 640, height: 960 },
    ...extra,
  });
}

/** The rejection a call ends in. */
async function rejectionOf(call: Promise<unknown>): Promise<Record<string, unknown>> {
  const error = await call.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(Error);
  return error as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe('removeBackground on fal BiRefNet', () => {
  it('sends an https image URL as image_url to fal-ai/birefnet/v2 and returns the cut-out URL', async () => {
    routes[`POST ${ENDPOINT}`] = () => cutOutAnswer();

    const result = await api.removeBackground({ image: SOURCE_URL, apiKey: 'fal-key-1', baseUrl: origin });

    expect(received).toHaveLength(1);
    const [request] = received;
    expect(request.method).toBe('POST');
    expect(request.path).toBe(ENDPOINT);
    expect(request.headers.authorization).toBe('Key fal-key-1');
    expect(request.headers['content-type']).toBe('application/json');
    expect(jsonOf(request)).toEqual({ image_url: SOURCE_URL, ...DEFAULT_BODY });

    expect(result).toEqual({
      image: { url: CUT_URL, mimeType: 'image/png', width: 640, height: 960, fileSize: 2048 },
      providerId: 'fal',
      modelId: 'fal-ai/birefnet/v2',
      durationMs: expect.any(Number),
    });
  });

  it('sends image bytes as a data URL typed by their signature, and a data URL as given', async () => {
    routes[`POST ${ENDPOINT}`] = () => cutOutAnswer();
    const call = (image: string | Buffer | Uint8Array) =>
      api.removeBackground({ image, apiKey: 'fal-key-1', baseUrl: origin });

    await call(SPRITE_PNG);
    await call(new Uint8Array(SPRITE_JPEG));
    const given = dataUrl('image/webp', Buffer.from('RIFF....WEBPVP8 a WebP sprite'));
    await call(given);

    expect(received.map((request) => jsonOf(request).image_url)).toEqual([
      dataUrl('image/png', SPRITE_PNG),
      dataUrl('image/jpeg', SPRITE_JPEG),
      given,
    ]);
  });

  it('asks for the cut-out inline with output "buffer" and returns its bytes', async () => {
    routes[`POST ${ENDPOINT}`] = () => cutOutAnswer(dataUrl('image/png', CUT_PNG));

    const result = await api.removeBackground({ image: SOURCE_URL, output: 'buffer', apiKey: 'fal-key-1', baseUrl: origin });

    expect(received).toHaveLength(1);
    expect(jsonOf(received[0])).toEqual({ image_url: SOURCE_URL, ...DEFAULT_BODY, sync_mode: true });
    expect(result.image.url).toBeUndefined();
    expect(result.image.dataUrl).toBe(dataUrl('image/png', CUT_PNG));
    expect(result.image.mimeType).toBe('image/png');
    expect(Buffer.isBuffer(result.image.buffer)).toBe(true);
    expect(result.image.buffer?.equals(CUT_PNG)).toBe(true);
  });

  it('downloads the cut-out for output "buffer" when fal answers with a URL, without the key', async () => {
    const fileUrl = `${origin}/files/cut.png`;
    routes[`POST ${ENDPOINT}`] = () => cutOutAnswer(fileUrl);
    routes['GET /files/cut.png'] = () => ({ type: 'image/png', body: CUT_PNG });

    const result = await api.removeBackground({ image: SOURCE_URL, output: 'buffer', apiKey: 'fal-key-1', baseUrl: origin });

    expect(received.map((request) => `${request.method} ${request.path}`)).toEqual([`POST ${ENDPOINT}`, 'GET /files/cut.png']);
    expect(received[1].headers.authorization).toBeUndefined();
    expect(result.image.url).toBe(fileUrl);
    expect(result.image.buffer?.equals(CUT_PNG)).toBe(true);
    expect(result.image.mimeType).toBe('image/png');
  });

  it('asks for the mask with returnMask and for WebP with format "webp"', async () => {
    routes[`POST ${ENDPOINT}`] = () =>
      json({
        image: { url: 'https://v3.fal.media/files/rabbit/cut.webp', content_type: 'image/webp', width: 640, height: 960 },
        mask_image: { url: 'https://v3.fal.media/files/rabbit/mask.png', content_type: 'image/png', width: 640, height: 960 },
      });

    const result = await api.removeBackground({
      image: SOURCE_URL,
      format: 'webp',
      returnMask: true,
      apiKey: 'fal-key-1',
      baseUrl: origin,
    });

    expect(jsonOf(received[0])).toEqual({ image_url: SOURCE_URL, ...DEFAULT_BODY, output_format: 'webp', output_mask: true });
    expect(result.image).toEqual({ url: 'https://v3.fal.media/files/rabbit/cut.webp', mimeType: 'image/webp', width: 640, height: 960 });
    expect(result.mask).toEqual({ url: 'https://v3.fal.media/files/rabbit/mask.png', mimeType: 'image/png', width: 640, height: 960 });
  });

  it('decodes an inline mask with output "buffer"', async () => {
    routes[`POST ${ENDPOINT}`] = () =>
      cutOutAnswer(dataUrl('image/png', CUT_PNG), { mask_image: { url: dataUrl('image/png', MASK_PNG), content_type: 'image/png' } });

    const result = await api.removeBackground({
      image: SOURCE_URL,
      output: 'buffer',
      returnMask: true,
      apiKey: 'fal-key-1',
      baseUrl: origin,
    });

    expect(result.image.buffer?.equals(CUT_PNG)).toBe(true);
    expect(result.mask?.buffer?.equals(MASK_PNG)).toBe(true);
    expect(result.mask?.url).toBeUndefined();
  });

  it('rejects an answer without the mask the call asked for', async () => {
    routes[`POST ${ENDPOINT}`] = () => cutOutAnswer(CUT_URL, { mask_image: null });

    const error = await rejectionOf(
      api.removeBackground({ image: SOURCE_URL, returnMask: true, apiKey: 'fal-key-1', baseUrl: origin }),
    );

    expect(error).toMatchObject({ name: 'SegmentationProviderError', code: 'provider_failed' });
    expect(String(error.message)).toMatch(/no mask/i);
  });

  it('types the mask by its own file when fal names no content type, not by the cut-out format', async () => {
    routes[`POST ${ENDPOINT}`] = () =>
      json({
        image: { url: 'https://v3.fal.media/files/rabbit/cut.webp' },
        mask_image: { url: 'https://v3.fal.media/files/rabbit/mask.png' },
      });

    const result = await api.removeBackground({
      image: SOURCE_URL,
      format: 'webp',
      returnMask: true,
      apiKey: 'fal-key-1',
      baseUrl: origin,
    });

    expect(result.image.mimeType).toBe('image/webp');
    expect(result.mask?.mimeType).toBe('image/png');
  });

  it('keeps the inline and mask flags, and the image, over extra input fields', async () => {
    routes[`POST ${ENDPOINT}`] = () =>
      cutOutAnswer(dataUrl('image/png', CUT_PNG), { mask_image: { url: dataUrl('image/png', MASK_PNG), content_type: 'image/png' } });

    await api.removeBackground({
      image: SOURCE_URL,
      output: 'buffer',
      returnMask: true,
      apiKey: 'fal-key-1',
      baseUrl: origin,
      providerOptions: {
        fal: { input: { output_mask: false, sync_mode: false, image_url: 'https://elsewhere.example.com/other.png', mask_only: false } },
      },
    });

    expect(jsonOf(received[0])).toEqual({ image_url: SOURCE_URL, ...DEFAULT_BODY, output_mask: true, sync_mode: true, mask_only: false });
  });

  it('rejects an inline answer that is not base64', async () => {
    routes[`POST ${ENDPOINT}`] = () => cutOutAnswer('data:image/png;base64,%%%%');

    const error = await rejectionOf(
      api.removeBackground({ image: SOURCE_URL, output: 'buffer', apiKey: 'fal-key-1', baseUrl: origin }),
    );

    expect(error).toMatchObject({ name: 'SegmentationProviderError', code: 'provider_failed' });
  });

  it('stops reading an answer or a download past maxResponseBytes', async () => {
    const fal = { maxResponseBytes: 512 };
    routes[`POST ${ENDPOINT}`] = () => cutOutAnswer(CUT_URL, { padding: 'x'.repeat(1_000) });
    const large = await rejectionOf(
      api.removeBackground({ image: SOURCE_URL, apiKey: 'fal-key-1', baseUrl: origin, providerOptions: { fal } }),
    );
    expect(large).toMatchObject({ name: 'SegmentationProviderError', code: 'provider_failed' });
    expect(String(large.message)).toContain('512 bytes');

    const fileUrl = `${origin}/files/large.png`;
    routes[`POST ${ENDPOINT}`] = () => cutOutAnswer(fileUrl);
    routes['GET /files/large.png'] = () => ({ type: 'image/png', body: Buffer.concat([PNG_SIGNATURE, Buffer.alloc(2_048)]) });
    const download = await rejectionOf(
      api.removeBackground({ image: SOURCE_URL, output: 'buffer', apiKey: 'fal-key-1', baseUrl: origin, providerOptions: { fal } }),
    );
    expect(download).toMatchObject({ name: 'SegmentationProviderError', code: 'provider_failed' });
    expect(String(download.message)).toContain('512 bytes');
  });

  it("passes fal's options: the BiRefNet variant, the resolution, refinement and extra input fields", async () => {
    routes[`POST ${ENDPOINT}`] = () => cutOutAnswer();

    await api.removeBackground({
      image: SOURCE_URL,
      apiKey: 'fal-key-1',
      baseUrl: origin,
      providerOptions: {
        fal: {
          variant: 'Portrait',
          operatingResolution: '2048x2048',
          refineForeground: false,
          input: { mask_only: false, image_url: 'https://elsewhere.example.com/other.png' },
        },
      },
    });

    expect(jsonOf(received[0])).toEqual({
      image_url: SOURCE_URL,
      model: 'Portrait',
      operating_resolution: '2048x2048',
      output_format: 'png',
      refine_foreground: false,
      mask_only: false,
    });
  });

  it('runs on the fal endpoint the call names', async () => {
    routes['POST /fal-ai/birefnet'] = () => cutOutAnswer();

    const result = await api.removeBackground({ image: SOURCE_URL, model: 'fal-ai/birefnet', apiKey: 'fal-key-1', baseUrl: origin });

    expect(received.map((request) => request.path)).toEqual(['/fal-ai/birefnet']);
    expect(result.modelId).toBe('fal-ai/birefnet');
  });

  it("reports fal's refusal of the input as invalid_request and a failure as provider_failed, each with its status", async () => {
    const detail = '{"detail":[{"loc":["body","image_url"],"msg":"Could not download the image","type":"image_load_error"}]}';
    let answer: Answer = { status: 422, body: detail };
    routes[`POST ${ENDPOINT}`] = () => answer;
    const call = () => api.removeBackground({ image: SOURCE_URL, apiKey: 'fal-key-1', baseUrl: origin });

    const refused = await rejectionOf(call());
    expect(refused).toMatchObject({ name: 'SegmentationProviderError', code: 'invalid_request', status: 422 });
    expect(String(refused.message)).toContain('Could not download the image');

    answer = { status: 500, body: '{"detail":"Internal error"}' };
    expect(await rejectionOf(call())).toMatchObject({ name: 'SegmentationProviderError', code: 'provider_failed', status: 500 });

    answer = json({ mask_image: null });
    const empty = await rejectionOf(call());
    expect(empty).toMatchObject({ name: 'SegmentationProviderError', code: 'provider_failed' });
    expect(String(empty.message)).toMatch(/no image/i);
  });

  it('refuses an image or a model it cannot send, before any request', async () => {
    const images: Array<string | Buffer> = [
      './sprites/hero.png',
      'iVBORw0KGgoAAAANSUhEUg==',
      'ftp://cdn.example.com/hero.png',
      'data:text/plain;base64,aGVsbG8=',
      'data:image/png;base64,%%%%',
      'data:image/png;base64,iVBORw0',
      'data:image/png;base64,====',
      'data:image/png;base64,aGVsbG8=',
      '',
      Buffer.from('these bytes are not an image'),
      Buffer.alloc(0),
    ];
    for (const image of images) {
      expect(await rejectionOf(api.removeBackground({ image, apiKey: 'fal-key-1', baseUrl: origin }))).toMatchObject({
        name: 'SegmentationProviderError',
        code: 'invalid_request',
      });
    }
    for (const model of ['fal-ai/../admin', '/fal-ai/birefnet', 'birefnet', 'fal-ai/birefnet?x=1']) {
      expect(await rejectionOf(api.removeBackground({ image: SOURCE_URL, model, apiKey: 'fal-key-1', baseUrl: origin }))).toMatchObject({
        name: 'SegmentationProviderError',
        code: 'invalid_request',
      });
    }
    expect(received).toEqual([]);
  });

  it('gives up at timeoutMs with code timeout', async () => {
    routes[`POST ${ENDPOINT}`] = () => ({ ...cutOutAnswer(), delayMs: 5_000 });

    const startedAt = Date.now();
    const error = await rejectionOf(api.removeBackground({ image: SOURCE_URL, timeoutMs: 150, apiKey: 'fal-key-1', baseUrl: origin }));

    expect(error).toMatchObject({ name: 'SegmentationProviderError', code: 'timeout' });
    expect(Date.now() - startedAt).toBeLessThan(4_000);
  });

  it('takes a fractional or a very long timeoutMs, and refuses one that is not a positive number', async () => {
    routes[`POST ${ENDPOINT}`] = () => cutOutAnswer();
    const call = (timeoutMs: number) => api.removeBackground({ image: SOURCE_URL, timeoutMs, apiKey: 'fal-key-1', baseUrl: origin });

    expect((await call(1_500.5)).image.url).toBe(CUT_URL);
    expect((await call(3_000_000_000)).image.url).toBe(CUT_URL);
    expect(received).toHaveLength(2);

    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(await rejectionOf(call(timeoutMs))).toMatchObject({ name: 'SegmentationProviderError', code: 'invalid_request' });
    }
    expect(received).toHaveLength(2);
  });

  it("stops at the caller's abort, before or during the request, with the abort's reason", async () => {
    const before = new AbortController();
    before.abort();
    const early = await rejectionOf(api.removeBackground({ image: SOURCE_URL, signal: before.signal, apiKey: 'fal-key-1', baseUrl: origin }));
    expect(early.name).toBe('AbortError');
    expect(received).toEqual([]);

    routes[`POST ${ENDPOINT}`] = () => ({ ...cutOutAnswer(), delayMs: 5_000 });
    const during = new AbortController();
    setTimeout(() => during.abort(), 100);
    const late = await rejectionOf(api.removeBackground({ image: SOURCE_URL, signal: during.signal, apiKey: 'fal-key-1', baseUrl: origin }));
    expect(late.name).toBe('AbortError');
    expect(received).toHaveLength(1);
  });

  it('reads FAL_API_KEY when the call passes no key, and names it when it is missing', async () => {
    routes[`POST ${ENDPOINT}`] = () => cutOutAnswer();
    vi.stubEnv('FAL_API_KEY', 'fal-env-key');

    await api.removeBackground({ image: SOURCE_URL, baseUrl: origin });
    expect(received[0].headers.authorization).toBe('Key fal-env-key');

    vi.stubEnv('FAL_API_KEY', '');
    const missing = await rejectionOf(api.removeBackground({ image: SOURCE_URL }));
    expect(String(missing.message)).toContain('FAL_API_KEY');
    expect(received).toHaveLength(1);
  });
});

describe('the background removal providers', () => {
  it('serves a registered provider by its id with the normalized request', async () => {
    const seen: CutOutRequest[] = [];
    const custom: CutOutProvider = {
      providerId: 'custom',
      isInitialized: true,
      defaultModelId: 'custom/matting',
      async initialize() {},
      async removeBackground(request) {
        seen.push(request);
        return { image: { url: 'https://custom.example.com/cut.png', mimeType: 'image/png' }, providerId: 'custom', modelId: request.modelId, durationMs: 1 };
      },
    };
    api.registerBackgroundRemovalProvider('custom', custom);

    const result = await api.removeBackground({ image: SPRITE_PNG, provider: 'custom', output: 'buffer' });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      modelId: 'custom/matting',
      imageUrl: dataUrl('image/png', SPRITE_PNG),
      output: 'buffer',
      format: 'png',
      returnMask: false,
      timeoutMs: 60_000,
    });
    expect(result.providerId).toBe('custom');
    expect(await api.resolveBackgroundRemovalProvider('custom')).toBe(custom);
    expect(received).toEqual([]);
  });

  it("sends a call's apiKey and baseUrl after the provider built from FAL_API_KEY is cached", async () => {
    routes[`POST ${ENDPOINT}`] = () => cutOutAnswer();
    vi.stubEnv('FAL_API_KEY', 'fal-env-key');
    const fromEnv = await api.resolveBackgroundRemovalProvider('fal');
    expect(await api.resolveBackgroundRemovalProvider('fal')).toBe(fromEnv);

    await api.removeBackground({ image: SOURCE_URL, apiKey: 'fal-tenant-key', baseUrl: origin });

    expect(received).toHaveLength(1);
    expect(received[0].headers.authorization).toBe('Key fal-tenant-key');
  });

  it("rotates a call's own comma-separated keys across calls, as the environment's keys rotate", async () => {
    routes[`POST ${ENDPOINT}`] = () => cutOutAnswer();

    for (let i = 0; i < 3; i += 1) {
      await api.removeBackground({ image: SOURCE_URL, apiKey: 'fal-k1,fal-k2', baseUrl: origin });
    }

    expect(new Set(received.map((request) => request.headers.authorization))).toEqual(new Set(['Key fal-k1', 'Key fal-k2']));
  });

  it('builds one provider for calls that miss the cache at the same time', async () => {
    vi.stubEnv('FAL_API_KEY', 'fal-env-key');
    const fromEnv = await Promise.all([1, 2, 3].map(() => api.resolveBackgroundRemovalProvider('fal')));
    expect(new Set(fromEnv).size).toBe(1);

    const config = { apiKey: 'fal-k1,fal-k2', baseUrl: origin };
    const fromCall = await Promise.all([1, 2, 3].map(() => api.resolveBackgroundRemovalProvider('fal', config)));
    expect(new Set(fromCall).size).toBe(1);
    expect(fromCall[0]).not.toBe(fromEnv[0]);
    expect(await api.resolveBackgroundRemovalProvider('fal', config)).toBe(fromCall[0]);
  });

  it('refuses a provider id it does not know', async () => {
    const error = await rejectionOf(api.removeBackground({ image: SOURCE_URL, provider: 'nowhere' }));
    expect(String(error.message)).toContain('nowhere');
  });

  it('runs the fal provider alone on a normalized request', async () => {
    routes[`POST ${ENDPOINT}`] = () => cutOutAnswer();
    const provider = new api.FalBackgroundRemovalProvider();
    expect(provider.providerId).toBe('fal');
    await expect(provider.initialize({})).rejects.toThrow(/apiKey/);

    await provider.initialize({ apiKey: 'fal-key-2', baseURL: origin });
    expect(provider.isInitialized).toBe(true);
    expect(provider.defaultModelId).toBe('fal-ai/birefnet/v2');

    const result = await provider.removeBackground({
      modelId: '',
      imageUrl: SOURCE_URL,
      output: 'url',
      format: 'png',
      returnMask: false,
      timeoutMs: 10_000,
    });

    expect(received[0].headers.authorization).toBe('Key fal-key-2');
    expect(jsonOf(received[0])).toEqual({ image_url: SOURCE_URL, ...DEFAULT_BODY });
    expect(result.image.url).toBe(CUT_URL);
    expect(result.modelId).toBe('fal-ai/birefnet/v2');
  });
});
