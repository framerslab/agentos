---
title: 'SQLite Brain Storage'
sidebar_position: 25
description: 'The brain database behind the Memory facade: its tables (every row keyed by brain id), WAL and FTS5 on SQLite, embedding BLOBs, metadata, export and health.'
---

> A `Memory` brain is a set of tables in one SQL database: a `brain.sqlite` file on SQLite, or a Postgres database through `Memory.createPostgres()`. Every row carries a `brain_id`, so one database can hold several brains.

---

## Overview

The [`Brain`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/store/Brain.ts) class opens the database through a `@framers/sql-storage-adapter` adapter (better-sqlite3, sql.js or IndexedDB for SQLite; `pg` for Postgres), creates the tables, and gives the memory subsystems `run`, `get`, `all`, `exec` and `transaction`.

```ts
import { Memory } from '@framers/agentos';

const mem = await Memory.createSqlite('./brain.sqlite'); // a path you choose
const tmp = await Memory.createSqlite();                  // brain-<random>.sqlite in the OS temp directory
```

`createSqlite()` without a path opens a new file in the temp directory. The brain id defaults to one derived from the file path; pass `brainId` to choose it.

### Design Choices

| Choice | Effect |
|--------|--------|
| One database file on SQLite | No server; the file can be copied and moved |
| WAL journal mode | Set on SQLite when the dialect supports the pragma, so reads continue during writes |
| FTS5 with the `porter ascii` tokenizer | Full-text search with English stemming on SQLite; Postgres uses its own full-text index |
| Embeddings as BLOBs | Float32 vectors stored in the row; no vector database needed |
| JSON text columns | Tags, emotions and metadata as JSON, read with `json_extract` |
| Foreign keys on | Set on SQLite at open |

---

## Tables

`Brain` creates 14 tables and the full-text index. Every table has a `brain_id` column, and the primary keys include it:

| Category | Tables |
|---|---|
| Memory traces | `memory_traces` · `memory_traces_fts` (FTS5 index) |
| Knowledge graph | `knowledge_nodes` · `knowledge_edges` |
| Documents | `documents` · `document_chunks` · `document_images` |
| Conversations | `conversations` · `messages` |
| Maintenance | `consolidation_log` · `retrieval_feedback` |
| Reminders | `prospective_items` |
| Meta and archive | `brain_meta` · `archived_traces` · `archive_access_log` |

### `memory_traces`

```sql
CREATE TABLE IF NOT EXISTS memory_traces (
  brain_id        TEXT    NOT NULL,
  id              TEXT    NOT NULL,
  type            TEXT    NOT NULL,      -- episodic | semantic | procedural | ...
  scope           TEXT    NOT NULL,      -- user | thread | persona | ...
  content         TEXT    NOT NULL,
  embedding       BLOB,                  -- Float32 vector, little-endian
  strength        REAL    NOT NULL DEFAULT 1.0,
  created_at      INTEGER NOT NULL,      -- Unix ms
  last_accessed   INTEGER,               -- Unix ms
  retrieval_count INTEGER NOT NULL DEFAULT 0,
  tags            TEXT    NOT NULL DEFAULT '[]',  -- JSON array
  emotions        TEXT    NOT NULL DEFAULT '{}',  -- JSON
  metadata        TEXT    NOT NULL DEFAULT '{}',  -- JSON: scopeId, entities, decay state, contentHash, ...
  deleted         INTEGER NOT NULL DEFAULT 0,     -- soft delete
  PRIMARY KEY (brain_id, id)
);
```

### `memory_traces_fts`

An FTS5 index over `content` and `tags`, with `memory_traces` as its external content table and the `porter ascii` tokenizer. When the SQLite build has no FTS5 module, the brain opens without the index and `recall()` falls back to `LIKE` matching.

### The other tables

| Table | Holds |
|-------|-------|
| `brain_meta` | Key-value pairs per brain: `schema_version`, `created_at`, `embedding_dimensions` |
| `knowledge_nodes` | Entities: `type`, `label`, JSON `properties`, optional `embedding`, `confidence`, JSON `source` |
| `knowledge_edges` | Typed edges between nodes: `source_id`, `target_id`, `type`, `weight`, `bidirectional`, JSON `metadata` |
| `documents` | Ingested documents: `path`, `format`, `title`, `content_hash`, `chunk_count`, JSON `metadata`, `ingested_at` |
| `document_chunks` | Chunks of a document: `document_id`, `trace_id`, `content`, `chunk_index`, `page_number`, `embedding` |
| `document_images` | Images of a document: `data`, `mime_type`, `caption`, `page_number`, `embedding` (`Memory.ingest()` writes none; JSON import fills it) |
| `consolidation_log` | One row per consolidation run: `ran_at`, `pruned`, `merged`, `derived`, `compacted`, `duration_ms` |
| `retrieval_feedback` | `trace_id`, `signal` (`'used'` or `'ignored'`), `query`, `created_at` |
| `conversations`, `messages` | Conversation rows and their messages (`role`, `content`, JSON `metadata`) |
| `prospective_items` | Reminders: trigger type, time, event or cue, importance, triggered and recurring flags |
| `archived_traces`, `archive_access_log` | Verbatim content kept by the memory archive, and its rehydration log |

