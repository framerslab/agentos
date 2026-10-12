import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Memory } from '../facade/Memory.js';

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
});
