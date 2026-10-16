/**
 * PCM container boundaries: raw samples and RIFF-wrapped samples are told
 * apart and checked against their declared rate, channels and duration, and
 * MP3, Opus, malformed WAV and partial samples are refused rather than
 * reinterpreted as raw PCM.
 */
import { describe, expect, it } from 'vitest';
import { inspectPcm16 } from '../audioFormat.js';
import type { EncodedAudioChunk } from '../types.js';

/** A 44-byte RIFF/WAVE header over 640 bytes of mono 16 kHz PCM16. */
function wav(): Buffer {
  const bytes = Buffer.alloc(44 + 640);
  bytes.write('RIFF');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVE', 8);
  bytes.write('fmt ', 12);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24);
  bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(640, 40);
  return bytes;
}
const chunk = (audio: Buffer, container: EncodedAudioChunk['container']): EncodedAudioChunk => ({ audio, container, format: 'pcm', sampleRate: 16000, durationMs: 20, text: '' });

describe('PCM container boundaries', () => {
  it('distinguishes raw samples from RIFF-wrapped samples and validates declared metadata', () => {
    expect(inspectPcm16(chunk(Buffer.alloc(640), 'raw')).samples).toBe(320);
    expect(inspectPcm16(chunk(wav(), 'wav')).pcm.length).toBe(640);
    expect(() => inspectPcm16(chunk(wav(), 'raw'))).toThrow('audio format');
    const stereo = wav();
    stereo.writeUInt16LE(2, 22);
    expect(() => inspectPcm16(chunk(stereo, 'wav'))).toThrow();
    expect(() => inspectPcm16({ ...chunk(wav(), 'wav'), sampleRate: 24000 })).toThrow();
    expect(() => inspectPcm16({ ...chunk(Buffer.alloc(640), 'raw'), durationMs: 200 })).toThrow();
  });

  it('refuses MP3, Opus, malformed WAV and partial PCM samples', () => {
    expect(() => inspectPcm16({ ...chunk(Buffer.from('ID3'), 'mp3'), format: 'mp3' })).toThrow();
    expect(() => inspectPcm16({ ...chunk(Buffer.from('OggS'), 'ogg'), format: 'opus' })).toThrow();
    expect(() => inspectPcm16(chunk(wav().subarray(0, 50), 'wav'))).toThrow();
    expect(() => inspectPcm16(chunk(Buffer.alloc(3), 'raw'))).toThrow();
  });
});
