/**
 * @module media/video/__tests__/GeminiVideoProvider.test
 *
 * Tests for the Gemini video provider against captured request bodies.
 * `fetch` is replaced by a spy, so each test reads the exact URL, headers
 * and JSON body the provider sends to the Gemini Interactions API and feeds
 * back an interaction shaped as the API documents it
 * (https://ai.google.dev/gemini-api/docs/omni).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createVideoProvider } from '../index.js';
import type { EgressConnector, EgressConnectResponse } from '../../../../safety/egress/index.js';

type FetchSpy = ReturnType<typeof vi.fn>;

/** A Response-like object for a JSON body. */
function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    headers: { get: () => 'application/json' },
    json: vi.fn(async () => body),
    text: vi.fn(async () => JSON.stringify(body)),
  };
}

/** A Response-like object for image bytes. */
function imageResponse(bytes: Buffer, contentType: string) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    arrayBuffer: vi.fn(async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
    text: vi.fn(async () => ''),
  };
}

/** A completed interaction whose model output holds `content`. */
function interaction(content: unknown[], status = 'completed') {
  return {
    id: 'int-1',
    object: 'interaction',
    model: 'gemini-omni-1.1-flash',
    status,
    steps: [
      { type: 'user_input', content: [{ type: 'text', text: 'prompt' }] },
      { type: 'thought' },
      { type: 'model_output', content },
    ],
  };
}

const VIDEO_B64 = Buffer.from('mp4-bytes').toString('base64');
/** The first bytes of a PNG file. */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
/** The first bytes of a JPEG file. */
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const INTERACTIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';

/** A public IPv4 address for the checked egress path's lookup. */
const PUBLIC_V4 = '142.250.0.1';
/** A lookup that answers `address` for every name. */
const resolvesTo = (address: string) => async () => [{ address, family: address.includes(':') ? 6 : 4 }];
/** A connector answer. */
function answer(status: number, headers: Record<string, string>, bytes: Buffer): EgressConnectResponse {
  return { status, headers, body: (async function* () { yield bytes; })() };
}

