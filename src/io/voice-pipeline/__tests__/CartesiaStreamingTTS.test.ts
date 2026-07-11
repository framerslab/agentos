/**
 * CartesiaStreamingTTS — WS request shape (pinned version + api_key query),
 * incremental context messages, chunk decode, flush via continue:false + done,
 * HARD-cancel semantics (post-cancel chunk suppression + context rotation),
 * error surfacing.
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

import { CartesiaStreamingTTS } from '../providers/CartesiaStreamingTTS.js';
import { CARTESIA_VERSION } from '../providers/CartesiaBatchTTS.js';

describe('CartesiaStreamingTTS', () => {
  let tts: CartesiaStreamingTTS;

  beforeEach(() => {
    tts = new CartesiaStreamingTTS({ apiKey: 'sk_car_x', voiceId: 'v1' });
  });

  it('has correct provider metadata', () => {
    expect(tts.providerId).toBe('cartesia-sonic-stream');
  });

  it('connects with the pinned version + api key in the query', async () => {
    const session = await tts.startSession();
    const ws = (session as any).ws;
    expect(ws.url).toContain('wss://api.cartesia.ai/tts/websocket');
    expect(ws.url).toContain(`cartesia_version=${CARTESIA_VERSION}`);
    expect(ws.url).toContain('api_key=sk_car_x');
  });

  it('sends incremental transcript messages carrying context_id + continue', async () => {
    const session = await tts.startSession();
    const ws = (session as any).ws;
    session.pushTokens('Hello ');
    session.pushTokens('world');
    expect(ws.send).toHaveBeenCalledTimes(2);
    const first = JSON.parse(ws.send.mock.calls[0][0]);
    const second = JSON.parse(ws.send.mock.calls[1][0]);
    expect(first.transcript).toBe('Hello ');
    expect(first['continue']).toBe(true);
    expect(first.model_id).toBe('sonic-3.5');
    expect(first.voice).toEqual({ mode: 'id', id: 'v1' });
    expect(typeof first.context_id).toBe('string');
    expect(second.context_id).toBe(first.context_id);
  });

  it('emits audio chunks decoded from base64', async () => {
    const session = await tts.startSession();
    const listener = vi.fn();
    session.on('audio', listener);
    const ws = (session as any).ws;
    session.pushTokens('hi');
    const ctx = JSON.parse(ws.send.mock.calls[0][0]).context_id;
    ws.emit('message', JSON.stringify({
      type: 'chunk',
      context_id: ctx,
      data: Buffer.from('pcm-bytes').toString('base64'),
      done: false,
    }));
    expect(listener).toHaveBeenCalledOnce();
    const chunk = listener.mock.calls[0][0];
    expect(Buffer.isBuffer(chunk.audio)).toBe(true);
    expect(chunk.audio.equals(Buffer.from('pcm-bytes'))).toBe(true);
    expect(chunk.format).toBe('pcm');
    expect(chunk.sampleRate).toBe(16000);
  });

  it('flush sends continue:false and resolves on done', async () => {
    const session = await tts.startSession();
    const flushListener = vi.fn();
    session.on('flush_complete', flushListener);
    const ws = (session as any).ws;
    session.pushTokens('hi');
    const ctx = JSON.parse(ws.send.mock.calls[0][0]).context_id;
    const flushPromise = session.flush();
    const finishMsg = JSON.parse(ws.send.mock.calls[1][0]);
    expect(finishMsg['continue']).toBe(false);
    expect(finishMsg.context_id).toBe(ctx);
    ws.emit('message', JSON.stringify({ type: 'done', context_id: ctx }));
    await flushPromise;
    expect(flushListener).toHaveBeenCalledOnce();
  });

  it('HARD-cancels: suppresses post-cancel chunks and rotates the context id', async () => {
    const session = await tts.startSession();
    const listener = vi.fn();
    session.on('audio', listener);
    const ws = (session as any).ws;
    session.pushTokens('speech one');
    const ctx1 = JSON.parse(ws.send.mock.calls[0][0]).context_id;

    session.cancel();
    // Best-effort vendor cancel went out for the dead context.
    const cancelMsg = JSON.parse(ws.send.mock.calls[1][0]);
    expect(cancelMsg).toEqual({ context_id: ctx1, cancel: true });

    // In-flight chunk for the dead context arrives late — MUST be dropped.
    ws.emit('message', JSON.stringify({
      type: 'chunk', context_id: ctx1,
      data: Buffer.from('late').toString('base64'), done: false,
    }));
    expect(listener).not.toHaveBeenCalled();

    // Next synthesis uses a FRESH context.
    session.pushTokens('speech two');
    const ctx2 = JSON.parse(ws.send.mock.calls[2][0]).context_id;
    expect(ctx2).not.toBe(ctx1);

    // Chunks for the new context flow.
    ws.emit('message', JSON.stringify({
      type: 'chunk', context_id: ctx2,
      data: Buffer.from('fresh').toString('base64'), done: false,
    }));
    expect(listener).toHaveBeenCalledOnce();
  });

  it('emits error on vendor error messages', async () => {
    const session = await tts.startSession();
    const errListener = vi.fn();
    session.on('error', errListener);
    const ws = (session as any).ws;
    session.pushTokens('hi');
    const ctx = JSON.parse(ws.send.mock.calls[0][0]).context_id;
    ws.emit('message', JSON.stringify({ type: 'error', context_id: ctx, error: 'boom' }));
    expect(errListener).toHaveBeenCalledOnce();
  });

  it('close terminates the socket', async () => {
    const session = await tts.startSession();
    const ws = (session as any).ws;
    session.close();
    expect(ws.close).toHaveBeenCalled();
  });
});
