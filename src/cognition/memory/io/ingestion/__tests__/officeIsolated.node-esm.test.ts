/**
 * Office documents read in a worker thread from the built package, under plain Node: the office kinds of
 * `loadIsolated`, and a scan `OfficeLoader` reads by OCR in a worker thread of its own.
 *
 * A worker thread cannot load the TypeScript source the other suites import, so this suite runs the built modules
 * in a child Node process, as a consumer of the package does, and reads through them documents written into a
 * temporary folder at run time. Two of the reads show what the worker thread is for. tesseract.js reads its
 * language data from the working folder before it fetches any, and in one folder that file is not language data:
 * its engine fails to start, which tesseract.js reports by throwing outside the promise of the read, and that
 * ends the read's worker while the child process reads on. And a read its caller cancels ends its worker. The
 * child records every worker it starts through the process's `'worker'` event, and each read reports how many of
 * them were still running when it settled.
 *
 * The scan that is read fetches tesseract's English data from its own address the first time, so that read needs
 * the network. CI builds before it tests, and there the suite always runs: a missing build fails it instead of
 * skipping it. On a machine without a build it is skipped (run `pnpm run build` first to check the current source).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { pptxOf, scannedPdf, xlsxOf, xlsxOfCells } from './fixtures/officeFiles.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const builtFolder = path.resolve(here, '../../../../../../dist/cognition/memory/io/ingestion');
const builtModule = path.join(builtFolder, 'loadIsolated.js');

/** The loaders and their workers write to stdout too, so the script marks its own result line. */
const RESULT_MARK = 'OFFICE_ISOLATED_RESULT ';

/** The sentence the deck and the sheet hold. */
const SENTENCE = 'The rooms are held until the twentieth.';

/** 1 MiB. */
const ONE_MIB = 1_048_576;

/** The office loader's bound on what an archive inflates to when it is left out: 64 MiB. */
const DEFAULT_MAX_INFLATED_BYTES = 67_108_864;

/** The files the child reads, by name. */
function documents(): Record<string, Buffer> {
  return {
    'deck.pptx': pptxOf(SENTENCE),
    'sheet.xlsx': xlsxOf(SENTENCE),
    'forty-cells.xlsx': xlsxOfCells(40),
    'scan.pdf': scannedPdf(),
  };
}

/**
 * The child's script: it imports the built modules, records every worker it
 * starts, reads each case in turn and prints one marked result line.
 *
 * @param folder - The folder that holds the documents, with the working folders `ocr` and `corrupt` inside.
 */
