/**
 * loadIsolated from the built package, under plain Node.
 *
 * A worker thread cannot load the TypeScript source the other suites import,
 * so `loadIsolated` starts the compiled `isolatedLoadWorker.js` beside its own
 * module in `dist`. This suite runs the built module in a child Node process,
 * as a consumer of the package does, and reads through it documents written
 * into a temporary folder at run time. Two of them exist to show that the
 * worker's caps end a read that would exhaust its process while the process
 * that called `loadIsolated` reads on: a Word file whose `document.xml` holds
 * two million empty paragraphs, and a PDF whose content stream inflates to
 * 256 MiB of spaces. The child records every worker it starts through the
 * process's `'worker'` event, and each read reports how many of them were
 * still running when it settled.
 *
 * CI builds before it tests, and there the suite always runs: a missing build
 * fails it instead of skipping it. On a machine without a build it is skipped
 * (run `pnpm run build` first to check the current source).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { flatePdfOf, pdfOf, zipOf, type ArchiveEntry } from './helpers/documents.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const builtModule = path.resolve(here, '../../../../../../dist/cognition/memory/io/ingestion/loadIsolated.js');
const builtFolder = path.dirname(builtModule);

/** The loaders and their workers write to stdout too, so the script marks its own result line. */
const RESULT_MARK = 'LOAD_ISOLATED_RESULT ';

/** The paragraph the small Word file and the small PDF hold. */
const PARAGRAPH = 'The quarterly review moved to Thursday.';

/** 1 MiB. */
const ONE_MIB = 1_048_576;

/** A Word file's content types part. */
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

/**
 * A Word file whose main document part holds `body`.
 *
 * @param body - The XML inside `<w:body>`.
 * @param more - Further entries of the archive.
 */
function wordFile(body: string, ...more: ArchiveEntry[]): Buffer {
  const document: ArchiveEntry = {
    name: 'word/document.xml',
    data: Buffer.from(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        `<w:body>${body}</w:body>` +
        '</w:document>',
      'utf8',
    ),
  };
  return zipOf([CONTENT_TYPES, document, ...more]);
}

