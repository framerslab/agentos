/**
 * @fileoverview The pieces of a recording, cut in the page: packets copied into a container OpenAI takes when the codec
 * allows (no decoding), and otherwise decoded and written as 16 kHz mono 16-bit WAV. On the decode path, each cut
 * moves to the quietest 100 milliseconds within ten seconds before its mark when the search succeeds.
 * @module agentos/io/hearing/pieces/cut
 */

import {
  AudioSample,
  AudioSampleSink,
  AudioSampleSource,
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  Mp3OutputFormat,
  Mp4OutputFormat,
  Output,
  WavOutputFormat,
  WebMOutputFormat,
  ALL_FORMATS,
  BlobSource,
  BufferSource,
  Input,
  type InputAudioTrack,
} from 'mediabunny';
import { planPieces } from './plan.js';
import { COPY_TARGETS, readAudioInfo, UnreadableAudioError, type AudioInfo } from './read.js';

/** One piece, ready to send. */
export interface AudioPiece {
  index: number;
  startMs: number;
  durationMs: number;
  data: Uint8Array;
  mimeType: string;
  fileName: string;
}

/** How to cut. */
export interface CutOptions {
  pieceSeconds: number;
  overlapSeconds: number;
  /** Refused past this; a decoded piece of 300 seconds is 9.6 MB. */
  maxBytes: number;
  /** Seconds before a mark searched for its quietest moment. @default 10 */
  quietSeconds?: number;
  /** The first piece to make; earlier pieces are skipped. @default 0 */
  fromIndex?: number;
  signal?: AbortSignal;
}

/** Creates a buffered output for a piece's container. */
function outputFor(extension: string): Output<Mp4OutputFormat | WebMOutputFormat | Mp3OutputFormat | WavOutputFormat, BufferTarget> {
  const format = extension === 'm4a' ? new Mp4OutputFormat() : extension === 'webm' ? new WebMOutputFormat() : extension === 'mp3' ? new Mp3OutputFormat() : new WavOutputFormat();
  return new Output({ format, target: new BufferTarget() });
}

/** The quietest 100 ms frame of the first channel in [from, to); keeps `to` if decoding fails or no frame fits. */
async function quietestBefore(track: InputAudioTrack, from: number, to: number): Promise<number> {
  if (from >= to) return to;
  let best = to;
  let bestLevel = Number.POSITIVE_INFINITY;
  let sum = 0;
  let count = 0;
  let frameStart = from;
  try {
    const sink = new AudioSampleSink(track);
    for await (const sample of sink.samples(from, to)) {
      try {
        const floats = new Float32Array(sample.numberOfFrames);
        sample.copyTo(floats, { format: 'f32-planar', planeIndex: 0 });
        const frame = Math.max(1, Math.round(sample.sampleRate / 10));
        // A decoded sample can be shorter than 100 ms and can straddle either edge of the search window.
        const first = Math.max(0, Math.ceil((from - sample.timestamp) * sample.sampleRate));
        const last = Math.min(floats.length, Math.ceil((to - sample.timestamp) * sample.sampleRate));
        for (let offset = first; offset < last; offset += 1) {
          if (count === 0) frameStart = sample.timestamp + offset / sample.sampleRate;
          sum += floats[offset]! * floats[offset]!;
          count += 1;
          if (count === frame) {
            const level = sum / count;
            if (level < bestLevel) {
              bestLevel = level;
              best = frameStart + frame / (2 * sample.sampleRate);
            }
            sum = 0;
            count = 0;
          }
        }
      } finally {
        sample.close();
      }
    }
  } catch {
    return to;
  }
  return best;
}

/** One piece by packet copy. */
async function copyPiece(track: InputAudioTrack, codec: keyof typeof COPY_TARGETS | 'pcm-s16', start: number, end: number, isLast: boolean): Promise<Uint8Array> {
  const extension = codec === 'pcm-s16' ? 'wav' : COPY_TARGETS[codec].extension;
  const output = outputFor(extension);
  const source = new EncodedAudioPacketSource(codec);
  output.addAudioTrack(source);
  await output.start();
  const sink = new EncodedPacketSink(track);
  const first = await sink.getPacket(start);
  const last = isLast ? undefined : await sink.getPacket(end, { metadataOnly: true });
  const decoderConfig = (await track.getDecoderConfig()) ?? undefined;
  let sent = false;
  if (first !== null) {
    for await (const packet of sink.packets(first, last ?? undefined)) {
      await source.add(packet.clone({ timestamp: packet.timestamp - first.timestamp }), sent ? undefined : { decoderConfig });
      sent = true;
    }
  }
  await output.finalize();
  return new Uint8Array(output.target.buffer!);
}

