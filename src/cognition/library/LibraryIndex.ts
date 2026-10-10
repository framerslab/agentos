/**
 * @file LibraryIndex.ts
 * @description A library over any vector store: sources (a kept session, a document) held as units. A source's
 * passages are indexed under a tenant and access groups, the metadata keys scopeToMetadataFilter reads, with a
 * folder, tags and a title; a source is replaced, re-scoped or removed whole; a search names who asks and never
 * runs without a tenant and at least one group.
 *
 * The store's own filter selects what a search reads, and the index checks every passage the store answers against
 * the search's scope and narrowing, so a store whose filter drops or ignores a condition cannot widen a search. A
 * store serves the index fully when it honours these MetadataFilter rules: a plain value and `$eq`; `$in`, which on an
 * array field keeps a passage whose field holds at least one of the values; `$all` on an array field; and
 * DeleteOptions.filter on `delete`. Lexical search needs the store's optional lexicalSearch, a change of scope its
 * optional updateMetadata. PostgresVectorStore honours every rule and has both members; InMemoryVectorStore honours
 * every rule and has neither.
 *
 * @module agentos/cognition/library/LibraryIndex
 */

import type {
  IVectorStore,
  MetadataFilter,
  MetadataScalarValue,
  MetadataValue,
  QueryResult,
  VectorDocument,
} from '../../core/vector-store/IVectorStore.js';
import { reciprocalRankFusion } from '../memory/retrieval/hybrid/reciprocalRankFusion.js';
import { mergeMetadataFilters, scopeToMetadataFilter } from '../rag/scopeFilter.js';

/** Who asks: the tenant, and the groups the principal is in. */
export interface LibraryScope {
  tenantId: string;
  aclGroups: string[];
}

/** One source and its passages. */
export interface LibrarySource {
  /** Unique in the collection, for example `session:<id>`. */
  sourceId: string;
  /** The caller's kind of source, for example `session` or `document`. */
  kind: string;
  tenantId: string;
  /** The groups that may see it; a principal sees it when in at least one. */
  aclGroups: string[];
  folderId?: string | null;
  tags?: string[];
  title?: string;
  /**
   * Copied onto every passage. The keys the index writes come from the fields above alone: a `folderId` or `title`
   * here, or in a passage's own metadata, is dropped.
   */
  metadata?: Record<string, MetadataValue>;
  passages: Array<{ text: string; metadata?: Record<string, MetadataValue> }>;
}

/** A passage found. */
export interface LibraryPassage {
  /** `<sourceId>#<index>`. */
  id: string;
  sourceId: string;
  kind: string;
  index: number;
  text: string;
  /**
   * The store's score for the passage, as the search's mode and the store compute it, read as a number. A hybrid
   * search with `anyOf` on a store with `lexicalSearch` answers the index's fusion of the two legs' ranks instead; on
   * a store without it, that search runs the dense leg alone and answers the store's score.
   */
  score: number;
  title?: string;
  folderId?: string;
  tags: string[];
  metadata: Record<string, MetadataValue>;
}

/** A search. */
export interface LibrarySearch {
  text: string;
  scope: LibraryScope;
  /** `lexical` embeds nothing; `hybrid` fuses both legs where the store can; `dense` is the embedding alone. @default 'hybrid' */
  mode?: 'lexical' | 'hybrid' | 'dense';
  /** The most passages answered. @default 10 */
  topK?: number;
  /** Only these kinds of source; an empty list narrows nothing. */
  kinds?: string[];
  /** Only the sources filed in this folder. */
  folderId?: string;
  /**
   * Only the sources filed in any of these folders; an empty list finds nothing, without a call to the embedder or
   * the store. With `folderId` as well, both apply.
   */
  folderIds?: string[];
  /** Every one of these tags; an empty list narrows nothing. */
  tags?: string[];
  /** Only these sources; an empty list finds nothing, without a call to the embedder or the store. */
  sourceIds?: string[];
  /**
   * Several narrowings at once: a passage is found when any one of them holds. Each is searched with the one
   * embedding of the text under the same scope, a passage found twice kept once, and the answer is ranked as one
   * search's: each leg by the passage's own score across every branch (its similarity to the text, the lexical rank
   * of the text's words in it), the two legs of a hybrid search fused once. A branch's fields replace the search's
   * own of the same name. An empty list finds nothing, as does a list whose every branch finds nothing by its own
   * narrowing, and neither calls the embedder or the store. The legs are the store's `query` and `lexicalSearch`,
   * never its `hybridSearch`; on a store without `lexicalSearch`, a hybrid search is answered by the dense leg alone.
   */
  anyOf?: Array<Pick<LibrarySearch, 'kinds' | 'folderId' | 'folderIds' | 'tags' | 'sourceIds'>>;
  /** For the lexical leg, alone or in a hybrid search: every word or any word (default), and whether a stored word may only begin with a query word. */
  match?: 'all' | 'any';
  prefix?: boolean;
}