/** A paragraph of one run of text. */
function paragraph(text: string): string {
  return `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
}

/** The files the child reads, by name. */
async function documents(): Promise<Record<string, Buffer>> {
  return {
    'small.docx': wordFile(paragraph(PARAGRAPH)),
    // 2,000,000 empty paragraphs: 12 MB of XML, inside DocxLoader's default bound of 128 MiB and about 12 KB deflated.
    'many-paragraphs.docx': wordFile('<w:p/>'.repeat(2_000_000)),
    'long.docx': wordFile(
      Array.from({ length: 20_000 }, (_, index) => paragraph(`Paragraph ${index + 1} of a long document.`)).join(''),
    ),
    'small-with-zeros.docx': wordFile(paragraph(PARAGRAPH), {
      name: 'word/media/zeros.bin',
      data: Buffer.alloc(2 * ONE_MIB),
    }),
    'not-a-word.docx': Buffer.from('PK\x03\x04 and nothing else'),
    'small.pdf': pdfOf(PARAGRAPH),
    // A content stream of 256 MiB of spaces, about 250 KB in the file.
    'inflating.pdf': await flatePdfOf(0x20, 256 * ONE_MIB),
    'notes.md': Buffer.from('---\ntitle: Quarterly review\n---\n\n# Notes\n\nThe review moved to Thursday.\n', 'utf8'),
  };
}

/**
 * The child's script: it imports the built modules, records every worker it
 * starts, reads each case in turn and prints one marked result line.
 *
 * @param folder - The folder that holds the documents.
 */
function childScript(folder: string): string {
  const built = (file: string): string => JSON.stringify(pathToFileURL(path.join(builtFolder, file)).href);
  return `
    import { readFileSync } from 'node:fs';
    import { join } from 'node:path';

    const { loadIsolated, DocumentTooComplexError, DocumentReadTimeoutError } = await import(${built('loadIsolated.js')});
    const { DocxLoader, DocumentTooLargeError } = await import(${built('DocxLoader.js')});
    const { PdfLoader } = await import(${built('PdfLoader.js')});
    const { MarkdownLoader } = await import(${built('MarkdownLoader.js')});

    const folder = ${JSON.stringify(folder)};
    const file = (name) => readFileSync(join(folder, name));

    // Every worker this process starts, and the ones whose 'exit' has been emitted.
    const made = [];
    const ended = new Set();
    process.on('worker', (worker) => {
      made.push(worker);
      worker.once('exit', () => ended.add(worker));
    });
    const running = () => made.filter((worker) => !ended.has(worker)).length;

    const failure = (error) => ({
      ok: false,
      name: error?.name,
      message: error?.message,
      code: error?.code,
      resource: error?.resource,
      limitMb: error?.limitMb,
      timeoutMs: error?.timeoutMs,
      limit: error?.limit,
      isError: error instanceof Error,
      rangeError: error instanceof RangeError,
      typeError: error instanceof TypeError,
      tooComplex: error instanceof DocumentTooComplexError,
      readTimeout: error instanceof DocumentReadTimeoutError,
      tooLarge: error instanceof DocumentTooLargeError,
    });

    async function attempt(kind, bytes, options) {
      const before = made.length;
      let result;
      try {
        result = { ok: true, document: await loadIsolated(kind, bytes, options) };
      } catch (error) {
        result = failure(error);
      }
      // Counted as the read settles: a worker it started and left running counts here.
      result.leftRunning = running();
      // The 'worker' event comes on the tick after a worker starts.
      await new Promise((resolve) => setTimeout(resolve, 20));
      result.started = made.length - before;
      return result;
    }

    const small = { docx: file('small.docx'), pdf: file('small.pdf'), markdown: file('notes.md') };
    const cases = {};
    // Each read in this thread takes the buffer the worker's read was given.
    cases.equal = {
      docx: { isolated: await attempt('docx', small.docx), inThread: await new DocxLoader().load(small.docx) },
      pdf: { isolated: await attempt('pdf', small.pdf), inThread: await new PdfLoader().load(small.pdf) },
      markdown: {
        isolated: await attempt('markdown', small.markdown),
        inThread: await new MarkdownLoader().load(small.markdown),
      },
    };
    cases.heap = {
      manyParagraphs: await attempt('docx', file('many-paragraphs.docx'), { maxHeapMb: 16 }),
      small: await attempt('docx', small.docx, { maxHeapMb: 16 }),
    };
    cases.deadline = await attempt('docx', file('long.docx'), { timeoutMs: 5 });
    cases.inflated = await attempt('docx', file('small-with-zeros.docx'), { maxInflatedBytes: ${ONE_MIB} });
    cases.external = {
      inflating: await attempt('pdf', file('inflating.pdf'), { maxExternalMb: 32 }),
      small: await attempt('pdf', small.pdf, { maxExternalMb: 32 }),
    };
    cases.loaderError = await attempt('docx', file('not-a-word.docx'));
    cases.argumentsChecked = {
      zeroHeap: await attempt('docx', small.docx, { maxHeapMb: 0 }),
      nanDeadline: await attempt('docx', small.docx, { timeoutMs: Number.NaN }),
      html: await attempt('html', small.docx),
    };

    process.stdout.write('\\n${RESULT_MARK}' + JSON.stringify({ cases, made: made.length, leftRunning: running(), alive: true }) + '\\n');
  `;
}

/** What a loader answers, as the child's JSON carries it. */
interface Loaded {
  content: string;
  metadata: Record<string, unknown>;
  format: string;
}

/** One read through `loadIsolated` in the child: its answer or its refusal, and the workers around it. */
interface Attempt {
  ok: boolean;
  document?: Loaded;
  name?: string;
  message?: string;
  code?: string;
  resource?: string;
  limitMb?: number;
  timeoutMs?: number;
  limit?: number;
  isError?: boolean;
  rangeError?: boolean;
  typeError?: boolean;
  tooComplex?: boolean;
  readTimeout?: boolean;
  tooLarge?: boolean;
  /** Workers the child saw start and not yet end when the read settled. */
  leftRunning: number;
  /** Workers the read started. */
  started: number;
}

/** The child's result line. */
interface ChildResult {
  cases: {
    equal: Record<'docx' | 'pdf' | 'markdown', { isolated: Attempt; inThread: Loaded }>;
    heap: { manyParagraphs: Attempt; small: Attempt };
    deadline: Attempt;
    inflated: Attempt;
    external: { inflating: Attempt; small: Attempt };
    loaderError: Attempt;
    argumentsChecked: { zeroHeap: Attempt; nanDeadline: Attempt; html: Attempt };
  };
  /** Every worker the child saw start. */
  made: number;
  leftRunning: number;
  /** Printed after the last case: the process that called `loadIsolated` lived through every read. */
  alive: boolean;
}

/**
 * Runs the cases in a child Node process and reads its result line.
 *
 * @param folder - The folder that holds the documents.
 */
function runChild(folder: string): ChildResult {
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', childScript(folder)], {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 16 * ONE_MIB,
    // --max-old-space-size in NODE_OPTIONS would override the worker's heap cap.
    env: { ...process.env, NODE_OPTIONS: undefined },
  });
  const line = stdout.split('\n').find((l) => l.startsWith(RESULT_MARK));
  if (!line) throw new Error(`no result line in the child's output:\n${stdout}`);
  return JSON.parse(line.slice(RESULT_MARK.length)) as ChildResult;
}

