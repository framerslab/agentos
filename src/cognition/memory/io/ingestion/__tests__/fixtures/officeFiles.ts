/**
 * @fileoverview Office documents the OfficeLoader tests write at run time, so
 * no binary file is committed: a workbook, a deck, an OpenDocument sheet and
 * an OpenDocument deck as the smallest packages officeparser's parsers read;
 * an OpenDocument text, an RTF file and an EPUB book written by officeparser's
 * own converter from Markdown; and a PDF of one page whose only content is a
 * picture of the words "Tesseract.js".
 *
 * @module memory/ingestion/__tests__/fixtures/officeFiles
 */

import { OfficeConverter } from 'officeparser';

import { zipOf, type ArchiveEntry } from '../helpers/documents.js';

// ---------------------------------------------------------------------------
// Parts of a package
// ---------------------------------------------------------------------------

/** The declaration every part of an Office Open XML package starts with. */
const OOXML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

/** The declaration every part of an OpenDocument package starts with. */
const ODF_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';

/** The namespace of a package's relationships parts. */
const PACKAGE_RELATIONSHIPS = 'http://schemas.openxmlformats.org/package/2006/relationships';

/** The namespace the relationship types of an Office document start with. */
const OFFICE_RELATIONSHIPS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/**
 * One part of a package.
 *
 * @param name - The part's name inside the archive.
 * @param xml - The part's XML.
 */
function part(name: string, xml: string): ArchiveEntry {
  return { name, data: Buffer.from(xml, 'utf8') };
}

/**
 * A text as XML character data: the ampersand and both angle brackets escaped.
 *
 * @param text - The text an element holds.
 */
function characterData(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * A package's `[Content_Types].xml`.
 *
 * @param overrides - Each part's name, from the package's root, with its content type.
 */
function contentTypes(overrides: Record<string, string>): ArchiveEntry {
  const named = Object.entries(overrides)
    .map(([partName, contentType]) => `<Override PartName="${partName}" ContentType="${contentType}"/>`)
    .join('');
  return part(
    '[Content_Types].xml',
    `${OOXML_DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      `<Default Extension="xml" ContentType="application/xml"/>${named}</Types>`,
  );
}

/**
 * A relationships part naming one target as `rId1`.
 *
 * @param name - The relationships part's name inside the archive.
 * @param type - The last segment of the relationship's type.
 * @param target - The part the relationship names, relative to the part the relationships belong to.
 */
function relationship(name: string, type: string, target: string): ArchiveEntry {
  return part(
    name,
    `${OOXML_DECLARATION}<Relationships xmlns="${PACKAGE_RELATIONSHIPS}">` +
      `<Relationship Id="rId1" Type="${OFFICE_RELATIONSHIPS}/${type}" Target="${target}"/></Relationships>`,
  );
}

// ---------------------------------------------------------------------------
// Excel and PowerPoint
// ---------------------------------------------------------------------------

/**
 * The smallest workbook officeparser reads: the content types, the package's
 * relationships, the workbook, its relationships and one sheet.
 *
 * @param rows - The sheet's `row` elements.
 */
function workbookOf(rows: string): Buffer {
  const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  return zipOf([
    contentTypes({
      '/xl/workbook.xml': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
      '/xl/worksheets/sheet1.xml': 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml',
    }),
    relationship('_rels/.rels', 'officeDocument', 'xl/workbook.xml'),
    part(
      'xl/workbook.xml',
      `${OOXML_DECLARATION}<workbook xmlns="${main}" xmlns:r="${OFFICE_RELATIONSHIPS}">` +
        '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
    ),
    relationship('xl/_rels/workbook.xml.rels', 'worksheet', 'worksheets/sheet1.xml'),
    part(
      'xl/worksheets/sheet1.xml',
      `${OOXML_DECLARATION}<worksheet xmlns="${main}"><sheetData>${rows}</sheetData></worksheet>`,
    ),
  ]);
}

/**
 * An `.xlsx` workbook whose one sheet holds one cell, an inline string.
 *
 * @param text - The cell's text.
 */
export function xlsxOf(text: string): Buffer {
  return workbookOf(`<row r="1"><c r="A1" t="inlineStr"><is><t>${characterData(text)}</t></is></c></row>`);
}

/**
 * An `.xlsx` workbook whose one sheet holds one row of cells, each the number 1.
 *
 * @param cells - How many cells the row holds.
 */
export function xlsxOfCells(cells: number): Buffer {
  return workbookOf(`<row r="1">${'<c><v>1</v></c>'.repeat(cells)}</row>`);
}

/**
 * The smallest `.pptx` deck officeparser reads: the content types, the
 * package's relationships, the presentation with its slide list, its
 * relationships and one slide holding one text box.
 *
 * @param text - The text box's one line.
 */
export function pptxOf(text: string): Buffer {
  const namespaces =
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    `xmlns:r="${OFFICE_RELATIONSHIPS}" ` +
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
  return zipOf([
    contentTypes({
      '/ppt/presentation.xml':
        'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
      '/ppt/slides/slide1.xml': 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml',
    }),
    relationship('_rels/.rels', 'officeDocument', 'ppt/presentation.xml'),
    part(
      'ppt/presentation.xml',
      `${OOXML_DECLARATION}<p:presentation ${namespaces}>` +
        '<p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>',
    ),
    relationship('ppt/_rels/presentation.xml.rels', 'slide', 'slides/slide1.xml'),
    part(
      'ppt/slides/slide1.xml',
      `${OOXML_DECLARATION}<p:sld ${namespaces}><p:cSld><p:spTree>` +
        '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>' +
        '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Text"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/>' +
        `<p:txBody><a:bodyPr/><a:p><a:r><a:t>${characterData(text)}</a:t></a:r></a:p></p:txBody></p:sp>` +
        '</p:spTree></p:cSld></p:sld>',
    ),
  ]);
}

// ---------------------------------------------------------------------------
// OpenDocument sheets and slides
// ---------------------------------------------------------------------------

/**
 * The smallest OpenDocument package officeparser reads: the media type stored
 * first, as the format asks, then the manifest and the content.
 *
 * @param mediaType - The package's media type.
 * @param body - The children of the content's `office:body`.
 */
function openDocumentOf(mediaType: string, body: string): Buffer {
  const namespaces =
    'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
    'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
    'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ' +
    'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"';
  return zipOf([
    { name: 'mimetype', data: Buffer.from(mediaType, 'ascii'), method: 0 },
    part(
      'META-INF/manifest.xml',
      `${ODF_DECLARATION}<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" ` +
        `manifest:version="1.2"><manifest:file-entry manifest:full-path="/" manifest:media-type="${mediaType}"/>` +
        '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>',
    ),
    part(
      'content.xml',
      `${ODF_DECLARATION}<office:document-content ${namespaces} office:version="1.2">` +
        `<office:body>${body}</office:body></office:document-content>`,
    ),
  ]);
}

