/**
 * @fileoverview What a recording is, read with Mediabunny without decoding: its container, its audio codec, its length,
 * and how its pieces are made. A piece's length read the same way on a server.
 * @module agentos/io/hearing/pieces/read
 */

import { ALL_FORMATS, BlobSource, BufferSource, EncodedPacketSink, Input } from 'mediabunny';

/** The containers and codecs a piece is copied into, and the type OpenAI's transcription reads it as. */
export const COPY_TARGETS = {
  aac: { extension: 'm4a', mimeType: 'audio/mp4' },
  opus: { extension: 'webm', mimeType: 'audio/webm' },
  vorbis: { extension: 'webm', mimeType: 'audio/webm' },
  mp3: { extension: 'mp3', mimeType: 'audio/mpeg' },
} as const;

/** PCM above this many bytes a second is decoded to 16 kHz mono (512 kbps). */
export const MAX_COPIED_PCM_BYTES_PER_SECOND = 64_000;

const REFUSED = new Set(['ac3', 'eac3', 'dts']);

/** Why a file cannot be cut. */
export class UnreadableAudioError extends Error {
  constructor(readonly reason: 'container' | 'no_audio' | 'unsupported_codec' | 'cannot_decode') {
    super(`the recording cannot be read (${reason})`);
    this.name = 'UnreadableAudioError';
  }
}

/** A recording as read. */
export interface AudioInfo {
  container: string;
  codec: string | null;
  seconds: number;
  sampleRate: number;
  channels: number;
  /** `copy`: packets copied into a container; `decode`: decoded to 16 kHz mono WAV; null: refused, with `reason`. */
  path: 'copy' | 'decode' | null;
  reason?: UnreadableAudioError['reason'];
}

function inputOf(source: Blob | Uint8Array): Input {
  return new Input({ formats: ALL_FORMATS, source: source instanceof Uint8Array ? new BufferSource(source) : new BlobSource(source) });
}

/** The bytes a second of a PCM codec at a rate and channel count, or null for a codec that is not PCM. */
function pcmBytesPerSecond(codec: string, sampleRate: number, channels: number): number | null {
  const bits = /^pcm-[suf](8|16|24|32|64)/.exec(codec)?.[1] ?? (codec === 'ulaw' || codec === 'alaw' ? '8' : null);
  return bits === null ? null : (Number(bits) / 8) * sampleRate * channels;
}

/** Reads a recording's container, codec and length, and decides how its pieces are made. The signal can cancel the packet scan. */
export async function readAudioInfo(source: Blob | Uint8Array, signal?: AbortSignal): Promise<AudioInfo> {
  signal?.throwIfAborted();
  const input = inputOf(source);
  try {
    let container: string;
    try {
      container = (await input.getFormat()).name;
    } catch {
      throw new UnreadableAudioError('container');
    }
    signal?.throwIfAborted();
    const track = await input.getPrimaryAudioTrack();
    if (track === null) return { container, codec: null, seconds: 0, sampleRate: 0, channels: 0, path: null, reason: 'no_audio' };
    const codec = await track.getCodec();
    const [seconds, sampleRate, channels] = await Promise.all([track.computeDuration(), track.getSampleRate(), track.getNumberOfChannels()]);
    signal?.throwIfAborted();
    const base = { container, codec, seconds, sampleRate, channels };
    if (codec === null || REFUSED.has(codec)) return { ...base, path: null, reason: 'unsupported_codec' };
    if (codec in COPY_TARGETS) {
      // Compressed tracks can exceed the copy limit too; count their packets without decoding or retaining them.
      let bytes = 0;
      for await (const packet of new EncodedPacketSink(track).packets()) {
        signal?.throwIfAborted();
        bytes += packet.data.byteLength;
        if (bytes > seconds * MAX_COPIED_PCM_BYTES_PER_SECOND) {
          return (await track.canDecode()) ? { ...base, path: 'decode' } : { ...base, path: null, reason: 'cannot_decode' };
        }
      }
      signal?.throwIfAborted();
      return { ...base, path: 'copy' };
    }
    const pcm = pcmBytesPerSecond(codec, sampleRate, channels);
    // 'pcm-s16' is little-endian; 'pcm-s16be' and every other PCM codec is decoded (Mediabunny's src/codec.ts lines 59 to 71).
    if (pcm !== null && pcm <= MAX_COPIED_PCM_BYTES_PER_SECOND && codec === 'pcm-s16') return { ...base, path: 'copy' };
    return (await track.canDecode()) ? { ...base, path: 'decode' } : { ...base, path: null, reason: 'cannot_decode' };
  } finally {
    input.dispose();
  }
}

/** A piece's length in seconds, read from its container: what a server measures before it sends the piece on. */
export async function pieceSeconds(bytes: Uint8Array): Promise<number> {
  const input = inputOf(bytes);
  try {
    const track = await input.getPrimaryAudioTrack();
    if (track === null) throw new UnreadableAudioError('no_audio');
    return await track.computeDuration();
  } catch (error) {
    if (error instanceof UnreadableAudioError) throw error;
    throw new UnreadableAudioError('container');
  } finally {
    input.dispose();
  }
}
