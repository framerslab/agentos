/**
 * @fileoverview WAVE durations and planar PCM samples read through DataView, in a page or on a server.
 * @module agentos/io/hearing/pieces/wav
 */

import { UnreadableAudioError } from './read.js';

/** A WAVE recording's rate, channel count and samples, one array per channel. */
export interface WavPcm {
  sampleRate: number;
  channels: number;
  samples: Float32Array[];
}

interface WavChunks {
  view: DataView;
  format: number;
  channels: number;
  sampleRate: number;
  byteRate: number;
  blockAlign: number;
  bits: number;
  dataOffset: number;
  dataLength: number;
}

/** Reads RIFF chunks, including padding, without requiring a data chunk's payload for a header read. */
function chunksOf(bytes: Uint8Array, headerOnly: boolean): WavChunks {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fourCC = (offset: number): string => String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
  if (bytes.length < 12 || fourCC(0) !== 'RIFF' || fourCC(8) !== 'WAVE') throw new UnreadableAudioError('container');
  const limit = view.getUint32(4, true) + 8;
  if (limit < 12 || (!headerOnly && limit > bytes.length)) throw new UnreadableAudioError('container');
  let formatOffset: number | undefined;
  let dataOffset: number | undefined;
  let dataLength = 0;
  for (let offset = 12; offset + 8 <= Math.min(limit, bytes.length);) {
    const name = fourCC(offset);
    const length = view.getUint32(offset + 4, true);
    const payload = offset + 8;
    if (payload + length > limit) throw new UnreadableAudioError('container');
    if (name === 'data') {
      dataOffset ??= payload;
      if (dataOffset === payload) dataLength = length;
      if (headerOnly && formatOffset !== undefined) break;
    }
    if (payload + length > bytes.length) throw new UnreadableAudioError('container');
    if (name === 'fmt ' && formatOffset === undefined) {
      if (length < 16) throw new UnreadableAudioError('container');
      formatOffset = payload;
    }
    offset = payload + length + (length % 2);
  }
  if (formatOffset === undefined || dataOffset === undefined) throw new UnreadableAudioError('container');
  const format = view.getUint16(formatOffset, true);
  const channels = view.getUint16(formatOffset + 2, true);
  const sampleRate = view.getUint32(formatOffset + 4, true);
  const byteRate = view.getUint32(formatOffset + 8, true);
  const blockAlign = view.getUint16(formatOffset + 12, true);
  const bits = view.getUint16(formatOffset + 14, true);
  if (channels === 0 || sampleRate === 0 || byteRate === 0 || blockAlign === 0) throw new UnreadableAudioError('container');
  return { view, format, channels, sampleRate, byteRate, blockAlign, bits, dataOffset, dataLength };
}

/** Reads seconds from the WAVE header's byte rate and declared data length; the sample bytes need not be present. */
export function wavHeaderSeconds(bytes: Uint8Array): number {
  const { byteRate, dataLength } = chunksOf(bytes, true);
  return dataLength / byteRate;
}

/** Reads 16-bit integer or 32-bit float PCM from a WAVE file into one Float32Array per channel. */
export function readWavPcm(bytes: Uint8Array): WavPcm {
  const { view, format, channels, sampleRate, byteRate, blockAlign, bits, dataOffset, dataLength } = chunksOf(bytes, false);
  if (!((format === 1 && bits === 16) || (format === 3 && bits === 32))) throw new UnreadableAudioError('unsupported_codec');
  const width = bits / 8;
  if (blockAlign !== channels * width || byteRate !== sampleRate * blockAlign || dataLength % blockAlign !== 0) throw new UnreadableAudioError('container');
  const frames = dataLength / blockAlign;
  const samples = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const offset = dataOffset + frame * blockAlign + channel * width;
      samples[channel]![frame] = format === 1 ? view.getInt16(offset, true) / 32_768 : view.getFloat32(offset, true);
    }
  }
  return { sampleRate, channels, samples };
}
