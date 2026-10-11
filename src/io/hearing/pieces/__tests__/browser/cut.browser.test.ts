import { ALL_FORMATS, AudioSample, AudioSampleSink, BufferSource, EncodedPacketSink, Input, InputAudioTrack } from 'mediabunny';
import { describe, expect, it, vi } from 'vitest';
import { cutPieces, readAudioInfo, readWavPcm, type AudioPiece } from '../../index.js';
import { ac3File, alacFile, flacFile, packetFile, pcmFile } from './fixtures.js';

const options = { pieceSeconds: 300, overlapSeconds: 3, maxBytes: 24_000_000 };

/** Collects pieces through the public cutting API. */
async function collect(bytes: Uint8Array): Promise<AudioPiece[]> {
  const pieces: AudioPiece[] = [];
  for await (const piece of cutPieces(bytes, options)) pieces.push(piece);
  return pieces;
}

/** Checks a decoded piece's format and size. */
function expectMonoWav(piece: AudioPiece): void {
  const read = readWavPcm(piece.data);
  expect(read).toMatchObject({ sampleRate: 16_000, channels: 1 });
  expect(piece.mimeType).toBe('audio/wav');
  expect(piece.fileName).toBe(`piece-${piece.index}.wav`);
  expect(piece.data.length).toBeLessThanOrEqual(64_000 * piece.durationMs / 1_000);
}

/** Checks support for the fixture's actual decoder configuration. */
async function canDecodeFile(bytes: Uint8Array): Promise<boolean> {
  const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(bytes) });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (track === null) throw new Error('fixture has no audio track');
    return await track.canDecode();
  } finally {
    input.dispose();
  }
}

/** Returns a browser decode failure for the fixture's first packet, or null when it emits audio. */
async function firstPacketDecodeFailure(bytes: Uint8Array): Promise<string | null> {
  const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(bytes) });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (track === null) throw new Error('fixture has no audio track');
    const config = await track.getDecoderConfig();
    const packet = await new EncodedPacketSink(track).getFirstPacket();
    if (config === null || packet === null) throw new Error('fixture has no decoder configuration or packet');
    const chunk = packet.toEncodedAudioChunk();
    let frames = 0;
    let failure: string | null = null;
    const decoder = new AudioDecoder({
      output: (data) => {
        frames += data.numberOfFrames;
        data.close();
      },
      error: (error) => { failure = `${error.name}: ${error.message}`; },
    });
    try {
      decoder.configure(config);
      decoder.decode(chunk);
      await decoder.flush();
    } catch (error) {
      if (failure !== null) return failure;
      if (error instanceof DOMException && (error.name === 'EncodingError' || error.name === 'NotSupportedError')) {
        return `${error.name}: ${error.message}`;
      }
      throw error;
    } finally {
      if (decoder.state !== 'closed') decoder.close();
    }
    return failure ?? (frames > 0 ? null : 'decoder emitted no audio frames');
  } finally {
    input.dispose();
  }
}

/** Emits a quiet frame before a decoder failure to exercise discarding a partial search. */
async function* failedQuietSearch(): AsyncGenerator<AudioSample, void, unknown> {
  yield new AudioSample({ data: new Float32Array(4_800), format: 'f32-planar', sampleRate: 48_000, numberOfChannels: 1, timestamp: 2 });
  throw new Error('quiet search decode failed');
}

