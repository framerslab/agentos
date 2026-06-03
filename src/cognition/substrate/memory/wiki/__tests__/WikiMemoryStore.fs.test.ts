import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WikiMemoryStore } from '../WikiMemoryStore.js';
import { ensureMemoryDir } from '../migrateMemoryMd.js';

let dir: string;
let memoryDir: string;
const noopPort = {
  remember: async () => ({ id: 'x' }),
  forget: async () => {},
  chunk: (t: string) => [{ text: t }],
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wikistore-'));
  memoryDir = ensureMemoryDir(dir);
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
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

  it('load returns all pages except index.md and .meta', async () => {
    const store = new WikiMemoryStore({ memoryDir, port: noopPort, agentId: 'a1' });
    await store.writePage({ id: 'concepts/billing', type: 'concept', summary: 's', updated: '', sources: [], body: 'b', links: [] });
    const pages = await store.load();
    expect(pages.map((p) => p.id)).toEqual(['concepts/billing']);
  });
});