/** What the index is made of. */
export interface LibraryIndexOptions {
  store: IVectorStore;
  collection: string;
  /** One vector per text, in order. The caller wires its model, its budget and its deadline. */
  embed: (texts: string[]) => Promise<number[][]>;
  /** How many passages one `embed` call and one upsert carry. @default 64 */
  batchSize?: number;
}

/**
 * Metadata without `folderId` and `title`: like the other keys the index writes, a passage holds them only when the
 * source's own fields set them, so a source indexed without a folder is in none, whatever its metadata or a
 * passage's own says.
 */
function withoutSourceFields(metadata: Record<string, MetadataValue> | undefined): Record<string, MetadataValue> {
  const rest: Record<string, MetadataValue> = { ...(metadata ?? {}) };
  delete rest.folderId;
  delete rest.title;
  return rest;
}

/**
 * A store may report a failed write or delete in its result instead of throwing (InMemoryVectorStore does for a
 * vector of the wrong dimension); the index throws on such a result as on a thrown error.
 */
function throwOnReportedFailure(result: { failedCount?: number; errors?: Array<{ message: string }> }, action: string): void {
  const failed = Math.max(result.failedCount ?? 0, result.errors?.length ?? 0);
  if (failed === 0) return;
  const reason = result.errors?.[0]?.message;
  throw new Error(`LibraryIndex: the store failed to ${action} (${failed} failed)${reason ? `: ${reason}` : '.'}`);
}

/** A metadata value's strings: the value itself when it is a string, an array's strings, or none. */
function stringsOf(value: MetadataValue | undefined): string[] {
  const values: MetadataScalarValue[] = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return values.filter((item): item is string => typeof item === 'string');
}

/**
 * Whether a passage's metadata meets a search's scope and narrowing, the conditions of the filter the store receives:
 * the tenant, the status `active`, at least one of the scope's groups, and each narrowing the search gives.
 */
function meetsSearch(metadata: Record<string, MetadataValue>, query: LibrarySearch): boolean {
  const { scope, kinds, folderId, folderIds, tags, sourceIds } = query;
  const held = (key: string): string[] => stringsOf(metadata[key]);
  return (
    metadata.tenantId === scope.tenantId &&
    held('status').includes('active') &&
    held('aclGroups').some((group) => scope.aclGroups.includes(group)) &&
    (!kinds || kinds.length === 0 || held('kind').some((kind) => kinds.includes(kind))) &&
    (!folderId || held('folderId').includes(folderId)) &&
    (!folderIds || held('folderId').some((id) => folderIds.includes(id))) &&
    (!tags || tags.every((tag) => held('tags').includes(tag))) &&
    (!sourceIds || held('sourceId').some((id) => sourceIds.includes(id)))
  );
}

/**
 * Whether a narrowing finds nothing, whatever the collection holds: an empty `sourceIds` or `folderIds`, or a
 * `folderId` that is not among the `folderIds`. The index answers it without a call to the embedder or the store.
 */
function findsNothing(query: Pick<LibrarySearch, 'folderId' | 'folderIds' | 'sourceIds'>): boolean {
  const { folderId, folderIds, sourceIds } = query;
  if (sourceIds && sourceIds.length === 0) return true;
  if (!folderIds) return false;
  if (folderIds.length === 0) return true;
  return folderId ? !folderIds.includes(folderId) : false;
}

/**
 * A library's sources in one collection of a vector store. Every passage of a source carries the source's tenant,
 * access groups, kind, folder, tags and title in its metadata, so the store's own filter selects who sees it and the
 * index checks what the store answers: `indexSource` replaces a source whole, `setSourceScope` changes who may see it
 * and where it is filed, `removeSource` and `removeTenant` delete, and `search` reads only what its scope may see.
 */
export class LibraryIndex {
  private readonly store: IVectorStore;
  private readonly collection: string;
  private readonly embed: (texts: string[]) => Promise<number[][]>;
  private readonly batchSize: number;

  /** An index over a collection the store already holds; the index makes no collection. */
  constructor(options: LibraryIndexOptions) {
    this.store = options.store;
    this.collection = options.collection;
    this.embed = options.embed;
    this.batchSize = Math.max(1, options.batchSize ?? 64);
  }

