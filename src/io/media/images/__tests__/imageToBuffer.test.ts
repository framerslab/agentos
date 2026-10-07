import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { bufferToBlobPart, imageToBuffer } from '../imageToBuffer.js';

// The first bytes of a JPEG (SOI and the JFIF APP0 header) and of a PNG.
const JPEG_START = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const PNG_START = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

describe('imageToBuffer', () => {
  it('decodes raw base64 that contains "/" instead of reading it as a file path', async () => {
    const raw = JPEG_START.toString('base64');
    expect(raw).toBe('/9j/4AAQSkZJRgAB');

    expect(await imageToBuffer(raw)).toEqual(JPEG_START);
  });

  it('decodes raw base64 TIFF data that contains "/"', async () => {
    const tiffStart = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0xff, 0xff, 0xff]);
    const raw = tiffStart.toString('base64');
    expect(raw).toBe('SUkqAP///w==');

    expect(await imageToBuffer(raw)).toEqual(tiffStart);
  });

  it('rejects a missing path made only of base64 characters', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imageToBuffer-'));
    try {
      await expect(imageToBuffer(join(dir, 'notfound'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a missing path that is not base64', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imageToBuffer-'));
    try {
      await expect(imageToBuffer(join(dir, 'missing.png'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reads a file whose path uses only base64 characters', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imageToBuffer-'));
    try {
      // No extension, so every character of the path is in the URL-safe base64 alphabet.
      const file = join(dir, 'photo');
      await writeFile(file, PNG_START);

      expect(await imageToBuffer(file)).toEqual(PNG_START);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('bufferToBlobPart', () => {
  it('converts Buffer data into a Blob-compatible Uint8Array', async () => {
    const bytes = bufferToBlobPart(Buffer.from([1, 2, 3, 4]));

    expect(bytes).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(bytes)).toEqual(new Uint8Array([1, 2, 3, 4]));

    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
  });
});