describe('cutting recordings in a browser', () => {
  it('names the containers, codecs, durations and copy, decode or refused paths', async () => {
    const vectors = [
      { container: 'm4a', name: /mp4/i, codec: 'aac' },
      { container: 'webm', name: /webm/i, codec: 'opus' },
      { container: 'mp3', name: /mp3/i, codec: 'mp3' },
      { container: 'wav', name: /wav(e)?/i, codec: 'pcm-s16' },
    ] as const;
    for (const vector of vectors) {
      const info = await readAudioInfo(new Blob([new Uint8Array(await packetFile(vector.container))]));
      expect(info.container).toMatch(vector.name);
      expect(info).toMatchObject({ codec: vector.codec, path: 'copy' });
      expect(Math.abs(info.seconds - 300)).toBeLessThan(0.05);
    }
    for (const container of ['wav', 'mov'] as const) {
      const info = await readAudioInfo(await pcmFile(container));
      expect(info.container).toMatch(container === 'wav' ? /wav(e)?/i : /mp4|mov|quicktime/i);
      expect(info).toMatchObject({ codec: 'pcm-s16', path: 'decode', sampleRate: 48_000, channels: 2 });
      expect(Math.abs(info.seconds - 310)).toBeLessThan(0.05);
    }
    const ac3 = await readAudioInfo(await ac3File());
    expect(ac3.container).toMatch(/matroska|mkv/i);
    expect(ac3).toMatchObject({ codec: 'ac3', path: null, reason: 'unsupported_codec' });
    expect(Math.abs(ac3.seconds - 1.024)).toBeLessThan(0.05);
    const alac = await readAudioInfo(await alacFile());
    expect(alac.container).toMatch(/mp4/i);
    expect(alac).toMatchObject({ codec: null, path: null, reason: 'unsupported_codec' });
    expect(Math.abs(alac.seconds - 1)).toBeLessThan(0.05);
    const highRateBytes = await packetFile('m4a', 12, 8_192);
    const highRate = await readAudioInfo(highRateBytes);
    expect(highRate.path).toBe(await canDecodeFile(highRateBytes) ? 'decode' : null);
    if (highRate.path === null) expect(highRate.reason).toBe('cannot_decode');
  });

  it('copies a twenty-minute M4A into five pieces, the last a short tail, and preserves the other copy containers', async () => {
    const pieces = await collect(await packetFile('m4a', 1_200));
    expect(pieces.map((piece) => piece.startMs)).toEqual([0, 297_000, 594_000, 891_000, 1_188_000]);
    expect(pieces.map((piece) => piece.fileName)).toEqual(['piece-0.m4a', 'piece-1.m4a', 'piece-2.m4a', 'piece-3.m4a', 'piece-4.m4a']);
    for (const piece of pieces) {
      expect(piece.mimeType).toBe('audio/mp4');
      expect(piece.data.length).toBeLessThan(24_000_000);
      expect(Math.abs((await readAudioInfo(piece.data)).seconds - piece.durationMs / 1_000)).toBeLessThanOrEqual(1_024 / 16_000);
    }
    for (const [container, mimeType] of [['webm', 'audio/webm'], ['mp3', 'audio/mpeg'], ['wav', 'audio/wav']] as const) {
      const copied = await collect(await packetFile(container, 12));
      expect(copied).toHaveLength(1);
      expect(copied[0]).toMatchObject({ fileName: `piece-0.${container}`, mimeType, startMs: 0 });
      expect(Math.abs((await readAudioInfo(copied[0]!.data)).seconds - 12)).toBeLessThan(0.1);
    }
  });

  it.each(['m4a', 'webm', 'mp3', 'wav'] as const)('preserves every packet when copying a whole %s recording', async (container) => {
    const bytes = await packetFile(container, 12);
    const copied = await collect(bytes);
    expect(copied).toHaveLength(1);
    expect((await readAudioInfo(copied[0]!.data)).seconds).toBeCloseTo((await readAudioInfo(bytes)).seconds, 6);
    const counts: number[] = [];
    for (const data of [bytes, copied[0]!.data]) {
      const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(data) });
      try {
        const track = (await input.getPrimaryAudioTrack())!;
        let count = 0;
        for await (const packet of new EncodedPacketSink(track).packets()) {
          expect(packet.data.byteLength).toBeGreaterThan(0);
          count += 1;
        }
        counts.push(count);
      } finally {
        input.dispose();
      }
    }
    expect(counts[1]).toBe(counts[0]);
  });

  it('copies the final packet of a multi-piece recording', async () => {
    const bytes = await packetFile('m4a', 12);
    const pieces: AudioPiece[] = [];
    for await (const piece of cutPieces(bytes, { ...options, pieceSeconds: 10, overlapSeconds: 1 })) pieces.push(piece);
    expect(pieces).toHaveLength(2);
    const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(bytes) });
    try {
      const track = (await input.getPrimaryAudioTrack())!;
      const first = (await new EncodedPacketSink(track).getPacket(pieces[1]!.startMs / 1_000))!;
      const seconds = (await readAudioInfo(pieces[1]!.data)).seconds;
      expect(first.timestamp + seconds).toBeCloseTo(await track.computeDuration(), 6);
    } finally {
      input.dispose();
    }
  });

  it('replans after early quiet cuts without extending pieces or losing the tail, including on resume', async () => {
    const bytes = await pcmFile('wav', 32);
    const cutOptions = { ...options, pieceSeconds: 10, overlapSeconds: 1, quietSeconds: 8 };
    const pieces: AudioPiece[] = [];
    for await (const piece of cutPieces(bytes, cutOptions)) pieces.push(piece);
    expect(pieces.length).toBeGreaterThan(3);
    expect(pieces[0]!.durationMs).toBeLessThan(3_000);
    for (const [index, piece] of pieces.entries()) {
      expect(piece.durationMs).toBeLessThanOrEqual(index === pieces.length - 1 ? 11_000 : 10_000);
      expect(Math.abs(readWavPcm(piece.data).samples[0]!.length / 16 - piece.durationMs)).toBeLessThanOrEqual(1);
      if (index > 0) expect(piece.startMs).toBe(pieces[index - 1]!.startMs + pieces[index - 1]!.durationMs - 1_000);
    }
    const last = pieces[pieces.length - 1]!;
    expect(last.startMs + last.durationMs).toBe(32_000);
    const resumed: AudioPiece[] = [];
    for await (const piece of cutPieces(bytes, { ...cutOptions, fromIndex: 2 })) resumed.push(piece);
    expect(resumed).toEqual(pieces.slice(2));
  });

  it('refuses PCM cutting when conversion has no decoder', async () => {
    const bytes = await pcmFile('wav', 1);
    const canDecode = vi.spyOn(InputAudioTrack.prototype, 'canDecode').mockResolvedValue(false);
    const samples = vi.spyOn(AudioSampleSink.prototype, 'samples');
    try {
      expect(await readAudioInfo(bytes)).toMatchObject({ path: null, reason: 'cannot_decode' });
      await expect(cutPieces(bytes, options).next()).rejects.toMatchObject({ reason: 'cannot_decode' });
      expect(samples).not.toHaveBeenCalled();
    } finally {
      canDecode.mockRestore();
      samples.mockRestore();
    }
  });

  it.each(['complete', 'return', 'error', 'abort'] as const)('disposes both cutting inputs on %s', async (ending) => {
    const bytes = await packetFile('wav', 12);
    const dispose = vi.spyOn(Input.prototype, 'dispose');
    const controller = new AbortController();
    const pieces = cutPieces(bytes, { ...options, pieceSeconds: 10, overlapSeconds: 1, maxBytes: ending === 'error' ? 1 : options.maxBytes, signal: controller.signal });
    try {
      if (ending === 'error') {
        await expect(pieces.next()).rejects.toBeInstanceOf(RangeError);
      } else {
        expect((await pieces.next()).done).toBe(false);
        expect(dispose).toHaveBeenCalledTimes(1);
        if (ending === 'return') await pieces.return(undefined);
        else if (ending === 'abort') {
          const reason = new Error('stop cutting');
          controller.abort(reason);
          await expect(pieces.next()).rejects.toBe(reason);
        } else {
          for await (const piece of pieces) expect(piece.data.length).toBeGreaterThan(0);
        }
      }
      expect(dispose).toHaveBeenCalledTimes(2);
      expect(new Set(dispose.mock.contexts).size).toBe(2);
    } finally {
      await pieces.return(undefined);
      dispose.mockRestore();
    }
  });

  it('does not inspect a recording when cutting was already aborted', async () => {
    const controller = new AbortController();
    const reason = new Error('stop before inspection');
    controller.abort(reason);
    const format = vi.spyOn(Input.prototype, 'getFormat');
    try {
      await expect(cutPieces(new Uint8Array([1, 2, 3, 4]), { ...options, signal: controller.signal }).next()).rejects.toBe(reason);
      expect(format).not.toHaveBeenCalled();
    } finally {
      format.mockRestore();
    }
  });

  it('passes cancellation through to the inspection packet scan', async () => {
    const bytes = await packetFile('m4a', 1);
    const controller = new AbortController();
    const reason = new Error('stop scanning');
    const packets = EncodedPacketSink.prototype.packets;
    let seen = 0;
    const scan = vi.spyOn(EncodedPacketSink.prototype, 'packets').mockImplementation(async function* (this: EncodedPacketSink, ...args) {
      for await (const packet of packets.call(this, ...args)) {
        seen += 1;
        controller.abort(reason);
        yield packet;
      }
    });
    try {
      await expect(cutPieces(bytes, { ...options, signal: controller.signal }).next()).rejects.toBe(reason);
      expect(seen).toBe(1);
    } finally {
      scan.mockRestore();
    }
  });

  it('decodes stereo PCM to 16 kHz mono and moves the first cut to the silence at 293 seconds', async () => {
    const pieces = await collect(await pcmFile('wav'));
    expect(pieces).toHaveLength(2);
    pieces.forEach(expectMonoWav);
    expect(Math.abs(pieces[0]!.durationMs - 293_000)).toBeLessThanOrEqual(100);
    expect(pieces[1]!.startMs).toBe(pieces[0]!.durationMs - 3_000);
    for (const piece of pieces) {
      const frames = readWavPcm(piece.data).samples[0]!.length;
      expect(Math.abs(frames - piece.durationMs * 16)).toBeLessThanOrEqual(16);
    }
  });

  it('never opens a sample sink for a copied recording', async () => {
    const search = vi.spyOn(AudioSampleSink.prototype, 'samples');
    try {
      const pieces: AudioPiece[] = [];
      for await (const piece of cutPieces(await packetFile('m4a', 12), { ...options, pieceSeconds: 10, overlapSeconds: 1 })) pieces.push(piece);
      expect(pieces.map((piece) => piece.startMs)).toEqual([0, 9_000]);
      expect(search).not.toHaveBeenCalled();
    } finally {
      search.mockRestore();
    }
  });

  it('keeps the planned mark when a quiet search fails after decoding a frame', async () => {
    const search = vi.spyOn(AudioSampleSink.prototype, 'samples').mockImplementationOnce(failedQuietSearch);
    try {
      const pieces: AudioPiece[] = [];
      for await (const piece of cutPieces(await pcmFile('wav', 12), { ...options, pieceSeconds: 10, overlapSeconds: 1 })) pieces.push(piece);
      expect(pieces.map((piece) => piece.startMs)).toEqual([0, 9_000]);
      expect(pieces[0]!.durationMs).toBe(10_000);
      pieces.forEach(expectMonoWav);
    } finally {
      search.mockRestore();
    }
  });

  it('decodes PCM in MOV', async () => {
    const mov = await collect(await pcmFile('mov', 12));
    expect(mov).toHaveLength(1);
    mov.forEach(expectMonoWav);
    expect(Math.abs(mov[0]!.durationMs - 12_000)).toBeLessThanOrEqual(1);
  });

  it('decodes FLAC when the fixture decoder configuration is supported', async (context) => {
    const bytes = await flacFile();
    if (!await canDecodeFile(bytes)) {
      expect(await readAudioInfo(bytes)).toMatchObject({ path: null, reason: 'cannot_decode' });
      context.skip('FLAC decoding at 48 kHz stereo is unavailable');
    }
    // WebKit can hold a FLAC packet without answering: a probe with no answer within fifteen seconds counts as a decoder that cannot.
    const failure = await Promise.race([
      firstPacketDecodeFailure(bytes),
      new Promise<string>((resolve) => setTimeout(() => resolve("the decoder did not answer within fifteen seconds"), 15_000)),
    ]);
    if (failure !== null) context.skip(`FLAC fixture packet cannot be decoded: ${failure}`);
    expect(await readAudioInfo(bytes)).toMatchObject({ codec: 'flac', path: 'decode', seconds: 12, sampleRate: 48_000, channels: 2 });
    const flac = await collect(bytes);
    expect(flac).toHaveLength(1);
    flac.forEach(expectMonoWav);
    const samples = readWavPcm(flac[0]!.data).samples[0]!;
    expect(Math.abs(samples.length - 12 * 16_000)).toBeLessThanOrEqual(1);
    expect(samples[16_000]).toBeCloseTo(0.0625, 3);
  });

  it('stops before the next piece when its signal aborts', async () => {
    const controller = new AbortController();
    const pieces = cutPieces(await packetFile('wav', 12), { ...options, pieceSeconds: 10, overlapSeconds: 1, signal: controller.signal });
    expect((await pieces.next()).done).toBe(false);
    const reason = new Error('stop cutting');
    controller.abort(reason);
    await expect(pieces.next()).rejects.toBe(reason);
  });
});
