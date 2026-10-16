/**
 * The transcript readers and the hash in a page, in Chromium and in WebKit, through the library's browser entry: every
 * vector read from its text and from its bytes, a Word file read by mammoth's browser build passed in as a page passes
 * it, and a text hashed by the page's Web Crypto. The vectors are read from disk by the test server.
 */
import mammoth from 'mammoth';
import { commands } from 'vitest/browser';
import { describe, expect, it } from 'vitest';

import { readTranscript, readWordTranscript, sha256Hex, transcriptFormatOf, type ReadTranscript } from '../browser.js';

/** A vector's text, as written by hand under `vectors/`. */
function vector(name: string): Promise<string> {
  return commands.readFile(`src/cognition/library/__tests__/vectors/${name}`);
}

/** What a vector reads into, written by hand beside it. */
async function expected(name: string): Promise<ReadTranscript> {
  const { format, turns, labels, durationMs } = JSON.parse(await vector(`${name}.expected.json`)) as ReadTranscript;
  return { format, turns, labels, durationMs };
}

/** The one meeting every vector holds, in its own layout. */
const LAYOUTS = [
  { file: 'meeting.srt', format: 'srt' },
  { file: 'meeting.vtt', format: 'vtt' },
  { file: 'otter.txt', format: 'otter' },
  { file: 'fireflies.json', format: 'fireflies' },
  { file: 'lines.txt', format: 'lines' },
] as const;

/** The CRC-32 of bytes, as a ZIP entry records it. */
function crc32(bytes: Uint8Array): number {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

/** A ZIP archive of stored entries, written in the page: each entry's local header and bytes, the directory, its end. */
function storedZip(entries: ReadonlyArray<{ name: string; text: string }>): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const directory: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const data = encoder.encode(entry.text);
    const crc = crc32(data);

    const local = new Uint8Array(30 + name.length + data.length);
    const head = new DataView(local.buffer);
    head.setUint32(0, 0x04034b50, true);
    head.setUint16(4, 20, true);
    head.setUint16(12, 0x21, true); // 1 January 1980
    head.setUint32(14, crc, true);
    head.setUint32(18, data.length, true);
    head.setUint32(22, data.length, true);
    head.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(data, 30 + name.length);

    const listed = new Uint8Array(46 + name.length);
    const record = new DataView(listed.buffer);
    record.setUint32(0, 0x02014b50, true);
    record.setUint16(4, 20, true);
    record.setUint16(6, 20, true);
    record.setUint16(14, 0x21, true);
    record.setUint32(16, crc, true);
    record.setUint32(20, data.length, true);
    record.setUint32(24, data.length, true);
    record.setUint16(28, name.length, true);
    record.setUint32(42, offset, true);
    listed.set(name, 46);

    parts.push(local);
    directory.push(listed);
    offset += local.length;
  }
  const size = directory.reduce((sum, listed) => sum + listed.length, 0);
  const end = new Uint8Array(22);
  const close = new DataView(end.buffer);
  close.setUint32(0, 0x06054b50, true);
  close.setUint16(8, entries.length, true);
  close.setUint16(10, entries.length, true);
  close.setUint32(12, size, true);
  close.setUint32(16, offset, true);

  const archive = new Uint8Array(offset + size + end.length);
  let at = 0;
  for (const part of [...parts, ...directory, end]) {
    archive.set(part, at);
    at += part.length;
  }
  return archive;
}

/** XML's three escapes for text. */
function xml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** A Word file of one paragraph a line: its content types, its package relationships and its main document part. */
function wordFileOf(lines: readonly string[]): Uint8Array {
  return storedZip([
    {
      name: '[Content_Types].xml',
      text:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ' +
        'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '</Types>',
    },
    {
      name: '_rels/.rels',
      text:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" ' +
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" ' +
        'Target="word/document.xml"/>' +
        '</Relationships>',
    },
    {
      name: 'word/document.xml',
      text:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
        lines.map((line) => `<w:p><w:r><w:t>${xml(line)}</w:t></w:r></w:p>`).join('') +
        '</w:body></w:document>',
    },
  ]);
}

describe('the transcript readers in a page', () => {
  it('read every vector from its text and from its bytes, and name its format, as they do in Node', async () => {
    for (const { file, format } of LAYOUTS) {
      const text = await vector(file);
      const want = await expected(file);

      expect(readTranscript(text, format), file).toEqual(want);
      // A file as a page holds it once picked: bytes, here with a byte order mark and CRLF line ends.
      const bytes = new TextEncoder().encode(`\ufeff${text.replace(/\n/g, '\r\n')}`);
      expect(readTranscript(bytes, format), `${file} as bytes`).toEqual(want);
      expect(transcriptFormatOf(file, bytes.subarray(0, 4096)), file).toBe(format);
    }
  });

  it('read a Word file through mammoth\'s browser build, passed in as a page passes it', async () => {
    const lines = (await vector('lines.txt')).split('\n').filter((line) => line.length > 0);
    const file = wordFileOf(lines);

    expect(transcriptFormatOf('Planning call.docx', file.subarray(0, 4096))).toBe('docx');
    expect(await readWordTranscript(file, { extractRawText: mammoth.extractRawText })).toEqual({
      ...(await expected('lines.txt')),
      format: 'docx',
    });
  });

  it('hash a text\'s UTF-8 bytes with SHA-256', async () => {
    expect(await sha256Hex('a\n')).toBe('87428fc522803d31065e7bce3cf03fe475096631e5e07bbd7a0fde60c4cf25c7');
    // Characters of two, three and four bytes: an n with a tilde, two Han characters and an emoji.
    expect(await sha256Hex('Señor 张伟 said: \u{1f600}')).toBe(
      'a523ceb31c35b879eb9f872531d01eac55f1c076df0c96186493302a0ada6c6a',
    );
  });
});
