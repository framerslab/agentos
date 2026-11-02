/**
 * SimliAvatarProvider face creation: the request `createFace` sends to
 * `POST /faces/trinity` and the one `faceStatus` sends to
 * `GET /faces/trinity/generation_status`, read from the captured fetch call,
 * and how each response maps onto the provider-neutral result.
 *
 * Vendor contract: https://docs.simli.com/api-reference/generate-trinity-face,
 * https://docs.simli.com/api-reference/check-trinity-generation-status and the
 * live spec at https://api.simli.ai/openapi.yaml.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SimliAvatarProvider } from '../providers/SimliAvatarProvider.js';

/** The face surface the provider exposes, as the tests call it. */
interface FaceSurface {
  createFace(
    image: { data: Uint8Array | ArrayBuffer | Blob; mimeType?: string; filename?: string },
    options?: {
      name?: string;
      signal?: AbortSignal;
      timeoutMs?: number;
      providerOptions?: Record<string, unknown>;
    }
  ): Promise<{
    faceId: string;
    message?: string;
    warnings: string[];
    startAfterMs?: number;
    raw: unknown;
  }>;
  faceStatus(
    faceId: string,
    options?: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<{
    faceId: string;
    state: string;
    providerState?: string;
    queuePosition?: number;
    startAfterMs?: number;
    raw: unknown;
  }>;
}

const faces = (provider: SimliAvatarProvider) => provider as unknown as FaceSurface;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 4, 5, 6]);

