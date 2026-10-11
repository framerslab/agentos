/**
 * @fileoverview Tests for the document loader system.
 *
 * Covers: TextLoader, MarkdownLoader, HtmlLoader, LoaderRegistry, and
 * DocxLoader's bound on what a Word file's archive inflates to (with Word
 * files written in the test and read by the real mammoth).
 *
 * Each test creates temporary files in beforeEach / afterEach so all tests
 * are fully isolated and leave no artefacts on disk.
 *
 * @module memory/ingestion/__tests__/loaders.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import mammoth from 'mammoth';

import type { IDocumentLoader } from '../IDocumentLoader.js';
import { TextLoader } from '../TextLoader.js';
import { MarkdownLoader } from '../MarkdownLoader.js';
import { HtmlLoader } from '../HtmlLoader.js';
import { LoaderRegistry } from '../LoaderRegistry.js';
import { DocxLoader, DocumentTooLargeError } from '../DocxLoader.js';
import { zipOf, type ArchiveEntry } from './helpers/documents.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generates a unique temporary directory path for a test. */
function tempDir(): string {
  return path.join(os.tmpdir(), `agentos-loaders-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

// ---------------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------------

/** Temporary directory created per-test. */
let tmpDir: string;

beforeEach(async () => {
  tmpDir = tempDir();
  await fs.mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// TextLoader
// ---------------------------------------------------------------------------

describe('TextLoader', () => {
  it('loads a .txt file and returns its content with wordCount metadata', async () => {
    const filePath = path.join(tmpDir, 'notes.txt');
    const text = 'Hello world. This is a test document with several words.';
    await fs.writeFile(filePath, text, 'utf8');

    const loader = new TextLoader();
    const doc = await loader.load(filePath);

    expect(doc.content).toBe(text);
    expect(doc.format).toBe('txt');
    expect(doc.metadata.source).toBe(filePath);
    expect(typeof doc.metadata.wordCount).toBe('number');
    // "Hello world. This is a test document with several words." = 10 words
    expect(doc.metadata.wordCount).toBe(10);
  });

  it('loads a .json file and returns pretty-printed content', async () => {
    const filePath = path.join(tmpDir, 'data.json');
    const obj = { name: 'AgentOS', version: 1, active: true };
    await fs.writeFile(filePath, JSON.stringify(obj), 'utf8');

    const loader = new TextLoader();
    const doc = await loader.load(filePath);

    // Content should be formatted JSON.
    const parsed = JSON.parse(doc.content);
    expect(parsed.name).toBe('AgentOS');
    expect(parsed.version).toBe(1);
    // Pretty-printed: should contain newlines and spaces.
    expect(doc.content).toContain('\n');
    expect(doc.format).toBe('json');
  });

  it('loads a .csv file and returns raw content unchanged', async () => {
    const filePath = path.join(tmpDir, 'data.csv');
    const csv = 'id,name,value\n1,foo,10\n2,bar,20\n';
    await fs.writeFile(filePath, csv, 'utf8');

    const loader = new TextLoader();
    const doc = await loader.load(filePath);

    expect(doc.content).toBe(csv);
    expect(doc.format).toBe('csv');
  });

  it('loads a .yaml file and returns formatted content', async () => {
    const filePath = path.join(tmpDir, 'config.yaml');
    const yaml = 'name: test\nversion: 2\nenabled: true\n';
    await fs.writeFile(filePath, yaml, 'utf8');

    const loader = new TextLoader();
    const doc = await loader.load(filePath);

    // Content should contain the keys — may be re-serialised.
    expect(doc.content).toContain('name');
    expect(doc.content).toContain('test');
    expect(doc.format).toBe('yaml');
  });

  it('canLoad returns true for supported extensions', () => {
    const loader = new TextLoader();
    expect(loader.canLoad('/path/to/file.txt')).toBe(true);
    expect(loader.canLoad('/path/to/file.json')).toBe(true);
    expect(loader.canLoad('/path/to/file.csv')).toBe(true);
    expect(loader.canLoad('/path/to/file.tsv')).toBe(true);
    expect(loader.canLoad('/path/to/file.yaml')).toBe(true);
    expect(loader.canLoad('/path/to/file.yml')).toBe(true);
  });

  it('canLoad returns false for unsupported extensions', () => {
    const loader = new TextLoader();
    expect(loader.canLoad('/path/to/file.pdf')).toBe(false);
    expect(loader.canLoad('/path/to/file.md')).toBe(false);
    expect(loader.canLoad('/path/to/file.html')).toBe(false);
  });

  it('canLoad returns false for Buffer sources', () => {
    const loader = new TextLoader();
    expect(loader.canLoad(Buffer.from('hello'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// MarkdownLoader
// ---------------------------------------------------------------------------

describe('MarkdownLoader', () => {
  it('parses YAML front-matter and strips it from content', async () => {
    const filePath = path.join(tmpDir, 'article.md');
    const md = [
      '---',
      'title: My Article',
      'author: Jane Doe',
      'language: en',
      '---',
      '',
      '# My Article',
      '',
      'This is the body.',
    ].join('\n');
    await fs.writeFile(filePath, md, 'utf8');

    const loader = new MarkdownLoader();
    const doc = await loader.load(filePath);

    // Front-matter key-value pairs appear in metadata.
    expect(doc.metadata.title).toBe('My Article');
    expect(doc.metadata.author).toBe('Jane Doe');
    expect(doc.metadata.language).toBe('en');

    // Front-matter delimiter must NOT appear in content.
    expect(doc.content).not.toContain('---');
    expect(doc.content).toContain('This is the body.');
    expect(doc.format).toBe('md');
  });

  it('extracts title from first # heading when no frontmatter title', async () => {
    const filePath = path.join(tmpDir, 'guide.md');
    const md = [
      '---',
      'author: Bob',
      '---',
      '',
      '# Getting Started',
      '',
      'Welcome to the guide.',
    ].join('\n');
    await fs.writeFile(filePath, md, 'utf8');

    const loader = new MarkdownLoader();
    const doc = await loader.load(filePath);

    // Title should come from the # heading.
    expect(doc.metadata.title).toBe('Getting Started');
    expect(doc.metadata.author).toBe('Bob');
    expect(doc.content).toContain('Welcome to the guide.');
  });

  it('extracts title from # heading when there is no front-matter at all', async () => {
    const filePath = path.join(tmpDir, 'no-fm.md');
    const md = '# Pure Heading\n\nSome content here.\n';
    await fs.writeFile(filePath, md, 'utf8');

    const loader = new MarkdownLoader();
    const doc = await loader.load(filePath);

    expect(doc.metadata.title).toBe('Pure Heading');
    expect(doc.content).toContain('Some content here.');
  });

  it('frontmatter title takes precedence over # heading', async () => {
    const filePath = path.join(tmpDir, 'both.md');
    const md = [
      '---',
      'title: FM Title',
      '---',
      '# Heading Title',
      '',
      'Body text.',
    ].join('\n');
    await fs.writeFile(filePath, md, 'utf8');

    const loader = new MarkdownLoader();
    const doc = await loader.load(filePath);

    expect(doc.metadata.title).toBe('FM Title');
  });

  it('evaluates no front matter marked as JavaScript, and reads no data from it', async () => {
    // Evaluated, the block would set this global and give the title 'evaluated'.
    const mark = '__agentosLoaderFrontMatterEvaluated';
    const md = [
      '---js',
      `{ title: (globalThis.${mark} = true) && 'evaluated' }`,
      '---',
      '# Notes',
      '',
      'The review moved to Thursday.',
      '',
    ].join('\n');

    try {
      const doc = await new MarkdownLoader().load(Buffer.from(md, 'utf8'));

      expect(Reflect.get(globalThis, mark)).toBeUndefined();
      // The block gives no data, so the title is the first heading's.
      expect(doc.metadata.title).toBe('Notes');
      expect(doc.content).toBe('# Notes\n\nThe review moved to Thursday.\n');
    } finally {
      Reflect.deleteProperty(globalThis, mark);
    }
  });

  it('includes word count in metadata', async () => {
    const filePath = path.join(tmpDir, 'words.md');
    const md = '# Hello\n\nOne two three four five.\n';
    await fs.writeFile(filePath, md, 'utf8');

    const loader = new MarkdownLoader();
    const doc = await loader.load(filePath);

    expect(typeof doc.metadata.wordCount).toBe('number');
    expect((doc.metadata.wordCount as number)).toBeGreaterThan(0);
  });

  it('canLoad returns true for .md and .mdx', () => {
    const loader = new MarkdownLoader();
    expect(loader.canLoad('README.md')).toBe(true);
    expect(loader.canLoad('/path/to/page.mdx')).toBe(true);
  });

  it('canLoad returns false for other extensions', () => {
    const loader = new MarkdownLoader();
    expect(loader.canLoad('file.txt')).toBe(false);
    expect(loader.canLoad('file.html')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// HtmlLoader
// ---------------------------------------------------------------------------

describe('HtmlLoader', () => {
  it('strips HTML tags and returns plain text', async () => {
    const filePath = path.join(tmpDir, 'page.html');
    const html = '<html><body><p>Hello <strong>world</strong>.</p></body></html>';
    await fs.writeFile(filePath, html, 'utf8');

    const loader = new HtmlLoader();
    const doc = await loader.load(filePath);

    expect(doc.content).not.toMatch(/<[^>]+>/);
    expect(doc.content).toContain('Hello');
    expect(doc.content).toContain('world');
    expect(doc.format).toBe('html');
  });

  it('extracts <title> into metadata', async () => {
    const filePath = path.join(tmpDir, 'titled.html');
    const html = [
      '<!DOCTYPE html>',
      '<html>',
      '<head><title>My Page Title</title></head>',
      '<body><p>Content goes here.</p></body>',
      '</html>',
    ].join('\n');
    await fs.writeFile(filePath, html, 'utf8');

    const loader = new HtmlLoader();
    const doc = await loader.load(filePath);

    expect(doc.metadata.title).toBe('My Page Title');
    expect(doc.content).toContain('Content goes here');
    // Tags should be stripped.
    expect(doc.content).not.toContain('<p>');
  });

  it('decodes HTML entities in extracted text', async () => {
    const filePath = path.join(tmpDir, 'entities.html');
    const html = '<p>A &amp; B &lt; C &gt; D &quot;quoted&quot;</p>';
    await fs.writeFile(filePath, html, 'utf8');

    const loader = new HtmlLoader();
    const doc = await loader.load(filePath);

    expect(doc.content).toContain('A & B');
    expect(doc.content).toContain('< C >');
    expect(doc.content).toContain('"quoted"');
  });

  it('removes script and style block content', async () => {
    const filePath = path.join(tmpDir, 'scripts.html');
    const html = [
      '<html><head>',
      '<style>body { color: red; }</style>',
      '<script>var x = 1;</script>',
      '</head><body><p>Visible text only.</p></body></html>',
    ].join('\n');
    await fs.writeFile(filePath, html, 'utf8');

    const loader = new HtmlLoader();
    const doc = await loader.load(filePath);

    expect(doc.content).not.toContain('color: red');
    expect(doc.content).not.toContain('var x');
    expect(doc.content).toContain('Visible text only');
  });

  it('canLoad returns true for .html and .htm', () => {
    const loader = new HtmlLoader();
    expect(loader.canLoad('index.html')).toBe(true);
    expect(loader.canLoad('/var/www/index.htm')).toBe(true);
  });

  it('canLoad returns false for other extensions', () => {
    const loader = new HtmlLoader();
    expect(loader.canLoad('file.md')).toBe(false);
    expect(loader.canLoad('file.txt')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// LoaderRegistry
// ---------------------------------------------------------------------------

describe('LoaderRegistry', () => {
  it('getLoader returns the correct loader for each built-in extension', () => {
    const registry = new LoaderRegistry();

    // Text extensions.
    for (const ext of ['.txt', '.csv', '.tsv', '.json', '.yaml', '.yml']) {
      const loader = registry.getLoader(ext);
      expect(loader, `Expected loader for ${ext}`).toBeDefined();
      expect(loader).toBeInstanceOf(TextLoader);
    }

    // Markdown extensions.
    for (const ext of ['.md', '.mdx']) {
      const loader = registry.getLoader(ext);
      expect(loader, `Expected loader for ${ext}`).toBeDefined();
      expect(loader).toBeInstanceOf(MarkdownLoader);
    }

    // HTML extensions.
    for (const ext of ['.html', '.htm']) {
      const loader = registry.getLoader(ext);
      expect(loader, `Expected loader for ${ext}`).toBeDefined();
      expect(loader).toBeInstanceOf(HtmlLoader);
    }
  });

  it('getLoader accepts full file paths', () => {
    const registry = new LoaderRegistry();
    const loader = registry.getLoader('/path/to/README.md');
    expect(loader).toBeInstanceOf(MarkdownLoader);
  });

  it('getLoader accepts extensions without a leading dot', () => {
    const registry = new LoaderRegistry();
    const loader = registry.getLoader('json');
    expect(loader).toBeInstanceOf(TextLoader);
  });

  it('getLoader returns undefined for truly unregistered extensions', () => {
    const registry = new LoaderRegistry();
    // .pdf and .docx are now registered by default (PdfLoader / DocxLoader).
    expect(registry.getLoader('.pdf')).toBeDefined();
    expect(registry.getLoader('.docx')).toBeDefined();
    // Exotic formats remain unregistered.
    expect(registry.getLoader('.xyz')).toBeUndefined();
    expect(registry.getLoader('.pptx')).toBeUndefined();
  });

  it('getSupportedExtensions returns all registered extensions sorted', () => {
    const registry = new LoaderRegistry();
    const exts = registry.getSupportedExtensions();
    // Should be sorted.
    expect(exts).toEqual([...exts].sort());
    // Should include all built-in extensions.
    for (const ext of ['.txt', '.csv', '.md', '.html', '.json']) {
      expect(exts).toContain(ext);
    }
  });

  it('register() adds a new loader and overrides existing ones for its extension', () => {
    const registry = new LoaderRegistry();

    // Build a minimal fake loader for a new extension.
    const fakePdfLoader: IDocumentLoader = {
      supportedExtensions: ['.pdf'],
      canLoad: (s) => typeof s === 'string' && s.endsWith('.pdf'),
      load: async () => ({
        content: 'fake pdf content',
        metadata: {},
        format: 'pdf',
      }),
    };

    registry.register(fakePdfLoader);

    expect(registry.getLoader('.pdf')).toBe(fakePdfLoader);
  });

  it('loadFile auto-detects format and loads a .txt file', async () => {
    const filePath = path.join(tmpDir, 'hello.txt');
    await fs.writeFile(filePath, 'Hello from registry.', 'utf8');

    const registry = new LoaderRegistry();
    const doc = await registry.loadFile(filePath);

    expect(doc.content).toBe('Hello from registry.');
    expect(doc.format).toBe('txt');
  });

  it('loadFile auto-detects format and loads a .md file', async () => {
    const filePath = path.join(tmpDir, 'readme.md');
    const md = '---\ntitle: Test Doc\n---\n\nBody text here.\n';
    await fs.writeFile(filePath, md, 'utf8');

    const registry = new LoaderRegistry();
    const doc = await registry.loadFile(filePath);

    expect(doc.metadata.title).toBe('Test Doc');
    expect(doc.content).toContain('Body text here.');
    expect(doc.format).toBe('md');
  });

  it('loadFile auto-detects format and loads an .html file', async () => {
    const filePath = path.join(tmpDir, 'page.html');
    const html = '<html><head><title>HTML Test</title></head><body><p>Text.</p></body></html>';
    await fs.writeFile(filePath, html, 'utf8');

    const registry = new LoaderRegistry();
    const doc = await registry.loadFile(filePath);

    expect(doc.metadata.title).toBe('HTML Test');
    expect(doc.content).toContain('Text.');
    expect(doc.format).toBe('html');
  });

  it('loadFile throws an informative error for unsupported extensions', async () => {
    // .xyz is not a built-in extension, so LoaderRegistry should throw.
    const filePath = path.join(tmpDir, 'document.xyz');
    const registry = new LoaderRegistry();

    await expect(registry.loadFile(filePath)).rejects.toThrow(/no loader registered for extension/i);
  });
});

// ---------------------------------------------------------------------------
// DocxLoader bound
// ---------------------------------------------------------------------------

/** The central directory's offset, read from an end record with no comment after it. */
function directoryOffsetOf(zip: Buffer): number {
  return zip.readUInt32LE(zip.length - 6);
}

/** The paragraph the test's Word file holds. */
const PARAGRAPH = 'The quarterly review moved to Thursday.';

/** The archive's content types part. */
const CONTENT_TYPES: ArchiveEntry = {
  name: '[Content_Types].xml',
  data: Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ' +
      'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>',
    'utf8',
  ),
};

/** The main document part: one paragraph. */
const DOCUMENT: ArchiveEntry = {
  name: 'word/document.xml',
  data: Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:body><w:p><w:r><w:t>${PARAGRAPH}</w:t></w:r></w:p></w:body>` +
      '</w:document>',
    'utf8',
  ),
};

