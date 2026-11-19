/**
 * @fileoverview Indexing a source by content (`planSource`, `applySourcePlan`) and reading stored vectors
 * (`passageVectors`) on InMemoryVectorStore, with an embedder that records every text it is sent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IVectorStore, MetadataFilter } from '../../../core/vector-store/IVectorStore.js';
import { InMemoryVectorStore } from '../../rag/vector_stores/InMemoryVectorStore.js';
import { LibraryIndex, LibraryPlanStale, type LibraryEmbedding, type LibrarySource } from '../LibraryIndex.js';

const MODEL: LibraryEmbedding = { model: 'test-embed', dimensions: 4 };
const ANN = { tenantId: 'org1', aclGroups: ['acct:ann'] };

/** A vector of a text: the same text, the same vector. */
function vectorOf(text: string): number[] {
  let hash = 7;
  for (const char of text) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  return [1, (hash % 97) / 97, (hash % 89) / 89, (hash % 83) / 83];
}

const passages = (count: number, change: (n: number) => string | undefined = () => undefined) =>
  Array.from({ length: count }, (_, n) => ({ text: change(n) ?? `Passage ${n} is about the budget and the plan.` }));

const documentSource = (over: Partial<LibrarySource> = {}): LibrarySource => ({
  sourceId: 'document:d1',
  kind: 'document',
  tenantId: 'org1',
  aclGroups: ['acct:ann'],
  title: 'Plan',
  tags: ['q3'],
  passages: passages(40),
  ...over,
});

const texts = (source: LibrarySource): string[] => source.passages.map((passage) => passage.text);

