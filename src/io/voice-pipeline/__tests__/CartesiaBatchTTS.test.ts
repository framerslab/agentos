/**
 * CartesiaBatchTTS — request shape (Bearer + pinned version header), format
 * mapping (pcm→raw/pcm_s16le, opus→mp3 fallback), generation_config speed
 * clamp, appliedExpressiveness contract, failure surfacing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CartesiaBatchTTS, CARTESIA_VERSION } from '../providers/CartesiaBatchTTS.js';

const okAudio = () => new Response(new Uint8Array([1, 2, 3, 4]).buffer, { status: 200 });

describe('CartesiaBatchTTS', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => okAudio()));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends Bearer auth + pinned version header + sonic-3.5 default', async () => {
    const tts = new CartesiaBatchTTS({ apiKey: 'sk_car_x', voiceId: 'v1' });
    await tts.synthesize('hello');
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.cartesia.ai/tts/bytes');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk_car_x');
    expect(headers['Cartesia-Version']).toBe(CARTESIA_VERSION);
    const body = JSON.parse(init.body as string);
    expect(body.model_id).toBe('sonic-3.5');
    expect(body.transcript).toBe('hello');
    expect(body.voice).toEqual({ mode: 'id', id: 'v1' });
    expect(body.output_format.container).toBe('mp3');
  });

  it('maps pcm to raw/pcm_s16le at the configured sample rate', async () => {
    const tts = new CartesiaBatchTTS({ apiKey: 'k', voiceId: 'v1', pcmSampleRate: 16000 });
    const res = await tts.synthesize('hi', { format: 'pcm' });
    const body = JSON.parse(((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.output_format).toEqual({ container: 'raw', encoding: 'pcm_s16le', sample_rate: 16000 });
    expect(res.format).toBe('pcm');
  });

  it('opus falls back to mp3 and reports the produced format', async () => {
    const tts = new CartesiaBatchTTS({ apiKey: 'k', voiceId: 'v1' });
    const res = await tts.synthesize('hi', { format: 'opus' });
    const body = JSON.parse(((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.output_format.container).toBe('mp3');
    expect(res.format).toBe('mp3');
  });

  it('clamps caller speed into generation_config and reports it consumed', async () => {
    const tts = new CartesiaBatchTTS({ apiKey: 'k', voiceId: 'v1' });
    const res = await tts.synthesize('hi', { speed: 9 });
    const body = JSON.parse(((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.generation_config.speed).toBe(1.5);
    expect(res.appliedExpressiveness).toEqual(['speed']);
  });

  it('does NOT report instructions (no surface) and omits appliedExpressiveness without caller knobs', async () => {
    const tts = new CartesiaBatchTTS({ apiKey: 'k', voiceId: 'v1' });
    const res = await tts.synthesize('hi', { expressiveness: { instructions: 'whisper' } });
    expect(res.appliedExpressiveness).toBeUndefined();
  });

  it('respects config voice + model overrides', async () => {
    const tts = new CartesiaBatchTTS({ apiKey: 'k', voiceId: 'v1' });
    await tts.synthesize('hi', { voice: 'v2', model: 'sonic-3' });
    const body = JSON.parse(((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.voice).toEqual({ mode: 'id', id: 'v2' });
    expect(body.model_id).toBe('sonic-3');
  });

  it('throws with status + body excerpt on failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 402 })));
    const tts = new CartesiaBatchTTS({ apiKey: 'k', voiceId: 'v1' });
    await expect(tts.synthesize('hi')).rejects.toThrow(/402/);
  });
});