/**
 * An `.ods` sheet of one cell.
 *
 * @param text - The cell's text.
 */
export function odsOf(text: string): Buffer {
  return openDocumentOf(
    'application/vnd.oasis.opendocument.spreadsheet',
    '<office:spreadsheet><table:table table:name="Sheet1"><table:table-row>' +
      `<table:table-cell office:value-type="string"><text:p>${characterData(text)}</text:p></table:table-cell>` +
      '</table:table-row></table:table></office:spreadsheet>',
  );
}

/**
 * An `.odp` deck of one slide holding one text box.
 *
 * @param text - The text box's one line.
 */
export function odpOf(text: string): Buffer {
  return openDocumentOf(
    'application/vnd.oasis.opendocument.presentation',
    '<office:presentation><draw:page draw:name="page1"><draw:frame><draw:text-box>' +
      `<text:p>${characterData(text)}</text:p>` +
      '</draw:text-box></draw:frame></draw:page></office:presentation>',
  );
}

// ---------------------------------------------------------------------------
// OpenDocument text, RTF and EPUB, written by officeparser's converter
// ---------------------------------------------------------------------------

/**
 * A Markdown text written by officeparser's own converter in one of the formats it writes.
 *
 * @param markdown - The document, as Markdown.
 * @param format - The format to write.
 * @throws {TypeError} When the converter answers neither text nor bytes.
 */
async function converted(markdown: string, format: 'odt' | 'rtf' | 'epub'): Promise<Buffer> {
  const written: { value: unknown } = await OfficeConverter.convert(Buffer.from(markdown, 'utf8'), format, {
    parseConfig: { fileType: 'md' as const },
  });
  if (typeof written.value === 'string') return Buffer.from(written.value, 'utf8');
  if (written.value instanceof Uint8Array) return Buffer.from(written.value);
  throw new TypeError(`officeparser wrote the ${format} file as neither text nor bytes`);
}

/**
 * An `.odt` text document.
 *
 * @param markdown - The document, as Markdown: a blank line between two paragraphs.
 */
export function odtOf(markdown: string): Promise<Buffer> {
  return converted(markdown, 'odt');
}

/**
 * An `.rtf` file.
 *
 * @param markdown - The document, as Markdown.
 */
export function rtfOf(markdown: string): Promise<Buffer> {
  return converted(markdown, 'rtf');
}

/**
 * An `.epub` book of one chapter.
 *
 * @param markdown - The chapter, as Markdown.
 */
export function epubOf(markdown: string): Promise<Buffer> {
  return converted(markdown, 'epub');
}

// ---------------------------------------------------------------------------
// A scanned page
// ---------------------------------------------------------------------------