describe('LibraryIndex indexes a source by content', () => {
  let store: InMemoryVectorStore;
  let sent: string[];
  let embed: (texts: string[]) => Promise<number[][]>;
  let library: LibraryIndex;

  /** Plans a source, embeds what the plan asks for, and applies it. */
  const index = async (source: LibrarySource, inputs = texts(source), embedding = MODEL) => {
    const plan = await library.planSource(source, { embedding, inputs });
    await library.applySourcePlan(plan, plan.toEmbed.length === 0 ? [] : await embed([...plan.toEmbed]));
    return plan;
  };
  const stored = () => store.listSourcePassages('library', 'document:d1');
  const storedTexts = async () =>
    (await store.scanByMetadata('library', { filter: { sourceId: 'document:d1' }, includeTextContent: true, limit: 1000 })).documents
      .sort((a, b) => Number(a.metadata?.index) - Number(b.metadata?.index))
      .map((doc) => doc.textContent);

  beforeEach(async () => {
    store = new InMemoryVectorStore();
    await store.initialize({ id: 'mem', type: 'in_memory' });
    await store.createCollection('library', 4);
    sent = [];
    embed = async (batch: string[]) => {
      sent.push(...batch);
      return batch.map(vectorOf);
    };
    library = new LibraryIndex({ store, collection: 'library', embed, dimensions: 4 });
  });

  it('embeds only the changed input of a 40-passage source, where indexSource sends all 40 again', async () => {
    const edited = documentSource({ passages: passages(40, (n) => (n === 7 ? 'Passage 7 now says the budget doubled.' : undefined)) });
    await library.indexSource(documentSource());
    sent.length = 0;
    await library.indexSource(edited);
    expect(sent).toHaveLength(40);

    // Rows written without an input hash count as absent: the first plan embeds every passage, once.
    sent.length = 0;
    const first = await index(documentSource());
    expect(sent).toHaveLength(40);
    expect(first.counts).toEqual({ embed: 40, reuse: 0, rewrite: 0, remove: 40 });

    sent.length = 0;
    const plan = await index(edited);
    expect(plan.toEmbed).toEqual(['Passage 7 now says the budget doubled.']);
    expect(sent).toEqual(['Passage 7 now says the budget doubled.']);
    expect(plan.counts).toEqual({ embed: 1, reuse: 39, rewrite: 0, remove: 1 });
    expect(await stored()).toHaveLength(40);
    expect(await storedTexts()).toEqual(texts(edited));
  });

  it('embeds nothing and writes nothing when nothing changed', async () => {
    await index(documentSource());
    sent.length = 0;
    const upsert = vi.spyOn(store, 'upsert');
    const patch = vi.spyOn(store, 'patchPassages');
    const remove = vi.spyOn(store, 'delete');
    const plan = await index(documentSource());
    expect(plan.toEmbed).toEqual([]);
    expect(plan.counts).toEqual({ embed: 0, reuse: 40, rewrite: 0, remove: 0 });
    expect(sent).toEqual([]);
    expect(upsert).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("embeds a title change only in the passage whose input carries the title, and an access change not at all", async () => {
    // The host puts the title in the first passage's input.
    const inputs = (source: LibrarySource) => texts(source).map((text, n) => (n === 0 ? `${source.title}\n${text}` : text));
    await index(documentSource(), inputs(documentSource()));
    sent.length = 0;
    const retitled = documentSource({ title: 'Plan, second draft' });
    const titled = await index(retitled, inputs(retitled));
    expect(sent).toEqual([`Plan, second draft\n${texts(retitled)[0]}`]);
    expect(titled.counts).toEqual({ embed: 1, reuse: 39, rewrite: 0, remove: 1 });
    expect((await stored()).every((row) => row.metadata.title === 'Plan, second draft')).toBe(true);

    sent.length = 0;
    const shared = documentSource({ title: 'Plan, second draft', aclGroups: ['acct:ann', 'org:org1'] });
    const access = await index(shared, inputs(shared));
    expect(sent).toEqual([]);
    expect(access.counts).toEqual({ embed: 0, reuse: 40, rewrite: 0, remove: 0 });
    expect(access.patches).toHaveLength(40);
    const ids = (await stored()).map((row) => row.id);
    expect((await library.passageVectors(ids, { tenantId: 'org1', aclGroups: ['org:org1'] }, MODEL)).size).toBe(40);
  });

  it('keeps the id and vector of a passage that moved, and writes its new place', async () => {
    await index(documentSource());
    const before = new Map((await stored()).map((row) => [row.metadata.index, row.id]));
    const moved = passages(40);
    [moved[3], moved[4]] = [moved[4], moved[3]];
    sent.length = 0;
    const plan = await index(documentSource({ passages: moved }));
    expect(sent).toEqual([]);
    expect(plan.counts).toEqual({ embed: 0, reuse: 40, rewrite: 0, remove: 0 });
    expect(plan.patches.map((patch) => patch.id).sort()).toEqual([before.get(3), before.get(4)].sort());
    const after = new Map((await stored()).map((row) => [row.id, row.metadata.index]));
    expect(after.get(before.get(3) as string)).toBe(4);
    expect(after.get(before.get(4) as string)).toBe(3);
    expect(new Set(after.keys())).toEqual(new Set(before.values()));
  });

  it('keeps the vector of two texts that redact to one input and rewrites the stored text', async () => {
    const input = ['Call Ann on [number] about the budget.'];
    await index(documentSource({ passages: [{ text: 'Call Ann on 555 0101 about the budget.' }] }), input);
    sent.length = 0;
    const plan = await index(documentSource({ passages: [{ text: 'Call Ann on 555 0199 about the budget.' }] }), input);
    expect(sent).toEqual([]);
    expect(plan.counts).toEqual({ embed: 0, reuse: 0, rewrite: 1, remove: 0 });
    expect(await storedTexts()).toEqual(['Call Ann on 555 0199 about the budget.']);
  });

  it('gives a new passage an id that holds nothing of its content', async () => {
    const plan = await index(documentSource());
    for (const row of plan.rows) {
      expect(row.id).toMatch(/^document:d1#[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
    let made = 0;
    const named = await library.planSource(documentSource({ sourceId: 'document:d2' }), {
      embedding: MODEL, inputs: texts(documentSource()), newId: () => `n${++made}`,
    });
    expect(named.rows.map((row) => row.id).slice(0, 2)).toEqual(['document:d2#n1', 'document:d2#n2']);
  });

  it('embeds every passage again for another model', async () => {
    await index(documentSource());
    sent.length = 0;
    const plan = await index(documentSource(), texts(documentSource()), { model: 'other-embed', dimensions: 4 });
    expect(sent).toHaveLength(40);
    expect(plan.counts).toEqual({ embed: 40, reuse: 0, rewrite: 0, remove: 40 });
  });

  it('throws LibraryPlanStale and writes nothing when another writer replaced the source after the plan', async () => {
    await index(documentSource());
    // A plan that reuses no row: every text is new.
    const fresh = documentSource({ passages: passages(40, (n) => `A new passage ${n}.`) });
    const plan = await library.planSource(fresh, { embedding: MODEL, inputs: texts(fresh) });
    expect(plan.counts.reuse).toBe(0);
    await library.indexSource(documentSource());
    const before = await stored();
    await expect(library.applySourcePlan(plan, await embed([...plan.toEmbed]))).rejects.toBeInstanceOf(LibraryPlanStale);
    expect(await stored()).toEqual(before);
  });

  it('throws LibraryPlanStale when another plan changed only the access groups', async () => {
    await index(documentSource());
    const retitled = documentSource({ title: 'Plan, second draft' });
    const first = await library.planSource(retitled, { embedding: MODEL, inputs: texts(retitled) });
    await index(documentSource({ aclGroups: ['acct:ann', 'org:org1'] }));
    const before = await stored();
    await expect(library.applySourcePlan(first, [])).rejects.toBeInstanceOf(LibraryPlanStale);
    expect(await stored()).toEqual(before);
  });

  it('lets one of two plans made from the same rows apply, and the other throw LibraryPlanStale', async () => {
    await index(documentSource());
    const a = await library.planSource(documentSource({ title: 'A' }), { embedding: MODEL, inputs: texts(documentSource()) });
    const b = await library.planSource(documentSource({ title: 'B' }), { embedding: MODEL, inputs: texts(documentSource()) });
    const settled = await Promise.allSettled([library.applySourcePlan(a, []), library.applySourcePlan(b, [])]);
    expect(settled.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    const failed = settled.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason).toBeInstanceOf(LibraryPlanStale);
  });

  it("refuses an embedding size other than the collection's, and a vector of another size", async () => {
    await expect(library.planSource(documentSource(), { embedding: { model: 'test-embed', dimensions: 8 }, inputs: texts(documentSource()) }))
      .rejects.toThrow('4 dimensions, not 8');
    await expect(library.passageVectors(['x'], ANN, { model: 'test-embed', dimensions: 8 })).rejects.toThrow('4 dimensions, not 8');
    const plan = await library.planSource(documentSource({ passages: passages(1) }), { embedding: MODEL, inputs: ['one'] });
    await expect(library.applySourcePlan(plan, [[1, 0, 0]])).rejects.toThrow('3 dimensions, not 4');
    await expect(library.applySourcePlan(plan, [])).rejects.toThrow('different number of vectors');
    await expect(library.planSource(documentSource(), { embedding: MODEL, inputs: ['one'] })).rejects.toThrow('one input for each passage');
  });

  it('reads stored vectors only inside the scope and for the model asked, with both in the store filter', async () => {
    await index(documentSource());
    await index(documentSource({ sourceId: 'document:other', tenantId: 'org2' }));
    const ours = (await stored()).map((row) => row.id);
    const theirs = (await store.listSourcePassages('library', 'document:other')).map((row) => row.id);
    const fetch = vi.spyOn(store, 'fetchVectors');
    const found = await library.passageVectors([...ours, ...theirs], ANN, MODEL);
    expect([...found.keys()].sort()).toEqual([...ours].sort());
    expect(found.get(ours[0])).toEqual(vectorOf(texts(documentSource())[Number((await stored())[0].metadata.index)]));
    const filter = fetch.mock.calls[0][2] as MetadataFilter;
    expect(filter).toMatchObject({
      tenantId: { $eq: 'org1' },
      aclGroups: { $in: ['acct:ann'] },
      status: { $in: ['active'] },
      embedModel: 'test-embed',
      embedDimensions: 4,
    });
    expect((await library.passageVectors(ours, ANN, { model: 'other-embed', dimensions: 4 })).size).toBe(0);
    expect((await library.passageVectors(ours, { tenantId: 'org1', aclGroups: ['acct:bob'] }, MODEL)).size).toBe(0);
  });

  it('embeds every passage and replaces the source on a store that cannot plan by content', async () => {
    const plain: IVectorStore = {
      initialize: async () => {},
      upsert: (collection, documents, options) => store.upsert(collection, documents, options),
      query: (collection, vector, options) => store.query(collection, vector, options),
      delete: (collection, ids, options) => store.delete(collection, ids, options),
      checkHealth: async () => ({ isHealthy: true }),
      shutdown: async () => {},
    };
    library = new LibraryIndex({ store: plain, collection: 'library', embed, dimensions: 4 });
    await index(documentSource());
    sent.length = 0;
    const plan = await index(documentSource());
    expect(plan.digest).toBeNull();
    expect(sent).toHaveLength(40);
    expect(await stored()).toHaveLength(40);
    expect((await library.passageVectors((await stored()).map((row) => row.id), ANN, MODEL)).size).toBe(0);
  });

  it('refuses a newId that gives an id twice, or the id of a stored row', async () => {
    await expect(library.planSource(documentSource({ passages: passages(2) }), { embedding: MODEL, inputs: texts(documentSource({ passages: passages(2) })), newId: () => 'same' }))
      .rejects.toThrow('twice');
    await index(documentSource({ passages: passages(1) }), texts(documentSource({ passages: passages(1) })));
    const [row] = await stored();
    const suffix = row.id.slice('document:d1#'.length);
    const two = documentSource({ passages: passages(2, (n) => `A new passage ${n}.`) });
    await expect(library.planSource(two, { embedding: MODEL, inputs: texts(two), newId: () => suffix })).rejects.toThrow('twice');
  });

  it('refuses to apply a plan that reuses stored rows through an index whose store cannot plan by content', async () => {
    await index(documentSource());
    const edited = documentSource({ passages: passages(40, (n) => (n === 3 ? 'Passage 3 changed.' : undefined)) });
    const plan = await library.planSource(edited, { embedding: MODEL, inputs: texts(edited) });
    const plain: IVectorStore = {
      initialize: async () => {},
      upsert: (collection, documents, options) => store.upsert(collection, documents, options),
      query: (collection, vector, options) => store.query(collection, vector, options),
      delete: (collection, ids, options) => store.delete(collection, ids, options),
      checkHealth: async () => ({ isHealthy: true }),
      shutdown: async () => {},
    };
    const elsewhere = new LibraryIndex({ store: plain, collection: 'library', embed, dimensions: 4 });
    const before = await stored();
    await expect(elsewhere.applySourcePlan(plan, await embed([...plan.toEmbed]))).rejects.toThrow('cannot plan by content');
    expect(await stored()).toEqual(before);
  });

  it('removes a source only once the source lock is free', async () => {
    await index(documentSource());
    let free: () => void = () => {};
    const held = store.withSourceLock('library', 'document:d1', () => new Promise<void>((resolve) => {
      free = resolve;
    }));
    const removed = library.removeSource('document:d1');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await stored()).toHaveLength(40);
    free();
    await held;
    expect(await removed).toBe(40);
    expect(await stored()).toHaveLength(0);
  });

  it('throws LibraryPlanStale when the store patches fewer rows than the plan reuses', async () => {
    await index(documentSource());
    const short = Object.assign(Object.create(store) as InMemoryVectorStore, { patchPassages: async () => ({ updatedCount: 0 }) });
    const shortIndex = new LibraryIndex({ store: short, collection: 'library', embed, dimensions: 4 });
    const retitled = documentSource({ title: 'Plan, second draft' });
    const plan = await shortIndex.planSource(retitled, { embedding: MODEL, inputs: texts(retitled) });
    expect(plan.patches).toHaveLength(40);
    await expect(shortIndex.applySourcePlan(plan, [])).rejects.toBeInstanceOf(LibraryPlanStale);
  });
});
