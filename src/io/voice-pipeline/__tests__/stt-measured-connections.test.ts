/**
 * Measured hosted transcription connections, end to end over the providers' real wire code: every Deepgram and
 * OpenAI socket is authorized before it is constructed, carries one identity through its periodic and final usage,
 * and converts live and replayed audio to its wire rate. The sockets are fakes that never leave the process; fake
 * time runs only on the runner.
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AudioFrame,
  SttConnectionHooks,
  SttConnectionOpening,
  SttMeasuredUsageEvent,
  StreamingSTTSession,
} from '../types.js';

vi.mock('ws', () => {
  const { EventEmitter: EE } = require('node:events');
  class Socket extends EE {
    static OPEN = 1;
    static CLOSED = 3;
    static instances: Socket[] = [];
    static rejectNext = false;
    static closeOnOpen = false;
    static closeOnFlush = false;
    readyState = 1;
    sent: Array<string | Buffer> = [];
    constructor(readonly url: string, readonly options: { headers: Record<string, string> }) {
      super();
      Socket.instances.push(this);
      const reject = Socket.rejectNext;
      Socket.rejectNext = false;
      process.nextTick(() => {
        if (this.readyState !== 1) return;
        if (reject) {
          this.emit('error', new Error('HTTP 503'));
          return;
        }
        this.emit('open');
        if (Socket.closeOnOpen) {
          Socket.closeOnOpen = false;
          this.drop();
        }
      });
    }
    send(data: string | Buffer): void {
      this.sent.push(data);
      if (typeof data !== 'string') return;
      const event = JSON.parse(data) as { type?: string; session?: unknown };
      if (event.type === 'CloseStream' && Socket.closeOnFlush) process.nextTick(() => this.drop());
      if (event.type === 'session.update') process.nextTick(() => {
        this.emit('message', JSON.stringify({ type: 'session.updated', session: event.session }));
      });
    }
    close(): void { this.readyState = 3; }
    terminate(): void { this.readyState = 3; }
    drop(): void {
      this.readyState = 3;
      this.emit('close', 1006, Buffer.from(''));
    }
  }
  return { default: Socket };
});

import Ws from 'ws';
import { DeepgramStreamingSTT } from '../providers/DeepgramStreamingSTT.js';
import { OpenAIRealtimeTranscriptionSTT } from '../providers/OpenAIRealtimeTranscriptionSTT.js';
import { StreamingSTTChain } from '../providers/StreamingSTTChain.js';
import { SttConnectionAuthorizationError } from '../SttConnectionAuthorizationError.js';
import { StreamResampler } from '../providers/StreamResampler.js';

interface SocketView extends EventEmitter {
  url: string;
  options: { headers: Record<string, string> };
  readyState: number;
  sent: Array<string | Buffer>;
  drop(): void;
}
const sockets = Ws as unknown as { instances: SocketView[]; rejectNext: boolean; closeOnOpen: boolean; closeOnFlush: boolean };
const sessions: StreamingSTTSession[] = [];
const dgEntry = 'deepgram:nova-3';
const oaEntry = 'openai:gpt-4o-mini-transcribe';

/**
 * Capture time of the next frame, in milliseconds: each frame starts where the previous one ended, as captured audio
 * does. The chain's replay ring keeps its last `ringBufferCapacityMs` by these timestamps, and the fake `Date` stands
 * still, so `Date.now()` would give every frame the same one.
 */