/** One piece decoded to 16 kHz mono 16-bit WAV. */
async function decodePiece(track: InputAudioTrack, start: number, end: number): Promise<Uint8Array> {
  if (!await track.canDecode()) throw new UnreadableAudioError('cannot_decode');
  const output = outputFor('wav');
  const source = new AudioSampleSource({ codec: 'pcm-s16', transform: { numberOfChannels: 1, sampleRate: 16_000 } });
  output.addAudioTrack(source);
  await output.start();
  let sent = false;
  for await (const sample of new AudioSampleSink(track).samples(start, end)) {
    try {
      const first = Math.max(0, Math.min(sample.numberOfFrames, Math.round((start - sample.timestamp) * sample.sampleRate)));
      const last = Math.max(0, Math.min(sample.numberOfFrames, Math.round((end - sample.timestamp) * sample.sampleRate)));
      if (first >= last) continue;
      const trimmed = sample.trim(first, last);
      try {
        // Round in frames so timestamp drift cannot create a zero-frame padding sample.
        const offsetFrames = Math.max(0, Math.round((sample.timestamp - start) * sample.sampleRate) + first);
        trimmed.setTimestamp(offsetFrames / sample.sampleRate);
        if (!sent && offsetFrames > 0) {
          const padding = new AudioSample({
            data: new Float32Array(offsetFrames * sample.numberOfChannels),
            format: 'f32',
            sampleRate: sample.sampleRate,
            numberOfChannels: sample.numberOfChannels,
            timestamp: 0,
          });
          try {
            await source.add(padding);
          } finally {
            padding.close();
          }
        }
        await source.add(trimmed);
        sent = true;
      } finally {
        trimmed.close();
      }
    } finally {
      sample.close();
    }
  }
  source.close();
  await output.finalize();
  return new Uint8Array(output.target.buffer!);
}

/** Cuts a recording; yields its pieces in order. */
export async function* cutPieces(file: Blob | Uint8Array, options: CutOptions): AsyncGenerator<AudioPiece> {
  const info: AudioInfo = await readAudioInfo(file, options.signal);
  options.signal?.throwIfAborted();
  if (info.path === null) throw new UnreadableAudioError(info.reason ?? 'unsupported_codec');
  // Validate the options before opening the cutting input. Quiet cuts are planned from their actual starts below.
  planPieces(info.seconds, options);
  const input = new Input({ formats: ALL_FORMATS, source: file instanceof Uint8Array ? new BufferSource(file) : new BlobSource(file) });
  try {
    const track = (await input.getPrimaryAudioTrack())!;
    const quiet = options.quietSeconds ?? 10;
    let start = 0;
    for (let index = 0; start < info.seconds; index += 1) {
      options.signal?.throwIfAborted();
      let end = Math.min(info.seconds, start + options.pieceSeconds);
      // Keep the planner's one-second tail allowance.
      if (info.seconds - end <= 1) end = info.seconds;
      if (info.path === 'decode' && end < info.seconds) end = await quietestBefore(track, Math.max(start + options.overlapSeconds + 1, end - quiet), end);
      if (index >= (options.fromIndex ?? 0)) {
        const data = info.path === 'copy' ? await copyPiece(track, info.codec as keyof typeof COPY_TARGETS | 'pcm-s16', start, end, end >= info.seconds) : await decodePiece(track, start, end);
        if (data.length > options.maxBytes) throw new RangeError(`piece ${index} is ${data.length} bytes, past ${options.maxBytes}`);
        const extension = info.path === 'decode' || info.codec === 'pcm-s16' ? 'wav' : COPY_TARGETS[info.codec as keyof typeof COPY_TARGETS].extension;
        yield {
          index,
          startMs: Math.round(start * 1000),
          durationMs: Math.round((end - start) * 1000),
          data,
          mimeType: extension === 'wav' ? 'audio/wav' : COPY_TARGETS[info.codec as keyof typeof COPY_TARGETS].mimeType,
          fileName: `piece-${index}.${extension}`,
        };
      }
      if (end >= info.seconds) break;
      start = Math.max(0, end - options.overlapSeconds);
    }
  } finally {
    input.dispose();
  }
}
