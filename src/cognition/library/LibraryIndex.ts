/**
 * @file LibraryIndex.ts
 * @description A library over any vector store: sources (a kept session, a document) held as units. A source's
 * passages are indexed under a tenant and access groups, the metadata keys scopeToMetadataFilter reads, with a
 * folder, tags and a title; a source is replaced, re-scoped or removed whole; a search names who asks and never
 * runs without a tenant and at least one group.
 *
 * The store must honour DeleteOptions.filter. Lexical search needs the store's optional lexicalSearch, a change of
 * scope its optional updateMetadata; PostgresVectorStore has both.
 *
 * @module agentos/cognition/library/LibraryIndex
 */

import type {
  IVectorStore,
  MetadataFilter,
  MetadataValue,
  QueryResult,
  VectorDocument,
} from '../../core/vector-store/IVectorStore.js';
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
  /** The store's score for the passage, as the search's mode and the store compute it, read as a number. */
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
  /** Every one of these tags; an empty list narrows nothing. */
  tags?: string[];
  /** Only these sources; an empty list finds nothing. */
  sourceIds?: string[];
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
 * A library's sources in one collection of a vector store. Every passage of a source carries the source's tenant,
 * access groups, kind, folder, tags and title in its metadata, so the store's own filter decides who sees it:
 * `indexSource` replaces a source whole, `setSourceScope` changes who may see it and where it is filed,
 * `removeSource` and `removeTenant` delete, and `search` reads only what its scope may see.
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
   * it, and indexing the source again replaces them.
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
      await this.store.upsert(this.collection, documents);
    }
    return { passages: source.passages.length };
  }

  /** Removes a source's passages; answers how many went. */
  async removeSource(sourceId: string): Promise<number> {
    const result = await this.store.delete(this.collection, undefined, { filter: { sourceId } });
    return result.deletedCount;
  }

  /** Removes everything of one tenant. */
  async removeTenant(tenantId: string): Promise<number> {
    const result = await this.store.delete(this.collection, undefined, { filter: { tenantId } });
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

  /** Searches what the scope may see. */
  async search(query: LibrarySearch): Promise<LibraryPassage[]> {
    if (!query.scope.tenantId || query.scope.aclGroups.length === 0) {
      throw new Error('LibraryIndex.search needs a tenant and at least one access group.');
    }
    const narrowed: MetadataFilter = {};
    if (query.kinds && query.kinds.length > 0) narrowed.kind = { $in: query.kinds };
    if (query.folderId) narrowed.folderId = query.folderId;
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
      const [vector] = await this.embed([query.text]);
      result =
        mode === 'hybrid' && typeof this.store.hybridSearch === 'function'
          ? await this.store.hybridSearch(this.collection, vector, query.text, { ...options, match: query.match ?? 'any', prefix: query.prefix === true })
          : await this.store.query(this.collection, vector, options);
    }
    return result.documents.map((doc) => {
      const metadata = (doc.metadata ?? {}) as Record<string, MetadataValue>;
      return {
        id: doc.id,
        sourceId: String(metadata.sourceId ?? ''),
        kind: String(metadata.kind ?? ''),
        index: Number(metadata.index ?? 0),
        text: doc.textContent ?? '',
        // A store may answer a score as numeric text: PostgresVectorStore's hybrid search fuses its legs into a
        // Postgres numeric, which node-postgres reads as a string.
        score: Number(doc.similarityScore),
        title: typeof metadata.title === 'string' ? metadata.title : undefined,
        folderId: typeof metadata.folderId === 'string' ? metadata.folderId : undefined,
        tags: Array.isArray(metadata.tags) ? metadata.tags.map(String) : [],
        metadata,
      };
    });
  }
}
