import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { TelephonyStreamTransport } from '../TelephonyStreamTransport.js';
import { TwilioMediaStreamParser } from '../parsers/TwilioMediaStreamParser.js';
import { TelnyxMediaStreamParser } from '../parsers/TelnyxMediaStreamParser.js';
import { PlivoMediaStreamParser } from '../parsers/PlivoMediaStreamParser.js';
import { convertPcmToMulaw8k } from '../telephony-audio.js';
import { VoicePipelineOrchestrator } from '../../../voice-pipeline/VoicePipelineOrchestrator.js';
import type { EncodedAudioChunk } from '../../../voice-pipeline/types.js';
import { CarrierSocket, startFrame, audioChunk } from './research-row-04-telephony-audio.test.js';

describe('carrier playback and start authority', () => {
  it('refuses unauthenticated starts and audio before the first admitted start', () => {
    const ws = new CarrierSocket(); const audio = vi.fn(); const t = new TelephonyStreamTransport(ws, new TwilioMediaStreamParser({ protocol: 'carrier' }), { protocol: 'carrier', authorizeStart: () => false });
    t.on('audio', audio); t.on('error', () => undefined);
    ws.emit('message', '{"event":"media","streamSid":"s","media":{"payload":"/w=="}}');
    ws.emit('message', startFrame()); expect(audio).not.toHaveBeenCalled(); expect(t.state).toBe('closed'); expect(ws.sent).toEqual([]);
  });
  it('bounds pending output, invalidates before clear and ignores cleared or foreign marks', async () => {
    const ws = new CarrierSocket(); const played = vi.fn(); const t = new TelephonyStreamTransport(ws, new TwilioMediaStreamParser({ protocol: 'carrier' }), { protocol: 'carrier', authorizeStart: () => true }); t.on('playback', played); ws.emit('message', startFrame());
    const first = t.sendAudio(audioChunk()); const rejected = expect(first).rejects.toThrow('cleared');
    await vi.waitFor(() => expect(ws.sent.some((m) => m.event === 'mark')).toBe(true));
    const mark = ws.sent.find((m) => m.event === 'mark')!.mark;
    await expect(t.sendAudio(audioChunk())).rejects.toThrow('concurrent producer');
    await t.sendControl({ type: 'barge_in', action: { type: 'cancel' } }); await rejected;
    expect(ws.sent[ws.sent.length - 1]).toEqual({ event: 'clear', streamSid: 's' });
    ws.emit('message', JSON.stringify({ event: 'mark', streamSid: 's', mark }));
    expect(played).not.toHaveBeenCalled();
    await expect(t.sendAudio(audioChunk())).rejects.toThrow('stale generation');
    await expect(t.sendAudio({ ...audioChunk(), generation: undefined })).rejects.toThrow("missing generation"); const next = { ...audioChunk(), generation: { workerGeneration: 1, inferenceGeneration: 2, transportEpoch: 1 } };
    const work = t.sendAudio(next);
    await vi.waitFor(() => expect(ws.sent.filter((m) => m.event === 'mark')).toHaveLength(2));
    const current = ws.sent.filter((m) => m.event === 'mark')[1]!.mark;
    ws.emit('message', JSON.stringify({ event: 'mark', streamSid: 'foreign', mark: current })); expect(played).not.toHaveBeenCalled();
    ws.emit('message', JSON.stringify({ event: 'mark', streamSid: 's', mark: current })); await work; expect(played).toHaveBeenCalledOnce(); t.close();
  });
  it("retains admission while an interrupted socket write is unresolved", async () => { const ws = new CarrierSocket(); const callbacks: Array<() => void> = []; ws.send = (data, callback) => { ws.sent.push(JSON.parse(data.toString())); callbacks.push(() => callback?.()); }; const t = new TelephonyStreamTransport(ws, new TwilioMediaStreamParser({ protocol: "carrier" }), { protocol: "carrier", authorizeStart: () => true }); ws.emit("message", startFrame()); const audio = t.sendAudio(audioChunk()); const rejected = expect(audio).rejects.toThrow("cleared"); const clearing = t.sendControl({ type: "barge_in", action: { type: "cancel" } }); await expect(t.sendAudio(audioChunk())).rejects.toThrow("concurrent producer"); await expect(t.sendControl({ type: "barge_in", action: { type: "cancel" } })).rejects.toThrow("concurrent clear"); callbacks[1]!(); await clearing; await expect(t.sendAudio(audioChunk())).rejects.toThrow("concurrent producer"); callbacks[0]!(); await rejected; expect(ws.sent).toHaveLength(2); t.close(); }); it('suppresses pipeline JSON and clears all three carrier queues', async () => {
    const cases = [
      { parser: new TwilioMediaStreamParser({ protocol: 'carrier' }), start: startFrame(), event: 'clear' },
      { parser: new TelnyxMediaStreamParser({ protocol: 'carrier' }), start: '{"event":"start","stream_id":"s","start":{"call_control_id":"c","media_format":{"encoding":"PCMU","sample_rate":8000,"channels":1}}}', event: 'clear' },
      { parser: new PlivoMediaStreamParser({ protocol: 'carrier' }), start: '{"event":"start","start":{"callId":"c","streamId":"s","mediaFormat":{"encoding":"audio/x-mulaw","sampleRate":8000}}}', event: 'clearAudio' },
    ];
    for (const c of cases) {
      const ws = new CarrierSocket(); const t = new TelephonyStreamTransport(ws, c.parser, { protocol: 'carrier', authorizeStart: () => true }); ws.emit('message', c.start);
      await t.sendControl({ type: 'agent_done', text: 'fixture', durationMs: 0 }); expect(ws.sent).toEqual([]);
      await t.sendControl({ type: 'barge_in', action: { type: 'cancel' } }); expect(ws.sent[0]?.event).toBe(c.event); t.close();
    }
  });
  it('surfaces media gaps, discards duplicate chunks and preserves source timing separately', () => {
    const ws = new CarrierSocket(); const t = new TelephonyStreamTransport(ws, new TwilioMediaStreamParser({ protocol: 'carrier' }), { protocol: 'carrier', authorizeStart: () => true });
    const frames: Array<{ samples: Float32Array; timestamp: number; sourceTimestampMs?: number }> = []; const gaps: unknown[] = [];
    t.on('audio', (f) => frames.push(f)); t.on('gap', (g) => gaps.push(g)); ws.emit('message', startFrame());
    const media = (n: number, timestamp: number) => JSON.stringify({ event: 'media', streamSid: 's', media: { chunk: String(n), timestamp: String(timestamp), payload: Buffer.alloc(160, 255).toString('base64') } });
    ws.emit('message', media(1, 0)); ws.emit('message', media(1, 0)); ws.emit('message', media(3, 40));
    expect(frames).toHaveLength(2); expect(frames[0]!.samples).toHaveLength(320); expect(frames[1]!.timestamp).toBe(40); expect(frames[1]!.sourceTimestampMs).toBe(40); expect(gaps).toEqual([{ reason: 'carrier-media-gap', droppedMs: 20, missingChunks: 1 }]); t.close();
  });
  it('supervises a rejected write and closes once on timeout', async () => {
    const ws = new CarrierSocket(); const t = new TelephonyStreamTransport(ws, new TwilioMediaStreamParser({ protocol: 'carrier' }), { protocol: 'carrier', authorizeStart: () => true }); t.on('error', () => undefined); ws.emit('message', startFrame());
    ws.send = (_data, callback) => callback?.(new Error('write failed'));
    await expect(t.sendAudio(audioChunk())).rejects.toThrow('write failed'); expect(t.state).toBe('closed');
    vi.useFakeTimers();
    try {
      const slow = new CarrierSocket(); const timeout = new TelephonyStreamTransport(slow, new TwilioMediaStreamParser({ protocol: 'carrier' }), { protocol: 'carrier', authorizeStart: () => true, playbackTimeoutMs: 100 }); timeout.on('error', () => undefined); slow.emit('message', startFrame());
      const closing = vi.fn(); timeout.on('close', closing); const work = timeout.sendAudio(audioChunk()); const check = expect(work).rejects.toThrow('playback timeout');
      await vi.advanceTimersByTimeAsync(101); await check; slow.emit('close'); expect(closing).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
});

/** One 20 ms chunk of constant PCM16 at 16 kHz, unstamped, as a streaming TTS session emits it. */
function speech(level: number): EncodedAudioChunk {
  const audio = Buffer.alloc(640);
  for (let i = 0; i < audio.length; i += 2) audio.writeInt16LE(level, i);
  return { audio, format: 'pcm', container: 'raw', sampleRate: 16000, durationMs: 20, text: '' };
}
/** The PCMU payload a carrier receives for `speech(level)`. */
const heard = (level: number): string => convertPcmToMulaw8k(speech(level).audio, 16000).toString('base64');
/** The payload of each media frame written, in order. */
const media = (sent: Array<Record<string, unknown>>): string[] => sent.filter((m) => m.event === 'media').map((m) => (m.media as { payload: string }).payload);
/** The name of each checkpoint written, in order. */
const marks = (sent: Array<Record<string, unknown>>): string[] => sent.filter((m) => m.event === 'mark').map((m) => (m.mark as { name: string }).name);
/** Lets every promise reaction already queued run. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const turn = () => ({ transcript: 'hello', confidence: 1, durationMs: 20, reason: 'manual' });

/** The voice pipeline without a call profile over a carrier transport, as a host wires a phone call to it. */
async function carrierPipeline() {
  const ws = new CarrierSocket();
  const transport = new TelephonyStreamTransport(ws, new TwilioMediaStreamParser({ protocol: 'carrier' }), { protocol: 'carrier', authorizeStart: () => true });
  ws.emit('message', startFrame());
  const stt = Object.assign(new EventEmitter(), { pushAudio() {}, flush: async () => {}, close: vi.fn() });
  const tts = Object.assign(new EventEmitter(), { pushTokens() {}, flush: async () => {}, cancel() {}, close: vi.fn() });
  const endpoint = Object.assign(new EventEmitter(), { mode: 'heuristic' as const, pushVadEvent() {}, pushTranscript() {}, reset() {} });
  const runtime = new VoicePipelineOrchestrator({ stt: 'fake', tts: 'fake' });
  const errors: unknown[] = [];
  runtime.on('error', (error: unknown) => errors.push(error));
  await runtime.startSession(transport, { async *sendText() { yield 'hello'; } }, {
    streamingSTT: { providerId: 'fake', isStreaming: true, startSession: async () => stt },
    streamingTTS: { providerId: 'fake', startSession: async () => tts },
    endpointDetector: endpoint,
    bargeinHandler: { mode: 'hard-cut', handleBargein: () => ({ type: 'cancel' }) },
  });
  const played: string[] = [];
  transport.on('playback', (event: { name: string }) => played.push(event.name));
  return { ws, stt, tts, endpoint, runtime, errors, played };
}

describe('carrier playback under the voice pipeline without a call profile', () => {
  it('writes every chunk of a reply the pipeline does not wait for, in order, each completing at its own checkpoint', async () => {
    const p = await carrierPipeline();
    try {
      p.endpoint.emit('turn_complete', turn());
      expect(p.runtime.state).toBe('speaking');
      for (const level of [1000, 2000, 3000]) p.tts.emit('audio', speech(level));
      await settle();
      expect(p.errors).toEqual([]);
      expect(media(p.ws.sent)).toEqual([heard(1000), heard(2000), heard(3000)]);
      const written = marks(p.ws.sent);
      expect(written).toHaveLength(3);
      for (const name of written) p.ws.emit('message', JSON.stringify({ event: 'mark', streamSid: 's', mark: { name } }));
      expect(p.played).toEqual(written);
      p.tts.emit('flush_complete');
      expect(p.runtime.state).toBe('listening');
      await settle();
      expect(p.errors).toEqual([]);
    } finally { await p.runtime.stopSession(); }
  });
  it('plays the reply that follows a barge-in', async () => {
    const p = await carrierPipeline();
    try {
      p.endpoint.emit('turn_complete', turn());
      p.tts.emit('audio', speech(1000));
      await settle();
      expect(marks(p.ws.sent)).toHaveLength(1);
      p.stt.emit('speech_start');
      await vi.waitFor(() => expect(p.runtime.state).toBe('listening'));
      await settle();
      const cleared = p.ws.sent.findIndex((m) => m.event === 'clear');
      expect(cleared).toBeGreaterThan(0);
      const before = p.errors.length;
      p.endpoint.emit('turn_complete', turn());
      expect(p.runtime.state).toBe('speaking');
      p.tts.emit('audio', speech(2000));
      await settle();
      expect(p.errors.slice(before)).toEqual([]);
      const after = p.ws.sent.slice(cleared + 1);
      expect(media(after)).toEqual([heard(2000)]);
      const [name] = marks(after);
      p.ws.emit('message', JSON.stringify({ event: 'mark', streamSid: 's', mark: { name } }));
      expect(p.played).toEqual([name]);
    } finally { await p.runtime.stopSession(); }
  });
});