/** The bound the refusals below are read against: 1 MiB. */
const ONE_MIB = 1_048_576;

/** 2 MiB of zeros, a few kilobytes once deflated. */
const TWO_MIB_OF_ZEROS = Buffer.alloc(2 * ONE_MIB);

describe('DocxLoader bound', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads a Word file within the default bound', async () => {
    const extractRawText = vi.spyOn(mammoth, 'extractRawText');
    const file = zipOf([CONTENT_TYPES, DOCUMENT]);

    const doc = await new DocxLoader().load(file);

    expect(doc.content.trim()).toBe(PARAGRAPH);
    expect(doc.format).toBe('docx');
    // The spy sees the loader's own call, so "not called" in the refusals
    // below means mammoth never ran.
    expect(extractRawText).toHaveBeenCalledTimes(1);
    expect(extractRawText).toHaveBeenCalledWith({ buffer: file });
  });

  it('finds the end record in front of an archive comment', async () => {
    const zip = zipOf([CONTENT_TYPES, DOCUMENT]);
    const comment = Buffer.from('a comment after the end record', 'utf8');
    zip.writeUInt16LE(comment.length, zip.length - 2); // the comment's length

    const doc = await new DocxLoader().load(Buffer.concat([zip, comment]));

    expect(doc.content.trim()).toBe(PARAGRAPH);
  });

  it('refuses a file whose entries inflate past the bound, and mammoth never reads it', async () => {
    const extractRawText = vi.spyOn(mammoth, 'extractRawText');
    const file = zipOf([CONTENT_TYPES, DOCUMENT, { name: 'word/media/zeros.bin', data: TWO_MIB_OF_ZEROS }]);

    const loading = new DocxLoader({ maxInflatedBytes: ONE_MIB }).load(file);

    await expect(loading).rejects.toBeInstanceOf(DocumentTooLargeError);
    await expect(loading).rejects.toMatchObject({ code: 'DOCUMENT_TOO_LARGE', limit: ONE_MIB });
    expect(extractRawText).not.toHaveBeenCalled();
  });

  it('inflates an entry instead of trusting the size its headers state', async () => {
    const extractRawText = vi.spyOn(mammoth, 'extractRawText');
    const file = zipOf([
      CONTENT_TYPES,
      { name: 'word/document.xml', data: TWO_MIB_OF_ZEROS, statedSize: 10 },
    ]);

    const loading = new DocxLoader({ maxInflatedBytes: ONE_MIB }).load(file);

    await expect(loading).rejects.toBeInstanceOf(DocumentTooLargeError);
    await expect(loading).rejects.toMatchObject({ limit: ONE_MIB });
    expect(extractRawText).not.toHaveBeenCalled();
  });

  it('counts a stored entry by its size', async () => {
    const extractRawText = vi.spyOn(mammoth, 'extractRawText');
    const file = zipOf([
      CONTENT_TYPES,
      DOCUMENT,
      { name: 'word/media/zeros.bin', data: TWO_MIB_OF_ZEROS, method: 0 },
    ]);

    await expect(new DocxLoader({ maxInflatedBytes: ONE_MIB }).load(file)).rejects.toBeInstanceOf(
      DocumentTooLargeError,
    );
    expect(extractRawText).not.toHaveBeenCalled();
  });

  it('refuses a buffer with no end record as no Word archive, before mammoth runs', async () => {
    const extractRawText = vi.spyOn(mammoth, 'extractRawText');

    await expect(new DocxLoader().load(Buffer.from('PK\x03\x04 and nothing else'))).rejects.toThrow(
      'DocxLoader: not a Word archive',
    );
    expect(extractRawText).not.toHaveBeenCalled();
  });

  it.each<[string, (zip: Buffer) => Buffer]>([
    [
      'a ZIP64 marker in the end record',
      (zip) => {
        zip.writeUInt16LE(0xffff, zip.length - 12); // entries in all
        return zip;
      },
    ],
    [
      'bytes between the central directory and the end record',
      (zip) => Buffer.concat([zip.subarray(0, zip.length - 22), Buffer.alloc(4), zip.subarray(zip.length - 22)]),
    ],
    [
      'a central directory whose stated size stops one byte short of the end record',
      (zip) => {
        // Every header is in place up to the end record, so the stated size
        // alone tells that JSZip would move every offset by one byte.
        zip.writeUInt32LE(zip.readUInt32LE(zip.length - 10) - 1, zip.length - 10);
        return zip;
      },
    ],
    [
      'another archive in front of it',
      // The last end record is the one read, as JSZip reads it. Its offsets
      // count from its own archive's start, one archive further on, so a check
      // of the first archive would say nothing about the one mammoth reads.
      (zip) => Buffer.concat([zip, zipOf([CONTENT_TYPES, DOCUMENT])]),
    ],
    [
      'a local header past the end of the file',
      (zip) => {
        zip.writeUInt32LE(zip.length, directoryOffsetOf(zip) + 42);
        return zip;
      },
    ],
    [
      'a compression method other than stored or deflated',
      (zip) => {
        zip.writeUInt16LE(12, directoryOffsetOf(zip) + 10); // bzip2
        return zip;
      },
    ],
    [
      'entries that share their data',
      (zip) => {
        // The central directory three times over: each entry listed three times, at the same local header.
        const offset = directoryOffsetOf(zip);
        const directory = zip.subarray(offset, zip.length - 22);
        const end = Buffer.from(zip.subarray(zip.length - 22));
        end.writeUInt16LE(6, 8); // entries on this disk
        end.writeUInt16LE(6, 10); // entries in all
        end.writeUInt32LE(directory.length * 3, 12); // the central directory's size
        return Buffer.concat([zip.subarray(0, offset), directory, directory, directory, end]);
      },
    ],
  ])('refuses an archive with %s as no Word archive, before mammoth runs', async (_case, alter) => {
    const extractRawText = vi.spyOn(mammoth, 'extractRawText');
    const file = alter(zipOf([CONTENT_TYPES, DOCUMENT]));

    await expect(new DocxLoader().load(file)).rejects.toThrow('DocxLoader: not a Word archive');
    expect(extractRawText).not.toHaveBeenCalled();
  });

  it('refuses a bound that is not a positive, finite number', () => {
    for (const maxInflatedBytes of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new DocxLoader({ maxInflatedBytes })).toThrow(RangeError);
    }
  });
});
