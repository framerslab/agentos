/**
 * @module voice-pipeline/audioFormat
 *
 * The format boundary for synthesized audio before it is published: a chunk is
 * read as mono PCM16 only when its declared codec, container, sample rate and
 * duration agree with its bytes. A WAV container is parsed once, by its `fmt `
 * and `data` chunks, and never treated as samples; MP3 and Opus are refused
 * with {@link UnsupportedAudioFormatError} rather than decoded.
 */

import type { EncodedAudioChunk } from './types.js';

/** A codec/container declaration that cannot safely be interpreted as mono PCM16. */
export class UnsupportedAudioFormatError extends Error {
  constructor() {
    super('unsupported or inconsistent audio format');
    this.name = 'UnsupportedAudioFormatError';
  }
}

/** Validated PCM view. No copy, decoder, resampling or playback takes place here. */
export interface Pcm16View {
  /** The PCM16 samples: the whole chunk when raw, the `data` chunk's bytes when WAV. */
  pcm: Buffer;
  /** Sample count of `pcm`. */
  samples: number;
  /** The declared sample rate, in Hz. */
  sampleRate: number;
  /** Duration of `pcm`, from its sample count. */
  durationMs: number;
}

/**
 * Inspects raw or RIFF PCM16, rejecting compressed bytes, inconsistent metadata and truncated containers.
 *
 * @param chunk - The chunk to inspect; its bytes are not copied.
 * @returns A view of the chunk's samples.
 * @throws {UnsupportedAudioFormatError} When the chunk is not mono PCM16 whose bytes, rate and duration agree with its declaration.
 */
export function inspectPcm16(chunk: EncodedAudioChunk): Pcm16View {
  const fail = (): never => {
    throw new UnsupportedAudioFormatError();
  };
  if (chunk.format !== 'pcm' || !Number.isSafeInteger(chunk.sampleRate) || chunk.sampleRate < 8000 || chunk.sampleRate > 192000) return fail();
  const bytes = chunk.audio;
  const container = chunk.container ?? 'raw';
  let pcm = bytes;
  if (container === 'wav') {
    if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE' || bytes.readUInt32LE(4) + 8 !== bytes.length) return fail();
    let format = false;
    let data = false;
    let offset = 12;
    while (offset < bytes.length) {
      if (offset + 8 > bytes.length) return fail();
      const name = bytes.toString('ascii', offset, offset + 4);
      const length = bytes.readUInt32LE(offset + 4);
      const start = offset + 8;
      const end = start + length;
      if (end > bytes.length) return fail();
      if (name === 'fmt ') {
        if (format || length < 16 || bytes.readUInt16LE(start) !== 1 || bytes.readUInt16LE(start + 2) !== 1 || bytes.readUInt32LE(start + 4) !== chunk.sampleRate || bytes.readUInt32LE(start + 8) !== chunk.sampleRate * 2 || bytes.readUInt16LE(start + 12) !== 2 || bytes.readUInt16LE(start + 14) !== 16) return fail();
        format = true;
      } else if (name === 'data') {
        if (data) return fail();
        pcm = bytes.subarray(start, end);
        data = true;
      }
      // RIFF pads an odd-length chunk to an even offset.
      offset = end + (length % 2);
    }
    if (!format || !data || offset !== bytes.length) return fail();
  } else if (container !== 'raw' || ['RIFF', 'OggS'].includes(bytes.toString('ascii', 0, 4)) || bytes.toString('ascii', 0, 3) === 'ID3') return fail();
  if (pcm.length === 0 || pcm.length % 2 !== 0) return fail();
  const samples = pcm.length / 2;
  const durationMs = samples / chunk.sampleRate * 1000;
  if (!Number.isFinite(chunk.durationMs) || Math.abs(chunk.durationMs - durationMs) > 1) return fail();
  return { pcm, samples, sampleRate: chunk.sampleRate, durationMs };
}
