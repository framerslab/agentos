/**
 * @fileoverview Documents the ingestion tests write at run time: a ZIP archive
 * of chosen entries (a Word file is one), the smallest PDF of one page of
 * text, and a PDF whose content stream inflates to a chosen size.
 *
 * @module memory/ingestion/__tests__/helpers/documents
 */

import { once } from 'node:events';
import { crc32, createDeflate, deflateRawSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// ZIP archives
// ---------------------------------------------------------------------------

/** One file of an archive written by {@link zipOf}. */
export interface ArchiveEntry {
  /** The entry's name inside the archive. */
  name: string;
  /** The entry's bytes before compression. */
  data: Buffer;
  /** The uncompressed size the headers state; the true size when left out. */
  statedSize?: number;
  /** The compression method: 8 deflates the data (the default), 0 stores it. */
  method?: 0 | 8;
}

/**
 * Writes a ZIP archive: each entry's local header and data, then the central
 * directory and its end record, with no archive comment.
 *
 * @param entries - The archive's files, in order.
 */
export function zipOf(entries: ArchiveEntry[]): Buffer {
  const files: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const method = entry.method ?? 8;
    const body = method === 8 ? deflateRawSync(entry.data) : entry.data;
    const checksum = crc32(entry.data);
    const statedSize = entry.statedSize ?? entry.data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed to extract
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0x21, 12); // 1 January 1980
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(statedSize, 22);
    local.writeUInt16LE(name.length, 26);
    files.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory file header signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed to extract
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0x21, 14); // 1 January 1980
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(statedSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42); // the local header's offset
    directory.push(central, name);

    offset += local.length + name.length + body.length;
  }

  const centralDirectory = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  end.writeUInt16LE(entries.length, 8); // entries on this disk
  end.writeUInt16LE(entries.length, 10); // entries in all
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16); // the central directory's offset
  return Buffer.concat([...files, centralDirectory, end]);
}

// ---------------------------------------------------------------------------
// PDF files
// ---------------------------------------------------------------------------

/** The size of each write {@link flatePdfOf} hands its deflate stream: 1 MiB. */
const WRITE_BYTES = 1_048_576;

/**
 * A text as a PDF literal string's contents: the backslash and both
 * parentheses escaped.
 *
 * @param text - The text to draw, in Latin-1.
 */
function literalString(text: string): string {
  return text.replace(/[\\()]/g, (char) => `\\${char}`);
}

/**
 * Lays out a PDF 1.4 file of one page as the smallest such file is laid out:
 * the catalog, the page tree, the page, the Helvetica font and the page's
 * content stream, then the cross-reference table with each object's byte
 * offset, and the trailer.
 *
 * @param content - The content stream's bytes as the file holds them.
 * @param filter - The filter that decodes them, when they are encoded.
 */
function onePagePdf(content: Buffer, filter?: string): Buffer {
  const parts: Buffer[] = [];
  const offsets: number[] = [];
  let length = 0;
  const write = (part: Buffer): void => {
    parts.push(part);
    length += part.length;
  };
  const object = (head: string, tail = ''): void => {
    offsets.push(length);
    write(Buffer.from(`${offsets.length} 0 obj\n${head}${tail}`, 'latin1'));
  };

  // The second line's four bytes above 127 mark the file as binary.
  write(Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1'));
  object('<< /Type /Catalog /Pages 2 0 R >>\n', 'endobj\n');
  object('<< /Type /Pages /Kids [3 0 R] /Count 1 >>\n', 'endobj\n');
  object(
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\n',
    'endobj\n',
  );
  object('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\n', 'endobj\n');
  // The stream's length counts its bytes alone, not the line end before endstream.
  object(`<< /Length ${content.length}${filter === undefined ? '' : ` /Filter /${filter}`} >>\nstream\n`);
  write(content);
  write(Buffer.from('\nendstream\nendobj\n', 'latin1'));

  const table = length;
  // Each entry of the table is 20 bytes: a 10-digit offset, a 5-digit generation, its kind and a two-byte line end.
  const entries = offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  write(
    Buffer.from(
      `xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n${entries}` +
        `trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${table}\n%%EOF\n`,
      'latin1',
    ),
  );
  return Buffer.concat(parts);
}

/**
 * The smallest PDF of one page whose content stream draws a line of text in
 * Helvetica.
 *
 * @param text - The line, in Latin-1.
 */
export function pdfOf(text: string): Buffer {
  return onePagePdf(Buffer.from(`BT /F1 12 Tf 72 720 Td (${literalString(text)}) Tj ET`, 'latin1'));
}

/**
 * The same page with a content stream of `bytes` copies of the byte `fill`
 * under `/Filter /FlateDecode`. The stream is deflated through
 * `zlib.createDeflate()` in writes of 1 MiB, so a stream of hundreds of
 * megabytes is deflated without being held: 256 MiB of spaces take about
 * 250 KB in the file.
 *
 * @param fill - The byte the content stream repeats.
 * @param bytes - How many bytes the content stream inflates to.
 */
export async function flatePdfOf(fill: number, bytes: number): Promise<Buffer> {
  const deflate = createDeflate();
  const deflated: Buffer[] = [];
  deflate.on('data', (part: Buffer) => {
    deflated.push(part);
  });
  const ended = once(deflate, 'end');

  const chunk = Buffer.alloc(Math.min(bytes, WRITE_BYTES), fill);
  for (let written = 0; written < bytes; written += chunk.length) {
    const piece = bytes - written >= chunk.length ? chunk : chunk.subarray(0, bytes - written);
    if (!deflate.write(piece)) await once(deflate, 'drain');
  }
  deflate.end();
  await ended;

  return onePagePdf(Buffer.concat(deflated), 'FlateDecode');
}