/** Stubs fetch with one response and returns the mock that records each call. */
function stubFetch(response: () => Response) {
  const mock = vi.fn(async (_url: string, _init?: RequestInit) => response());
  vi.stubGlobal('fetch', mock);
  return mock;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** The one captured request: its URL, headers and init. */
function captured(mock: ReturnType<typeof stubFetch>, index = 0) {
  const [url, init] = mock.mock.calls[index] as [string, RequestInit];
  return { url: new URL(String(url)), init, headers: (init.headers ?? {}) as Record<string, string> };
}

describe('SimliAvatarProvider.createFace', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts the image as the multipart field `image` to /faces/trinity with the API key and face_name', async () => {
    const mock = stubFetch(() =>
      json({ message: 'Queued at position 1', face_id: 'face-new', warnings: [] })
    );
    const provider = new SimliAvatarProvider({ apiKey: 'sk' });

    const job = await faces(provider).createFace({ data: PNG }, { name: 'companion portrait' });

    expect(mock).toHaveBeenCalledTimes(1);
    const { url, init, headers } = captured(mock);
    expect(`${url.origin}${url.pathname}`).toBe('https://api.simli.ai/faces/trinity');
    expect(init.method).toBe('POST');
    expect(headers['x-simli-api-key']).toBe('sk');
    // fetch writes the multipart boundary itself; a hand-set content type would drop it.
    expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain('content-type');
    expect(url.searchParams.get('face_name')).toBe('companion portrait');
    expect(url.searchParams.has('target-ratio')).toBe(false);

    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    const fields: string[] = [];
    form.forEach((_value, field) => fields.push(field));
    expect(fields).toEqual(['image']);
    const part = form.get('image') as File;
    expect(part.type).toBe('image/png');
    expect(part.name).toBe('face.png');
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(PNG);

    expect(job).toEqual({
      faceId: 'face-new',
      message: 'Queued at position 1',
      warnings: [],
      raw: { message: 'Queued at position 1', face_id: 'face-new', warnings: [] },
    });
  });

  it('sends no face_name when no name is given, so the vendor default applies', async () => {
    const mock = stubFetch(() => json({ message: 'ok', face_id: 'f', warnings: [] }));
    await faces(new SimliAvatarProvider({ apiKey: 'sk' })).createFace({ data: PNG });
    expect(captured(mock).url.search).toBe('');
  });

  it('sends providerOptions.targetRatio as the target-ratio header and the rest as query parameters', async () => {
    const mock = stubFetch(() =>
      json({
        message: 'Held until the next slot',
        face_id: 'face-held',
        dispatch_after: 1_798_000_000,
        warnings: ['low light'],
      })
    );
    const provider = new SimliAvatarProvider({ apiKey: 'sk', baseUrl: 'https://simli.test' });

    const job = await faces(provider).createFace(
      { data: PNG },
      { name: 'n', providerOptions: { gsVersion: 'GSA_1.0', targetRatio: 0.42 } }
    );

    const { url, headers } = captured(mock);
    expect(`${url.origin}${url.pathname}`).toBe('https://simli.test/faces/trinity');
    expect(url.searchParams.get('gsVersion')).toBe('GSA_1.0');
    expect(url.searchParams.get('face_name')).toBe('n');
    expect(url.searchParams.has('targetRatio')).toBe(false);
    expect(headers['target-ratio']).toBe('0.42');
    expect(job.faceId).toBe('face-held');
    expect(job.warnings).toEqual(['low light']);
    // dispatch_after is Unix seconds; the result carries epoch milliseconds.
    expect(job.startAfterMs).toBe(1_798_000_000_000);
  });

  it('labels the part with the given type and a matching file name, and keeps a Blob input as given', async () => {
    const mock = stubFetch(() => json({ message: 'ok', face_id: 'f', warnings: [] }));
    const provider = faces(new SimliAvatarProvider({ apiKey: 'sk' }));

    await provider.createFace({ data: JPEG, mimeType: 'image/jpeg' });
    const jpegPart = (captured(mock, 0).init.body as FormData).get('image') as File;
    expect(jpegPart.type).toBe('image/jpeg');
    expect(jpegPart.name).toBe('face.jpg');
    expect(new Uint8Array(await jpegPart.arrayBuffer())).toEqual(JPEG);

    await provider.createFace({
      data: new Blob([JPEG], { type: 'image/jpeg' }),
      filename: 'portrait.jpg',
    });
    const blobPart = (captured(mock, 1).init.body as FormData).get('image') as File;
    expect(blobPart.type).toBe('image/jpeg');
    expect(blobPart.name).toBe('portrait.jpg');
    expect(new Uint8Array(await blobPart.arrayBuffer())).toEqual(JPEG);

    const buffer = JPEG.buffer.slice(0);
    await provider.createFace({ data: buffer, mimeType: 'image/jpeg' });
    const bufferPart = (captured(mock, 2).init.body as FormData).get('image') as File;
    expect(new Uint8Array(await bufferPart.arrayBuffer())).toEqual(JPEG);
  });

  it("passes the caller's abort signal through to the upload", async () => {
    const mock = stubFetch(() => json({ message: 'ok', face_id: 'f', warnings: [] }));
    const controller = new AbortController();
    controller.abort();
    await faces(new SimliAvatarProvider({ apiKey: 'sk' })).createFace(
      { data: PNG },
      { signal: controller.signal }
    );
    const signal = captured(mock).init.signal as AbortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(true);
  });

  it('bounds the upload with a deadline of its own when the caller gives none', async () => {
    const mock = stubFetch(() => json({ message: 'ok', face_id: 'f', warnings: [] }));
    await faces(new SimliAvatarProvider({ apiKey: 'sk' })).createFace({ data: PNG });
    const signal = captured(mock).init.signal as AbortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
  });

  it('rejects an out-of-avatars 403 with the status and the body the caller can classify', async () => {
    stubFetch(() => json({ detail: 'No Trinity-2 generations left' }, 403));
    await expect(
      faces(new SimliAvatarProvider({ apiKey: 'sk' })).createFace({ data: PNG })
    ).rejects.toMatchObject({
      name: 'AvatarProviderError',
      providerId: 'simli',
      status: 403,
      body: expect.stringContaining('No Trinity-2 generations left'),
      message: expect.stringMatching(/403/),
    });
  });

  it('rejects a 422 validation error with its status', async () => {
    stubFetch(() =>
      json({ detail: [{ loc: ['body', 'image'], msg: 'Field required', type: 'missing' }] }, 422)
    );
    await expect(
      faces(new SimliAvatarProvider({ apiKey: 'sk' })).createFace({ data: PNG })
    ).rejects.toMatchObject({ name: 'AvatarProviderError', status: 422 });
  });

  it('rejects a 200 that carries no face_id', async () => {
    stubFetch(() => json({ message: 'ok', warnings: [] }));
    await expect(
      faces(new SimliAvatarProvider({ apiKey: 'sk' })).createFace({ data: PNG })
    ).rejects.toThrow(/face_id/);
  });
});

