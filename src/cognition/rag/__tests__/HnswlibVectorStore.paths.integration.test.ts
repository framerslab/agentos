/**
 * @file HnswlibVectorStore.paths.integration.test.ts
 * The Hnswlib store's persistence against a temp folder: a manifest entry whose `fileBase` is not the name the store
 * gives a collection's files is skipped with a warning, so no query, delete or flush of that collection touches a
 * file outside the persist folder; such an entry does not keep the entries after it from loading; and a manifest the
 * store wrote itself loads again.
 *
 * hnswlib-node is replaced, as in HnswlibVectorStore.test.ts, by a fake whose index files are real files at the
 * paths the store gives it: CI does not build the native module, and the paths are what is tested here.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

/** Every path the fake index read or wrote. */
const indexFiles = vi.hoisted(() => ({ read: [] as string[], written: [] as string[] }));

vi.mock('hnswlib-node', async () => {
  const nodeFs = await import('node:fs');
  class HierarchicalNSW {
    initIndex(): void {}
    setEf(): void {}
    addPoint(): void {}
    markDelete(): void {}
    resizeIndex(): void {}
    getPoint(): number[] {
      return [];
    }
    // Each collection here holds one document, under the label 0.
    searchKnn(): { neighbors: number[]; distances: number[] } {
      return { neighbors: [0], distances: [0.05] };
    }
    async readIndex(file: string): Promise<boolean> {
      indexFiles.read.push(file);
      nodeFs.readFileSync(file);
      return true;
    }
    async writeIndex(file: string): Promise<boolean> {
      indexFiles.written.push(file);
      nodeFs.writeFileSync(file, 'index');
      return true;
    }
  }
  return { HierarchicalNSW };
});

import { HnswlibVectorStore, type HnswlibVectorStoreConfig } from '../vector_stores/HnswlibVectorStore.js';

// <base>/one/persist is the store's folder; <base>/elsewhere is where a fileBase of ../../elsewhere/x leads.
let base: string;
let persist: string;
let elsewhere: string;
let warn: MockInstance<typeof console.warn>;

const SECRET = 'A document outside the persist folder, which no query may return.';

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'hnswlib-paths-'));
  persist = path.join(base, 'one', 'persist');
  elsewhere = path.join(base, 'elsewhere');
  fs.mkdirSync(persist, { recursive: true });
  indexFiles.read.length = 0;
  indexFiles.written.length = 0;
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
  fs.rmSync(base, { recursive: true, force: true });
});

/** A store on the persist folder, initialized. */
async function openStore(): Promise<HnswlibVectorStore> {
  const config: HnswlibVectorStoreConfig = { id: 'paths', type: 'hnswlib', persistDirectory: persist };
  const store = new HnswlibVectorStore();
  await store.initialize(config);
  return store;
}

/** The files in `dir`, by name, with their text. */
function filesIn(dir: string): Record<string, string> {
  return Object.fromEntries(
    fs.readdirSync(dir).sort().map((name) => [name, fs.readFileSync(path.join(dir, name), 'utf8')]),
  );
}

/** True when `file` lies in the persist folder. */
function inPersist(file: string): boolean {
  return path.resolve(file).startsWith(path.resolve(persist) + path.sep);
}

/** The warning lines that say a manifest entry was skipped. */
function skippedLines(): string[] {
  return warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('Skipped collection'));
}