let captureMs = 0;
function frame(count = 24_000, rate = 24_000): AudioFrame {
  const timestamp = captureMs;
  captureMs += (count / rate) * 1000;
  return { samples: new Float32Array(count).fill(0.25), sampleRate: rate, timestamp };
}
async function turns(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function dg() {
  return new DeepgramStreamingSTT({
    apiKey: 'fixture', mipOptOut: true, inputSampleRate: 24_000, usageIntervalMs: 100,
  });
}
function oa() {
  return new OpenAIRealtimeTranscriptionSTT({ apiKey: 'fixture', rollover: false, usageIntervalMs: 100 });
}
/** PCM16 samples a socket received: Deepgram's binary frames and OpenAI's base64 appends. */
function pcmSamples(socket: SocketView): number {
  return socket.sent.reduce((total, item) => {
    if (Buffer.isBuffer(item)) return total + item.length / 2;
    const event = JSON.parse(item) as { type?: string; audio?: string };
    return total + (event.type === 'input_audio_buffer.append' ? Buffer.from(event.audio!, 'base64').length / 2 : 0);
  }, 0);
}
function hooks() {
  const openings: SttConnectionOpening[] = [];
  const usage: SttMeasuredUsageEvent[] = [];
  const callbacks: SttConnectionHooks = {
    authorize: async (opening, signal) => {
      signal.throwIfAborted();
      openings.push(opening);
    },
    usage: (event) => { usage.push(event); },
  };
  return { openings, usage, callbacks };
}

beforeEach(() => {
  sockets.instances.length = 0;
  sockets.rejectNext = false;
  sockets.closeOnOpen = false;
  sockets.closeOnFlush = false;
  captureMs = 0;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});
afterEach(() => {
  for (const session of sessions.splice(0)) session.close();
  vi.useRealTimers();
});

describe('measured hosted connections', () => {
  it.each(['deepgram', 'openai'] as const)('deduplicates replay in a long session with %s first', async (firstVendor) => {
    const primary = firstVendor === 'deepgram' ? dg()
      : new OpenAIRealtimeTranscriptionSTT({ apiKey: 'fixture', rollover: false, maxRetries: 0 });
    const backup = firstVendor === 'deepgram' ? oa() : dg();
    Object.defineProperty(primary, 'priority', { value: 1 }); Object.defineProperty(backup, 'priority', { value: 2 });
    const seen = hooks();
    const session = await new StreamingSTTChain([primary, backup], {
      enableMidUtteranceFailover: true, ringBufferCapacityMs: 3000, minReplayMs: 1,
    }).startSession({ language: 'en', connectionHooks: seen.callbacks });
    sessions.push(session);
    const finals: Array<{ text: string; startMs: number; endMs: number; itemId: string }> = [];
    session.on('transcript', (event) => { if (event.isFinal) finals.push(event); });
    const emit = (socket: SocketView, vendor: string, id: string, startMs: number, endMs: number): void => {
      const wire = (event: unknown) => socket.emit('message', JSON.stringify(event));
      if (vendor === 'deepgram') wire({ type: 'Results', start: startMs / 1000,
        duration: (endMs - startMs) / 1000, is_final: true, speech_final: true,
        channel: { alternatives: [{ transcript: 'Repeated words', confidence: 1, words: [] }] } });
      else {
        wire({ type: 'input_audio_buffer.speech_started', item_id: id, audio_start_ms: startMs });
        wire({ type: 'input_audio_buffer.speech_stopped', item_id: id, audio_end_ms: endMs });
        wire({ type: 'input_audio_buffer.committed', item_id: id });
        wire({ type: 'conversation.item.input_audio_transcription.completed', item_id: id, transcript: 'Repeated words' });
      }
    };
    for (let i = 0; i < 12; i++) await session.pushAudio(frame());
    emit(sockets.instances[0]!, firstVendor, 'first', 10000, 11000);
    expect(finals).toHaveLength(1);
    if (firstVendor === 'deepgram') sockets.instances[0]!.emit('error', new Error('HTTP 503'));
    else sockets.instances[0]!.drop();
    await vi.advanceTimersByTimeAsync(100); await turns();
    expect(sockets.instances).toHaveLength(2);
    const secondVendor = firstVendor === 'deepgram' ? 'openai' : 'deepgram';
    emit(sockets.instances[1]!, secondVendor, 'replay', 1000, 2000);
    expect(finals).toHaveLength(1);
    await session.pushAudio(frame());
    emit(sockets.instances[1]!, secondVendor, 'fresh', 3000, 4000);
    expect(finals.map((event) => [event.startMs, event.endMs])).toEqual([[10000, 11000], [12000, 13000]]);
    expect(new Set(finals.map((event) => event.itemId)).size).toBe(2);
    session.close();
    expect(seen.usage.filter((event) => event.final).map((event) => event.audioSeconds)).toEqual([12, 4]);
  });

  it('preserves Deepgram interim/final identity and handles empty VAD terminals', async () => {
    const session = await dg().startSession({ language: 'es' }); sessions.push(session);
    const socket = sockets.instances[0]!;
    expect(new URL(socket.url).searchParams.get('language')).toBe('es');
    const transcripts: Array<{ itemId?: string; isFinal: boolean; text: string; startMs?: number; endMs?: number }> = [];
    const starts = vi.fn(); const ends = vi.fn();
    session.on('transcript', (event) => transcripts.push(event));
    session.on('speech_start', starts); session.on('speech_end', ends);
    const result = (text: string, final: boolean, terminal: boolean, start = 0) =>
      socket.emit('message', JSON.stringify({ type: 'Results', start, duration: 1,
        is_final: final, speech_final: terminal, channel: { alternatives: [{ transcript: text, confidence: 1, words: [] }] } }));
    result('hola', false, false); result('hola', true, false); result('', true, true);
    expect(transcripts[0]?.itemId).toMatch(/^[a-f0-9-]{36}:1$/);
    expect(transcripts[1]).toMatchObject({ itemId: transcripts[0]!.itemId, text: 'hola', isFinal: true, startMs: 0, endMs: 1000 });
    expect(starts).toHaveBeenCalledTimes(1); expect(ends).toHaveBeenCalledTimes(1);
    result('unfinished', false, false, 2); result('', true, true, 2);
    socket.emit('message', JSON.stringify({ type: 'UtteranceEnd' }));
    expect(transcripts.filter((event) => event.isFinal)).toHaveLength(1);
    result('next', false, false, 3); result('next', true, true, 3);
    expect(transcripts[4]?.itemId).toBe(transcripts[3]?.itemId);
    expect(transcripts[4]?.itemId).not.toBe(transcripts[1]?.itemId);
    expect(starts).toHaveBeenCalledTimes(3); expect(ends).toHaveBeenCalledTimes(3);
  });

  it('tries the allowed backup when Deepgram opens and closes before adoption', async () => {
    sockets.closeOnOpen = true;
    const seen = hooks();
    const first = dg(); const second = oa();
    Object.defineProperty(first, 'priority', { value: 1 });
    Object.defineProperty(second, 'priority', { value: 2 });
    const session = await new StreamingSTTChain([first, second], { enableMidUtteranceFailover: true })
      .startSession({ connectionHooks: seen.callbacks });
    sessions.push(session);
    await session.pushAudio(frame());
    expect(seen.openings.map((opening) => opening.entry)).toEqual([dgEntry, oaEntry]);
    expect(seen.usage.filter((event) => event.final)).toEqual([
      expect.objectContaining({ entry: dgEntry, audioSeconds: 0, final: true }),
    ]);
    expect(pcmSamples(sockets.instances[1]!)).toBe(24000);
  });

  it.each([false, true])('continues funded Deepgram sockets with failover=%s', async (failover) => {
    sockets.closeOnFlush = true;
    const seen = hooks();
    const provider = failover ? new StreamingSTTChain([dg(), oa()], { enableMidUtteranceFailover: true }) : dg();
    const pending = provider.startSession({ language: 'en', connectionHooks: {
      ...seen.callbacks, audioCeiling: () => 1, beforeAudio: (_opening, seconds) => seconds <= 1,
    } });
    const session = await pending; sessions.push(session);
    await session.pushAudio(frame());
    const next = session.pushAudio(frame());
    await vi.advanceTimersByTimeAsync(200); await turns(); await next;
    session.close();
    expect(seen.openings.map((opening) => opening.entry)).toEqual([dgEntry, dgEntry]);
    expect(new Set(seen.openings.map((opening) => opening.connectionId)).size).toBe(2);
    expect(seen.usage.filter((event) => event.final).map((event) => event.audioSeconds)).toEqual([1, 1]);
    expect(sockets.instances.every((socket) => new URL(socket.url).searchParams.get('mip_opt_out') === 'true')).toBe(true);
  });

  it.each(['deepgram', 'openai'] as const)('awaits %s authorization before constructing any socket', async (vendor) => {
    const gate = deferred();
    const seen = hooks();
    const provider = vendor === 'deepgram' ? dg() : oa();
    const pending = provider.startSession({ connectionHooks: {
      ...seen.callbacks,
      authorize: async (opening, signal) => {
        seen.openings.push(opening);
        await gate.promise;
        signal.throwIfAborted();
      },
    } });
    await turns();
    expect(seen.openings).toHaveLength(1);
    expect(seen.openings[0]?.entry).toBe(vendor === 'deepgram' ? dgEntry : oaEntry);
    expect(sockets.instances).toHaveLength(0);
    gate.resolve();
    const session = await pending;
    sessions.push(session);
    session.pushAudio(frame());
    await vi.advanceTimersByTimeAsync(100);
    session.close();
    const id = seen.openings[0]!.connectionId;
    expect(seen.usage.map((event) => [event.connectionId, event.audioSeconds, event.final])).toEqual([
      [id, 1, false], [id, 1, true],
    ]);
    expect(seen.usage.every((event) => event.entry === seen.openings[0]!.entry)).toBe(true);
  });

  it('declares 16 kHz and converts 24 kHz live audio while preserving the opt-out', async () => {
    const seen = hooks();
    const session = await dg().startSession({ connectionHooks: seen.callbacks, providerOptions: { mip_opt_out: false } });
    sessions.push(session);
    session.pushAudio(frame());
    const socket = sockets.instances[0]!;
    const url = new URL(socket.url);
    expect(url.searchParams.get('sample_rate')).toBe('16000');
    expect(url.searchParams.get('mip_opt_out')).toBe('true');
    expect(url.searchParams.has('token')).toBe(false);
    expect(socket.options.headers.Authorization).toBe('Token fixture');
    expect(pcmSamples(socket)).toBe(16_000);
    session.close();
    session.close();
    socket.drop();
    expect(seen.usage.filter((event) => event.final)).toHaveLength(1);
    expect(seen.usage[0]?.audioSeconds).toBe(1);
  });

  it('rejects a declared input-rate mismatch before sending or counting audio', async () => {
    const seen = hooks();
    const session = await dg().startSession({ connectionHooks: seen.callbacks });
    sessions.push(session);
    expect(() => session.pushAudio(frame(16_000, 16_000))).toThrow('input sample rate');
    expect(pcmSamples(sockets.instances[0]!)).toBe(0);
    session.close();
    expect(seen.usage[0]?.audioSeconds).toBe(0);
  });

  it('keeps conversion phase over many short frames', () => {
    const converter = new StreamResampler(16_000);
    let samples = 0;
    for (let i = 0; i < 1000; i++) samples += converter.process(new Float32Array(128), 44_100).length;
    expect(samples).toBe(Math.floor((128_000 - 1) * 16_000 / 44_100) + 1);
    expect(() => converter.process(new Float32Array(1), Number.NaN)).toThrow(RangeError);
    expect(() => converter.process(new Float32Array([Number.NaN]), 24_000)).toThrow(RangeError);
  });

  it.each(['deepgram', 'openai'] as const)('reports a final zero for a failed %s upgrade', async (vendor) => {
    const seen = hooks();
    sockets.rejectNext = true;
    const provider = vendor === 'deepgram' ? dg() : oa();
    await expect(provider.startSession({ connectionHooks: seen.callbacks })).rejects.toThrow();
    expect(seen.usage).toHaveLength(1);
    expect(seen.usage[0]).toMatchObject({
      connectionId: seen.openings[0]!.connectionId, audioSeconds: 0, final: true,
    });
    expect(sockets.instances[0]!.readyState).toBe(3);
  });

  it('refuses authorization without trying another vendor', async () => {
    const chain = new StreamingSTTChain([dg(), oa()], { enableMidUtteranceFailover: true });
    const usage: SttMeasuredUsageEvent[] = [];
    await expect(chain.startSession({ connectionHooks: {
      authorize: async () => { throw new Error('no funding'); },
      usage: (event) => { usage.push(event); },
    } })).rejects.toBeInstanceOf(SttConnectionAuthorizationError);
    expect(sockets.instances).toHaveLength(0);
    expect(usage).toHaveLength(1);
    expect(usage[0]?.entry).toBe(dgEntry);
  });

  it('bounds authorization and ignores a late approval', async () => {
    const gate = deferred();
    const seen = hooks();
    const pending = dg().startSession({ connectionHooks: {
      ...seen.callbacks,
      authorizationTimeoutMs: 25,
      authorize: async (opening) => { seen.openings.push(opening); await gate.promise; },
    } });
    const rejected = expect(pending).rejects.toBeInstanceOf(SttConnectionAuthorizationError);
    await vi.advanceTimersByTimeAsync(25);
    await rejected;
    gate.resolve();
    await turns();
    expect(sockets.instances).toHaveLength(0);
    expect(seen.usage.filter((event) => event.final)).toHaveLength(1);
  });

  it('authorizes OpenAI reconnects with new identities before replaying held audio', async () => {
    const seen = hooks();
    const gate = deferred();
    const session = await oa().startSession({ connectionHooks: {
      ...seen.callbacks,
      authorize: async (opening, signal) => {
        seen.openings.push(opening);
        if (seen.openings.length === 2) await gate.promise;
        signal.throwIfAborted();
      },
    } });
    sessions.push(session);
    session.pushAudio(frame());
    sockets.instances[0]!.drop();
    session.pushAudio(frame());
    await vi.advanceTimersByTimeAsync(100);
    await turns();
    expect(seen.openings).toHaveLength(2);
    expect(sockets.instances).toHaveLength(1);
    gate.resolve();
    await turns();
    expect(sockets.instances).toHaveLength(2);
    expect(pcmSamples(sockets.instances[1]!)).toBe(24_000);
    session.close();
    const finals = seen.usage.filter((event) => event.final);
    expect(finals.map((event) => event.audioSeconds)).toEqual([1, 1]);
    expect(new Set(finals.map((event) => event.connectionId)).size).toBe(2);
  });

  it('authorizes rollover independently of the legacy rollover approval', async () => {
    const seen = hooks();
    const provider = new OpenAIRealtimeTranscriptionSTT({
      apiKey: 'fixture', usageIntervalMs: 100,
      rollover: { afterMs: 1000, deadlineMs: 2000, overlapMs: 100, hardStopMs: 3000 },
    });
    const session = await provider.startSession({ connectionHooks: seen.callbacks });
    sessions.push(session);
    session.pushAudio(frame());
    await vi.advanceTimersByTimeAsync(2000);
    await turns();
    expect(seen.openings).toHaveLength(2);
    session.pushAudio(frame());
    session.close();
    const finals = seen.usage.filter((event) => event.final);
    expect(finals.map((event) => event.audioSeconds)).toEqual([2, 1]);
    expect(new Set(finals.map((event) => event.connectionId)).size).toBe(2);
  });

  it.each(['deepgram', 'openai'] as const)('resamples replay and live frames when %s is the fallback', async (fallback) => {
    // OpenAI first has maxRetries zero, so its dropped socket reaches the chain instead of reconnecting.
    const first = fallback === 'deepgram'
      ? new OpenAIRealtimeTranscriptionSTT({ apiKey: 'fixture', rollover: false, maxRetries: 0 })
      : dg();
    const second = fallback === 'deepgram' ? dg() : oa();
    Object.defineProperty(first, 'priority', { value: 1 });
    Object.defineProperty(second, 'priority', { value: 2 });
    const seen = hooks();
    const chain = new StreamingSTTChain([first, second], { enableMidUtteranceFailover: true, minReplayMs: 1 });
    const gate = deferred();
    const session = await chain.startSession({ connectionHooks: {
      ...seen.callbacks,
      authorize: async (opening, signal) => {
        seen.openings.push(opening);
        if (seen.openings.length === 2) await gate.promise;
        signal.throwIfAborted();
      },
    } });
    sessions.push(session);
    const emitted: SttMeasuredUsageEvent[] = [];
    session.on('usage', (event: SttMeasuredUsageEvent) => { emitted.push(event); });
    await session.pushAudio(frame(12_000));
    const active = sockets.instances[0];
    expect(active).toBeDefined();
    // Deepgram surfaces an established socket's error; OpenAI reports a dropped socket to the chain only once its
    // retries are spent, which maxRetries zero makes at once.
    if (fallback === 'openai') active!.emit('error', new Error('HTTP 503'));
    else {
      active!.drop();
      await vi.advanceTimersByTimeAsync(100);
      await turns();
    }
    await turns();
    expect(seen.openings[1]?.entry).toBe(fallback === 'deepgram' ? dgEntry : oaEntry);
    expect(sockets.instances).toHaveLength(1);
    gate.resolve();
    await turns();
    await session.pushAudio(frame(12_000));
    session.close();
    const rate = fallback === 'deepgram' ? 16_000 : 24_000;
    expect(pcmSamples(sockets.instances[1]!)).toBe(rate);
    const finals = emitted.filter((event) => event.final);
    expect(finals.map((event) => event.audioSeconds)).toEqual([0.5, 1]);
    expect(new Set(finals.map((event) => event.connectionId)).size).toBe(2);
    expect(finals[1]?.entry).toBe(fallback === 'deepgram' ? dgEntry : oaEntry);
  });
});
