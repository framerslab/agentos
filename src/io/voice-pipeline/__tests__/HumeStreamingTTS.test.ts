/**
 * HumeStreamingTTS — WSS input-streaming contract: api_key + no_binary query
 * auth, incremental InputMessage publishes (text / description-on-first /
 * flush / close), TtsOutput audio decode, cancel = local drop + socket close.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('ws', () => {
  const { EventEmitter: EE } = require('node:events');
  class MockWebSocket extends EE {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 1;
    url: string;
    send = vi.fn();
    close = vi.fn();

    constructor(url: string) {
      super();
      this.url = url;
      process.nextTick(() => this.emit('open'));
    }
  }
  return { default: MockWebSocket, WebSocket: MockWebSocket };
});

import { HumeStreamingTTS } from '../providers/HumeStreamingTTS.js';

describe('HumeStreamingTTS', () => {
  let tts: HumeStreamingTTS;

  beforeEach(() => {
    tts = new HumeStreamingTTS({ apiKey: 'hk' });
  });

  it('has correct provider metadata', () => {
    expect(tts.providerId).toBe('hume-octave-stream');
  });

  it('connects with api_key + no_binary and instant_mode off without a voice', async () => {
    const session = await tts.startSession();
    const ws = (session as any).ws;
    expect(ws.url).toContain('wss://api.hume.ai/v0/tts/stream/input');
    expect(ws.url).toContain('api_key=hk');
    expect(ws.url).toContain('no_binary=true');
    expect(ws.url).toContain('instant_mode=false');
  });

  it('enables instant_mode when a voice is configured', async () => {
    const withVoice = new HumeStreamingTTS({ apiKey: 'hk', voice: { id: 'v1' } });
    const session = await withVoice.startSession();
    expect((session as any).ws.url).toContain('instant_mode=true');
  });

  it('publishes incremental text messages', async () => {
    const session = await tts.startSession();
    const ws = (session as any).ws;
    session.pushTokens('Hello ');
    session.pushTokens('there');
    expect(ws.send).toHaveBeenCalledTimes(2);
    expect(JSON.parse(ws.send.mock.calls[0][0]).text).toBe('Hello ');
    expect(JSON.parse(ws.send.mock.calls[1][0]).text).toBe('there');
  });

  it('rides description + voice on the FIRST publish only', async () => {
    const withVoice = new HumeStreamingTTS({ apiKey: 'hk', voice: { id: 'v1' } });
    const session = await withVoice.startSession({
      expressiveness: { instructions: 'gentle, warm' },
    });
    const ws = (session as any).ws;
    session.pushTokens('Hi');
    session.pushTokens(' again');
    const first = JSON.parse(ws.send.mock.calls[0][0]);
    const second = JSON.parse(ws.send.mock.calls[1][0]);
    expect(first.description).toBe('gentle, warm');
    expect(first.voice).toEqual({ id: 'v1', provider: 'HUME_AI' });
    expect(second.description).toBeUndefined();
    expect(second.voice).toBeUndefined();
  });

  it('emits audio chunks decoded from TtsOutput JSON', async () => {
    const session = await tts.startSession();
    const listener = vi.fn();
    session.on('audio', listener);
    const ws = (session as any).ws;
    ws.emit('message', JSON.stringify({
      audio: Buffer.from('hume-mp3').toString('base64'),
      audio_format: 'mp3',
      chunk_index: 0,
    }));
    expect(listener).toHaveBeenCalledOnce();
    const chunk = listener.mock.calls[0][0];
    expect(chunk.audio.equals(Buffer.from('hume-mp3'))).toBe(true);
    expect(chunk.format).toBe('mp3');
  });

  it('flush publishes {flush:true} and resolves on the flush boundary', async () => {
    const session = await tts.startSession();
    const flushListener = vi.fn();
    session.on('flush_complete', flushListener);
    const ws = (session as any).ws;
    session.pushTokens('hi');
    const flushPromise = session.flush();
    expect(JSON.parse(ws.send.mock.calls[1][0]).flush).toBe(true);
    ws.emit('message', JSON.stringify({ type: 'flushed' }));
    await flushPromise;
    expect(flushListener).toHaveBeenCalledOnce();
  });

  it('cancel suppresses subsequent chunks and closes the socket', async () => {
    const session = await tts.startSession();
    const listener = vi.fn();
    session.on('audio', listener);
    const ws = (session as any).ws;
    session.cancel();
    ws.emit('message', JSON.stringify({
      audio: Buffer.from('late').toString('base64'),
      audio_format: 'mp3',
    }));
    expect(listener).not.toHaveBeenCalled();
    expect(ws.close).toHaveBeenCalled();
  });

  it('close publishes {close:true} then closes the socket', async () => {
    const session = await tts.startSession();
    const ws = (session as any).ws;
    session.close();
    expect(JSON.parse(ws.send.mock.calls[0][0]).close).toBe(true);
    expect(ws.close).toHaveBeenCalled();
  });
});
