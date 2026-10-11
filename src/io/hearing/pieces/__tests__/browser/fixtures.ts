import {
  ALL_FORMATS,
  BufferSource,
  BufferTarget,
  Conversion,
  EncodedAudioPacketSource,
  EncodedPacket,
  FlacOutputFormat,
  Input,
  MkvOutputFormat,
  Mp3OutputFormat,
  Mp4OutputFormat,
  Output,
  WavOutputFormat,
  WebMOutputFormat,
  type OutputFormat,
} from 'mediabunny';

/** Containers built from packets, without an encoder. */
export type PacketContainer = 'm4a' | 'webm' | 'mp3' | 'wav';

/** An Opus identification header for a mono 48 kHz stream with no pre-skip. */
const OPUS_HEAD = new Uint8Array([
  0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64,
  1, 1, 0, 0, 0x80, 0xbb, 0, 0, 0, 0, 0,
]);

/** A MPEG-1 Layer III frame: 128 kbps, 44.1 kHz, mono, zeroed payload. */
function mp3Frame(): Uint8Array {
  const bytes = new Uint8Array(417);
  bytes.set([0xff, 0xfb, 0x90, 0xc0]);
  return bytes;
}

/** Writes a recording with the muxer, including an MP4 whose index follows its packets. */
export async function packetFile(container: PacketContainer, seconds = 300, aacPacketBytes = 8): Promise<Uint8Array> {
  const codec = container === 'm4a' ? 'aac' : container === 'webm' ? 'opus' : container === 'mp3' ? 'mp3' : 'pcm-s16';
  const format = container === 'm4a' ? new Mp4OutputFormat({ fastStart: false }) : container === 'webm' ? new WebMOutputFormat() : container === 'mp3' ? new Mp3OutputFormat() : new WavOutputFormat();
  const sampleRate = container === 'webm' ? 48_000 : container === 'mp3' ? 44_100 : 16_000;
  const frameSamples = container === 'm4a' ? 1_024 : container === 'webm' ? 960 : container === 'mp3' ? 1_152 : 1_600;
  const payload = container === 'm4a' ? new Uint8Array(aacPacketBytes) : container === 'webm' ? new Uint8Array([0xf8, 0xff, 0xfe]) : container === 'mp3' ? mp3Frame() : new Uint8Array(frameSamples * 2);
  const source = new EncodedAudioPacketSource(codec);
  const output = new Output({ format, target: new BufferTarget() });
  output.addAudioTrack(source);
  await output.start();
  for (let sample = 0; sample < seconds * sampleRate; sample += frameSamples) {
    const duration = Math.min(frameSamples, seconds * sampleRate - sample) / sampleRate;
    const data = codec === 'pcm-s16' ? payload.subarray(0, Math.round(duration * sampleRate) * 2) : payload;
    await source.add(new EncodedPacket(data, 'key', sample / sampleRate, duration), sample === 0 ? {
      decoderConfig: {
        codec: codec === 'aac' ? 'mp4a.40.2' : codec,
        sampleRate,
        numberOfChannels: 1,
        ...(codec === 'aac' ? { description: new Uint8Array([0x14, 0x08]) } : codec === 'opus' ? { description: OPUS_HEAD } : {}),
      },
    } : undefined);
  }
  await output.finalize();
  return new Uint8Array(output.target.buffer!);
}

/** Replaces one four-byte container field, leaving its length and offsets unchanged. */
function replaceFourCC(bytes: Uint8Array, before: string, after: string): void {
  const encoded = new TextEncoder();
  const search = encoded.encode(before);
  for (let offset = 0; offset <= bytes.length - 4; offset += 1) {
    if (search.every((value, index) => bytes[offset + index] === value)) {
      bytes.set(encoded.encode(after), offset);
      return;
    }
  }
  throw new Error(`missing container field ${before}`);
}

/** A stereo 48 kHz PCM tone, with a second of silence beginning at 293 seconds, inside the ten seconds a cut is moved within. */
export async function pcmFile(container: 'wav' | 'mov', seconds = 310): Promise<Uint8Array> {
  const sampleRate = 48_000;
  const channels = 2;
  const format: OutputFormat = container === 'wav' ? new WavOutputFormat() : new Mp4OutputFormat({ fastStart: false });
  // The MP4 muxer supplies the sample tables; the QuickTime entry then names these raw samples as sowt.
  const source = new EncodedAudioPacketSource(container === 'wav' ? 'pcm-s16' : 'aac');
  const output = new Output({ format, target: new BufferTarget() });
  output.addAudioTrack(source);
  await output.start();
  const frameSamples = 4_800;
  for (let start = 0; start < seconds * sampleRate; start += frameSamples) {
    const count = Math.min(frameSamples, Math.round(seconds * sampleRate) - start);
    const bytes = new Uint8Array(count * channels * 2);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < count; index += 1) {
      const time = (start + index) / sampleRate;
      const value = time >= 293 && time < 294 ? 0 : Math.round(Math.sin(2 * Math.PI * 440 * time) * 16_000);
      view.setInt16(index * 4, value, true);
      view.setInt16(index * 4 + 2, value, true);
    }
    await source.add(new EncodedPacket(bytes, 'key', start / sampleRate, count / sampleRate), start === 0 ? {
      decoderConfig: {
        codec: container === 'wav' ? 'pcm-s16' : 'mp4a.40.2',
        sampleRate,
        numberOfChannels: channels,
        ...(container === 'mov' ? { description: new Uint8Array([0x11, 0x90]) } : {}),
      },
    } : undefined);
  }
  await output.finalize();
  const bytes = new Uint8Array(output.target.buffer!);
  if (container === 'mov') {
    bytes.set(new TextEncoder().encode('qt  '), 8);
    replaceFourCC(bytes, 'mp4a', 'sowt');
  }
  return bytes;
}

/** An unsupported ALAC sample entry in a muxed M4A. */
export async function alacFile(): Promise<Uint8Array> {
  const bytes = await packetFile('m4a', 1);
  replaceFourCC(bytes, 'mp4a', 'alac');
  return bytes;
}

/** A Matroska track explicitly marked AC-3, built without decoding its payload. */
export async function ac3File(): Promise<Uint8Array> {
  const source = new EncodedAudioPacketSource('ac3');
  const output = new Output({ format: new MkvOutputFormat(), target: new BufferTarget() });
  output.addAudioTrack(source);
  await output.start();
  for (let index = 0; index < 32; index += 1) {
    const bytes = new Uint8Array(768);
    bytes.set([0x0b, 0x77, 0, 0, 0x14, 0x40, 0x40]);
    await source.add(new EncodedPacket(bytes, 'key', index * 0.032, 0.032), index === 0 ? {
      decoderConfig: { codec: 'ac-3', sampleRate: 48_000, numberOfChannels: 2 },
    } : undefined);
  }
  await output.finalize();
  return new Uint8Array(output.target.buffer!);
}

/** Encodes a short PCM recording as FLAC after the caller has checked codec support. */
export async function flacFile(): Promise<Uint8Array> {
  const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(await pcmFile('wav', 12)) });
  const output = new Output({ format: new FlacOutputFormat(), target: new BufferTarget() });
  const conversion = await Conversion.init({ input, output, audio: { codec: 'flac' } });
  if (!conversion.isValid) throw new Error('FLAC conversion is invalid');
  await conversion.execute();
  return new Uint8Array(output.target.buffer!);
}
