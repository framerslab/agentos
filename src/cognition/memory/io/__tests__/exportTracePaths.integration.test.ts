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

/** Every file the export wrote, by its path under the export folder. */
function exportedFiles(): string[] {
  return (fs.readdirSync(exportDir, { recursive: true }) as string[])
    .filter((rel) => fs.statSync(path.join(exportDir, rel)).isFile())
    .sort();
}

describe('memory exports write only inside the export folder', () => {
  it.each(['markdown', 'obsidian'] as const)(
    'a %s export of imported traces leaves out and reports each trace whose scope, type or id is not a safe name',
    async (format) => {
      const memory = await Memory.createSqlite(path.join(dbDir, 'brain.sqlite'), {
        graph: false,
        selfImprove: false,
        decay: false,
      });
      opened.push(memory);

      // Each refused trace would, by its id or scope, name a file one or two levels above the export folder.
      const source = path.join(workspace, 'in.json');
      fs.writeFileSync(
        source,
        JSON.stringify({
          traces: [
            { id: '../../../escaped', content: 'An id that leads one level up.' },
            { id: '../../../../outside', content: 'An id that names the file two levels up.' },
            { id: 'mt_scoped', scope: '../../elsewhere', content: 'A scope that leads two levels up.' },
            { id: 'mt_typed', type: 'semantic\\..', content: 'A type with a backslash.' },
            { id: 'mt_kept', type: 'semantic', scope: 'user', content: 'A trace with safe names.' },
          ],
        }),
      );
      const imported = await memory.importFrom(source, { format: 'json' });
      expect(imported).toMatchObject({ imported: 5, errors: [] });

      const before = entriesOutsideExport();
      const result = await memory.export(exportDir, { format });

      expect(result.refused).toHaveLength(4);
      expect(result.refused).toEqual(
        expect.arrayContaining([
          { id: '../../../escaped', field: 'id', problem: 'character' },
          { id: '../../../../outside', field: 'id', problem: 'character' },
          { id: 'mt_scoped', field: 'scope', problem: 'character' },
          { id: 'mt_typed', field: 'type', problem: 'character' },
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
});
