import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WikiMemoryStore } from '../WikiMemoryStore.js';
import { ensureMemoryDir } from '../migrateMemoryMd.js';

function fakePort() {
  const remembered: Array<{ content: string; options: any }> = [];
  const forgotten: string[] = [];
  let n = 0;
  return {
    remembered,
    forgotten,
    remember: async (content: string, options?: any) => {
      remembered.push({ content, options });
      return { id: `t${++n}` };
    },
    forget: async (id: string) => {
      forgotten.push(id);
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
    expect(port.remembered[0].options).toMatchObject({ scope: 'persona', scopeId: 'a1', type: 'semantic' });
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

  it('forgets old trace ids and re-embeds when a page changes', async () => {
    const port = fakePort();
    const store = new WikiMemoryStore({ memoryDir, port, agentId: 'a1' });
    await store.writePage({ id: 'concepts/x', type: 'concept', summary: '', updated: '', sources: [], body: 'v1', links: [] });
    await store.index();
    await store.writePage({ id: 'concepts/x', type: 'concept', summary: '', updated: '', sources: [], body: 'v2 changed', links: [] });
    const res = await store.index();
    expect(res.indexed).toEqual(['concepts/x']);
    expect(port.forgotten).toEqual(['t1']); // old trace removed
  });
});
