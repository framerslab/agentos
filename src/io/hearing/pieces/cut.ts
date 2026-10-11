/**
 * @fileoverview The pieces of a recording, cut in the page: packets copied into a container OpenAI takes when the codec
 * allows (no decoding), and otherwise decoded and written as 16 kHz mono 16-bit WAV; when the codec decodes here, each
 * cut moves to the quietest 100 milliseconds within ten seconds before its mark.
 * @module agentos/io/hearing/pieces/cut
 */

import {
  AudioSampleSink,
  BufferTarget,
  Conversion,
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

function outputFor(extension: string): Output<Mp4OutputFormat | WebMOutputFormat | Mp3OutputFormat | WavOutputFormat, BufferTarget> {
  const format = extension === 'm4a' ? new Mp4OutputFormat() : extension === 'webm' ? new WebMOutputFormat() : extension === 'mp3' ? new Mp3OutputFormat() : new WavOutputFormat();
  return new Output({ format, target: new BufferTarget() });
}

/** The quietest 100 ms frame in [from, to), by root mean square of the first channel; `to` when nothing decodes. */
async function quietestBefore(track: InputAudioTrack, from: number, to: number): Promise<number> {
  const sink = new AudioSampleSink(track);
  let best = to;
  let bestLevel = Number.POSITIVE_INFINITY;
  for await (const sample of sink.samples(from, to)) {
    const floats = new Float32Array(sample.allocationSize({ format: 'f32', planeIndex: 0 }) / 4);
    sample.copyTo(floats, { format: 'f32', planeIndex: 0 });
    const frame = Math.max(1, Math.round(sample.sampleRate / 10));
    for (let offset = 0; offset + frame <= floats.length; offset += frame) {
      let sum = 0;
      for (let i = offset; i < offset + frame; i += 1) sum += floats[i]! * floats[i]!;
      const level = sum / frame;
      if (level < bestLevel) {
        bestLevel = level;
        best = sample.timestamp + (offset + frame / 2) / sample.sampleRate;
      }
    }
    sample.close();
  }
  return best;
}

/** One piece by packet copy. */
async function copyPiece(track: InputAudioTrack, codec: keyof typeof COPY_TARGETS | 'pcm-s16', start: number, end: number): Promise<Uint8Array> {
  const extension = codec === 'pcm-s16' ? 'wav' : COPY_TARGETS[codec].extension;
  const output = outputFor(extension);
  const source = new EncodedAudioPacketSource(codec);
  output.addAudioTrack(source);
  await output.start();
  const sink = new EncodedPacketSink(track);
  const first = await sink.getPacket(start);
  const last = await sink.getPacket(end, { metadataOnly: true });
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
async function decodePiece(input: Input, start: number, end: number): Promise<Uint8Array> {
  const output = outputFor('wav');
  const conversion = await Conversion.init({ input, output, video: { discard: true }, audio: { numberOfChannels: 1, sampleRate: 16_000, codec: 'pcm-s16' }, trim: { start, end } });
  if (!conversion.isValid) throw new UnreadableAudioError('cannot_decode');
  await conversion.execute();
  return new Uint8Array(output.target.buffer!);
}

/** Cuts a recording; yields its pieces in order. */
export async function* cutPieces(file: Blob | Uint8Array, options: CutOptions): AsyncGenerator<AudioPiece> {
  const info: AudioInfo = await readAudioInfo(file);
  if (info.path === null) throw new UnreadableAudioError(info.reason ?? 'unsupported_codec');
  const input = new Input({ formats: ALL_FORMATS, source: file instanceof Uint8Array ? new BufferSource(file) : new BlobSource(file) });
  const track = (await input.getPrimaryAudioTrack())!;
  const decodes = info.path === 'decode' || (await track.canDecode());
  const quiet = options.quietSeconds ?? 10;
  const plan = planPieces(info.seconds, options);
  let start = 0;
  for (const planned of plan) {
    options.signal?.throwIfAborted();
    let end = planned.end;
    if (decodes && end < info.seconds) end = await quietestBefore(track, Math.max(start + options.overlapSeconds + 1, end - quiet), end);
    if (planned.index >= (options.fromIndex ?? 0)) {
      const data = info.path === 'copy' ? await copyPiece(track, info.codec as keyof typeof COPY_TARGETS | 'pcm-s16', start, end) : await decodePiece(input, start, end);
      if (data.length > options.maxBytes) throw new RangeError(`piece ${planned.index} is ${data.length} bytes, past ${options.maxBytes}`);
      const extension = info.path === 'decode' || info.codec === 'pcm-s16' ? 'wav' : COPY_TARGETS[info.codec as keyof typeof COPY_TARGETS].extension;
      yield {
        index: planned.index,
        startMs: Math.round(start * 1000),
        durationMs: Math.round((end - start) * 1000),
        data,
        mimeType: extension === 'wav' ? 'audio/wav' : COPY_TARGETS[info.codec as keyof typeof COPY_TARGETS].mimeType,
        fileName: `piece-${planned.index}.${extension}`,
      };
    }
    start = Math.max(0, end - options.overlapSeconds);
  }
}