The full DDL is in [`Brain.ts`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/store/Brain.ts) and, for the archive tables, [`SqlStorageMemoryArchive.ts`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/archive/SqlStorageMemoryArchive.ts). On Postgres, `INTEGER` columns become `BIGINT`, `BLOB` becomes `BYTEA`, and autoincrement keys become identity columns.

---

## Full-text recall

`Memory.recall(query)` turns the query into an FTS5 query with `buildNaturalLanguageFtsQuery()`: the distinct lower-cased words, without one-letter words and stop words (unless nothing else is left), each as a prefix term, joined with `OR`. `"What are my deploy steps?"` becomes `deploy* OR steps*`. A query with no words returns no results.

Without an active HNSW index, matches are ranked by the trace's `strength` times the absolute FTS rank. With the index active (see [SQL Storage Quickstart](../getting-started/SQL_STORAGE_QUICKSTART.md)), vector and full-text candidates are merged by reciprocal rank fusion. The Porter tokenizer stems both sides, so `deploy` also matches `deployment` and `deployed`.

---

## Embeddings

`remember()` stores the vector from the `embed` function as a BLOB of little-endian Float32 values; rows written as JSON arrays by older versions are still read.

`Memory` calls `brain.checkEmbeddingCompat(dimensions)` at open, with `embeddings.dimensions` or 1536. The first call stores the value under `embedding_dimensions`; a later open with a different value logs a warning and goes on. The facade reads only `dimensions` from `embeddings` (`provider` and `model` are not read) and embeds with the `embed` function.

The brain has no re-embedding method. After a change of embedding model, stored traces keep their old vectors; re-create the brain or re-insert the traces to embed them with the new model.

---

## Export and backup

```ts
await mem.export('./backup.sqlite');        // SQLite copy (format from the extension, or { format: 'sqlite' })
await mem.export('./backup.json');          // JSON
await mem.export('./notes/', { format: 'markdown' });
await mem.export('./vault/', { format: 'obsidian' });
```

On a SQLite brain, the `sqlite` export runs `VACUUM INTO '<path>'`, which writes a compacted copy of the whole file, including every brain it holds, while the source stays open. [`Brain.exportToSqlite(targetPath)`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/store/Brain.ts) writes one brain to a new file and throws when the target exists.

The facade has no backup schedule; a host that wants one calls `export()` from a timer:

```ts
setInterval(async () => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await mem.export(`./backups/brain-${stamp}.sqlite`);
}, 6 * 60 * 60 * 1000);
```

---

## Opening sequence

`Brain.openSqlite(path, { brainId?, priority? })` (and the Postgres and adapter variants):

1. Resolves an adapter (`better-sqlite3`, then `sqljs`, then `indexeddb` by default) and the brain id.
2. Sets WAL journal mode and foreign keys where the dialect supports the pragmas.
3. Runs pending schema migrations.
4. Creates the tables, then the full-text index (skipped when FTS5 is missing).
5. Seeds `brain_meta` with `schema_version` and `created_at` when absent.
6. Repairs the full-text index on SQLite when it is out of step with `memory_traces`.

```ts
import { Brain } from '@framers/agentos';

const brain = await Brain.openSqlite('/path/to/brain.sqlite');
const row = await brain.get('SELECT * FROM memory_traces WHERE brain_id = ? AND id = ?', [brain.brainId, id]);
await brain.setMeta('last_sync', Date.now().toString());
const version = await brain.getMeta('schema_version'); // '2'
await brain.close();
```

---

## Health

```ts
const health = await mem.health();
console.log(health.totalTraces, health.activeTraces, health.avgStrength.toFixed(2));
console.log(health.graphNodes, health.graphEdges, health.documentsIngested, health.lastConsolidation);
```

```ts
interface MemoryHealth {
  totalTraces: number;            // memory_traces rows, deleted ones included
  activeTraces: number;           // rows with deleted = 0
  avgStrength: number;            // of active traces
  weakestTraceStrength: number;   // of active traces
  graphNodes: number;             // knowledge_nodes rows
  graphEdges: number;             // knowledge_edges rows
  lastConsolidation: string | null; // ISO time of the newest consolidation_log row
  tracesPerType: Record<string, number>;
  tracesPerScope: Record<string, number>;
  documentsIngested: number;      // documents rows
}
```

---

## Source Files

| File | Purpose |
|------|---------|
| [`retrieval/store/Brain.ts`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/store/Brain.ts) | Connection, DDL, migrations, meta helpers, export to SQLite |
| [`retrieval/store/migrations/`](https://github.com/framerslab/agentos/tree/master/src/cognition/memory/retrieval/store/migrations) | Schema migrations (`schema_version` 2) |
| [`archive/SqlStorageMemoryArchive.ts`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/archive/SqlStorageMemoryArchive.ts) | Archive tables and the `IMemoryArchive` implementation |
| [`retrieval/store/SqlKnowledgeGraph.ts`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/store/SqlKnowledgeGraph.ts) | `IKnowledgeGraph` over the graph tables |
| [`retrieval/store/SqlMemoryGraph.ts`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/store/SqlMemoryGraph.ts) | `IMemoryGraph` with spreading activation and co-activation edges |
| [`retrieval/store/tracePersistence.ts`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/store/tracePersistence.ts) | FTS query builder, trace metadata and decay-state helpers |
| [`io/SqliteExporter.ts`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/io/SqliteExporter.ts) | `VACUUM INTO` export |

All paths are under `src/cognition/memory/`.