const inCI = Boolean(process.env.CI);

describe.skipIf(!inCI && !existsSync(builtModule))('loadIsolated built for plain Node ESM', () => {
  let folder: string | undefined;
  let result: ChildResult;

  beforeAll(async () => {
    const created = await mkdtemp(path.join(os.tmpdir(), 'agentos-load-isolated-'));
    folder = created;
    for (const [name, bytes] of Object.entries(await documents())) {
      await writeFile(path.join(created, name), bytes);
    }
    result = runChild(created);
  }, 180_000);

  afterAll(async () => {
    if (folder !== undefined) await rm(folder, { recursive: true, force: true });
  });

  it("answers what each loader answers in the caller's thread, and leaves the caller's buffer usable", () => {
    for (const kind of ['docx', 'pdf', 'markdown'] as const) {
      const { isolated, inThread } = result.cases.equal[kind];
      expect(isolated).toMatchObject({ ok: true, leftRunning: 0, started: 1 });
      expect(isolated.document).toEqual(inThread);
    }
    // The in-thread reads ran after the worker's on the same buffers, so a buffer moved to the worker would fail them.
    expect(result.cases.equal.docx.inThread.content.trim()).toBe(PARAGRAPH);
    expect(result.cases.equal.pdf.inThread.content).toContain('quarterly review');
    expect(result.cases.equal.markdown.inThread.metadata.title).toBe('Quarterly review');
  });

  it('ends a read that reaches the heap cap, and the process that called it reads on', () => {
    expect(result.cases.heap.manyParagraphs).toMatchObject({
      ok: false,
      tooComplex: true,
      name: 'DocumentTooComplexError',
      code: 'DOCUMENT_TOO_COMPLEX',
      resource: 'heap',
      limitMb: 16,
      leftRunning: 0,
    });
    // The same cap holds a worker and a small file, so the refusal above is the file's.
    expect(result.cases.heap.small).toMatchObject({ ok: true, leftRunning: 0 });
    expect(result.cases.heap.small.document?.content.trim()).toBe(PARAGRAPH);
    expect(result.alive).toBe(true);
  });

  it('ends a read that passes its deadline', () => {
    expect(result.cases.deadline).toMatchObject({
      ok: false,
      readTimeout: true,
      name: 'DocumentReadTimeoutError',
      code: 'DOCUMENT_READ_TIMEOUT',
      timeoutMs: 5,
      leftRunning: 0,
    });
  });

  it("passes the Word loader's bound through as the class DocxLoader exports", () => {
    expect(result.cases.inflated).toMatchObject({
      ok: false,
      tooLarge: true,
      name: 'DocumentTooLargeError',
      code: 'DOCUMENT_TOO_LARGE',
      limit: ONE_MIB,
      leftRunning: 0,
    });
  });

  it('ends a read whose memory outside the heap passes maxExternalMb', () => {
    expect(result.cases.external.inflating).toMatchObject({
      ok: false,
      tooComplex: true,
      code: 'DOCUMENT_TOO_COMPLEX',
      resource: 'external',
      limitMb: 32,
      leftRunning: 0,
    });
    expect(result.cases.external.small).toMatchObject({ ok: true, leftRunning: 0 });
    expect(result.cases.external.small.document).toEqual(result.cases.equal.pdf.inThread);
  });

  it("carries the loader's own error across by its name and message", () => {
    expect(result.cases.loaderError).toMatchObject({
      ok: false,
      isError: true,
      name: 'Error',
      message: 'DocxLoader: not a Word archive',
      tooComplex: false,
      readTimeout: false,
      tooLarge: false,
      leftRunning: 0,
    });
  });

  it('refuses a bound or a kind before any worker starts', () => {
    expect(result.cases.argumentsChecked.zeroHeap).toMatchObject({ ok: false, rangeError: true, started: 0 });
    expect(result.cases.argumentsChecked.nanDeadline).toMatchObject({ ok: false, rangeError: true, started: 0 });
    expect(result.cases.argumentsChecked.html).toMatchObject({ ok: false, typeError: true, started: 0 });
  });

  it('leaves no worker running once a read settles', () => {
    const { equal, heap, deadline, inflated, external, loaderError } = result.cases;
    const reads = [
      equal.docx.isolated,
      equal.pdf.isolated,
      equal.markdown.isolated,
      heap.manyParagraphs,
      heap.small,
      deadline,
      inflated,
      external.inflating,
      external.small,
      loaderError,
    ];
    for (const read of reads) expect(read).toMatchObject({ started: 1, leftRunning: 0 });
    expect(result.made).toBe(reads.length);
    expect(result.leftRunning).toBe(0);
  });
});
