import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WikiMemoryStore } from '../WikiMemoryStore.js';
import { ensureMemoryDir } from '../migrateMemoryMd.js';

function fakePort() {
  const remembered: Array<{ content: string; options: any }> = [];
  const forgotten: string[] = [];
  const deleted: string[][] = [];
  let n = 0;
  return {
    remembered,
    forgotten,
    deleted,
    remember: async (content: string, options?: any) => {
      remembered.push({ content, options });
      return { id: `t${++n}` };
    },
    forget: async (id: string) => {
      forgotten.push(id);
    },
    deleteTraces: async (ids: readonly string[]) => {
      deleted.push([...ids]);
      return { deleted: ids.length };
    },
    chunk: (t: string) => [{ text: t }],
  };
}

let dir: string;
let memoryDir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wikiidx-'));
  memoryDir = ensureMemoryDir(dir);
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('WikiMemoryStore.index', () => {
  it('indexes a new page and tags traces with scope + page id', async () => {
    const port = fakePort();
    const store = new WikiMemoryStore({ memoryDir, port, agentId: 'a1' });
    await store.writePage({ id: 'entities/johnny', type: 'entity', summary: 's', updated: '', sources: [], body: 'Founder of Frame.', links: [] });
    const res = await store.index();
    expect(res.indexed).toEqual(['entities/johnny']);
    expect(port.remembered).toHaveLength(1);
    // The operator's pages are filed under the operator's own conversation key of the agent.
    expect(port.remembered[0].options).toMatchObject({ scope: 'conversation', scopeId: 'c1:o:2:a1:0:;', type: 'semantic' });
    expect(port.remembered[0].options.tags).toContain('wiki');
    expect(port.remembered[0].options.tags).toContain('page:entities/johnny');
  });

  it('skips an unchanged page on the second run', async () => {
    const port = fakePort();
    const store = new WikiMemoryStore({ memoryDir, port, agentId: 'a1' });
    await store.writePage({ id: 'concepts/x', type: 'concept', summary: '', updated: '', sources: [], body: 'stable', links: [] });
    await store.index();
    const res2 = await store.index();
    expect(res2.indexed).toEqual([]);
    expect(res2.skipped).toEqual(['concepts/x']);
    expect(port.remembered).toHaveLength(1); // not re-remembered
  });

  it('deletes old trace ids for good and re-embeds when a page changes', async () => {
    const port = fakePort();
    const store = new WikiMemoryStore({ memoryDir, port, agentId: 'a1' });
    await store.writePage({ id: 'concepts/x', type: 'concept', summary: '', updated: '', sources: [], body: 'v1', links: [] });
    await store.index();
    await store.writePage({ id: 'concepts/x', type: 'concept', summary: '', updated: '', sources: [], body: 'v2 changed', links: [] });
    const res = await store.index();
    expect(res.indexed).toEqual(['concepts/x']);
    expect(res.removed).toEqual(['t1']);
    expect(port.deleted).toEqual([['t1']]); // old trace deleted, not soft-deleted
    expect(port.forgotten).toEqual([]);
  });

  it('deletes the traces of a page whose file is gone, and drops its entry', async () => {
    const port = fakePort();
    const store = new WikiMemoryStore({ memoryDir, port, agentId: 'a1' });
    await store.writePage({ id: 'concepts/x', type: 'concept', summary: '', updated: '', sources: [], body: 'v1', links: [] });
    await store.index();
    fs.rmSync(path.join(memoryDir, 'concepts', 'x.md'));
    const res = await store.index();
    expect(res.removed).toEqual(['t1']);
    expect(port.deleted).toEqual([['t1']]);
    expect(port.forgotten).toEqual([]);
    const meta = JSON.parse(fs.readFileSync(path.join(memoryDir, '.meta', 'index.json'), 'utf8'));
    expect(meta.keyVersion).toBe('c1');
    expect(meta.pages).toEqual({});
  });

  it("indexes every page again under the agent's own key when the folder's index names another agent's", async () => {
    const port = fakePort();
    const first = new WikiMemoryStore({ memoryDir, port, agentId: 'a1' });
    await first.writePage({ id: 'concepts/ops', type: 'concept', summary: '', updated: '', sources: [], body: 'Open nine to five.', links: [] });
    await first.index();
    expect(port.remembered[0].options.scopeId).toBe('c1:o:2:a1:0:;');

    // The same folder opened as another agent: its pages are unchanged, and their chunks sit under the first key.
    const second = new WikiMemoryStore({ memoryDir, port, agentId: 'a2' });
    const res = await second.index();

    expect(res.indexed).toEqual(['concepts/ops']);
    expect(port.remembered).toHaveLength(2);
    expect(port.remembered[1].options).toMatchObject({ scope: 'conversation', scopeId: 'c1:o:2:a2:0:;' });
    // The chunks under the first key, which no turn of this agent reads, are deleted.
    expect(res.removed).toEqual(['t1']);
    expect(port.deleted).toEqual([['t1']]);

    // An unchanged page is skipped while the key stays the same.
    expect((await second.index()).skipped).toEqual(['concepts/ops']);
    expect(port.remembered).toHaveLength(2);
  });

  it('indexes no page a compile wrote, and none whose sources it cannot read', async () => {
    const port = fakePort();
    const store = new WikiMemoryStore({ memoryDir, port, agentId: 'a1' });
    fs.mkdirSync(path.join(memoryDir, 'concepts'), { recursive: true });
    fs.writeFileSync(path.join(memoryDir, 'concepts', 'compiled.md'), '---\nsummary: Compiled.\nsources:\n  - t-1\n---\nFrom a conversation.\n');
    fs.writeFileSync(path.join(memoryDir, 'concepts', 'odd.md'), '---\nsummary: Odd.\nsources: yes\n---\nCannot tell.\n');
    fs.writeFileSync(path.join(memoryDir, 'concepts', 'ops.md'), '---\nsummary: Opening hours\n---\nOpen nine to five.\n');
    const res = await store.index();
    expect(res.indexed).toEqual(['concepts/ops']);
    expect(port.remembered.map((r) => r.content)).toEqual(['Open nine to five.\n']);
  });

  it('a delete that failed once its file was gone is finished by the next delete', async () => {
    const port = fakePort();
    const deleteTraces = port.deleteTraces;
    let busy = true;
    port.deleteTraces = async (ids: readonly string[]) => {
      if (busy) {
        busy = false;
        throw new Error('the store is busy');
      }
      return deleteTraces(ids);
    };
    const store = new WikiMemoryStore({ memoryDir, port, agentId: 'a1' });
    await store.writePage({ id: 'concepts/x', type: 'concept', summary: '', updated: '', sources: [], body: 'Gone soon.', links: [] });
    await store.index();

    await expect(store.deletePage('concepts/x')).rejects.toThrow('the store is busy');
    expect(fs.existsSync(path.join(memoryDir, 'concepts', 'x.md'))).toBe(false);

    expect(await store.deletePage('concepts/x')).toBe(true);
    expect(port.deleted).toEqual([['t1']]);
    const meta = JSON.parse(fs.readFileSync(path.join(memoryDir, '.meta', 'index.json'), 'utf8'));
    expect(meta.pages).toEqual({});
    // Nothing is left of it: a third delete finds no page.
    expect(await store.deletePage('concepts/x')).toBe(false);
  });
});
