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
  scope_id        TEXT    NOT NULL DEFAULT '',    -- the scope id, as in metadata.scopeId
  PRIMARY KEY (brain_id, id)
);
```

`scope_id` holds the trace's scope id, the value `metadata.scopeId` holds, and `''` for a trace filed under no scope id. The index `idx_memory_traces_brain_scope_id` covers `(brain_id, scope, scope_id, created_at)`. A database written at schema version 2 gains the column at its first open at version 3, filled from each row's metadata JSON for every brain the table holds; a row whose JSON cannot be read, or names no scope id, keeps `''`. A release older than the column writes `''` whatever scope id the metadata names, to a brain at version 3 as well, where no migration runs again. Every open files the rows of the brain it opens that hold `''` while their metadata names a scope id, reading only the rows whose metadata can name a scope id other than `''`, and every import does the same before its first duplicate check. That read goes through the partial index `idx_memory_traces_unfiled_scope_id` on `(brain_id, id)`, so an open reads none of the traces that hold their scope id. On SQLite the index holds only the rows that hold `''` while their metadata text can name a scope id, so an open reads none of the traces `remember()` filed under no scope id either. On Postgres it holds every row that holds `''`, and the read tests the metadata of each on the server. Postgres can update a row without writing any of the table's indexes (a heap-only update) only when the update changes no column an index reads, and a recall writes the metadata of every trace it returns, so no index of `memory_traces` reads `metadata` there. A row whose metadata text names `scopeId` while its JSON gives no scope id other than `''` keeps `''` and is read again at every open and import. Such a row holds a `null` scope id, a nested `scopeId` key, a `""` written with a space after the colon, or JSON that cannot be read. A row whose metadata holds a `\u` escape and names no scope id stays there too.

The migration that adds the column fills it inside its transaction. On Postgres that transaction holds the table's ACCESS EXCLUSIVE lock until it commits, and every brain's reads and writes of `memory_traces` wait for it; on SQLite it holds the file's write lock, and another connection's write waits for it up to that connection's busy timeout. The migration of a brain whose table already has the column changes nothing: its open builds any index of the column the table lacks and files the brain's traces after the migration commits.

A release before 0.13.159 has no `scope_id` column, and its `Brain.exportToSqlite` and `Brain.importFromSqlite` copy every column they read. Its export of a brain whose table has the column, and its import of a file at schema version 3 into a table without the column, fail naming `scope_id`. A release with the column migrates a database or file at schema version 2 in place at its first open, so keep a copy made before that open for any release before 0.13.159 that must still read it.

`metadata.decay` holds a trace's decay state: `stability` and `reinforcementInterval` in milliseconds, `accessCount`, and `nextReinforcementAt` (Unix ms) once a retrieval has set it. `Memory` writes it at `remember()`, at each recall and at each `feedback()`, the consolidation loop and `memory_merge` merge it, and the store of `CognitiveMemoryManager` writes it at `store()` and at every access ([Access state across restarts](./COGNITIVE_MEMORY.md#access-state-across-restarts)).

### `memory_traces_fts`

An FTS5 index over `content` and `tags`, with `memory_traces` as its external content table and the `porter ascii` tokenizer. When the SQLite build has no FTS5 module, the brain opens without the index and `recall()` falls back to `LIKE` matching.

### The other tables

| Table | Holds |
|-------|-------|
| `brain_meta` | Key-value pairs per brain: `schema_version`, `created_at`, `embedding_dimensions` |
| `knowledge_nodes` | Entities: `type`, `label`, JSON `properties`, optional `embedding`, `confidence`, JSON `source`. Rows of type `memory` are the memory graph's node of each trace (node id: the trace id) and episodic memories; `MemoryStore.store()` records each trace's episodic copy under the node id `trace:<traceId>` ([Deleting traces](./COGNITIVE_MEMORY.md#deleting-traces) says which delete removes which) |
| `knowledge_edges` | Typed edges between nodes: `source_id`, `target_id`, `type`, `weight`, `bidirectional`, JSON `metadata` |
| `documents` | Ingested documents: `path`, `format`, `title`, `content_hash`, `chunk_count`, JSON `metadata`, `ingested_at` |
| `document_chunks` | Chunks of a document: `document_id`, `trace_id`, `content`, `chunk_index`, `page_number`, `embedding` |
| `document_images` | Images of a document: `data`, `mime_type`, `caption`, `page_number`, `embedding` (`Memory.ingest()` writes none; JSON import fills it) |
| `consolidation_log` | One row per consolidation run: `ran_at`, `pruned`, `merged`, `derived`, `compacted`, `duration_ms` |
| `retrieval_feedback` | `trace_id`, `signal` (`'used'` or `'ignored'`), `query`, `created_at` |
| `conversations`, `messages` | Conversation rows and their messages (`role`, `content`, JSON `metadata`) |
| `prospective_items` | Reminders: trigger type, time, event or cue, importance, triggered and recurring flags |
| `archived_traces`, `archive_access_log` | Verbatim content kept by the memory archive, and its rehydration log |

The full DDL is in [`Brain.ts`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/store/Brain.ts) and, for the archive tables, [`SqlStorageMemoryArchive.ts`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/archive/SqlStorageMemoryArchive.ts). On Postgres, `INTEGER` columns become `BIGINT`, `BLOB` becomes `BYTEA`, and autoincrement keys become identity columns. `Memory.createPostgres()` and `Brain.openPostgres()` read `BIGINT` back as numbers, as SQLite returns its integers. A brain on a Postgres adapter you build yourself (`Memory.createWithAdapter()`, `Brain.openWithAdapter()`) reads them the same way only when the adapter is opened with `typeParsers: { int8: 'number' }` (`createPostgresAdapter` from `@framers/sql-storage-adapter`); with pg's default, a trace's retrieval count and times load as strings.

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

## Deleting and restoring traces

`Memory.deleteScope(scope, scopeId, { turnUserId? })` and `Memory.deleteTraces(traceIds)` delete traces for good. The rows that name a trace go first, as the foreign keys require: its `retrieval_feedback` rows are deleted, and a `document_chunks` row it was filed from lets go of it (`trace_id` set to NULL) and keeps its text, which belongs to its document. Then the trace's row goes, with its memory-graph node and that node's edges, whichever facade on the Brain wrote them, a relation a host made to the node (`addRelation`) included, and its knowledge-graph copy. On SQLite the full-text index is rebuilt from the rows that remain. `deleteScope` takes every row filed under the scope (`scope_id`), soft-deleted rows included, and every knowledge-graph copy filed under it; with `turnUserId` it takes only the rows whose metadata names that user (`metadata.turnUserId`: a second user's trace on another user's session) and leaves the scope's other rows and copies. Before it reads, it files the brain's rows that hold `''` while their metadata names a scope id, as an open does, so a row a release older than the column wrote after the facade opened goes too. An empty scope id or `turnUserId` is refused with a `TypeError`, so a caller's missing id never deletes the traces filed under no scope id or widens a user's delete to the whole scope. Both return `{ deleted }`, the number of rows deleted, so a call made again counts none. A cognitive `MemoryStore` over the same Brain stops recalling a deleted trace at its next read of the rows, and its cache keeps the trace's words until its own `deleteScope` or `deleteTraces` runs.

`Memory.restoreTrace(traceId, snapshot)` writes back the row a snapshot holds, live again: content, tags, scope, scope id and metadata. `readTraceSnapshot(brain, brainId, traceId)` in `tracePersistence.ts` reads one, every column but the embedding, with the form the brain's scope ids hold when it reads (`scopeIdForm`: `'encoded'` once a learning layer re-filed the brain, else `'plain'`). A snapshot read before the re-file is written under the encoded id, as the re-file wrote the row, since in a re-filed brain the plain form of an id that holds a `/` names a namespaced user (`team/ana` is user `ana` of namespace `team`); on Postgres the restore reads the brain's record under the lock a re-file takes. A row that still holds the snapshot's content keeps its embedding, so a `forget` taken back is recalled as before; a row that holds other content is written with no embedding, and the trace gets one when it is next written. The full-text index follows the restored words: SQLite rebuilds it, and Postgres re-indexes the restored row alone. A restore writes the row only, so a trace deleted for good gets back its row, not the memory-graph node or the HNSW entry its delete removed. `Memory.brainId` names the brain the facade reads and writes.

`remember(content, { metadata })` merges extra keys into the trace's stored metadata, under the keys the facade sets itself (`scopeId`, `content_hash`, `entities`, `decay`), which win. A trace whose metadata names a `turnUserId` is no duplicate of the same words filed under the same scope with another `turnUserId` or none: each user's words stay a trace of their own, so a delete of one user's traces leaves the other's.

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
5. Files the brain's traces that hold `scope_id` `''` while their metadata names a scope id, the rows a release older than the column wrote.
6. Seeds `brain_meta` with `schema_version` and `created_at` when absent.
7. Repairs the full-text index on SQLite when it is out of step with `memory_traces`.

```ts
import { Brain } from '@framers/agentos';

