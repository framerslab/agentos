#!/usr/bin/env node
// Example: office documents read to text in memory, under bounds on what they inflate to.
//
// Docs: docs/memory/MEMORY_DOCUMENT_INGESTION.md, "PowerPoint, Excel, OpenDocument, RTF and EPUB files".
//
// This script demonstrates:
//   - OfficeLoader from its own entry, @framers/agentos/cognition/memory/office, which imports
//     officeparser on its first read
//   - a document's bytes read under the format its caller names, with the text's word count
//   - the same document read in a worker thread with loadIsolated, as for a file from someone
//     you do not know, under a heap cap and a deadline made for that read
//   - a read cancelled by its own signal, while the loader reads on
//   - a document past a bound refused with DocumentTooLargeError, its cause naming the bound
//   - a PDF refused with ScannedDocumentError while OCR is off (ocrPages 0, the default)
//
// With no file named, it writes an OpenDocument text and an EPUB book from Markdown with
// officeparser's converter and reads them. Name files to read those instead:
//   node examples/office-documents.mjs deck.pptx budget.xlsx notes.odt
//
// Usage (no API key, no network; officeparser is an optional peer: npm install officeparser):
//   pnpm install && pnpm run build
//   node examples/office-documents.mjs

import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { OfficeConverter } from 'officeparser';
import {
  DocumentTooLargeError,
  OFFICE_TYPES,
  OfficeLoader,
  ScannedDocumentError,
} from '@framers/agentos/cognition/memory/office';
import { loadIsolated } from '@framers/agentos/cognition/memory';

const loader = new OfficeLoader({
  maxInflatedBytes: 32 * 1024 * 1024,
  maxXmlElements: 400_000,
  maxTableCells: 200_000,
});

/** Prints what a read gave: the word count and the first lines of the text. */
function show(label, doc) {
  const lines = doc.content.split('\n').map((line) => line.trim()).filter(Boolean);
  console.log(`${label}: ${doc.format}, ${doc.metadata.wordCount} words`);
  for (const line of lines.slice(0, 3)) console.log(`  ${line}`);
}

/** A Markdown text written by officeparser's converter as an .odt, .rtf or .epub file. */
async function written(markdown, format) {
  const { value } = await OfficeConverter.convert(Buffer.from(markdown, 'utf8'), format, {
    parseConfig: { fileType: 'md' },
  });
  return typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
}

const files = process.argv.slice(2);

if (files.length > 0) {
  for (const file of files) {
    const format = OFFICE_TYPES[extname(file).toLowerCase()];
    if (format === undefined) {
      console.log(`${file}: not one of ${Object.keys(OFFICE_TYPES).join(', ')}`);
      continue;
    }
    show(file, await loader.load(await readFile(file), { format, signal: AbortSignal.timeout(30_000) }));
  }
} else {
  const notes = [
    '# Offsite plan',
    '',
    'The rooms are held until the twentieth.',
    '',
    'Travel is booked for the second week of the month.',
  ].join('\n');

  console.log('\n=== an OpenDocument text and an EPUB book, read from their bytes ===\n');
  const odt = await written(notes, 'odt');
  show('notes.odt', await loader.load(odt, { format: 'odt' }));
  show('notes.epub', await loader.load(await written(notes, 'epub'), { format: 'epub' }));

  console.log('\n=== the same text read in a worker thread, as for a file from someone you do not know ===\n');
  show(
    'notes.odt',
    await loadIsolated('odt', odt, { maxHeapMb: 256, maxTableCells: 200_000, signal: AbortSignal.timeout(30_000) }),
  );

  console.log('\n=== a read cancelled by its own signal ===\n');
  const upload = new AbortController();
  upload.abort(new Error('the upload was withdrawn'));
  try {
    await loader.load(odt, { format: 'odt', signal: upload.signal });
    throw new Error('a read whose signal was aborted was read');
  } catch (error) {
    if (error !== upload.signal.reason) throw error;
    console.log(`cancelled: ${error.message}`);
  }
  show('notes.odt, read again with no signal', await loader.load(odt, { format: 'odt' }));

  console.log('\n=== a document past a bound ===\n');
  const long = await written(Array.from({ length: 2_000 }, (_, i) => `Paragraph ${i + 1}.`).join('\n\n'), 'odt');
  const strict = new OfficeLoader({ maxXmlElements: 1_000 });
  try {
    await strict.load(long, { format: 'odt' });
    throw new Error('a document of 2,000 paragraphs was read under a bound of 1,000 XML elements');
  } catch (error) {
    if (!(error instanceof DocumentTooLargeError)) throw error;
    console.log(`refused: ${error.code}, ${error.cause.message}`);
  }

  console.log('\n=== a PDF while OCR is off ===\n');
  try {
    await loader.load(Buffer.from('%PDF-1.4\n'), { format: 'pdf' });
    throw new Error('a PDF was read with ocrPages at 0');
  } catch (error) {
    if (!(error instanceof ScannedDocumentError)) throw error;
    console.log(`refused: ${error.code}, ${error.message}`);
  }
}
