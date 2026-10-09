---
title: 'Incremental Vector Ingestion'
sidebar_position: 7
description: 'Keep a raw IVectorStore collection in sync with content-hash caching: skip unchanged chunks, re-embed only what changed, and re-run the same ingest as often as you like for near-zero cost. The lower-level path beneath Memory.ingest().'
---

> `Memory.ingest()` builds a full cognitive-memory brain (traces, FTS5, knowledge graph, decay). When you want a plain searchable vector collection instead, doc citations, a help index, a product knowledge base, drive [`IVectorStore`](https://github.com/framerslab/agentos/blob/master/src/core/vector-store/IVectorStore.ts) directly and add a content-hash check so re-ingesting a corpus only embeds what actually changed.

---

## When to use this

Two ingestion paths sit at different levels of the stack:

| Path | Builds | Use when |
|------|--------|----------|
| [`Memory.ingest()`](./MEMORY_DOCUMENT_INGESTION.md) | A cognitive-memory brain: traces, FTS5, knowledge graph, decay | You want agent memory with recall, consolidation, and forgetting |
| **[`IVectorStore`](https://github.com/framerslab/agentos/blob/master/src/core/vector-store/IVectorStore.ts) + content hash** (this page) | A flat collection you own: `{ id, embedding, metadata, textContent }` | You want a plain RAG index for citations, search, or a knowledge base |

The flat path is what powers, for example, an in-app documentation assistant: one collection of doc chunks, queried per turn, cited back to the source. No traces, no decay, no graph. Embeddings, metadata, and similarity.

The cost concern with the flat path is embeddings, which are billed per token. Re-ingesting a 5,000-chunk corpus on every docs change would re-embed all 5,000 chunks even when one file moved. A content hash on each chunk removes that waste.

---

## Wiring it up

The recipe below takes a `store` and an `embed` function so it stays backend-agnostic and unit-testable. A typical server-side wiring uses Postgres and OpenAI:

```ts
import { PostgresVectorStore } from '@framers/agentos/cognition/rag';
import OpenAI from 'openai';

const store = new PostgresVectorStore({
  id: 'docs-store',
  type: 'postgres',
  connectionString: process.env.DATABASE_URL,
  defaultDimension: 1536,
  similarityMetric: 'cosine',
});
await store.initialize();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const embed = async (texts: string[]): Promise<number[][]> => {
  const res = await openai.embeddings.create({ model: 'text-embedding-3-small', input: texts });
  return res.data.map((d) => d.embedding);
};
```

---

## The recipe

Hash each chunk by the content that matters, look up the existing rows by id, and only embed the chunks whose hash changed:

```ts
import { createHash } from 'node:crypto';
import type { IVectorStore, VectorDocument } from '@framers/agentos/cognition/rag';

interface Chunk {
  id: string;        // stable across runs, e.g. `${source}#${index}`
  text: string;
  source: string;
  title: string;
}

interface IngestResult {
  inserted: number;
  updated: number;
  skipped: number;
}

const hashChunk = (c: Chunk): string =>
  createHash('sha256').update(`${c.source}::${c.text}`).digest('hex');

export async function ingestChunks(
  store: IVectorStore,
  collection: string,
  chunks: Chunk[],
  embed: (texts: string[]) => Promise<number[][]>,
  dimension: number,
): Promise<IngestResult> {
  // CREATE TABLE IF NOT EXISTS underneath. Safe to call on every run.
  await store.createCollection?.(collection, dimension, { similarityMetric: 'cosine' });

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (let i = 0; i < chunks.length; i += 256) {
    const batch = chunks.slice(i, i + 256);
    const hashes = batch.map(hashChunk);

    // Read the existing rows by primary key, metadata only (no vectors, no text).
    const existing = store.fetchByIds
      ? await store.fetchByIds(collection, batch.map((c) => c.id), {
          includeMetadata: true,
          includeTextContent: false,
        })
      : [];
    const priorHash = new Map(
      existing.map((row) => [row.id, String(row.metadata?.content_hash ?? '')]),
    );

    // Only the chunks whose hash changed (or are brand new) get embedded.
    const stale = batch.filter((c, j) => priorHash.get(c.id) !== hashes[j]);
    skipped += batch.length - stale.length;
    if (stale.length === 0) continue;

    const vectors = await embed(stale.map((c) => c.text));

    const docs: VectorDocument[] = stale.map((c, j) => {
      if (priorHash.has(c.id)) updated += 1;
      else inserted += 1;
      return {
        id: c.id,
        embedding: vectors[j],
        textContent: c.text,
        metadata: {
          source: c.source,
          title: c.title,
          content_hash: hashChunk(c),
        },
      };
    });

    await store.upsert(collection, docs);
  }

  return { inserted, updated, skipped };
}
```

The first run embeds the whole corpus. Every run after only embeds the deltas. A run with no changes makes **zero embedding calls** and returns `{ inserted: 0, updated: 0, skipped: N }`.

---

## How the skip works

- The `id` is the primary key and must be stable across runs. Use something deterministic like `${source}#${chunkIndex}` so a chunk keeps its id when its neighbours change.
- `content_hash` rides in the document's `metadata`, so it round-trips through the store with no extra table. `fetchByIds(..., { includeMetadata: true, includeTextContent: false })` reads the hash back without pulling the large vectors or text.
- Hash the content that actually affects the embedding. Hashing `source::text` re-embeds a chunk when its text is edited, but a metadata-only change (a new title) leaves the embedding alone. Add a field to the hash input only when a change to it should force a re-embed.
- `upsert` is insert-or-replace by `id`, so a changed chunk overwrites its prior row and embedding in place.

`metadata` values are `string | number | boolean` or arrays of those. `null` is not allowed, so store `''` for an absent field rather than `null`.

---

## Methods used

| Method | Role in the loop |
|--------|------------------|
| `createCollection(name, dim, { similarityMetric })` | Idempotent collection setup. Optional on the interface; backends that auto-create can skip it. |
| `fetchByIds(name, ids, { includeMetadata })` | Primary-key read of existing rows to compare hashes. |
| `upsert(name, documents)` | Insert-or-replace the changed and new chunks by id. |
| `query(name, queryEmbedding, { topK, filter })` | Retrieval at read time (see below). |

The skip depends on `fetchByIds`, an optional method. A store that does not implement it cannot do the skip, and the recipe embeds everything every run. Among the bundled stores only [`PostgresVectorStore`](https://github.com/framerslab/agentos/blob/master/src/cognition/rag/vector_stores/PostgresVectorStore.ts) implements it; the in-memory, SQL, HNSW, Qdrant, Neo4j and Pinecone stores do not.

---

## Querying what you ingested

```ts
const [queryVec] = await embed([userQuestion]);
const { documents } = await store.query(collection, queryVec, {
  topK: 6,
  includeTextContent: true,
  filter: { source: { $eq: 'guide.md' } }, // optional metadata filter
});
```

For keyword and vector retrieval in one call, use `hybridSearch` where the backend supports it (Postgres exposes a tsvector full-text column), and [HyDE](./HYDE_RETRIEVAL.md) to rewrite the question into a hypothetical answer before embedding. See [RAG Memory Configuration](./RAG_MEMORY_CONFIGURATION.md) for the retrieval and reranking surface.

---

## Picking a backend

The recipe is backend-agnostic: it only calls interface methods. Choose the store by deployment shape:

- [Postgres + pgvector](./POSTGRES_BACKEND.md): HNSW index, tsvector FTS, `fetchByIds`. The default for a server-side corpus.
- [Pinecone](./PINECONE_BACKEND.md): managed, for large or multi-region indexes.
- In-memory: tests and small static corpora, no persistence; it has no `fetchByIds`, so every run re-embeds.

---

## When to reach for `Memory.ingest()` instead

When you want agent memory rather than a static index, with traces that decay and a brain you can consolidate, use the [Document Ingestion](./MEMORY_DOCUMENT_INGESTION.md) pipeline. It skips content it has already stored (by content hash), loads PDF, DOCX, HTML and Markdown files (CSV, JSON and YAML as plain text) and URLs, chunks the text, and scans folders with glob filters. It stores chunks as full-text-indexed traces without embeddings. The flat-collection recipe on this page is for when you do not want a brain behind your vectors.

---

## Source Files

| File | Purpose |
|------|---------|
| `core/vector-store/IVectorStore.ts` | The interface: `createCollection`, `upsert`, `fetchByIds`, `query`, `delete`. |
| `cognition/rag/vector_stores/PostgresVectorStore.ts` | pgvector backend with HNSW index, tsvector FTS, and `fetchByIds`. |
| `cognition/rag/vector_stores/InMemoryVectorStore.ts` | In-process backend for tests and small corpora (no `fetchByIds`). |

---

## Related

- [Document Ingestion](./MEMORY_DOCUMENT_INGESTION.md): the cognitive-memory ingest path with the same content-hash idempotency.
- [Postgres + pgvector Backend](./POSTGRES_BACKEND.md): the store this recipe usually runs on.
- [RAG Memory Configuration](./RAG_MEMORY_CONFIGURATION.md): retrieval, reranking, and hybrid search.
- [HyDE Retrieval](./HYDE_RETRIEVAL.md): query rewriting for better recall.
