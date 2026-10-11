import { EncodedPacketSink, Input, InputAudioTrack } from 'mediabunny';
import { describe, expect, it, vi } from 'vitest';
import { encodeFloat32ToWav } from '../../../speech/audio.js';
import { pieceSeconds, readAudioInfo, UnreadableAudioError } from '../read.js';
import { readWavPcm, wavHeaderSeconds } from '../wav.js';
import { alacFile, flacFile, packetFile, pcmFile } from './browser/fixtures.js';

/** A float WAVE with the format code and samples written independently of the reader. */
function floatWav(): Uint8Array {
  const bytes = new Uint8Array(60);
  const view = new DataView(bytes.buffer);
  const text = new TextEncoder();
  bytes.set(text.encode('RIFF'), 0);
  view.setUint32(4, 52, true);
  bytes.set(text.encode('WAVEfmt '), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 128_000, true);
  view.setUint16(32, 8, true);
  view.setUint16(34, 32, true);
  bytes.set(text.encode('data'), 36);
  view.setUint32(40, 16, true);
  [-1, 0.5, 0.25, -0.75].forEach((value, index) => view.setFloat32(44 + index * 4, value, true));
  return bytes;
}

describe('audio readers on a server', () => {
  it('refuses PCM requiring conversion when its decoder is unavailable', async () => {
    const canDecode = vi.spyOn(InputAudioTrack.prototype, 'canDecode').mockResolvedValue(false);
    try {
      expect(await readAudioInfo(await pcmFile('wav', 1))).toMatchObject({ path: null, reason: 'cannot_decode' });
      expect(await readAudioInfo(await packetFile('wav', 1))).toMatchObject({ path: 'copy' });
    } finally {
      canDecode.mockRestore();
    }
  });

  it.each([readAudioInfo, pieceSeconds])('disposes reader inputs after success and failure (%#)', async (read) => {
    const bytes = await packetFile('wav', 1);
    const dispose = vi.spyOn(Input.prototype, 'dispose');
    try {
      await read(bytes);
      expect(dispose).toHaveBeenCalledTimes(1);
      await expect(read(new Uint8Array([1, 2, 3, 4]))).rejects.toBeInstanceOf(UnreadableAudioError);
      expect(dispose).toHaveBeenCalledTimes(2);
      const noTrack = vi.spyOn(Input.prototype, 'getPrimaryAudioTrack').mockResolvedValueOnce(null);
      try {
        if (read === readAudioInfo) {
          expect(await read(bytes)).toMatchObject({ path: null, reason: 'no_audio' });
        } else {
          await expect(read(bytes)).rejects.toMatchObject({ reason: 'no_audio' });
        }
        expect(dispose).toHaveBeenCalledTimes(3);
        expect(new Set(dispose.mock.contexts).size).toBe(3);
      } finally {
        noTrack.mockRestore();
      }
    } finally {
      dispose.mockRestore();
    }
  });

  it('aborts inspection during the packet scan and disposes the input', async () => {
    const bytes = await packetFile('m4a', 1);
    const controller = new AbortController();
    const reason = new Error('stop inspecting');
    const packets = EncodedPacketSink.prototype.packets;
    let seen = 0;
    let closed = false;
    const scan = vi.spyOn(EncodedPacketSink.prototype, 'packets').mockImplementation(async function* (this: EncodedPacketSink, ...args) {
      try {
        for await (const packet of packets.call(this, ...args)) {
          seen += 1;
          controller.abort(reason);
          yield packet;
        }
      } finally {
        closed = true;
      }
    });
    const dispose = vi.spyOn(Input.prototype, 'dispose');
    try {
      await expect(readAudioInfo(bytes, controller.signal)).rejects.toBe(reason);
      expect(seen).toBe(1);
      expect(closed).toBe(true);
      expect(dispose).toHaveBeenCalledTimes(1);
    } finally {
      scan.mockRestore();
      dispose.mockRestore();
    }
  });

  it('reads 300 seconds from M4A, WebM, MP3 and WAV without a decoder', async () => {
    for (const container of ['m4a', 'webm', 'mp3', 'wav'] as const) {
      const bytes = await packetFile(container);
      expect(Math.abs(await pieceSeconds(bytes) - 300), container).toBeLessThan(0.05);
    }
  });

  it('reads the WAV duration from its header alone', async () => {
    const bytes = await packetFile('wav');
    const dataOffset = bytes.findIndex((_, index) => bytes[index] === 100 && bytes[index + 1] === 97 && bytes[index + 2] === 116 && bytes[index + 3] === 97);
    expect(dataOffset).toBeGreaterThan(0);
    expect(wavHeaderSeconds(bytes.subarray(0, dataOffset + 8))).toBe(300);
  });

  it('reads MOV PCM, FLAC and an unsupported sample entry without browser encoders', async () => {
    expect(await readAudioInfo(await pcmFile('mov', 12))).toMatchObject({ codec: 'pcm-s16', path: 'decode', seconds: 12, sampleRate: 48_000, channels: 2 });
    expect(await pieceSeconds(await flacFile())).toBe(12);
    expect(await readAudioInfo(await alacFile())).toMatchObject({ codec: null, path: null, reason: 'unsupported_codec' });
  });

  it('refuses bytes of no container with a typed error', async () => {
    const read = pieceSeconds(new Uint8Array([1, 2, 3, 4]));
    await expect(read).rejects.toBeInstanceOf(UnreadableAudioError);
    await expect(read).rejects.toMatchObject({ reason: 'container' });
    expect(() => readWavPcm(new Uint8Array([1, 2, 3, 4]))).toThrow(UnreadableAudioError);
  });

  it('reads the mono tone written by encodeFloat32ToWav', () => {
    const original = Float32Array.from({ length: 22_050 }, (_, index) => Math.sin(2 * Math.PI * 440 * index / 22_050));
    const read = readWavPcm(encodeFloat32ToWav(original, 22_050));
    expect(read.sampleRate).toBe(22_050);
    expect(read.channels).toBe(1);
    expect(read.samples).toHaveLength(1);
    expect(read.samples[0]).toHaveLength(original.length);
    expect(Math.max(...original.map((value, index) => Math.abs(value - read.samples[0]![index]!)))).toBeLessThanOrEqual(2 / 32_768);
  });

  it('separates stereo channels, preserves float PCM and refuses another WAVE format', () => {
    const stereo = readWavPcm(encodeFloat32ToWav(new Float32Array([-1, 1, 0.5, -0.5]), 22_050, 2));
    expect(stereo.sampleRate).toBe(22_050);
    expect(stereo.channels).toBe(2);
    expect(stereo.samples.map((channel) => [...channel])).toEqual([[-1, 0.5], [32_767 / 32_768, -0.5]]);
    const floats = readWavPcm(floatWav());
    expect(floats).toMatchObject({ sampleRate: 16_000, channels: 2 });
    expect(floats.samples.map((channel) => [...channel])).toEqual([[-1, 0.25], [0.5, -0.75]]);
    const unsupported = floatWav();
    new DataView(unsupported.buffer).setUint16(20, 0x0055, true);
    expect(() => readWavPcm(unsupported)).toThrow(UnreadableAudioError);
    try {
      readWavPcm(unsupported);
    } catch (error) {
      expect(error).toMatchObject({ reason: 'unsupported_codec' });
    }
  });
});
