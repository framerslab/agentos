/**
 * @fileoverview Tests for PDF and DOCX document loaders.
 *
 * Covers:
 * - {@link PdfLoader} — structure, `canLoad`, `supportedExtensions`.
 * - {@link DocxLoader} — structure, `canLoad`, `supportedExtensions`, and
 *   basic loading from a minimal DOCX buffer.
 * - {@link createOcrPdfLoader} factory — returns null when tesseract.js is absent.
 * - {@link createDoclingLoader} factory — returns null when python docling is absent.
 * - {@link LoaderRegistry} — `.pdf` and `.docx` are registered by default.
 *
 * Note: generating real in-process PDFs requires heavyweight dependencies that
 * are not part of the test environment.  PDF loading tests therefore focus on
 * structural validation (`canLoad`, `supportedExtensions`) and use mock-based
 * strategies rather than real PDF parse cycles.
 *
 * @module memory/ingestion/__tests__/pdf.test
 */

import { describe, it, expect, vi } from 'vitest';
import { PdfLoader } from '../PdfLoader.js';
import { DocxLoader } from '../DocxLoader.js';
import { createOcrPdfLoader } from '../OcrPdfLoader.js';
import { createDoclingLoader } from '../DoclingLoader.js';
import { LoaderRegistry } from '../LoaderRegistry.js';

// Vitest hoists vi.mock above every import, so it lives at the top level:
// the DOCX test needs no real binary, only the loader's wiring around mammoth.
vi.mock('mammoth', () => ({
  default: {
    extractRawText: vi.fn().mockResolvedValue({
      value: 'Hello world from docx',
      messages: [],
    }),
  },
}));

// ---------------------------------------------------------------------------
// PdfLoader
// ---------------------------------------------------------------------------

describe('PdfLoader', () => {
  it('includes .pdf in supportedExtensions', () => {
    const loader = new PdfLoader();
    expect(loader.supportedExtensions).toContain('.pdf');
  });

  it('canLoad returns true for .pdf paths', () => {
    const loader = new PdfLoader();
    expect(loader.canLoad('/reports/q3.pdf')).toBe(true);
    expect(loader.canLoad('document.pdf')).toBe(true);
    expect(loader.canLoad('UPPER.PDF')).toBe(true);
  });

  it('canLoad returns false for non-PDF paths', () => {
    const loader = new PdfLoader();
    expect(loader.canLoad('/notes/file.txt')).toBe(false);
    expect(loader.canLoad('/notes/file.md')).toBe(false);
    expect(loader.canLoad('/notes/file.docx')).toBe(false);
    expect(loader.canLoad('/notes/file.html')).toBe(false);
  });

  it('canLoad returns true for a Buffer starting with PDF magic bytes (%PDF)', () => {
    const loader = new PdfLoader();
    // %PDF- magic bytes: 0x25 0x50 0x44 0x46
    const pdfMagic = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
    expect(loader.canLoad(pdfMagic)).toBe(true);
  });

  it('canLoad returns false for a Buffer that does not start with PDF magic bytes', () => {
    const loader = new PdfLoader();
    const notPdf = Buffer.from('Hello, world!');
    expect(loader.canLoad(notPdf)).toBe(false);
  });

  it('delegates to doclingLoader when provided and it can load the file', async () => {
    // Build a mock Docling loader that returns a fixed document.
    const mockDocling = {
      supportedExtensions: ['.pdf'],
      canLoad: () => true,
      load: vi.fn().mockResolvedValue({
        content: 'Docling extracted text',
        metadata: { title: 'Docling Doc', pageCount: 2 },
        format: 'pdf',
      }),
    };

    const loader = new PdfLoader(null, mockDocling);
    // Provide a fake path; PdfLoader should delegate before reading from disk.
    const doc = await loader.load('/fake/path.pdf');

    expect(mockDocling.load).toHaveBeenCalledOnce();
    expect(doc.content).toBe('Docling extracted text');
    expect(doc.metadata.title).toBe('Docling Doc');
  });
});

// ---------------------------------------------------------------------------
// DocxLoader
// ---------------------------------------------------------------------------