  /**
   * Indexes a source, replacing whatever the collection held under its id: the old passages are deleted first, then
   * the new ones are embedded and written `batchSize` at a time. A failed batch leaves the passages written before
   * it, and indexing the source again replaces them. A delete or a write the store reports as failed in its result,
   * instead of throwing, fails the call as well.
   */
  async indexSource(source: LibrarySource): Promise<{ passages: number }> {
    if (!source.tenantId || source.aclGroups.length === 0) {
      throw new Error('LibraryIndex.indexSource needs a tenant and at least one access group.');
    }
    await this.removeSource(source.sourceId);
    const owned: Record<string, MetadataValue> = {
      tenantId: source.tenantId,
      aclGroups: source.aclGroups,
      status: 'active',
      sourceId: source.sourceId,
      kind: source.kind,
      tags: source.tags ?? [],
    };
    if (source.folderId) owned.folderId = source.folderId;
    if (source.title) owned.title = source.title;
    const inherited = withoutSourceFields(source.metadata);
    for (let from = 0; from < source.passages.length; from += this.batchSize) {
      const batch = source.passages.slice(from, from + this.batchSize);
      const vectors = await this.embed(batch.map((passage) => passage.text));
      if (vectors.length !== batch.length) throw new Error('LibraryIndex: the embedder answered a different number of vectors than texts.');
      const documents: VectorDocument[] = batch.map((passage, offset) => ({
        id: `${source.sourceId}#${from + offset}`,
        embedding: vectors[offset],
        textContent: passage.text,
        metadata: { ...withoutSourceFields(passage.metadata), ...inherited, ...owned, index: from + offset },
      }));
      throwOnReportedFailure(await this.store.upsert(this.collection, documents), `write the passages of ${source.sourceId}`);
    }
    return { passages: source.passages.length };
  }

  /**
   * Removes a source's passages and answers the store's `deletedCount`: how many went on a store that counts a delete
   * by filter, as PostgresVectorStore and InMemoryVectorStore do, and the store's own value on one that does not (-1
   * on PineconeVectorStore, 0 on QdrantVectorStore). Throws when the store reports the delete as failed.
   */
  async removeSource(sourceId: string): Promise<number> {
    const result = await this.store.delete(this.collection, undefined, { filter: { sourceId } });
    throwOnReportedFailure(result, `delete the passages of ${sourceId}`);
    return result.deletedCount;
  }

  /**
   * Removes every passage of one tenant and answers the store's `deletedCount`, as `removeSource` does. Throws when
   * the store reports the delete as failed.
   */
  async removeTenant(tenantId: string): Promise<number> {
    const result = await this.store.delete(this.collection, undefined, { filter: { tenantId } });
    throwOnReportedFailure(result, `delete the passages of tenant ${tenantId}`);
    return result.deletedCount;
  }

  /** Changes who may see a source, its folder, its tags or its title; `folderId: null` takes it out of its folder. */
  async setSourceScope(
    sourceId: string,
    change: { aclGroups?: string[]; folderId?: string | null; tags?: string[]; title?: string },
  ): Promise<number> {
    if (typeof this.store.updateMetadata !== 'function') throw new Error('LibraryIndex: the store has no updateMetadata.');
    if (change.aclGroups !== undefined && change.aclGroups.length === 0) {
      throw new Error('LibraryIndex.setSourceScope needs at least one access group.');
    }
    const patch: Record<string, MetadataValue | null> = {};
    if (change.aclGroups !== undefined) patch.aclGroups = change.aclGroups;
    if (change.folderId !== undefined) patch.folderId = change.folderId;
    if (change.tags !== undefined) patch.tags = change.tags;
    if (change.title !== undefined) patch.title = change.title;
    const result = await this.store.updateMetadata(this.collection, { sourceId }, patch);
    return result.updatedCount;
  }

