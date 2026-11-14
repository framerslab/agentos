import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WikiMemoryStore, listWikiPageIds, type WikiFolderEntry } from '../WikiMemoryStore.js';
import { ensureMemoryDir } from '../migrateMemoryMd.js';

let dir: string;
let memoryDir: string;
const noopPort = {
  remember: async () => ({ id: 'x' }),
  forget: async () => {},
  deleteTraces: async () => ({ deleted: 0 }),
  chunk: (t: string) => [{ text: t }],
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wikistore-'));
  memoryDir = ensureMemoryDir(dir);
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('WikiMemoryStore index.md and the text migrated from MEMORY.md', () => {
  const page = (id: string, summary: string) => ({ id, type: 'concept' as const, summary, updated: '', sources: [], body: 'b', links: [] });

  it('keeps an index written before the end marker existed, and gives it its end marker on the first refresh', async () => {
    // What ensureMemoryDir wrote before the migrated text had an end marker, the catalog not yet written.
    fs.writeFileSync(
      path.join(memoryDir, 'index.md'),
      '# Memory Index\n\n<!-- migrated from MEMORY.md -->\n\n# Facts\n\nThe user prefers concise answers.\n',
    );
    const store = new WikiMemoryStore({ memoryDir, port: noopPort, agentId: 'a1' });
    await store.writePage(page('concepts/billing', 'How billing works.'));
    await store.writePage(page('concepts/tone', 'How to talk.'));

    expect(fs.readFileSync(path.join(memoryDir, 'index.md'), 'utf8')).toBe(
      '# Memory Index\n\n<!-- migrated from MEMORY.md -->\n\n# Facts\n\nThe user prefers concise answers.\n\n<!-- end of MEMORY.md -->\n\n' +
        '## Concepts\n\n- [billing](concepts/billing.md): How billing works.\n- [tone](concepts/tone.md): How to talk.\n',
    );
  });

  // A file its owner may write and not read; the superuser reads it all the same, and Windows has no such mode.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'leaves an index.md it cannot read as it is, and fails the write',
    async () => {
      const index = path.join(memoryDir, 'index.md');
      fs.writeFileSync(index, '# Memory Index\n\n<!-- migrated from MEMORY.md -->\n\nThe user prefers concise answers.\n\n<!-- end of MEMORY.md -->\n');
      const before = fs.readFileSync(index, 'utf8');
      const store = new WikiMemoryStore({ memoryDir, port: noopPort, agentId: 'a1' });
      fs.chmodSync(index, 0o200);
      try {
        await expect(store.writePage(page('concepts/billing', 'How billing works.'))).rejects.toThrow();
      } finally {
        fs.chmodSync(index, 0o644);
      }
      expect(fs.readFileSync(index, 'utf8')).toBe(before);
    },
  );
});

describe('WikiMemoryStore filesystem', () => {
  it('writePage then readPage round-trips and updates index.md', async () => {
    const store = new WikiMemoryStore({ memoryDir, port: noopPort, agentId: 'a1' });
    await store.writePage({
      id: 'entities/johnny',
      type: 'entity',
      summary: 'Founder.',
      updated: '2026-06-02T00:00:00Z',
      sources: [],
      body: 'Founder of [[Frame]].',
      links: ['Frame'],
    });
    const got = await store.readPage('entities/johnny');
    expect(got?.summary).toBe('Founder.');
    expect(fs.existsSync(path.join(memoryDir, 'entities', 'johnny.md'))).toBe(true);
    const catalog = await store.getCatalog();
    expect(catalog).toContain('[johnny](entities/johnny.md)');
  });

  it('writePage and readPage keep a body that opens with a front-matter block, and evaluate none marked as JavaScript', async () => {
    // Evaluated, the block would set this global and give the type 'log'.
    const mark = '__agentosWikiStoreFrontMatterEvaluated';
    const page = {
      id: 'concepts/notes',
      type: 'concept' as const,
      summary: 'Notes.',
      updated: '2026-06-02T10:00:00Z',
      sources: ['trace:a'],
      body: `---js\n{ type: (globalThis.${mark} = true) && 'log' }\n---\nNotes on [[Frame]].\n`,
      links: ['Frame'],
    };
    const store = new WikiMemoryStore({ memoryDir, port: noopPort, agentId: 'a1' });

    try {
      await store.writePage(page);
      expect(Reflect.get(globalThis, mark)).toBeUndefined();

      // The page file is the page's own front matter, then the body as it is.
      const file = fs.readFileSync(path.join(memoryDir, 'concepts', 'notes.md'), 'utf8');
      expect(file.startsWith('---\nid: concepts/notes\n')).toBe(true);
      expect(file.endsWith(`\n---\n${page.body}`)).toBe(true);

      // Read back, the fields are the page's own and the body is whole; a page that lists sources reads as compiled.
      expect(await store.readPage('concepts/notes')).toEqual({ ...page, origin: 'compiled' });
      expect(Reflect.get(globalThis, mark)).toBeUndefined();

      // A page file that opens with the block itself: the block gives no fields, so the id decides the type.
      fs.writeFileSync(path.join(memoryDir, 'concepts', 'marked.md'), page.body);
      expect(await store.readPage('concepts/marked')).toEqual({
        id: 'concepts/marked',
        type: 'concept',
        summary: '',
        updated: '',
        sources: [],
        body: 'Notes on [[Frame]].\n',
        links: ['Frame'],
        origin: 'operator',
      });
      expect(Reflect.get(globalThis, mark)).toBeUndefined();
    } finally {
      Reflect.deleteProperty(globalThis, mark);
    }
  });

  it('load returns all pages except index.md and .meta', async () => {
    const store = new WikiMemoryStore({ memoryDir, port: noopPort, agentId: 'a1' });
    await store.writePage({ id: 'concepts/billing', type: 'concept', summary: 's', updated: '', sources: [], body: 'b', links: [] });
    const pages = await store.load();
    expect(pages.map((p) => p.id)).toEqual(['concepts/billing']);
  });
});

describe('listWikiPageIds', () => {
  const folder = (name: string): WikiFolderEntry => ({ name, isDirectory: () => true });
  const file = (name: string): WikiFolderEntry => ({ name, isDirectory: () => false });

  it('joins folder names with / on Windows, so nested pages keep the ids the compiler writes', async () => {
    const listings: Record<string, WikiFolderEntry[]> = {
      'C:\\agent\\memory': [folder('entities'), folder('.meta'), file('index.md'), file('page.md'), file('.hidden.md')],
      'C:\\agent\\memory\\entities': [file('johnny.md'), folder('team'), file('notes.txt')],
      'C:\\agent\\memory\\entities\\team': [file('ana.md')],
      'C:\\agent\\memory\\.meta': [file('stale.md')],
    };
    const asked: string[] = [];
    const ids = await listWikiPageIds(
      'C:\\agent\\memory',
      async (dir) => {
        asked.push(dir);
        return listings[dir] ?? [];
      },
      path.win32,
    );

    expect(ids).toEqual(['entities/johnny', 'entities/team/ana', 'page']);
    // Each folder is read at its Windows path, and no folder whose name starts with a dot is read.
    expect(asked.sort()).toEqual([
      'C:\\agent\\memory',
      'C:\\agent\\memory\\entities',
      'C:\\agent\\memory\\entities\\team',
    ]);
  });
});