describe("the Hnswlib store's files stay in its persist folder", () => {
  it('a manifest entry whose fileBase leads out of the folder is skipped with one warning, and a query, a delete and a flush of its collection touch nothing outside the folder', async () => {
    fs.writeFileSync(
      path.join(persist, 'hnswlib.manifest.json'),
      JSON.stringify({
        version: 1,
        collections: [{ name: 'docs', fileBase: '../../elsewhere/x', dimension: 3, similarityMetric: 'cosine' }],
      }),
    );
    // The index and metadata files that fileBase names, outside the folder; the metadata holds one document.
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, 'x.hnsw'), 'outside index');
    fs.writeFileSync(
      path.join(elsewhere, 'x.meta.json'),
      JSON.stringify({
        version: 1,
        name: 'docs',
        dimension: 3,
        similarityMetric: 'cosine',
        nextLabel: 1,
        maxElements: 10,
        labelToId: [[0, 'outside']],
        metadata: [['outside', { textContent: SECRET }]],
      }),
    );
    const outside = filesIn(elsewhere);

    const store = await openStore();

    expect(skippedLines()).toHaveLength(1);
    expect(skippedLines()[0]).toContain('"docs"');
    expect(await store.collectionExists('docs')).toBe(false);

    const queried = await store.query('docs', [0.1, 0.2, 0.3], { includeTextContent: true });
    expect(queried.documents).toEqual([]);
    expect(JSON.stringify(queried)).not.toContain(SECRET);

    await store.deleteCollection('docs');

    // The upsert makes the collection again under the store's own name for its files, and the shutdown flushes it.
    await store.upsert('docs', [{ id: 'inside', embedding: [0.1, 0.2, 0.3], textContent: 'inside' }]);
    await store.shutdown();

    expect(filesIn(elsewhere)).toEqual(outside);
    expect(fs.readdirSync(base).sort()).toEqual(['elsewhere', 'one']);
    expect(indexFiles.read).toEqual([]);
    expect(indexFiles.written.length).toBeGreaterThan(0);
    expect(indexFiles.written.every(inPersist)).toBe(true);
    expect(fs.readdirSync(persist).sort()).toEqual(['docs.hnsw', 'docs.meta.json', 'hnswlib.manifest.json']);
    const manifest = JSON.parse(fs.readFileSync(path.join(persist, 'hnswlib.manifest.json'), 'utf8'));
    expect(manifest.collections).toEqual([{ name: 'docs', fileBase: 'docs', dimension: 3, similarityMetric: 'cosine' }]);
  });

  it('an entry whose name the store cannot encode is skipped with a warning, and the entries after it still load', async () => {
    const writer = await openStore();
    await writer.upsert('notes', [{ id: 'doc', embedding: [0.1, 0.2, 0.3], textContent: 'kept' }]);
    await writer.shutdown();
    // Before the store's own entry goes one whose name holds a lone surrogate, which URI encoding refuses.
    const manifestPath = path.join(persist, 'hnswlib.manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.collections.unshift({ name: '\ud800', fileBase: 'x', dimension: 3, similarityMetric: 'cosine' });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    const reader = await openStore();

    expect(skippedLines()).toHaveLength(1);
    expect(await reader.collectionExists('notes')).toBe(true);
    const result = await reader.query('notes', [0.1, 0.2, 0.3], { includeTextContent: true });
    expect(result.documents.map((document) => document.textContent)).toEqual(['kept']);
    await reader.shutdown();
  });

  it('a manifest the store wrote itself loads again, for collection names it encodes and for a long one it shortens', async () => {
    // A slash, a name of two dots, and a name whose encoded form is longer than the store keeps whole.
    const names = ['notes/2026', '..', '\u00fc'.repeat(60)];
    const writer = await openStore();
    for (const [index, name] of names.entries()) {
      await writer.upsert(name, [{ id: `doc-${index}`, embedding: [0.1, 0.2, 0.3], textContent: `text ${index}` }]);
    }
    await writer.shutdown();

    const reader = await openStore();
    for (const [index, name] of names.entries()) {
      expect(await reader.collectionExists(name)).toBe(true);
      const result = await reader.query(name, [0.1, 0.2, 0.3], { includeTextContent: true });
      expect(result.documents.map((document) => document.textContent)).toEqual([`text ${index}`]);
    }
    await reader.shutdown();

    expect(skippedLines()).toEqual([]);
    expect(indexFiles.read).toHaveLength(names.length);
    expect([...indexFiles.read, ...indexFiles.written].every(inPersist)).toBe(true);
    // Each collection's index and metadata files, and the manifest.
    expect(fs.readdirSync(persist)).toHaveLength(names.length * 2 + 1);
  });
});