  /**
   * Searches what the scope may see. The store's filter selects the passages, and the index keeps only those whose
   * metadata meets the scope and the narrowing: a store whose filter drops or ignores a condition cannot widen the
   * answer, which can then hold fewer than `topK` passages. With `anyOf`, each narrowing is searched leg by leg under
   * the same scope and the answers are ranked as one search's ({@link LibrarySearch.anyOf}).
   */
  async search(query: LibrarySearch): Promise<LibraryPassage[]> {
    if (!query.scope.tenantId || query.scope.aclGroups.length === 0) {
      throw new Error('LibraryIndex.search needs a tenant and at least one access group.');
    }
    const { anyOf, ...base } = query;
    if (anyOf === undefined) return this.searchWith(query, undefined);
    // A branch narrows and nothing more: the text and the scope stay the search's own, whatever a branch holds at run
    // time. A branch that finds nothing by its own narrowing is left out, so a choice of nothing embeds nothing.
    const branches = anyOf
      .map((branch) => ({ ...base, ...branch, text: base.text, scope: base.scope }))
      .filter((narrowed) => !findsNothing(narrowed));
    if (branches.length === 0) return [];
    const mode = base.mode ?? 'hybrid';
    const topK = base.topK ?? 10;
    const dense = mode !== 'lexical';
    const lexical = mode === 'lexical' || (mode === 'hybrid' && typeof this.store.lexicalSearch === 'function');
    // A hybrid answer's score is a rank among one branch's own candidates, so a choice of several branches is searched
    // leg by leg, each leg's score the passage's own, and the two legs are fused once over every branch.
    const pool = dense && lexical ? topK * 3 : topK;
    const vector = dense ? (await this.embed([base.text]))[0] : undefined;
    const byDense = new Map<string, LibraryPassage>();
    const byLexical = new Map<string, LibraryPassage>();
    for (const narrowed of branches) {
      if (dense) for (const passage of await this.searchWith({ ...narrowed, topK: pool, mode: 'dense' }, vector)) byDense.set(passage.id, passage);
      if (lexical) for (const passage of await this.searchWith({ ...narrowed, topK: pool, mode: 'lexical' }, undefined)) byLexical.set(passage.id, passage);
    }
    const ranked = (found: Map<string, LibraryPassage>): LibraryPassage[] =>
      [...found.values()].sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1)).slice(0, pool);
    if (!lexical) return ranked(byDense).slice(0, topK);
    if (!dense) return ranked(byLexical).slice(0, topK);
    const ranks = (found: Map<string, LibraryPassage>) => ranked(found).map((passage, at) => ({ id: passage.id, rank: at + 1 }));
    return reciprocalRankFusion(ranks(byDense), ranks(byLexical), { denseWeight: 1, sparseWeight: 1, k: 60 })
      .slice(0, topK)
      .flatMap(({ id, score }): LibraryPassage[] => {
        const passage = byDense.get(id) ?? byLexical.get(id);
        return passage === undefined ? [] : [{ ...passage, score }];
      });
  }

  /**
   * One search under one narrowing: the store's filter, then the check of every passage the store answers. `vector`
   * is the text's embedding when the caller holds it already; without it, a dense or hybrid search embeds the text.
   */
  private async searchWith(query: LibrarySearch, vector: number[] | undefined): Promise<LibraryPassage[]> {
    // An empty source or folder list finds nothing on every store, whatever a store's filter makes of an empty `$in`,
    // and so does a folder that is not in the folder list.
    if (findsNothing(query)) return [];
    const narrowed: MetadataFilter = {};
    if (query.kinds && query.kinds.length > 0) narrowed.kind = { $in: query.kinds };
    if (query.folderId) narrowed.folderId = query.folderId;
    // With `folderId` as well, that folder is in the list (findsNothing holds the rest), so it alone narrows.
    if (query.folderIds && !query.folderId) narrowed.folderId = { $in: query.folderIds };
    if (query.tags && query.tags.length > 0) narrowed.tags = { $all: query.tags };
    if (query.sourceIds) narrowed.sourceId = { $in: query.sourceIds };
    const filter = mergeMetadataFilters(narrowed, scopeToMetadataFilter({ tenantId: query.scope.tenantId, aclGroups: query.scope.aclGroups }));
    const options = { topK: query.topK ?? 10, filter, includeMetadata: true, includeTextContent: true };
    const mode = query.mode ?? 'hybrid';
    let result: QueryResult;
    if (mode === 'lexical') {
      if (typeof this.store.lexicalSearch !== 'function') throw new Error('LibraryIndex: the store has no lexicalSearch.');
      result = await this.store.lexicalSearch(this.collection, query.text, { topK: options.topK, match: query.match ?? 'any', prefix: query.prefix === true, includeMetadata: true, includeTextContent: true, filter });
    } else {
      const [embedded] = vector === undefined ? await this.embed([query.text]) : [vector];
      result =
        mode === 'hybrid' && typeof this.store.hybridSearch === 'function'
          ? await this.store.hybridSearch(this.collection, embedded, query.text, { ...options, match: query.match ?? 'any', prefix: query.prefix === true })
          : await this.store.query(this.collection, embedded, options);
    }
    // The store's filter selected these passages. A store whose filter drops or ignores a condition can still answer
    // one outside the scope or the narrowing, so each passage is checked against them again here.
    const allowed = result.documents.filter((doc) => meetsSearch((doc.metadata ?? {}) as Record<string, MetadataValue>, query));
    return allowed.map((doc) => {
      const metadata = (doc.metadata ?? {}) as Record<string, MetadataValue>;
      return {
        id: doc.id,
        sourceId: String(metadata.sourceId ?? ''),
        kind: String(metadata.kind ?? ''),
        index: Number(metadata.index ?? 0),
        text: doc.textContent ?? '',
        // A store can answer a score as numeric text (node-postgres returns a Postgres numeric as a string), so the
        // index reads it as a number.
        score: Number(doc.similarityScore),
        title: typeof metadata.title === 'string' ? metadata.title : undefined,
        folderId: typeof metadata.folderId === 'string' ? metadata.folderId : undefined,
        tags: Array.isArray(metadata.tags) ? metadata.tags.map(String) : [],
        metadata,
      };
    });
  }
}