/*
 * The picture below is tests/assets/images/simple.jpg of tesseract.js 7.0.0
 * (https://github.com/naptha/tesseract.js): the words "Tesseract.js" in black
 * on white, 320 by 180 pixels, a baseline JPEG of three components. It is
 * carried unchanged, as the base64 that tesseract.js's tests/constants.mjs
 * holds as SIMPLE_JPG_BASE64.
 *
 * The picture is the work of the tesseract.js authors, licensed under the
 * Apache License, Version 2.0 (the "License"); you may not use it except in
 * compliance with the License. You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
const SIMPLE_JPG_BASE64 = [
  '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',
  'cvUjnfzFOyglpGRUkbkc5WfqqkSIiNVF8XN0nV/hL09DT56eaxatpzaa5jOLz3Ex5mfxTGYiZme86acbqtv4q3G0xaYmvURbuYjGMTH5fEVzi0xiOLTH',
  'LfZe5skvHF+XSGd1GEXXZNXOrvUnkko2JUUML2rUQNVGVXopK57GSNViva3tOlU91dnen1+/0+L+2tNWJn9Kz3aI/q4xPHuJicYmPLLb7uur9Crvr1za',
  '1tCY+O78vbnzFZnHLGeviVuU+i7/AKY0xmFuouX+e0ddcW09XNmme3GmvDLG2JzfXdA2oSOOGORnm1Ue9UYrmuRe2/PG71NKdOunPt04t3377VtivDn9',
  '/HGYjPKZxHeFG2jU9e2vaOd5rPWMUi0RaeUUj4iZzNc4mtYieu2EM85H6i09JZ8x4zc/dzbEzC3XykgqMazSsr7nabnQvk8KhipPSRRNXpe0kR6uRO/D',
  'pyte2r6ba2vvtvoxSLaeraK2zGJrFvFoziYmJiIxjPffti1Zm31I0tprWtbGpp1mazE5ibR13EZi0YmZjM46j5xLZHK3PNn5XuDWHFLVWdVeDTZ/T192',
  'yLIqFjVrqe1U8S+UNK9yfpSyL59St6exWsVF67RYtvpfxe+1NK9pjT0aV1LRHU25X41iJ+MTXvzExbuJiONttTcRt9jp61axOprWmlc9xXFeVpnxmeM9',
  'ftOMTMWr3OI8VNm4PdLzjdDys2jf8Cyiw1VDXtyG9e7yG13FytSGsttxSNFhRGK9FYremuRHfervs1n+bpW0dXxmtqzXq0TE1ma2n5raInMf2jGbTKIj',
  'TvXV0/xdxaJ7rNZraImI+L1tMTE/MefwxnOfATjf9RzfaGT/AMetxUv5H2vcKL6fTZT4UV89u6N3q3OL0v5qWT9pHdt8k+OkNvp+px+l7XdYiedbe38t',
  'cxj2x8YzmP1iJc/U9LP1DW23Keq6c8s+6c5nEz9usRH2mXpCYumTuOmb5/eORfKizVGQXa9w45drYywWuuuEklNSOdRyu9KBj3eELXvRvfj4ov7qYadt',
  'X/D86+lHLV9XcRGfM8ZjjXP2jxEeId60acfWq6OpPHT9PSmcfGYjlOPv85x2ovize5duZZQ1+x+be08V39br4kl917dq9tDZ+2VDvKigtMrGx1DX0sbk',
  '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',
  'AAAAAAAAAAAAAAAAAAAAAB//2Q==',
].join('');

/** The picture's width, in pixels. */
const SCAN_WIDTH = 320;

/** The picture's height, in pixels. */
const SCAN_HEIGHT = 180;

/**
 * A scanned page: a PDF 1.4 file of one page with no text, whose content
 * stream draws one JPEG picture (an image XObject under `/Filter /DCTDecode`)
 * over the whole page. The file is laid out as the smallest such file is: the
 * catalog, the page tree, the page, the picture and the content stream, then
 * the cross-reference table with each object's byte offset, and the trailer.
 */
export function scannedPdf(): Buffer {
  const picture = Buffer.from(SIMPLE_JPG_BASE64, 'base64');
  const parts: Buffer[] = [];
  const offsets: number[] = [];
  let length = 0;
  const write = (bytes: Buffer): void => {
    parts.push(bytes);
    length += bytes.length;
  };
  const object = (body: string): void => {
    offsets.push(length);
    write(Buffer.from(`${offsets.length} 0 obj\n${body}`, 'latin1'));
  };
  // A stream's length counts its bytes alone, not the line end before endstream.
  const stream = (entries: string, data: Buffer): void => {
    object(`<< ${entries}/Length ${data.length} >>\nstream\n`);
    write(data);
    write(Buffer.from('\nendstream\nendobj\n', 'latin1'));
  };

  // The second line's four bytes above 127 mark the file as binary.
  write(Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1'));
  object('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  object('<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  object(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${SCAN_WIDTH} ${SCAN_HEIGHT}] ` +
      '/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n',
  );
  stream(
    `/Type /XObject /Subtype /Image /Width ${SCAN_WIDTH} /Height ${SCAN_HEIGHT} ` +
      '/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode ',
    picture,
  );
  // The picture fills the unit square, which this matrix stretches over the page.
  stream('', Buffer.from(`q ${SCAN_WIDTH} 0 0 ${SCAN_HEIGHT} 0 0 cm /Im0 Do Q`, 'latin1'));

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