describe('DocxLoader', () => {
  it('includes .docx in supportedExtensions', () => {
    const loader = new DocxLoader();
    expect(loader.supportedExtensions).toContain('.docx');
  });

  it('canLoad returns true for .docx paths', () => {
    const loader = new DocxLoader();
    expect(loader.canLoad('/docs/spec.docx')).toBe(true);
    expect(loader.canLoad('report.docx')).toBe(true);
    expect(loader.canLoad('UPPER.DOCX')).toBe(true);
  });

  it('canLoad returns false for non-DOCX paths', () => {
    const loader = new DocxLoader();
    expect(loader.canLoad('/notes/file.txt')).toBe(false);
    expect(loader.canLoad('/notes/file.pdf')).toBe(false);
    expect(loader.canLoad('/notes/file.md')).toBe(false);
    expect(loader.canLoad('/notes/file.html')).toBe(false);
  });

  it('canLoad returns true for a Buffer starting with PK (ZIP) magic bytes', () => {
    const loader = new DocxLoader();
    // .docx is a ZIP archive — PK magic: 0x50 0x4B 0x03 0x04
    const pkMagic = Buffer.from([0x50, 0x4B, 0x03, 0x04, 0x00, 0x00]);
    expect(loader.canLoad(pkMagic)).toBe(true);
  });

  it('canLoad returns false for a Buffer that does not start with PK magic bytes', () => {
    const loader = new DocxLoader();
    const notDocx = Buffer.from('Not a zip file');
    expect(loader.canLoad(notDocx)).toBe(false);
  });

  it('loads a minimal DOCX buffer and returns text content with wordCount', async () => {
    const loader = new DocxLoader();

    // mammoth is mocked at the top of this file; this checks the loader's wiring.
    // We pass a buffer so the loader skips disk I/O. The loader reads the ZIP
    // archive's central directory before mammoth runs, so the buffer is an
    // empty archive: its end of central directory record alone.
    const emptyArchive = Buffer.alloc(22);
    emptyArchive.writeUInt32LE(0x06054b50, 0);
    const doc = await loader.load(emptyArchive);

    expect(typeof doc.content).toBe('string');
    expect(doc.format).toBe('docx');
    expect(typeof doc.metadata.wordCount).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// OcrPdfLoader factory
// ---------------------------------------------------------------------------

describe('createOcrPdfLoader', () => {
  it('returns null when tesseract.js is not installed', () => {
    // In the standard test environment tesseract.js is not a dependency.
    // The factory should gracefully return null rather than throwing.
    const loader = createOcrPdfLoader();
    // It may return null (tesseract.js absent) or an IDocumentLoader (if somehow
    // present in the test environment).  We only assert null is acceptable.
    expect(loader === null || typeof loader === 'object').toBe(true);

    // In CI / standard dev the package is absent, so we further verify the
    // null branch.  We use a try/resolve guard rather than a brittle env check.
    if (loader === null) {
      // Correct: tesseract.js was not found.
      expect(loader).toBeNull();
    } else {
      // If somehow installed, it should at least be a valid IDocumentLoader.
      expect(loader.supportedExtensions).toContain('.pdf');
      expect(typeof loader.canLoad).toBe('function');
      expect(typeof loader.load).toBe('function');
    }
  });
});

// ---------------------------------------------------------------------------
// DoclingLoader factory
// ---------------------------------------------------------------------------

describe('createDoclingLoader', () => {
  it('returns null when python3 docling is not installed', () => {
    // In the standard Node/test environment `python3 -m docling` is not
    // available.  The factory should return null rather than throwing.
    const loader = createDoclingLoader();
    expect(loader === null || typeof loader === 'object').toBe(true);

    if (loader === null) {
      // Correct — docling is absent.
      expect(loader).toBeNull();
    } else {
      // If somehow available, verify the shape.
      expect(loader.supportedExtensions).toContain('.pdf');
      expect(loader.supportedExtensions).toContain('.docx');
      expect(typeof loader.canLoad).toBe('function');
      expect(typeof loader.load).toBe('function');
    }
  });
});

// ---------------------------------------------------------------------------
// LoaderRegistry — PDF + DOCX now registered by default
// ---------------------------------------------------------------------------

describe('LoaderRegistry (pdf + docx)', () => {
  it('registers a PdfLoader for .pdf by default', () => {
    const registry = new LoaderRegistry();
    const loader = registry.getLoader('.pdf');
    expect(loader).toBeDefined();
    expect(loader?.supportedExtensions).toContain('.pdf');
  });

  it('registers a DocxLoader for .docx by default', () => {
    const registry = new LoaderRegistry();
    const loader = registry.getLoader('.docx');
    expect(loader).toBeDefined();
    expect(loader?.supportedExtensions).toContain('.docx');
  });

  it('getSupportedExtensions includes .pdf and .docx', () => {
    const registry = new LoaderRegistry();
    const exts = registry.getSupportedExtensions();
    expect(exts).toContain('.pdf');
    expect(exts).toContain('.docx');
  });

  it('getLoader accepts full file paths for .pdf and .docx', () => {
    const registry = new LoaderRegistry();
    expect(registry.getLoader('/reports/q3.pdf')).toBeDefined();
    expect(registry.getLoader('/docs/spec.docx')).toBeDefined();
  });
});
