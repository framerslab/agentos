/**
 * SimliAvatarProvider — control-plane contract: /compose/token minting with
 * x-simli-api-key auth + documented defaults, /compose/ice mapping, handle
 * shape for client-delegated consumers, error surfacing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SimliAvatarProvider } from '../providers/SimliAvatarProvider.js';

const tokenRes = () =>
  new Response(JSON.stringify({ session_token: 'st-1' }), { status: 200 });
const iceRes = () =>
  new Response(
    JSON.stringify([{ urls: ['turn:x'], username: 'u', credential: 'c' }]),
    { status: 200 }
  );

describe('SimliAvatarProvider', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => (String(url).includes('/compose/ice') ? iceRes() : tokenRes()))
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('exposes provider metadata + capabilities', () => {
    const p = new SimliAvatarProvider({ apiKey: 'sk' });
    expect(p.providerId).toBe('simli');
    expect(p.capabilities.mediaModes).toEqual(['client-delegated', 'server-driven']);
    expect(p.capabilities.audioFormat).toBe('pcm16');
    expect(p.capabilities.sampleRate).toBe(16000);
  });

  it('mints a session with x-simli-api-key + documented defaults', async () => {
    const p = new SimliAvatarProvider({ apiKey: 'sk' });
    const handle = await p.createSession({ faceId: 'face-1' });
    const tokenCall = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
      String(c[0]).endsWith('/compose/token')
    )!;
    const init = tokenCall[1] as RequestInit;
    expect((init.headers as Record<string, string>)['x-simli-api-key']).toBe('sk');
    const body = JSON.parse(init.body as string);
    expect(body.faceId).toBe('face-1');
    expect(body.apiVersion).toBe('v2');
    expect(body.handleSilence).toBe(true);
    expect(body.audioInputFormat).toBe('pcm16');
    expect(handle.sessionToken).toBe('st-1');
    expect(handle.audioFormat).toBe('pcm16');
    expect(handle.sampleRate).toBe(16000);
    expect(handle.iceServers[0].urls).toEqual(['turn:x']);
  });

  it('honors session-length overrides + providerOptions passthrough', async () => {
    const p = new SimliAvatarProvider({ apiKey: 'sk' });
    await p.createSession({
      faceId: 'f',
      maxSessionLengthSec: 600,
      maxIdleTimeSec: 60,
      providerOptions: { startFrame: 3 },
    });
    const tokenCall = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
      String(c[0]).endsWith('/compose/token')
    )!;
    const body = JSON.parse((tokenCall[1] as RequestInit).body as string);
    expect(body.maxSessionLength).toBe(600);
    expect(body.maxIdleTime).toBe(60);
    expect(body.startFrame).toBe(3);
  });

  it('config sampleRate override flows into the handle (rate is not vendor-pinned)', async () => {
    const p = new SimliAvatarProvider({ apiKey: 'sk', sampleRate: 24000 });
    const handle = await p.createSession({ faceId: 'f' });
    expect(handle.sampleRate).toBe(24000);
    expect(p.capabilities.sampleRate).toBe(24000);
  });

  it('getIceServers maps the documented shape', async () => {
    const p = new SimliAvatarProvider({ apiKey: 'sk' });
    const ice = await p.getIceServers();
    expect(ice).toEqual([{ urls: ['turn:x'], username: 'u', credential: 'c' }]);
  });

  it('throws with status + excerpt on token failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('denied', { status: 401 })));
    const p = new SimliAvatarProvider({ apiKey: 'bad' });
    await expect(p.createSession({ faceId: 'f' })).rejects.toThrow(/401/);
  });
});