function childScript(folder: string): string {
  const built = (file: string): string => JSON.stringify(pathToFileURL(path.join(builtFolder, file)).href);
  return `
    import { readFileSync } from 'node:fs';
    import { join } from 'node:path';

    const { loadIsolated } = await import(${built('loadIsolated.js')});
    const { OfficeLoader, ScannedDocumentError, DocumentTooLargeError } = await import(${built('OfficeLoader.js')});

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

    const failure = (error, reason) => ({
      ok: false,
      name: error?.name,
      message: error?.message,
      code: error?.code,
      limit: error?.limit,
      cause: error?.cause?.message,
      isError: error instanceof Error,
      rangeError: error instanceof RangeError,
      typeError: error instanceof TypeError,
      tooLarge: error instanceof DocumentTooLargeError,
      scanned: error instanceof ScannedDocumentError,
      isReason: reason !== undefined && error === reason,
    });

    async function attempt(read, reason) {
      const before = made.length;
      let result;
      try {
        result = { ok: true, document: await read() };
      } catch (error) {
        result = failure(error, reason);
      }
      // Counted as the read settles: a worker it started and left running counts here.
      result.leftRunning = running();
      // The 'worker' event comes on the tick after a worker starts.
      await new Promise((resolve) => setTimeout(resolve, 20));
      result.started = made.length - before;
      return result;
    }

    const inThread = new OfficeLoader();
    const cases = {};
    // Each read in this thread takes the buffer the worker's read was given.
    cases.equal = {
      pptx: {
        isolated: await attempt(() => loadIsolated('pptx', file('deck.pptx'))),
        inThread: await inThread.load(file('deck.pptx'), { format: 'pptx' }),
      },
      xlsx: {
        isolated: await attempt(() => loadIsolated('xlsx', file('sheet.xlsx'))),
        inThread: await inThread.load(file('sheet.xlsx'), { format: 'xlsx' }),
      },
    };
    cases.cellBound = await attempt(() => loadIsolated('xlsx', file('forty-cells.xlsx'), { maxTableCells: 39 }));
    cases.argumentsChecked = {
      scanWithoutPages: await attempt(() => loadIsolated('scan', file('scan.pdf'))),
      pagesForASheet: await attempt(() => loadIsolated('xlsx', file('sheet.xlsx'), { ocrPages: 1 })),
      cellsForWord: await attempt(() => loadIsolated('docx', file('sheet.xlsx'), { maxTableCells: 10 })),
      nanCells: await attempt(() => loadIsolated('xlsx', file('sheet.xlsx'), { maxTableCells: Number.NaN })),
    };
    const cancelled = AbortSignal.abort();
    cases.cancelledBefore = await attempt(
      () => loadIsolated('xlsx', file('sheet.xlsx'), { signal: cancelled }),
      cancelled.reason,
    );

    // Scans, each read by OCR in a worker thread the loader starts. tesseract.js reads and keeps its language
    // data in the working folder.
    process.chdir(join(folder, 'ocr'));
    cases.scan = await attempt(() => new OfficeLoader({ ocrPages: 1 }).load(file('scan.pdf'), { format: 'pdf' }));

    // Cancelled once the read's worker has started.
    const controller = new AbortController();
    const withdrawn = new Error('the upload was withdrawn');
    process.once('worker', () => controller.abort(withdrawn));
    cases.scanCancelled = await attempt(
      () => new OfficeLoader({ ocrPages: 1 }).load(file('scan.pdf'), { format: 'pdf', signal: controller.signal }),
      withdrawn,
    );

    // The language data here is not language data: tesseract's engine fails to start.
    process.chdir(join(folder, 'corrupt'));
    cases.engineFails = await attempt(() => new OfficeLoader({ ocrPages: 1 }).load(file('scan.pdf'), { format: 'pdf' }));
    process.chdir(folder);

    const line = '\\n${RESULT_MARK}' + JSON.stringify({ cases, made: made.length, leftRunning: running(), alive: true }) + '\\n';
    // The result is written before the process ends, whatever a loader left behind.
    process.stdout.write(line, () => process.exit(0));
  `;
}

/** What a loader answers, as the child's JSON carries it. */
interface Loaded {
  content: string;
  metadata: Record<string, unknown>;
  format: string;
}

/** One read in the child: its answer or its refusal, and the workers around it. */
interface Attempt {
  ok: boolean;
  document?: Loaded;
  name?: string;
  message?: string;
  code?: string;
  limit?: number;
  cause?: string;
  isError?: boolean;
  rangeError?: boolean;
  typeError?: boolean;
  tooLarge?: boolean;
  scanned?: boolean;
  /** Whether the read rejected with the reason its caller's signal gave. */
  isReason?: boolean;
  /** Workers the child saw start and not yet end when the read settled. */
  leftRunning: number;
  /** Workers the read started. */
  started: number;
}

/** The child's result line. */
interface ChildResult {
  cases: {
    equal: Record<'pptx' | 'xlsx', { isolated: Attempt; inThread: Loaded }>;
    cellBound: Attempt;
    argumentsChecked: { scanWithoutPages: Attempt; pagesForASheet: Attempt; cellsForWord: Attempt; nanCells: Attempt };
    cancelledBefore: Attempt;
    scan: Attempt;
    scanCancelled: Attempt;
    engineFails: Attempt;
  };
  /** Every worker the child saw start. */
  made: number;
  leftRunning: number;
  /** Printed after the last case: the process that read lived through every read. */
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
    timeout: 150_000,
    maxBuffer: 16 * ONE_MIB,
    // --max-old-space-size in NODE_OPTIONS would override the worker's heap cap.
    env: { ...process.env, NODE_OPTIONS: undefined },
  });
  const line = stdout.split('\n').find((l) => l.startsWith(RESULT_MARK));
  if (!line) throw new Error(`no result line in the child's output:\n${stdout}`);
  return JSON.parse(line.slice(RESULT_MARK.length)) as ChildResult;
}

