import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { TelephonyStreamTransport, type TelephonyAudioChunk } from '../TelephonyStreamTransport.js';
import { TwilioMediaStreamParser } from '../parsers/TwilioMediaStreamParser.js';
import { convertPcmToMulaw8k } from '../telephony-audio.js';

/** A socket whose write callback succeeds; carrier playback still needs its own mark. */
export class CarrierSocket extends EventEmitter {
  bufferedAmount = 0;
  readonly sent: Array<Record<string, unknown>> = [];
  send(data: Buffer | string, callback?: (error?: Error) => void): void { this.sent.push(JSON.parse(data.toString())); callback?.(); }
  close(): void { this.emit('close'); }
}
/** Neutral, authenticated start fixture. */
export function startFrame(): string { return '{"event":"start","streamSid":"s","start":{"callSid":"c","customParameters":{"token":"fixture"},"mediaFormat":{"encoding":"audio/x-mulaw","sampleRate":8000,"channels":1}}}'; }
/** One 20 ms raw PCM chunk with an explicitly scoped generation. */
export function audioChunk(): TelephonyAudioChunk { return { audio: Buffer.alloc(640), format: 'pcm', container: 'raw', sampleRate: 16000, durationMs: 20, text: '', generation: { workerGeneration: 1, inferenceGeneration: 1, transportEpoch: 1 } }; }
/** Standard PCM16 mono fixture container; no external fixture generator is required. */
export function wav(pcm: Buffer, rate: number): Buffer {
  const header = Buffer.alloc(44); header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVE', 8); header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40); return Buffer.concat([header, pcm]);
}
/** Waits for the actual wire checkpoint and returns that checkpoint to the transport. */
export async function acknowledge(ws: CarrierSocket): Promise<void> {
  await vi.waitFor(() => expect(ws.sent.some((m) => m.event === 'mark')).toBe(true));
  const mark = ws.sent.find((m) => m.event === 'mark')!;
  ws.emit('message', JSON.stringify({ event: 'mark', streamSid: 's', mark: mark.mark }));
}
describe('telephony PCM boundary', () => {
  it.each(['raw', 'wav'] as const)('converts %s PCM exactly once and waits for playback', async (container) => {
    const ws = new CarrierSocket(); const t = new TelephonyStreamTransport(ws, new TwilioMediaStreamParser({ protocol: 'carrier' }), { protocol: 'carrier', authorizeStart: () => true });
    ws.emit('message', startFrame());
    const raw = audioChunk(); for (let i = 0; i < raw.audio.length; i += 2) raw.audio.writeInt16LE(1000, i);
    const input = { ...raw, container, audio: container === 'wav' ? wav(raw.audio, raw.sampleRate) : raw.audio };
    let complete = false; const sending = t.sendAudio(input).then(() => { complete = true; });
    await vi.waitFor(() => expect(ws.sent.some((m) => m.event === 'media')).toBe(true));
    expect(complete).toBe(false);
    const media = ws.sent.find((m) => m.event === 'media')!.media as { payload: string };
    expect(Buffer.from(media.payload, 'base64')).toEqual(convertPcmToMulaw8k(raw.audio, 16000));
    expect(Buffer.from(media.payload, 'base64')).toHaveLength(160);
    await acknowledge(ws); await sending; expect(complete).toBe(true); t.close();
  });
  it('rejects compressed, mislabeled, truncated and misaligned chunks without output', async () => {
    const ws = new CarrierSocket(); const t = new TelephonyStreamTransport(ws, new TwilioMediaStreamParser({ protocol: 'carrier' }), { protocol: 'carrier', authorizeStart: () => true }); ws.emit('message', startFrame());
    const raw = audioChunk();
    for (const bad of [{ ...raw, format: 'mp3' as const }, { ...raw, format: 'opus' as const }, { ...raw, container: 'mp3' as const }, { ...raw, container: 'ogg' as const }, { ...raw, audio: wav(raw.audio, 16000) }, { ...raw, container: 'wav' as const, audio: Buffer.from('RIFF') }, { ...raw, audio: Buffer.alloc(3) }, { ...raw, durationMs: 500 }, { ...raw, sampleRate: 44100 }]) await expect(t.sendAudio(bad)).rejects.toThrow('audio format');
    expect(ws.sent).toEqual([]); t.close();
  });
  it('reads little-endian samples from an unaligned view without reinterpreting a header', async () => {
    const ws = new CarrierSocket(); const t = new TelephonyStreamTransport(ws, new TwilioMediaStreamParser({ protocol: 'carrier' }), { protocol: 'carrier', authorizeStart: () => true }); ws.emit('message', startFrame());
    const input = { ...audioChunk(), audio: Buffer.alloc(641).subarray(1) };
    const sending = t.sendAudio(input); await acknowledge(ws); await sending; t.close();
  });
});
