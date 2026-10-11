import { canDecodeAudio, canEncodeAudio } from 'mediabunny';
import { describe, expect, it } from 'vitest';
import { cutPieces, readAudioInfo, readWavPcm, type AudioPiece } from '../../index.js';
import { ac3File, alacFile, flacFile, packetFile, pcmFile } from './fixtures.js';

const options = { pieceSeconds: 300, overlapSeconds: 3, maxBytes: 24_000_000 };

async function collect(bytes: Uint8Array): Promise<AudioPiece[]> {
  const pieces: AudioPiece[] = [];
  for await (const piece of cutPieces(bytes, options)) pieces.push(piece);
  return pieces;
}

function expectMonoWav(piece: AudioPiece): void {
  const read = readWavPcm(piece.data);
  expect(read).toMatchObject({ sampleRate: 16_000, channels: 1 });
  expect(piece.mimeType).toBe('audio/wav');
  expect(piece.fileName).toBe(`piece-${piece.index}.wav`);
  expect(piece.data.length).toBeLessThanOrEqual(64_000 * piece.durationMs / 1_000);
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
    const highRate = await readAudioInfo(await packetFile('m4a', 12, 8_192));
    expect(highRate.path).toBe(await canDecodeAudio('aac') ? 'decode' : null);
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

  it('decodes stereo PCM to 16 kHz mono and moves the first cut to the silence at 293 seconds', async () => {
    const pieces = await collect(await pcmFile('wav'));
    expect(pieces).toHaveLength(2);
    pieces.forEach(expectMonoWav);
    expect(Math.abs(pieces[0]!.durationMs - 293_000)).toBeLessThanOrEqual(100);
    expect(pieces[1]!.startMs).toBe(pieces[0]!.durationMs - 3_000);
  });

  it('decodes PCM in MOV and FLAC where a browser can encode and decode it', async (context) => {
    const mov = await collect(await pcmFile('mov', 12));
    expect(mov).toHaveLength(1);
    mov.forEach(expectMonoWav);
    if (!await canEncodeAudio('flac')) context.skip('FLAC encoder is unavailable');
    const bytes = await flacFile();
    if (!await canDecodeAudio('flac')) {
      expect(await readAudioInfo(bytes)).toMatchObject({ path: null, reason: 'cannot_decode' });
      context.skip('FLAC decoder is unavailable');
    }
    expect(await readAudioInfo(bytes)).toMatchObject({ codec: 'flac', path: 'decode' });
    const flac = await collect(bytes);
    expect(flac).toHaveLength(1);
    flac.forEach(expectMonoWav);
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