describe('GeminiVideoProvider', () => {
  let provider: any;
  let fetchSpy: FetchSpy;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    provider = createVideoProvider('gemini');
    await provider.initialize({ apiKey: 'gk-test' });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** The call to the Interactions API (the last fetch). */
  function interactionCall(): [string, any] {
    const calls = fetchSpy.mock.calls;
    return calls[calls.length - 1] as [string, any];
  }

  it('posts a prompt to the Interactions API with the key in the x-goog-api-key header', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(interaction([{ type: 'video', mime_type: 'video/mp4', data: VIDEO_B64 }])),
    );

    const result = await provider.generateVideo({
      prompt: 'a marble rolls down a chain-reaction track',
      aspectRatio: '9:16',
      resolution: '1080p',
      durationSec: 8,
      negativePrompt: 'blur',
      seed: 3,
    });

    const [url, init] = interactionCall();
    expect(url).toBe(INTERACTIONS_URL);
    expect(url).not.toContain('key=');
    expect(init.method).toBe('POST');
    expect(init.headers['x-goog-api-key']).toBe('gk-test');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body)).toEqual({
      store: false,
      model: 'gemini-omni-1.1-flash',
      input: 'a marble rolls down a chain-reaction track',
      response_format: { type: 'video', aspect_ratio: '9:16', resolution: '1080p' },
    });

    expect(result.providerId).toBe('gemini');
    expect(result.modelId).toBe('gemini-omni-1.1-flash');
    expect(result.videos).toHaveLength(1);
    expect(result.videos[0]).toMatchObject({ base64: VIDEO_B64, mimeType: 'video/mp4' });
    expect(result.videos[0].url).toBeUndefined();
    expect(result.usage).toEqual({ totalVideos: 1 });
  });

  it('sends the source image first, then the reference images, then the prompt, as image-to-video', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(interaction([{ type: 'video', mime_type: 'video/mp4', data: VIDEO_B64 }])),
    );

    await provider.imageToVideo({
      prompt: 'the figure walks toward the camera',
      image: PNG_BYTES,
      referenceImages: ['data:image/webp;base64,UklGRgAAAABXRUJQ'],
    });

    const body = JSON.parse(interactionCall()[1].body);
    expect(body.input).toEqual([
      { type: 'image', data: PNG_BYTES.toString('base64'), mime_type: 'image/png' },
      { type: 'image', data: 'UklGRgAAAABXRUJQ', mime_type: 'image/webp' },
      { type: 'text', text: 'the figure walks toward the camera' },
    ]);
    expect(body.generation_config).toEqual({ video_config: { task: 'image_to_video' } });
  });

  it('fetches an image URL through the checked egress path without the key, and sends a Files API URI as a uri', async () => {
    const seen: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
    const connector: EgressConnector = async (req) => {
      seen.push({ url: req.destination.url.href, method: req.method, headers: req.headers });
      return answer(200, { 'content-type': 'image/jpeg; charset=binary' }, JPEG_BYTES);
    };
    await provider.initialize({ apiKey: 'gk-test', imageEgress: { lookup: resolvesTo(PUBLIC_V4), connector } });
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(interaction([{ type: 'video', mime_type: 'video/mp4', data: VIDEO_B64 }])),
    );

    await provider.imageToVideo({
      prompt: 'p',
      image: 'https://cdn.example.com/start.jpg',
      referenceImages: ['https://generativelanguage.googleapis.com/v1beta/files/abc123'],
    });

    expect(seen).toEqual([{ url: 'https://cdn.example.com/start.jpg', method: 'GET', headers: {} }]);
    // The image never goes through the global fetch; the interaction does.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(interactionCall()[0]).toBe(INTERACTIONS_URL);

    const body = JSON.parse(interactionCall()[1].body);
    expect(body.input).toEqual([
      { type: 'image', data: JPEG_BYTES.toString('base64'), mime_type: 'image/jpeg' },
      { type: 'image', uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc123' },
      { type: 'text', text: 'p' },
    ]);
  });

  it('refuses an http image URL and a name with a private address before connecting', async () => {
    let connected = 0;
    const connector: EgressConnector = async () => {
      connected += 1;
      return answer(200, { 'content-type': 'image/png' }, PNG_BYTES);
    };
    const lookup = async (hostname: string) => [
      { address: hostname === 'metadata.internal.example' ? '169.254.169.254' : PUBLIC_V4, family: 4 },
    ];
    await provider.initialize({ apiKey: 'gk-test', imageEgress: { lookup, connector } });

    await expect(
      provider.imageToVideo({ prompt: 'p', image: 'http://cdn.example.com/start.png' }),
    ).rejects.toMatchObject({ reason: 'scheme' });
    await expect(
      provider.imageToVideo({ prompt: 'p', image: 'https://metadata.internal.example/latest' }),
    ).rejects.toMatchObject({ reason: 'private_address' });
    expect(connected).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('checks every redirect of an image URL as its own destination', async () => {
    const seen: string[] = [];
    const connector: EgressConnector = async (req) => {
      seen.push(req.destination.url.href);
      if (req.destination.url.pathname === '/moved') {
        return answer(302, { location: '/start.png' }, Buffer.alloc(0));
      }
      if (req.destination.url.pathname === '/to-private') {
        return answer(301, { location: 'https://metadata.internal.example/latest' }, Buffer.alloc(0));
      }
      return answer(200, { 'content-type': 'image/png' }, PNG_BYTES);
    };
    const lookup = async (hostname: string) => [
      { address: hostname === 'metadata.internal.example' ? '169.254.169.254' : PUBLIC_V4, family: 4 },
    ];
    await provider.initialize({ apiKey: 'gk-test', imageEgress: { lookup, connector } });
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(interaction([{ type: 'video', mime_type: 'video/mp4', data: VIDEO_B64 }])),
    );

    await provider.imageToVideo({ prompt: 'p', image: 'https://cdn.example.com/moved' });
    expect(seen).toEqual(['https://cdn.example.com/moved', 'https://cdn.example.com/start.png']);
    expect(JSON.parse(interactionCall()[1].body).input[0]).toEqual({
      type: 'image',
      data: PNG_BYTES.toString('base64'),
      mime_type: 'image/png',
    });

    seen.length = 0;
    await expect(
      provider.imageToVideo({ prompt: 'p', image: 'https://cdn.example.com/to-private' }),
    ).rejects.toMatchObject({ reason: 'private_address' });
    expect(seen).toEqual(['https://cdn.example.com/to-private']);
  });

  it('refuses image bytes past maxImageBytes across the images of a call', async () => {
    const connector: EgressConnector = async () => answer(200, { 'content-type': 'image/png' }, PNG_BYTES);
    await provider.initialize({
      apiKey: 'gk-test',
      maxImageBytes: PNG_BYTES.length + 4,
      imageEgress: { lookup: resolvesTo(PUBLIC_V4), connector },
    });

    await expect(
      provider.imageToVideo({
        prompt: 'p',
        image: 'https://cdn.example.com/a.png',
        referenceImages: ['https://cdn.example.com/b.png'],
      }),
    ).rejects.toMatchObject({ reason: 'too_large' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('charges the bodies of redirects to maxImageBytes', async () => {
    const connector: EgressConnector = async (req) =>
      req.destination.url.pathname === '/moved'
        ? answer(302, { location: '/start.png' }, Buffer.from('redirect'))
        : answer(200, { 'content-type': 'image/png' }, PNG_BYTES);
    await provider.initialize({
      apiKey: 'gk-test',
      maxImageBytes: PNG_BYTES.length + 4,
      imageEgress: { lookup: resolvesTo(PUBLIC_V4), connector },
    });

    await expect(
      provider.imageToVideo({ prompt: 'p', image: 'https://cdn.example.com/moved' }),
    ).rejects.toMatchObject({ reason: 'too_large' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('counts data: URL images toward maxImageBytes', async () => {
    await provider.initialize({ apiKey: 'gk-test', maxImageBytes: 8 });
    const sixteen = Buffer.alloc(16, 1);

    await expect(
      provider.generateVideo({
        prompt: 'p',
        referenceImages: [`data:image/png;base64,${sixteen.toString('base64')}`],
      }),
    ).rejects.toMatchObject({ reason: 'too_large' });
    await expect(
      provider.generateVideo({ prompt: 'p', referenceImages: [`data:image/svg+xml,${'%41'.repeat(16)}`] }),
    ).rejects.toMatchObject({ reason: 'too_large' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('raises a refused image fetch with its status and without its URL', async () => {
    const connector: EgressConnector = async () => answer(404, {}, Buffer.from('not here'));
    await provider.initialize({ apiKey: 'gk-test', imageEgress: { lookup: resolvesTo(PUBLIC_V4), connector } });

    const error = await provider
      .imageToVideo({ prompt: 'p', image: 'https://cdn.example.com/secret-name.png' })
      .catch((e: Error) => e);
    expect(error.message).toBe('Gemini video provider could not read an image (HTTP 404).');
  });

  it('reads private and http image URLs under the local egress profile', async () => {
    const seen: string[] = [];
    const connector: EgressConnector = async (req) => {
      seen.push(req.destination.url.href);
      return answer(200, { 'content-type': 'image/png' }, PNG_BYTES);
    };
    await provider.initialize({
      apiKey: 'gk-test',
      imageEgress: { profile: 'local', lookup: resolvesTo('10.0.0.8'), connector },
    });
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(interaction([{ type: 'video', mime_type: 'video/mp4', data: VIDEO_B64 }])),
    );

    await provider.imageToVideo({ prompt: 'p', image: 'http://assets.lan:8080/start.png' });

    expect(seen).toEqual(['http://assets.lan:8080/start.png']);
  });

  it('sends a base64 data: URL with escapes, line breaks or the URL-safe alphabet as standard base64', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(interaction([{ type: 'video', mime_type: 'video/mp4', data: VIDEO_B64 }])),
    );
    const bytes = Buffer.from([0xfb, 0xff, 0xbf, 0x01, 0x02, 0x03]);
    expect(bytes.toString('base64')).toBe('+/+/AQID');

    await provider.generateVideo({ prompt: 'p', referenceImages: ['data:image/png;base64,%2B/-_\nAQ%49D'] });

    expect(JSON.parse(interactionCall()[1].body).input[0]).toEqual({
      type: 'image',
      data: '+/+/AQID',
      mime_type: 'image/png',
    });
  });

  it('reads a data: URL whatever the case of its scheme', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(interaction([{ type: 'video', mime_type: 'video/mp4', data: VIDEO_B64 }])),
    );

    await provider.generateVideo({ prompt: 'p', referenceImages: ['DATA:image/webp;base64,UklGRgAAAABXRUJQ'] });

    expect(JSON.parse(interactionCall()[1].body).input[0]).toEqual({
      type: 'image',
      data: 'UklGRgAAAABXRUJQ',
      mime_type: 'image/webp',
    });
  });

  it('decodes a data: URL image that is not base64 encoded', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(interaction([{ type: 'video', mime_type: 'video/mp4', data: VIDEO_B64 }])),
    );

    await provider.generateVideo({
      prompt: 'p',
      referenceImages: ['data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22x%22%2F%3E'],
    });

    expect(JSON.parse(interactionCall()[1].body).input[0]).toEqual({
      type: 'image',
      data: Buffer.from('<svg xmlns="x"/>').toString('base64'),
      mime_type: 'image/svg+xml',
    });
  });

  it('asks for reference-to-video when a prompt comes with reference images and no source image', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(interaction([{ type: 'video', mime_type: 'video/mp4', data: VIDEO_B64 }])),
    );

    await provider.generateVideo({ prompt: 'the cat plays with yarn', referenceImages: [JPEG_BYTES] });

    const body = JSON.parse(interactionCall()[1].body);
    expect(body.input).toEqual([
      { type: 'image', data: JPEG_BYTES.toString('base64'), mime_type: 'image/jpeg' },
      { type: 'text', text: 'the cat plays with yarn' },
    ]);
    expect(body.generation_config).toEqual({ video_config: { task: 'reference_to_video' } });
  });

  it('adds provider options without replacing the model, the input or the video format the call sets', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(interaction([{ type: 'video', mime_type: 'video/mp4', data: VIDEO_B64 }])),
    );

    await provider.generateVideo({
      prompt: 'p',
      aspectRatio: '9:16',
      providerOptions: {
        gemini: {
          model: 'not-this-model',
          input: 'not this input',
          store: true,
          response_format: { aspect_ratio: '16:9', delivery: 'uri' },
          generation_config: { seed: 7 },
        },
        fal: { end_image_url: 'https://cdn.example.com/end.png' },
      },
    });

    expect(JSON.parse(interactionCall()[1].body)).toEqual({
      store: true,
      model: 'gemini-omni-1.1-flash',
      input: 'p',
      response_format: { type: 'video', aspect_ratio: '9:16', delivery: 'uri' },
      generation_config: { seed: 7 },
    });
  });

  it('waits for a video delivered by URI to be ACTIVE, then downloads it with the key', async () => {
    await provider.initialize({ apiKey: 'gk-test', pollIntervalMs: 1 });
    const uri = 'https://generativelanguage.googleapis.com/v1beta/files/vid9';
    const VIDEO_BYTES = Buffer.from('mp4-file-bytes');
    fetchSpy
      .mockResolvedValueOnce(jsonResponse(interaction([{ type: 'video', mime_type: 'video/mp4', uri }])))
      .mockResolvedValueOnce(jsonResponse({ name: 'files/vid9', state: 'PROCESSING' }))
      .mockResolvedValueOnce(jsonResponse({ name: 'files/vid9', state: 'ACTIVE' }))
      .mockResolvedValueOnce(imageResponse(VIDEO_BYTES, 'video/mp4'));

    const result = await provider.generateVideo({
      prompt: 'p',
      providerOptions: { gemini: { response_format: { delivery: 'uri' } } },
    });

    const calls = fetchSpy.mock.calls as Array<[string, any]>;
    expect(calls.map(([url]) => url)).toEqual([
      INTERACTIONS_URL,
      'https://generativelanguage.googleapis.com/v1beta/files/vid9',
      'https://generativelanguage.googleapis.com/v1beta/files/vid9',
      'https://generativelanguage.googleapis.com/v1beta/files/vid9:download?alt=media',
    ]);
    for (const [, init] of calls.slice(1)) {
      expect(init.headers['x-goog-api-key']).toBe('gk-test');
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
    expect(result.videos[0].base64).toBe(VIDEO_BYTES.toString('base64'));
    expect(result.videos[0].url).toBeUndefined();
    expect(result.videos[0].providerMetadata).toMatchObject({ interactionId: 'int-1', fileUri: uri });
  });

  it('polls and downloads a file with the key that generated it', async () => {
    // Files belong to the project of the key that made them
    // (https://ai.google.dev/api/files), so a pool of keys from several
    // projects must not switch keys between the interaction and the file.
    await provider.initialize({ apiKey: 'gk-a,gk-b', pollIntervalMs: 1 });
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse(interaction([{ type: 'video', mime_type: 'video/mp4', uri: 'files/vid9' }])),
      )
      .mockResolvedValueOnce(jsonResponse({ name: 'files/vid9', state: 'PROCESSING' }))
      .mockResolvedValueOnce(jsonResponse({ name: 'files/vid9', state: 'PROCESSING' }))
      .mockResolvedValueOnce(jsonResponse({ name: 'files/vid9', state: 'ACTIVE' }))
      .mockResolvedValueOnce(imageResponse(Buffer.from('mp4'), 'video/mp4'));

    await provider.generateVideo({ prompt: 'p' });

    const keys = (fetchSpy.mock.calls as Array<[string, any]>).map(([, init]) => init.headers['x-goog-api-key']);
    expect(keys).toHaveLength(5);
    expect(new Set(keys).size).toBe(1);
  });

  it('raises a video delivered by URI whose file fails processing', async () => {
    await provider.initialize({ apiKey: 'gk-test', pollIntervalMs: 1 });
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse(interaction([{ type: 'video', mime_type: 'video/mp4', uri: 'files/vid9' }])),
      )
      .mockResolvedValueOnce(jsonResponse({ name: 'files/vid9', state: 'FAILED' }));

    await expect(provider.generateVideo({ prompt: 'p' })).rejects.toThrow(
      'Gemini video file files/vid9 failed processing.',
    );
  });

  it('refuses a background interaction, which it does not poll', async () => {
    await expect(
      provider.generateVideo({ prompt: 'p', providerOptions: { gemini: { background: true } } }),
    ).rejects.toThrow(/does not run background interactions/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses a background interaction before it fetches any image', async () => {
    let connected = 0;
    const connector: EgressConnector = async () => {
      connected += 1;
      return answer(200, { 'content-type': 'image/jpeg' }, JPEG_BYTES);
    };
    await provider.initialize({ apiKey: 'gk-test', imageEgress: { lookup: resolvesTo(PUBLIC_V4), connector } });

    await expect(
      provider.imageToVideo({
        prompt: 'p',
        image: 'https://cdn.example.com/start.jpg',
        referenceImages: ['https://cdn.example.com/ref.jpg'],
        providerOptions: { gemini: { background: true } },
      }),
    ).rejects.toThrow(/does not run background interactions/);
    expect(connected).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('runs a configured model', async () => {
    await provider.initialize({ apiKey: 'gk-test', defaultModelId: 'gemini-omni-flash-next' });
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(interaction([{ type: 'video', mime_type: 'video/mp4', data: VIDEO_B64 }])),
    );

    const result = await provider.generateVideo({ prompt: 'p' });

    expect(JSON.parse(interactionCall()[1].body).model).toBe('gemini-omni-flash-next');
    expect(result.modelId).toBe('gemini-omni-flash-next');
  });

  it('raises an interaction that ends without completing', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ ...interaction([]), status: 'cancelled' }));

    await expect(provider.generateVideo({ prompt: 'p' })).rejects.toThrow(
      /Gemini video generation ended with status cancelled\./,
    );
  });

  it('raises an interaction with no status, even when it holds a video', async () => {
    // `status` is a required field of the Interaction resource
    // (https://ai.google.dev/api/interactions-api); a reply without it is not a completed one.
    const { status: _status, ...noStatus } = interaction([
      { type: 'video', mime_type: 'video/mp4', data: VIDEO_B64 },
    ]);
    fetchSpy.mockResolvedValueOnce(jsonResponse(noStatus));

    await expect(provider.generateVideo({ prompt: 'p' })).rejects.toThrow(
      'Gemini video generation ended with no status.',
    );
  });

  it('raises the messages of the errors a failed interaction records', async () => {
    // The Interaction resource records its faults in `errors`, a list of
    // `{ code, message }` (https://ai.google.dev/api/interactions-api).
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        ...interaction([]),
        status: 'failed',
        errors: [
          { code: 'https://example.com/errors/safety', message: 'The prompt was blocked.' },
          { message: 'No video was generated.' },
        ],
      }),
    );

    await expect(provider.generateVideo({ prompt: 'p' })).rejects.toThrow(
      'Gemini video generation ended with status failed: The prompt was blocked.; No video was generated.',
    );
  });

  it('raises a completed interaction with no video', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(interaction([{ type: 'text', text: 'I cannot do that.' }])));

    await expect(provider.generateVideo({ prompt: 'p' })).rejects.toThrow(/returned no video/);
  });

  it('raises the HTTP status and body of a refused request', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ error: { message: 'quota' } }, false, 429));

    await expect(provider.generateVideo({ prompt: 'p' })).rejects.toThrow(
      /Gemini video generation request failed \(429\): .*quota/,
    );
  });

  it('aborts a request that outlives timeoutMs', async () => {
    await provider.initialize({ apiKey: 'gk-test', timeoutMs: 20 });
    fetchSpy.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('The operation was aborted.')));
        }),
    );

    await expect(provider.generateVideo({ prompt: 'p' })).rejects.toThrow(/timed out after 20ms/);
  });

  it('runs a call with a fractional timeoutMs, rounded up to whole milliseconds', async () => {
    await provider.initialize({ apiKey: 'gk-test', timeoutMs: 200.5 });
    fetchSpy.mockImplementationOnce(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => resolve(jsonResponse(interaction([{ type: 'video', mime_type: 'video/mp4', data: VIDEO_B64 }]))),
            20,
          );
          init.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('The operation was aborted.'));
          });
        }),
    );

    const result = await provider.generateVideo({ prompt: 'p' });

    expect(result.videos[0]).toMatchObject({ base64: VIDEO_B64 });
  });

  it('refuses a timeoutMs past the longest timer delay at initialize', async () => {
    const fresh = createVideoProvider('gemini');
    // Node fires a longer timer after 1 ms, which would end every call at once.
    await expect(fresh.initialize({ apiKey: 'gk-test', timeoutMs: 3_000_000_000 })).rejects.toThrow(RangeError);
    await expect(fresh.initialize({ apiKey: 'gk-test', timeoutMs: Number.POSITIVE_INFINITY })).rejects.toThrow(RangeError);
    await expect(fresh.initialize({ apiKey: 'gk-test', timeoutMs: 2_147_483_647 })).resolves.toBeUndefined();
  });

  it('refuses a maxImageBytes that is not finite at initialize', async () => {
    const fresh = createVideoProvider('gemini');
    // An infinite budget would read an image URL without a byte bound.
    await expect(
      fresh.initialize({ apiKey: 'gk-test', maxImageBytes: Number.POSITIVE_INFINITY }),
    ).rejects.toThrow(RangeError);
    await expect(fresh.initialize({ apiKey: 'gk-test', maxImageBytes: 1024 })).resolves.toBeUndefined();
  });

  it('refuses a pollIntervalMs past the longest timer delay at initialize', async () => {
    const fresh = createVideoProvider('gemini');
    // Node fires a longer timer after 1 ms, which would poll the Files API without a pause.
    await expect(fresh.initialize({ apiKey: 'gk-test', pollIntervalMs: 3_000_000_000 })).rejects.toThrow(RangeError);
    await expect(
      fresh.initialize({ apiKey: 'gk-test', pollIntervalMs: Number.POSITIVE_INFINITY }),
    ).rejects.toThrow(RangeError);
    await expect(fresh.initialize({ apiKey: 'gk-test', pollIntervalMs: 2_147_483_647 })).resolves.toBeUndefined();
  });

  it('requires an API key', async () => {
    const fresh = createVideoProvider('gemini');
    await expect(fresh.initialize({})).rejects.toThrow(/requires apiKey/);
    await expect(fresh.initialize({ apiKey: '  ' })).rejects.toThrow(/requires apiKey/);
  });

  it('supports text-to-video and image-to-video', () => {
    expect(provider.providerId).toBe('gemini');
    expect(provider.defaultModelId).toBe('gemini-omni-1.1-flash');
    expect(provider.supports('text-to-video')).toBe(true);
    expect(provider.supports('image-to-video')).toBe(true);
  });

  it('rejects calls before initialize', async () => {
    const fresh = createVideoProvider('gemini');
    await expect(fresh.generateVideo({ prompt: 'p' })).rejects.toThrow(/not initialized/);
  });
});