describe('SimliAvatarProvider.faceStatus', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('asks /faces/trinity/generation_status for the one face id, with the API key', async () => {
    const mock = stubFetch(() =>
      json({
        status: 'pending',
        queue_position: 2,
        face_id: 'face 1/x',
        generations: [{ face_id: 'face 1/x', status: 'pending', queue_position: 2 }],
      })
    );
    const status = await faces(new SimliAvatarProvider({ apiKey: 'sk' })).faceStatus('face 1/x');

    const { url, init, headers } = captured(mock);
    expect(`${url.origin}${url.pathname}`).toBe('https://api.simli.ai/faces/trinity/generation_status');
    expect(url.searchParams.get('face_id')).toBe('face 1/x');
    expect(init.method ?? 'GET').toBe('GET');
    expect(headers['x-simli-api-key']).toBe('sk');
    expect((init.signal as AbortSignal).aborted).toBe(false);
    expect(status).toMatchObject({
      faceId: 'face 1/x',
      state: 'pending',
      providerState: 'pending',
      queuePosition: 2,
    });
  });

  it('reads `completed` as ready', async () => {
    stubFetch(() =>
      json({
        status: 'completed',
        queue_position: 0,
        face_id: 'f1',
        generations: [{ face_id: 'f1', status: 'completed', queue_position: 0 }],
      })
    );
    const status = await faces(new SimliAvatarProvider({ apiKey: 'sk' })).faceStatus('f1');
    expect(status.state).toBe('ready');
    expect(status.providerState).toBe('completed');
    expect(status.queuePosition).toBe(0);
  });

  it('reads the matching entry of `generations` over the top-level fields', async () => {
    stubFetch(() =>
      json({
        status: 'pending',
        queue_position: 3,
        face_id: 'newer',
        generations: [
          { face_id: 'f1', status: 'processing', queue_position: 0 },
          { face_id: 'newer', status: 'pending', queue_position: 3, dispatch_after: 1_798_000_600 },
        ],
      })
    );
    const status = await faces(new SimliAvatarProvider({ apiKey: 'sk' })).faceStatus('f1');
    expect(status).toMatchObject({ faceId: 'f1', state: 'processing', queuePosition: 0 });
    expect(status.startAfterMs).toBeUndefined();
  });

  it('carries a held build’s dispatch_after as startAfterMs', async () => {
    stubFetch(() =>
      json({
        status: 'pending',
        queue_position: 1,
        face_id: 'held',
        generations: [
          { face_id: 'held', status: 'pending', queue_position: 1, dispatch_after: 1_798_000_600 },
        ],
      })
    );
    const status = await faces(new SimliAvatarProvider({ apiKey: 'sk' })).faceStatus('held');
    expect(status.startAfterMs).toBe(1_798_000_600_000);
  });

  it('reads `failed` as failed', async () => {
    stubFetch(() =>
      json({
        status: 'failed',
        queue_position: 0,
        face_id: 'f1',
        generations: [{ face_id: 'f1', status: 'failed', queue_position: 0 }],
      })
    );
    const status = await faces(new SimliAvatarProvider({ apiKey: 'sk' })).faceStatus('f1');
    expect(status.state).toBe('failed');
  });

  it('reads an untracked face as not_found, with no queue position', async () => {
    stubFetch(() => json({ status: 'not_found', queue_position: -1, face_id: 'gone', generations: [] }));
    const status = await faces(new SimliAvatarProvider({ apiKey: 'sk' })).faceStatus('gone');
    expect(status.state).toBe('not_found');
    expect(status.queuePosition).toBeUndefined();
  });

  it('reads a response about another face only as not_found for the one asked about', async () => {
    stubFetch(() =>
      json({
        status: 'completed',
        queue_position: 0,
        face_id: 'other',
        generations: [{ face_id: 'other', status: 'completed', queue_position: 0 }],
      })
    );
    const status = await faces(new SimliAvatarProvider({ apiKey: 'sk' })).faceStatus('mine');
    expect(status).toMatchObject({ faceId: 'mine', state: 'not_found' });
  });

  it('rejects a failed status request with its status and body', async () => {
    stubFetch(() => new Response('Invalid API key', { status: 401 }));
    await expect(
      faces(new SimliAvatarProvider({ apiKey: 'bad' })).faceStatus('f1')
    ).rejects.toMatchObject({
      name: 'AvatarProviderError',
      providerId: 'simli',
      status: 401,
      body: 'Invalid API key',
    });
  });
});
