import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { attachMemoryWiki } from '../attachMemoryWiki.js';
import { Memory } from '../facade/Memory.js';
import { ReadMemoryPageTool } from '../tools/ReadMemoryPageTool.js';
import { ensureMemoryDir, InvalidWikiPageIdError, type WikiPage } from '../../../substrate/memory/wiki/index.js';

// The wiki is <root>/workspace/memory. A Markdown file sits one level above it, another two levels above.
let root: string;
let workspace: string;
let memoryDir: string;

const ONE_LEVEL_UP = 'Text one level above the memory folder.';
const TWO_LEVELS_UP = 'Text two levels above the memory folder.';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-page-id-'));
  workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  memoryDir = ensureMemoryDir(workspace);
  fs.writeFileSync(path.join(memoryDir, 'page.md'), '---\nid: page\ntype: concept\nsummary: A page.\n---\nInside the wiki.\n');
  fs.writeFileSync(path.join(workspace, 'outside.md'), `---\nsummary: Outside.\n---\n${ONE_LEVEL_UP}\n`);
  fs.writeFileSync(path.join(root, 'outside.md'), `---\nsummary: Outside.\n---\n${TWO_LEVELS_UP}\n`);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** A Memory facade stand-in that records what the boot index remembers and the wiki it is handed. */
function fakeMemory() {
  let attached: any = null;
  let n = 0;
  const remembered: string[] = [];
  return {
    remembered,
    attached: () => attached,
    remember: async (content: string) => {
      remembered.push(content);
      return { id: `t${++n}` };
    },
    forget: async () => {},
    attachWiki: (wiki: any) => {
      attached = wiki;
    },
  };
}

/** Wire the wiki over the temp folder the way souledAgent does, and pick out its read_memory_page tool. */
async function wire(opts: {
  llm?: (prompt: string) => Promise<string>;
  cluster?: Parameters<typeof attachMemoryWiki>[0]['cluster'];
} = {}) {
  const memory = fakeMemory();
  const { store, tools } = await attachMemoryWiki({
    memory,
    memoryDir,
    agentId: 'a1',
    llm: opts.llm ?? (async () => 'merged'),
    chunk: (t) => [{ text: t }],
    now: () => '2026-10-12T00:00:00.000Z',
    cluster: opts.cluster,
  });
  const tool = tools.find((t): t is ReadMemoryPageTool => t instanceof ReadMemoryPageTool);
  if (!tool) throw new Error('attachMemoryWiki added no read_memory_page tool');
  return { memory, store, tool };
}

function pageWithId(id: string): WikiPage {
  return { id, type: 'concept', summary: 'Written.', updated: '', sources: [], body: 'Written by the test.', links: [] };
}

describe('wiki page ids stay inside the memory folder', () => {
  it('read_memory_page reads a page and refuses ids that leave the memory folder', async () => {
    const { tool } = await wire();

    const read = await tool.execute({ id: 'page' }, {} as any);
    expect(read.success).toBe(true);
    expect(read.output?.id).toBe('page');
    expect(read.output?.body).toContain('Inside the wiki.');

    for (const id of ['../outside', '../../outside', 'entities/../../outside', '..\\outside']) {
      const res = await tool.execute({ id }, {} as any);
      expect(res.success, id).toBe(false);
      expect(res.output, id).toBeUndefined();
      expect(res.details, id).toMatchObject({ code: 'INVALID_WIKI_PAGE_ID' });
      expect(res.error, id).toContain('refused');
      expect(JSON.stringify(res), id).not.toContain(ONE_LEVEL_UP);
      expect(JSON.stringify(res), id).not.toContain(TWO_LEVELS_UP);
    }
  });

  it('the store refuses such ids: readPage reads nothing and writePage writes nothing outside the folder', async () => {
    const { store } = await wire();

    await expect(store.readPage('../outside')).rejects.toBeInstanceOf(InvalidWikiPageIdError);
    await expect(store.readPage('../../outside')).rejects.toMatchObject({ code: 'INVALID_WIKI_PAGE_ID', problem: 'dot' });

    const catalog = fs.readFileSync(path.join(memoryDir, 'index.md'), 'utf8');
    for (const id of ['../outside', '../written', '../../written', 'entities/../../written']) {
      await expect(store.writePage(pageWithId(id)), id).rejects.toBeInstanceOf(InvalidWikiPageIdError);
    }
    expect(fs.existsSync(path.join(workspace, 'written.md'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'written.md'))).toBe(false);
    expect(fs.existsSync(path.join(memoryDir, 'entities'))).toBe(false);
    expect(fs.readFileSync(path.join(workspace, 'outside.md'), 'utf8')).toContain(ONE_LEVEL_UP);
    expect(fs.readFileSync(path.join(memoryDir, 'index.md'), 'utf8')).toBe(catalog);

    // An id in the wiki's form is still written inside the folder.
    await store.writePage(pageWithId('concepts/kept'));
    expect(fs.readFileSync(path.join(memoryDir, 'concepts', 'kept.md'), 'utf8')).toContain('Written by the test.');
  });

  it('a compile skips a cluster assignment whose page id is refused and reports it', async () => {
    const prompts: string[] = [];
    const { memory } = await wire({
      llm: async (prompt) => {
        prompts.push(prompt);
        return 'Merged facts.';
      },
      cluster: async () => [
        { pageId: '../stolen', traceIds: ['ta'] },
        { pageId: 'concepts/kept', traceIds: ['tb'] },
      ],
    });

    const result = await memory.attached().compiler.compile({
      traces: [
        { id: 'ta', content: 'Fact a.', tags: [], entities: [] },
        { id: 'tb', content: 'Fact b.', tags: [], entities: [] },
      ],
      reason: 'explicit',
    });

    expect(result.pagesWritten).toEqual(['concepts/kept']);
    expect(result.tracesConsumed).toBe(1);
    expect(result.conflicts).toEqual([{ pageId: '../stolen', note: expect.stringContaining('refused') }]);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Fact b.');
    expect(prompts[0]).not.toContain('Fact a.');
    expect(fs.existsSync(path.join(workspace, 'stolen.md'))).toBe(false);
    expect(fs.readFileSync(path.join(memoryDir, 'concepts', 'kept.md'), 'utf8')).toContain('Merged facts.');
  });

  it('the boot index lists only files whose path makes a page id', async () => {
    fs.writeFileSync(path.join(memoryDir, '.hidden.md'), 'Hidden page.\n');
    fs.mkdirSync(path.join(memoryDir, '.trash'));
    fs.writeFileSync(path.join(memoryDir, '.trash', 'old.md'), 'Old page.\n');

    const { memory, store } = await wire();

    expect((await store.load()).map((p) => p.id)).toEqual(['page']);
    expect(memory.remembered.some((c) => c.includes('Inside the wiki.'))).toBe(true);
    expect(memory.remembered.some((c) => c.includes('Hidden page.') || c.includes('Old page.'))).toBe(false);
  });
});

