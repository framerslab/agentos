import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspect } from 'node:util';

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

  it('decodes raw base64 BMP data that contains "/"', async () => {
    // "BM", the file size (32, little-endian), reserved bytes, the pixel offset, then pixels.
    const bmp = Buffer.concat([
      Buffer.from([0x42, 0x4d, 0x20, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1a, 0x00, 0x00, 0x00]),
      Buffer.alloc(18, 0xff),
    ]);
    const raw = bmp.toString('base64');
    expect(raw).toContain('/');

    expect(await imageToBuffer(raw)).toEqual(bmp);
  });

  it('decodes raw base64 SVG markup that contains "/"', async () => {
    const svg = Buffer.from('<svg><!--???--></svg>');
    const raw = svg.toString('base64');
    expect(raw).toContain('/');

    expect(await imageToBuffer(raw)).toEqual(svg);
  });

  it.each([
    ['ICO', [0x00, 0x00, 0x01, 0x00]],
    ['JPEG 2000 (JP2)', [0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a]],
    ['JPEG 2000 codestream', [0xff, 0x4f, 0xff, 0x51]],
    ['JPEG XL container', [0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a]],
  ])('decodes raw base64 %s data that contains "/"', async (_format, signature) => {
    // The signature, zero padding to a 3-byte boundary, then FF FF FF, which is "////".
    const bytes = Buffer.concat([
      Buffer.from(signature),
      Buffer.alloc((3 - (signature.length % 3)) % 3),
      Buffer.from([0xff, 0xff, 0xff]),
    ]);
    const raw = bytes.toString('base64');
    expect(raw).toContain('/');

    expect(await imageToBuffer(raw)).toEqual(bytes);
  });

  it.each([
    ['a comment', '<!--???--><svg></svg>'],
    ['a declaration and a DOCTYPE', '<?xml version="1.0"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg><!--???--></svg>'],
    ['a DOCTYPE whose subset holds a processing instruction with a quote', '<!DOCTYPE svg [<?pi a\'?>]><svg><!--???--></svg>'],
    [
      'a DOCTYPE whose subset holds a processing instruction with a quote and a bracket',
      '<!DOCTYPE svg [<?pi "]>?><!ENTITY e "x">]><svg><!--???--></svg>',
    ],
    [
      'a DOCTYPE whose quoted literals hold its delimiters',
      '<!DOCTYPE svg SYSTEM "http://example.com/a>b.dtd" [<!ENTITY e "x]>y"><!-- it\'s ] a comment -->]><svg><!--???--></svg>',
    ],
  ])('decodes raw base64 SVG markup after %s', async (_prolog, markup) => {
    const svg = Buffer.from(markup);
    const raw = svg.toString('base64');
    expect(raw).toContain('/');

    expect(await imageToBuffer(raw)).toEqual(svg);
  });

  it.each([
    ['a root element that only starts with "svg"', '<svg-not/><!--???-->'],
    ['"<svg" only inside a comment', '<?xml version="1.0"?><doc><!-- <svg --><!--???--></doc>'],
  ])('rejects base64 of XML with %s', async (_case, markup) => {
    const raw = Buffer.from(markup).toString('base64');
    expect(raw).toContain('/');

    await expect(imageToBuffer(raw)).rejects.toThrow('not base64 of a recognised image format');
  });

  it('rejects a DOCTYPE with hundreds of comments and no closing bracket in linear time', async () => {
    // A subset comment that could end at any later '-->' made this input backtrack exponentially.
    const raw = Buffer.from(`<!DOCTYPE x [${'<!-- -->'.repeat(500)}<???`).toString('base64');
    expect(raw).toContain('/');

    await expect(imageToBuffer(raw)).rejects.toThrow('not base64 of a recognised image format');
  }, 2000);

  it('quotes at most 40 characters of a short unrecognised payload', async () => {
    // 00 11 FF repeated: 60 characters of base64 "ABH/", a relative path that names nothing.
    const raw = Buffer.from(Array.from({ length: 45 }, (_, i) => [0x00, 0x11, 0xff][i % 3])).toString('base64');
    expect(raw).toHaveLength(60);

    const error = await imageToBuffer(raw).then(
      () => null,
      (e: Error) => e,
    );
    expect(error!.message).toContain(`${JSON.stringify(raw.slice(0, 40))}... (60 characters)`);
    expect(error!.message).not.toContain(raw);
  });

  it('rejects base64 of an unrecognised format without repeating it in the error', async () => {
    // 00 11 FF repeated: base64 "ABH/" repeated, a 4,000-character relative path
    // that names nothing and matches no signature.
    const raw = Buffer.from(Array.from({ length: 3000 }, (_, i) => [0x00, 0x11, 0xff][i % 3])).toString('base64');
    expect(raw.startsWith('ABH/ABH/')).toBe(true);

    const error = await imageToBuffer(raw).then(
      () => null,
      (e: NodeJS.ErrnoException) => e,
    );
    expect(error).not.toBeNull();
    expect(['ENOENT', 'ENOTDIR', 'ENAMETOOLONG']).toContain(error!.code);
    expect(error!.message).toContain('Pass the image as a data URL or a Buffer');
    expect(error!.message).toContain('(4000 characters)');
    expect(error!.message.length).toBeLessThan(400);
    // What console.error prints, causes included, does not carry the payload.
    expect(inspect(error)).not.toContain(raw.slice(0, 200));
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

  it('percent-decodes a data URL without ";base64", byte by byte (RFC 2397)', async () => {
    expect((await imageToBuffer('data:image/svg+xml,%3Csvg%3E%3C/svg%3E')).toString('utf8')).toBe('<svg></svg>');
    expect([...(await imageToBuffer('data:image/png,%89PNG'))]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(await imageToBuffer('DATA:image/png;BASE64,aGVsbG8=')).toEqual(Buffer.from('hello'));
    // Spaces around ;base64, as WHATWG Fetch reads a data URL.
    expect(await imageToBuffer('data:image/png; base64,aGVsbG8=')).toEqual(Buffer.from('hello'));
    expect(await imageToBuffer('data:image/png;base64 ,aGVsbG8=')).toEqual(Buffer.from('hello'));
  });

  it('reads a file URL whose path has an escaped space', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imageToBuffer-'));
    try {
      const file = join(dir, 'a photo.png');
      await writeFile(file, PNG_START);

      expect(await imageToBuffer(pathToFileURL(file).href)).toEqual(PNG_START);
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
