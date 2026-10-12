import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Memory } from '../facade/Memory.js';
import { MAX_OPEN_TRACE_FILES, MarkdownExporter } from '../MarkdownExporter.js';
import { Brain } from '../../retrieval/store/Brain.js';

// The export folder is <root>/workspace/export. A Markdown file sits one level above it, another two levels above.
let root: string;
let workspace: string;
let exportDir: string;
let dbDir: string;
const opened: Memory[] = [];

const ONE_LEVEL_UP = 'Text one level above the export folder.\n';
const TWO_LEVELS_UP = 'Text two levels above the export folder.\n';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'export-trace-paths-'));
  workspace = path.join(root, 'workspace');
  exportDir = path.join(workspace, 'export');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'outside.md'), ONE_LEVEL_UP);
  fs.writeFileSync(path.join(root, 'outside.md'), TWO_LEVELS_UP);
  // The store lives apart from the folders the test watches.
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-trace-paths-db-'));
});

afterEach(async () => {
  for (const memory of opened.splice(0)) {
    await memory.close().catch(() => {});
  }
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(dbDir, { recursive: true, force: true });
});

/** Every file and folder under the temp root, outside the export folder, with each file's text. */
function entriesOutsideExport(): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const rel of fs.readdirSync(root, { recursive: true }) as string[]) {
    const abs = path.join(root, rel);
    if (abs === exportDir || abs.startsWith(exportDir + path.sep)) continue;
    entries[rel] = fs.statSync(abs).isDirectory() ? '(folder)' : fs.readFileSync(abs, 'utf8');
  }
  return entries;
}

/** Every regular file under the export folder, by its path there; a link is not counted. */
function exportedFiles(): string[] {
  return (fs.readdirSync(exportDir, { recursive: true }) as string[])
    .filter((rel) => fs.lstatSync(path.join(exportDir, rel)).isFile())
    .sort();
}

/** A Memory on its own store, closed after the test. */
async function openMemory(): Promise<Memory> {
  const memory = await Memory.createSqlite(path.join(dbDir, 'brain.sqlite'), {
    graph: false,
    selfImprove: false,
    decay: false,
  });
  opened.push(memory);
  return memory;
}

/** Import `traces` into `memory` through a JSON file, as `Memory.importFrom` reads an export. */
async function importTraces(memory: Memory, traces: Array<Record<string, unknown>>): Promise<void> {
  const source = path.join(workspace, 'in.json');
  fs.writeFileSync(source, JSON.stringify({ traces }));
  const imported = await memory.importFrom(source, { format: 'json' });
  expect(imported).toMatchObject({ imported: traces.length, errors: [] });
}

