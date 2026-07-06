import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { DeepgramAuraBatchTTS, chunkForAura } from '../providers/DeepgramAuraBatchTTS.js';

describe('DeepgramAuraBatchTTS', () => {
  let tts: DeepgramAuraBatchTTS;

  beforeEach(() => {
    mockFetch.mockReset();
    tts = new DeepgramAuraBatchTTS({ apiKey: 'dg_key' });
  });

  it('has providerId deepgram-aura', () => {
    expect(tts.providerId).toBe('deepgram-aura');
  });

  it('posts to /v1/speak with Token auth and the model query param', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer),
    });

    const res = await tts.synthesize('hello world', { voice: 'aura-2-thalia-en', format: 'mp3' });

    expect(res.provider).toBe('deepgram-aura');
    expect(res.format).toBe('mp3');
    expect(res.audio).toBeInstanceOf(Buffer);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('https://api.deepgram.com/v1/speak');
    expect(url).toContain('model=aura-2-thalia-en');
    expect(opts.headers.Authorization).toBe('Token dg_key');
    expect(JSON.parse(opts.body)).toEqual({ text: 'hello world' });
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it('chunks text over 2000 chars into multiple requests and concatenates audio', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new Uint8Array([9]).buffer),
    });

    const long = 'Sentence one. '.repeat(200); // ~2800 chars
    const res = await tts.synthesize(long, { voice: 'aura-2-arcas-en' });

    expect(mockFetch.mock.calls.length).toBeGreaterThan(1);
    // each mocked chunk returns exactly one byte, so the concatenated
    // length equals the number of requests made.
    expect(res.audio.byteLength).toBe(mockFetch.mock.calls.length);
  });

  it('fires chunk requests concurrently and concatenates in chunk order', async () => {
    const resolvers: Array<
      (value: { ok: boolean; arrayBuffer: () => Promise<ArrayBuffer> }) => void
    > = [];
    mockFetch.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const long = 'Sentence one. '.repeat(200); // ~2800 chars -> 2 chunks
    const pending = tts.synthesize(long, { voice: 'aura-2-arcas-en' });

    // Both requests must be in flight BEFORE any response resolves —
    // a sequential loop would have issued only the first call here.
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));

    // Resolve out of order; concatenated audio must stay in chunk order.
    resolvers[1]({ ok: true, arrayBuffer: () => Promise.resolve(new Uint8Array([2]).buffer) });
    resolvers[0]({ ok: true, arrayBuffer: () => Promise.resolve(new Uint8Array([1]).buffer) });

    const res = await pending;
    expect(Array.from(new Uint8Array(res.audio))).toEqual([1, 2]);
  });

  it('bounds concurrency: never more than 4 requests in flight, order preserved', async () => {
    let inFlight = 0;
    let peak = 0;
    let pendingResolvers: Array<() => void> = [];
    mockFetch.mockImplementation(
      () =>
        new Promise<{ ok: boolean; arrayBuffer: () => Promise<ArrayBuffer> }>((resolve) => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          const callIndex = mockFetch.mock.calls.length - 1;
          pendingResolvers.push(() => {
            inFlight -= 1;
            resolve({
              ok: true,
              arrayBuffer: () => Promise.resolve(new Uint8Array([callIndex & 0xff]).buffer),
            });
          });
        }),
    );

    // 'x' has no sentence/space boundary, so chunkForAura hard-cuts at 2000
    // chars — 20 chunks here, well over the concurrency cap of 4.
    const long = 'x'.repeat(2000 * 20);
    let done = false;
    const pending = tts.synthesize(long, { voice: 'aura-2-arcas-en' }).then((r) => {
      done = true;
      return r;
    });

    // Drain until the whole run settles: release everything currently in
    // flight, yield so freed workers can pull their next chunk, repeat. This
    // is settle-driven (not "queue momentarily empty") so a worker that
    // re-fetches after a wave can't strand `pending`. Every observation of
    // inFlight must respect the cap.
    for (let guard = 0; guard < 500 && !done; guard++) {
      expect(inFlight).toBeLessThanOrEqual(4);
      const wave = pendingResolvers;
      pendingResolvers = [];
      wave.forEach((r) => r());
      // Let the freed workers finish arrayBuffer() + loop + re-fetch.
      for (let t = 0; t < 4; t++) await Promise.resolve();
    }
    await pending;
    expect(done).toBe(true); // never stranded
    expect(peak).toBeLessThanOrEqual(4); // cap held
    expect(peak).toBeGreaterThan(1); // and it did run concurrently
  });

  it('throws a classified error on non-2xx', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('bad'),
    });
    await expect(tts.synthesize('x')).rejects.toThrow(/Deepgram Aura/i);
  });

  it('chunkForAura splits long text into <= max-length pieces', () => {
    const chunks = chunkForAura('A sentence here. '.repeat(300), 2000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(2000);
  });

  it('chunkForAura never exceeds max with no boundaries or a boundary at max', () => {
    // No spaces — forces the hard-cut fallback.
    for (const c of chunkForAura('x'.repeat(5000), 2000)) {
      expect(c.length).toBeLessThanOrEqual(2000);
    }
    // A sentence boundary landing exactly at the max must not push a max+1 chunk.
    const boundaryAtMax = 'a'.repeat(1999) + '. ' + 'b'.repeat(2500);
    for (const c of chunkForAura(boundaryAtMax, 2000)) {
      expect(c.length).toBeLessThanOrEqual(2000);
    }
  });

  it('chunkForAura returns a single chunk for short text', () => {
    expect(chunkForAura('short', 2000)).toEqual(['short']);
  });
});