const inCI = Boolean(process.env.CI);

describe.skipIf(!inCI && !existsSync(builtModule))('office documents in a worker thread, built for plain Node ESM', () => {
  let folder: string | undefined;
  let result: ChildResult;

  beforeAll(async () => {
    const created = await mkdtemp(path.join(os.tmpdir(), 'agentos-office-isolated-'));
    folder = created;
    for (const [name, bytes] of Object.entries(documents())) {
      await writeFile(path.join(created, name), bytes);
    }
    await mkdir(path.join(created, 'ocr'));
    await mkdir(path.join(created, 'corrupt'));
    // Its first four bytes read as more entries than a tessdata file holds, in either byte order.
    await writeFile(path.join(created, 'corrupt', 'eng.traineddata'), Buffer.from('not language data\n'.repeat(64)));
    result = runChild(created);
  }, 180_000);

  afterAll(async () => {
    if (folder !== undefined) await rm(folder, { recursive: true, force: true });
  });

  it("answers what the office loader answers in the caller's thread", () => {
    for (const kind of ['pptx', 'xlsx'] as const) {
      const { isolated, inThread } = result.cases.equal[kind];
      expect(isolated).toMatchObject({ ok: true, leftRunning: 0, started: 1 });
      expect(isolated.document).toEqual(inThread);
      expect(inThread.content.replace(/\s+/g, ' ')).toContain(SENTENCE);
    }
  });

  it("passes the office loader's bound through as DocumentTooLargeError, its message and cause naming the bound", () => {
    expect(result.cases.cellBound).toMatchObject({
      ok: false,
      tooLarge: true,
      name: 'DocumentTooLargeError',
      code: 'DOCUMENT_TOO_LARGE',
      limit: DEFAULT_MAX_INFLATED_BYTES,
      message: 'the document reached the bound officeparser reports as TABLE_CELL_LIMIT_EXCEEDED',
      cause: 'officeparser: TABLE_CELL_LIMIT_EXCEEDED',
      started: 1,
      leftRunning: 0,
    });
  });

  it("refuses a scan without its pages, and an office loader's option given to a kind that does not take it, before any worker starts", () => {
    const { scanWithoutPages, pagesForASheet, cellsForWord, nanCells } = result.cases.argumentsChecked;
    expect(scanWithoutPages).toMatchObject({ ok: false, rangeError: true, started: 0 });
    expect(pagesForASheet).toMatchObject({ ok: false, typeError: true, started: 0 });
    expect(cellsForWord).toMatchObject({ ok: false, typeError: true, started: 0 });
    expect(nanCells).toMatchObject({ ok: false, rangeError: true, started: 0 });
  });

  it('starts no worker for a read its caller has already cancelled, and rejects with the reason', () => {
    expect(result.cases.cancelledBefore).toMatchObject({ ok: false, isReason: true, started: 0 });
  });

  it('reads a scan by OCR in a worker thread of its own, which has ended when the read settles', () => {
    expect(result.cases.scan).toMatchObject({ ok: true, started: 1, leftRunning: 0 });
    expect(result.cases.scan.document?.content).toMatch(/Tesseract/);
    expect(result.cases.scan.document).toMatchObject({ format: 'pdf', metadata: { pageCount: 1 } });
  });

  it("ends a scan's worker when its caller cancels the read, and rejects with the signal's reason", () => {
    expect(result.cases.scanCancelled).toMatchObject({ ok: false, isReason: true, started: 1, leftRunning: 0 });
  });

  it('ends the worker, not the process, when tesseract.js throws outside the promise of the read', () => {
    // tesseract.js throws the failure its engine reported from its worker's message listener: in the caller's
    // thread, an uncaught exception that ends a Node process handling none.
    expect(result.cases.engineFails).toMatchObject({
      ok: false,
      isError: true,
      name: 'Error',
      message: 'initialization failed',
      scanned: false,
      tooLarge: false,
      started: 1,
      leftRunning: 0,
    });
    expect(result.alive).toBe(true);
  });

  it('leaves no worker running once the reads settle', () => {
    expect(result.leftRunning).toBe(0);
    // One worker for each read that started one: the two office kinds, the bound, and the three scans.
    expect(result.made).toBe(6);
  });
});