const brain = await Brain.openSqlite('/path/to/brain.sqlite');
const row = await brain.get('SELECT * FROM memory_traces WHERE brain_id = ? AND id = ?', [brain.brainId, id]);
await brain.setMeta('last_sync', Date.now().toString());
const version = await brain.getMeta('schema_version'); // '3'
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

Every count is of the brain's own rows, a number on SQLite and Postgres alike; another brain in the same database is not counted.

---

## Source Files

| File | Purpose |
|------|---------|
| [`retrieval/store/Brain.ts`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/store/Brain.ts) | Connection, DDL, migrations, meta helpers, export to SQLite |
| [`retrieval/store/migrations/`](https://github.com/framerslab/agentos/tree/master/src/cognition/memory/retrieval/store/migrations) | Schema migrations (`schema_version` 3) |
| [`archive/SqlStorageMemoryArchive.ts`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/archive/SqlStorageMemoryArchive.ts) | Archive tables and the `IMemoryArchive` implementation |
| [`retrieval/store/SqlKnowledgeGraph.ts`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/store/SqlKnowledgeGraph.ts) | `IKnowledgeGraph` over the graph tables |
| [`retrieval/store/SqlMemoryGraph.ts`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/store/SqlMemoryGraph.ts) | `IMemoryGraph` with spreading activation and co-activation edges |
| [`retrieval/store/tracePersistence.ts`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/store/tracePersistence.ts) | FTS query builder, trace metadata and decay-state helpers |
| [`io/SqliteExporter.ts`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/io/SqliteExporter.ts) | `VACUUM INTO` export |

All paths are under `src/cognition/memory/`.
