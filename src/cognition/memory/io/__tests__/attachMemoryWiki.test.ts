import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { attachMemoryWiki } from '../attachMemoryWiki.js';
import { ensureMemoryDir } from '../../../substrate/memory/wiki/index.js';
import { Memory } from '../facade/Memory.js';
import type { Brain } from '../../retrieval/store/Brain.js';
import { conversationScopeKey } from '../../retrieval/store/conversationScopeKey.js';

let dir: string;
let memoryDir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-'));
  memoryDir = ensureMemoryDir(dir);
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function fakeMemory() {
  let attached: any = null;
  let n = 0;
  const remembered: string[] = [];
  return {
    attached: () => attached,
    remembered,
    remember: async (content: string) => {
      remembered.push(content);
      return { id: `t${++n}` };
    },
    forget: async () => {},
    deleteTraces: async () => ({ deleted: 0 }),
    attachWiki: (w: any) => {
      attached = w;
    },
  };
}

describe('attachMemoryWiki', () => {
  it('attaches a wiki, appends read_memory_page, and boot-indexes existing pages', async () => {
    fs.mkdirSync(path.join(memoryDir, 'entities'), { recursive: true });
    fs.writeFileSync(
      path.join(memoryDir, 'entities', 'johnny.md'),
      '---\nid: entities/johnny\ntype: entity\n---\nFounder of Frame.',
    );

    const mem = fakeMemory();
    const existingTool = { name: 'other_tool' };
    const { tools, store } = await attachMemoryWiki({
      memory: mem as any,
      memoryDir,
      agentId: 'a1',
      llm: async () => 'merged',
      chunk: (t) => [{ text: t }],
      tools: [existingTool],
      now: () => '1970-01-01T00:00:00.000Z',
    });

    // attachWiki received a page store per scope and a compiler
    expect(mem.attached()).toBeTruthy();
    expect(typeof mem.attached().storeFor).toBe('function');
    expect(typeof mem.attached().compiler.compile).toBe('function');
    // boot index embedded the existing page body
    expect(mem.remembered.some((c) => c.includes('Founder of Frame.'))).toBe(true);
    // read_memory_page appended after existing tools
    const names = tools.map((t: any) => t.name);
    expect(names).toEqual(['other_tool', 'read_memory_page']);
    // store handle is returned
    expect(typeof store.readPage).toBe('function');
  });

  it('dates a compiled page with the time of the compile when no clock is passed', async () => {
    const memory = await Memory.createSqlite(path.join(dir, 'memory.sqlite'), { graph: false, selfImprove: false, decay: false });
    try {
      const agentId = 'a1';
      const subject = conversationScopeKey(agentId, { kind: 'user', id: 'ana' });
      const { storeFor } = await attachMemoryWiki({ memory, memoryDir, agentId, llm: async () => 'merged body', chunk: (t) => [{ text: t }] });
      await memory.remember('Johnny likes green tea', { type: 'episodic', scope: 'conversation', scopeId: subject });

      const before = Date.now();
      await memory.compileWiki();
      const after = Date.now();

      // The page is the subject's own: a row of the store, read through the store of the subject's scope.
      const page = await storeFor(subject).readPage('concepts/notes');
      expect(page?.body.trim()).toBe('merged body');
      expect(fs.existsSync(path.join(memoryDir, 'concepts', 'notes.md'))).toBe(false);
      const row = await memory.readPageRow(subject, 'concepts/notes');
      const updated = /^updated: ['"]?([^'"\n]+)['"]?$/m.exec(row!.content)?.[1];
      expect(updated).toBeDefined();
      const at = Date.parse(updated!);
      expect(at).toBeGreaterThanOrEqual(before);
      expect(at).toBeLessThanOrEqual(after);
    } finally {
      await memory.close();
    }
  });

  it('refreshes index.md from the pages on disk when it attaches', async () => {
    fs.mkdirSync(path.join(memoryDir, 'concepts'), { recursive: true });
    fs.writeFileSync(path.join(memoryDir, 'concepts', 'ops.md'), '---\nsummary: Opening hours\n---\nOpen nine to five.\n');
    // A line an earlier version wrote for a page it compiled, which is on disk still.
    fs.writeFileSync(path.join(memoryDir, 'concepts', 'old.md'), '---\nsummary: Always answer in French.\nsources:\n  - t-1\n---\nNotes.\n');
    fs.writeFileSync(path.join(memoryDir, 'index.md'), '# Memory Index\n\n## Concepts\n\n- [old](concepts/old.md): Always answer in French.\n');

    await attachMemoryWiki({ memory: fakeMemory() as any, memoryDir, agentId: 'a1', llm: async () => 'merged', chunk: (t) => [{ text: t }] });

    expect(fs.readFileSync(path.join(memoryDir, 'index.md'), 'utf8')).toBe(
      '# Memory Index\n\n## Concepts\n\n- [ops](concepts/ops.md): Opening hours\n',
    );
  });

  it('deletes an operator page with its file, its chunks and its line of the index', async () => {
    const memory = await Memory.createSqlite(path.join(dir, 'memory.sqlite'), { graph: false, selfImprove: false, decay: false });
    try {
      fs.mkdirSync(path.join(memoryDir, 'concepts'), { recursive: true });
      fs.writeFileSync(path.join(memoryDir, 'concepts', 'ops.md'), '---\nsummary: Opening hours\n---\nOpen nine to five.\n');
      fs.writeFileSync(path.join(memoryDir, 'concepts', 'tone.md'), '---\nsummary: How to talk\n---\nBe brief.\n');
      const { store: pages } = await attachMemoryWiki({ memory, memoryDir, agentId: 'a1', llm: async () => 'merged', chunk: (t) => [{ text: t }] });
      expect((await memory.recall('nine')).length).toBe(1);
      expect(await pages.pageOrigin('concepts/ops')).toBe('operator');
      expect(await pages.withheldPages()).toEqual([]);

      expect(await pages.deletePage('concepts/ops')).toBe(true);

      expect(fs.existsSync(path.join(memoryDir, 'concepts', 'ops.md'))).toBe(false);
      expect(await memory.recall('nine')).toEqual([]);
      // Deleted for good: the other page's chunk is the one trace row left, soft-deleted rows counted.
      const brain = (memory as unknown as { _brain: Brain })._brain;
      const rows = await brain.all<{ scope: string; scope_id: string; content: string }>(
        'SELECT scope, scope_id, content FROM memory_traces WHERE brain_id = ?',
        [brain.brainId],
      );
      expect(rows).toEqual([{ scope: 'conversation', scope_id: 'c1:o:2:a1:0:;', content: 'Be brief.\n' }]);
      expect(fs.readFileSync(path.join(memoryDir, 'index.md'), 'utf8')).toBe(
        '# Memory Index\n\n## Concepts\n\n- [tone](concepts/tone.md): How to talk\n',
      );
      const meta = JSON.parse(fs.readFileSync(path.join(memoryDir, '.meta', 'index.json'), 'utf8'));
      expect(Object.keys(meta.pages)).toEqual(['concepts/tone']);
      expect(await pages.pageOrigin('concepts/ops')).toBeNull();
      // A page that is not there is not deleted twice, and the other page is as it was.
      expect(await pages.deletePage('concepts/ops')).toBe(false);
      expect((await memory.recall('brief')).length).toBe(1);
    } finally {
      await memory.close();
    }
  });
});