describe('memory exports write only inside the export folder', () => {
  it.each(['markdown', 'obsidian'] as const)(
    'a %s export of imported traces leaves out and reports each trace whose scope, type or id is not a safe name',
    async (format) => {
      const memory = await openMemory();
      // The first three would, by their id or scope, name a file one or two levels above the export folder; the
      // next two hold a character no name may hold.
      await importTraces(memory, [
        { id: '../../../escaped', content: 'An id that leads one level up.' },
        { id: '../../../../outside', content: 'An id that names the file two levels up.' },
        { id: 'mt_scoped', scope: '../../elsewhere', content: 'A scope that leads two levels up.' },
        { id: 'mt_typed', type: 'semantic\\..', content: 'A type with a backslash.' },
        { id: 'mt_asked?', content: 'An id with a character Windows refuses in a name.' },
        { id: 'mt_kept', type: 'semantic', scope: 'user', content: 'A trace with safe names.' },
      ]);

      const before = entriesOutsideExport();
      const result = await memory.export(exportDir, { format });

      expect(result.refused).toHaveLength(5);
      expect(result.refused).toEqual(
        expect.arrayContaining([
          { id: '../../../escaped', field: 'id', problem: 'character' },
          { id: '../../../../outside', field: 'id', problem: 'character' },
          { id: 'mt_scoped', field: 'scope', problem: 'character' },
          { id: 'mt_typed', field: 'type', problem: 'character' },
          { id: 'mt_asked?', field: 'id', problem: 'character' },
        ]),
      );

      // Nothing outside the export folder was written or changed, the file two levels up among it.
      expect(entriesOutsideExport()).toEqual(before);
      expect(fs.readFileSync(path.join(root, 'outside.md'), 'utf8')).toBe(TWO_LEVELS_UP);
      expect(fs.existsSync(path.join(workspace, 'escaped.md'))).toBe(false);
      expect(fs.existsSync(path.join(root, 'elsewhere'))).toBe(false);

      // The trace with safe names is written where its scope, type and id place it.
      expect(exportedFiles()).toEqual([path.join('user', 'semantic', 'mt_kept.md')]);
      expect(fs.readFileSync(path.join(exportDir, 'user', 'semantic', 'mt_kept.md'), 'utf8')).toContain(
        'A trace with safe names.',
      );
    },
  );

  it.each(['markdown', 'obsidian'] as const)(
    'a %s export writes through no link in the export folder, and writes one of two traces whose files would be one',
    async (format) => {
      // A link inside the export folder to a folder outside it; a link where a trace's file goes, to the file two
      // levels up; and a second name for that file (a hard link) where another trace's file goes.
      const linkedFolder = path.join(root, 'linked-folder');
      fs.mkdirSync(linkedFolder);
      fs.mkdirSync(path.join(exportDir, 'thread', 'episodic'), { recursive: true });
      fs.symlinkSync(linkedFolder, path.join(exportDir, 'user'), 'dir');
      fs.symlinkSync(path.join(root, 'outside.md'), path.join(exportDir, 'thread', 'episodic', 'mt_linked.md'));
      fs.linkSync(path.join(root, 'outside.md'), path.join(exportDir, 'thread', 'episodic', 'mt_hard.md'));

      const memory = await openMemory();
      await importTraces(memory, [
        { id: 'mt_through_link', scope: 'user', type: 'semantic', content: 'A trace whose folder is a link.' },
        { id: 'mt_linked', scope: 'thread', type: 'episodic', content: 'A trace whose file is a link.' },
        { id: 'mt_hard', scope: 'thread', type: 'episodic', content: 'A trace whose file has a second name.' },
        { id: 'mt_case', scope: 'persona', type: 'semantic', content: 'The older of two ids that differ in case.', created_at: 1 },
        { id: 'MT_CASE', scope: 'persona', type: 'semantic', content: 'The newer of two ids that differ in case.', created_at: 2 },
        { id: 'mt_kept', scope: 'organization', type: 'semantic', content: 'A trace with a place of its own.' },
      ]);

      const before = entriesOutsideExport();
      const result = await memory.export(exportDir, { format });

      expect(result.refused).toHaveLength(4);
      expect(result.refused).toEqual(
        expect.arrayContaining([
          { id: 'mt_through_link', field: 'path', problem: 'link' },
          { id: 'mt_linked', field: 'path', problem: 'link' },
          { id: 'mt_hard', field: 'path', problem: 'link' },
          { id: 'MT_CASE', field: 'path', problem: 'collision' },
        ]),
      );

      // Nothing was made or written through any of the links.
      expect(entriesOutsideExport()).toEqual(before);
      expect(fs.readdirSync(linkedFolder)).toEqual([]);
      expect(fs.readFileSync(path.join(root, 'outside.md'), 'utf8')).toBe(TWO_LEVELS_UP);
      expect(exportedFiles()).toEqual([
        path.join('organization', 'semantic', 'mt_kept.md'),
        path.join('persona', 'semantic', 'mt_case.md'),
        // The file two levels up, by the second name the test gave it, as it was.
        path.join('thread', 'episodic', 'mt_hard.md'),
      ]);
      expect(fs.readFileSync(path.join(exportDir, 'persona', 'semantic', 'mt_case.md'), 'utf8')).toContain(
        'The older of two ids that differ in case.',
      );
    },
  );

  it.each(['markdown', 'obsidian'] as const)(
    'a %s export writes the older of two traces whose ids a file system that ignores case folds together, the long s and s',
    async (format) => {
      const memory = await openMemory();
      await importTraces(memory, [
        { id: 's', scope: 'user', type: 'semantic', content: 'The older trace, whose id is s.', created_at: 1 },
        { id: 'ſ', scope: 'user', type: 'semantic', content: 'The newer trace, whose id is the long s.', created_at: 2 },
      ]);

      const result = await memory.export(exportDir, { format });

      expect(result.refused).toEqual([{ id: 'ſ', field: 'path', problem: 'collision' }]);
      expect(exportedFiles()).toEqual([path.join('user', 'semantic', 's.md')]);
      expect(fs.readFileSync(path.join(exportDir, 'user', 'semantic', 's.md'), 'utf8')).toContain(
        'The older trace, whose id is s.',
      );
    },
  );

  it('a markdown export writes the oldest of traces whose files the file system makes one, though their names differ, in one batch of open files or a later one', async () => {
    const memory = await openMemory();
    // mt_near is opened in the same batch as mt_first; a full batch of other traces puts mt_far in a later one.
    const others = Array.from({ length: MAX_OPEN_TRACE_FILES }, (_, i) => ({
      id: `mt_other_${String(i).padStart(3, '0')}`,
      scope: 'user',
      type: 'semantic',
      content: `Another trace, number ${i}.`,
      created_at: 3 + i,
    }));
    await importTraces(memory, [
      { id: 'mt_first', scope: 'user', type: 'semantic', content: 'The oldest trace.', created_at: 1 },
      {
        id: 'mt_near',
        scope: 'user',
        type: 'semantic',
        content: 'A newer trace, with a much longer text than the oldest one holds.',
        created_at: 2,
      },
      ...others,
      {
        id: 'mt_far',
        scope: 'user',
        type: 'semantic',
        content: 'The newest trace, with a much longer text than the oldest one holds.',
        created_at: 3 + MAX_OPEN_TRACE_FILES,
      },
    ]);
    // A file system on which the names mt_near.md and mt_far.md open the file mt_first.md, as a Windows short name
    // opens the file of its long name: the names share no key, and only the open files show they are one.
    const folder = path.join(exportDir, 'user', 'semantic');
    const first = path.join(folder, 'mt_first.md');
    const aliases = [path.join(folder, 'mt_near.md'), path.join(folder, 'mt_far.md')];
    const realOpen = fsp.open.bind(fsp);
    const open = vi
      .spyOn(fsp, 'open')
      .mockImplementation((file, flags, mode) => realOpen(aliases.includes(String(file)) ? first : file, flags, mode));

    const result = await memory.export(exportDir, { format: 'markdown' }).finally(() => open.mockRestore());

    for (const alias of aliases) expect(open).toHaveBeenCalledWith(alias, expect.any(Number));
    expect(result.refused).toEqual([
      { id: 'mt_near', field: 'path', problem: 'collision' },
      { id: 'mt_far', field: 'path', problem: 'collision' },
    ]);
    expect(exportedFiles()).toEqual(
      ['mt_first', ...others.map((other) => other.id)].map((id) => path.join('user', 'semantic', `${id}.md`)).sort(),
    );
    const text = fs.readFileSync(first, 'utf8');
    expect(text).toContain('The oldest trace.');
    expect(text).not.toContain('much longer');
  });

  it.skipIf(process.platform === 'win32')(
    'a markdown export leaves out a trace whose place holds a folder or a named pipe, with a reader or without, and settles at once',
    async () => {
      const memory = await openMemory();
      await importTraces(memory, [
        { id: 'mt_piped', scope: 'user', type: 'episodic', content: 'A trace whose place holds a pipe nobody reads.' },
        { id: 'mt_read', scope: 'user', type: 'episodic', content: 'A trace whose place holds a pipe a process reads.' },
        { id: 'mt_folder', scope: 'user', type: 'episodic', content: 'A trace whose place holds a folder.' },
        { id: 'mt_kept', scope: 'user', type: 'episodic', content: 'A trace with a place of its own.' },
      ]);
      const folder = path.join(exportDir, 'user', 'episodic');
      fs.mkdirSync(path.join(folder, 'mt_folder.md'), { recursive: true });
      const unread = path.join(folder, 'mt_piped.md');
      const read = path.join(folder, 'mt_read.md');
      execFileSync('mkfifo', [unread, read]);
      // A reader that never reads, opened without waiting for a writer.
      const reader = fs.openSync(read, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
      try {
        const result = await memory.export(exportDir, { format: 'markdown' });

        expect(result.refused).toHaveLength(3);
        expect(result.refused).toEqual(
          expect.arrayContaining([
            { id: 'mt_piped', field: 'path', problem: 'special' },
            { id: 'mt_read', field: 'path', problem: 'special' },
            { id: 'mt_folder', field: 'path', problem: 'special' },
          ]),
        );
        // Nothing was written into the pipe a process reads.
        expect(fs.readSync(reader, Buffer.alloc(16), 0, 16, null)).toBe(0);
      } finally {
        fs.closeSync(reader);
      }
      expect(fs.lstatSync(unread).isFIFO()).toBe(true);
      expect(fs.lstatSync(read).isFIFO()).toBe(true);
      expect(fs.readdirSync(path.join(folder, 'mt_folder.md'))).toEqual([]);
      expect(exportedFiles()).toEqual([path.join('user', 'episodic', 'mt_kept.md')]);
    },
    15_000,
  );

  it('an exporter subclass whose paths lead out of the export folder has those traces left out, and nothing written outside', async () => {
    const memory = await openMemory();
    await importTraces(memory, [
      { id: 'mt_up', content: 'A trace the subclass places one level above the export folder.' },
      { id: 'mt_absolute', content: 'A trace the subclass places at an absolute path outside the export folder.' },
      { id: 'mt_kept', content: 'A trace the subclass places inside the export folder.' },
    ]);
    await memory.close();
    const absolute = path.join(root, 'absolute.md');

    // A subclass builds each trace's path itself; whatever it returns, a file is written only inside the export folder.
    class PlacingExporter extends MarkdownExporter {
      protected override traceRelativePath(trace: { id: string }): string {
        if (trace.id === 'mt_up') return path.join('..', 'escaped.md');
        if (trace.id === 'mt_absolute') return absolute;
        return `${trace.id}.md`;
      }
    }

    const brain = await Brain.openSqlite(path.join(dbDir, 'brain.sqlite'));
    try {
      const before = entriesOutsideExport();
      const result = await new PlacingExporter(brain).export(exportDir);

      expect(result.refused).toHaveLength(2);
      expect(result.refused).toEqual(
        expect.arrayContaining([
          { id: 'mt_up', field: 'path', problem: 'outside' },
          { id: 'mt_absolute', field: 'path', problem: 'outside' },
        ]),
      );
      expect(entriesOutsideExport()).toEqual(before);
      expect(fs.existsSync(path.join(workspace, 'escaped.md'))).toBe(false);
      expect(fs.existsSync(absolute)).toBe(false);
      expect(exportedFiles()).toEqual(['mt_kept.md']);
    } finally {
      await brain.close();
    }
  });
});