describe('a compile goes on past a page the file system will not take', () => {
  it('reports a name too long for a file and a page it cannot write, writes the rest and moves the watermark', async () => {
    const memory = await Memory.createSqlite(path.join(root, 'memory.sqlite'), {
      graph: false,
      selfImprove: false,
      decay: false,
    });
    try {
      // A file where the folder of the page blocked/page would go, so that page cannot be written.
      fs.writeFileSync(path.join(memoryDir, 'blocked'), 'Not a folder.\n');
      const longId = `concepts/${'x'.repeat(300)}`;
      const prompts: string[] = [];
      const { store } = await attachMemoryWiki({
        memory,
        memoryDir,
        agentId: 'a1',
        llm: async (prompt) => {
          prompts.push(prompt);
          return 'Merged facts.';
        },
        chunk: (t) => [{ text: t }],
        now: () => '2026-10-12T00:00:00.000Z',
        cluster: async (traces) =>
          traces.map((t) => ({
            pageId: t.content.startsWith('Long') ? longId : t.content.startsWith('Blocked') ? 'blocked/page' : 'concepts/kept',
            traceIds: [t.id],
          })),
      });
      await memory.remember('Long fact.');
      await memory.remember('Blocked fact.');
      await memory.remember('Kept fact.');

      const result = await memory.compileWiki({ reason: 'explicit' });

      expect(result.pagesWritten).toEqual(['concepts/kept']);
      expect(result.tracesConsumed).toBe(1);
      expect(result.conflicts).toHaveLength(2);
      expect(result.conflicts).toEqual(
        expect.arrayContaining([
          { pageId: longId, note: expect.stringContaining('refused') },
          { pageId: 'blocked/page', note: expect.stringContaining('write failed') },
        ]),
      );
      // The long id is refused before its merge prompt; the blocked page is merged, then its write fails.
      expect(prompts).toHaveLength(2);
      expect(prompts.some((p) => p.includes('Long fact.'))).toBe(false);
      expect(fs.readFileSync(path.join(memoryDir, 'concepts', 'kept.md'), 'utf8')).toContain('Merged facts.');
      expect(await store.readMetaWatermark()).not.toBeNull();

      // The watermark moved past the batch, so the next compile does not run into the same pages.
      expect(await memory.compileWiki({ reason: 'explicit' })).toEqual({ pagesWritten: [], tracesConsumed: 0, conflicts: [] });
      expect(prompts).toHaveLength(2);
    } finally {
      await memory.close();
    }
  });

  it('indexes a page whose file was written before the catalog failed', async () => {
    const memory = await Memory.createSqlite(path.join(root, 'memory.sqlite'), {
      graph: false,
      selfImprove: false,
      decay: false,
    });
    try {
      // A folder where the catalog, index.md, goes: the page's file is written, then refreshing the catalog fails.
      fs.rmSync(path.join(memoryDir, 'index.md'));
      fs.mkdirSync(path.join(memoryDir, 'index.md'));
      await attachMemoryWiki({
        memory,
        memoryDir,
        agentId: 'a1',
        llm: async () => 'Merged facts.',
        chunk: (t) => [{ text: t }],
        now: () => '2026-10-12T00:00:00.000Z',
        cluster: async (traces) => [{ pageId: 'concepts/kept', traceIds: traces.map((t) => t.id) }],
      });
      await memory.remember('Kept fact.');

      const result = await memory.compileWiki({ reason: 'explicit' });

      expect(result.pagesWritten).toEqual([]);
      expect(result.conflicts).toEqual([{ pageId: 'concepts/kept', note: expect.stringContaining('write failed') }]);
      expect(fs.readFileSync(path.join(memoryDir, 'concepts', 'kept.md'), 'utf8')).toContain('Merged facts.');
      // The page on disk is indexed all the same.
      const traces = await memory.recentTraces(0, { limit: 50 });
      expect(traces.some((t) => t.tags.includes('page:concepts/kept') && t.content.includes('Merged facts.'))).toBe(true);
    } finally {
      await memory.close();
    }
  });
});
