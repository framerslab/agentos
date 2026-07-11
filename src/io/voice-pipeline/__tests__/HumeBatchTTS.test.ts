/**
 * HumeBatchTTS — X-Hume-Api-Key auth, version OMITTED by default (version 2
 * requires an explicit voice), instructions→description rendering with
 * appliedExpressiveness reporting, voice/speed mapping, base64 decode,
 * vendor-duration passthrough, failure surfacing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HumeBatchTTS } from '../providers/HumeBatchTTS.js';

const gen = (audioB64: string) =>
  new Response(
    JSON.stringify({
      generations: [
        { audio: audioB64, duration: 1.5, encoding: { format: 'mp3' }, generation_id: 'g1' },
      ],
    }),
    { status: 200 }
  );

describe('HumeBatchTTS', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => gen(Buffer.from('abcd').toString('base64'))));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const call = () =>
    (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];

  it('authenticates with X-Hume-Api-Key and OMITS version by default', async () => {
    const tts = new HumeBatchTTS({ apiKey: 'hk' });
    await tts.synthesize('hello');
    const [url, init] = call();
    expect(url).toBe('https://api.hume.ai/v0/tts');
    expect((init.headers as Record<string, string>)['X-Hume-Api-Key']).toBe('hk');
    const body = JSON.parse(init.body as string);
    expect(body.version).toBeUndefined();
    expect(body.utterances[0].text).toBe('hello');
    expect(body.utterances[0].description).toBeUndefined();
  });

  it('renders instructions as description and reports it consumed', async () => {
    const tts = new HumeBatchTTS({ apiKey: 'hk' });
    const res = await tts.synthesize('hello', {
      expressiveness: { instructions: 'urgent whisper' },
    });
    const body = JSON.parse(call()[1].body as string);
    expect(body.utterances[0].description).toBe('urgent whisper');
    expect(res.appliedExpressiveness).toContain('instructions');
  });

  it('maps voice + speed and decodes base64 audio', async () => {
    const tts = new HumeBatchTTS({ apiKey: 'hk', voice: { id: 'v9' } });
    const res = await tts.synthesize('hello', { speed: 1.3 });
    const body = JSON.parse(call()[1].body as string);
    expect(body.utterances[0].voice).toEqual({ id: 'v9', provider: 'HUME_AI' });
    expect(body.utterances[0].speed).toBe(1.3);
    expect(res.audio.equals(Buffer.from('abcd'))).toBe(true);
    expect(res.appliedExpressiveness).toContain('speed');
  });

  it('maps config.voice string to a name-addressed hume voice', async () => {
    const tts = new HumeBatchTTS({ apiKey: 'hk' });
    await tts.synthesize('hello', { voice: 'Ava Song' });
    const body = JSON.parse(call()[1].body as string);
    expect(body.utterances[0].voice).toEqual({ name: 'Ava Song', provider: 'HUME_AI' });
  });

  it('passes providerOptions.version through (caller owns the voice constraint)', async () => {
    const tts = new HumeBatchTTS({ apiKey: 'hk', voice: { id: 'v9' } });
    await tts.synthesize('hello', { providerOptions: { version: '2' } });
    expect(JSON.parse(call()[1].body as string).version).toBe('2');
  });

  it('requests pcm when asked and reports the produced format', async () => {
    const tts = new HumeBatchTTS({ apiKey: 'hk' });
    const res = await tts.synthesize('hello', { format: 'pcm' });
    const body = JSON.parse(call()[1].body as string);
    expect(body.format).toEqual({ type: 'pcm' });
    expect(res.format).toBe('pcm');
  });

  it('uses vendor duration when present', async () => {
    const tts = new HumeBatchTTS({ apiKey: 'hk' });
    const res = await tts.synthesize('hello');
    expect(res.durationMs).toBe(1500);
  });

  it('throws with status + excerpt on failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad', { status: 429 })));
    const tts = new HumeBatchTTS({ apiKey: 'hk' });
    await expect(tts.synthesize('x')).rejects.toThrow(/429/);
  });

  it('throws a determinate error when generations come back empty', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ generations: [] }), { status: 200 })));
    const tts = new HumeBatchTTS({ apiKey: 'hk' });
    await expect(tts.synthesize('x')).rejects.toThrow(/no generations/i);
  });
});
