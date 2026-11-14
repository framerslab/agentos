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

`Brain` creates 16 tables and the full-text index. Every table has a `brain_id` column, and the primary keys include it:

| Category | Tables |
|---|---|
| Memory traces | `memory_traces` · `memory_traces_fts` (FTS5 index) |
| Conversation scopes | `memory_scopes` · `memory_pages` |
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

## Conversation scopes

The `'conversation'` scope holds what was said between one agent and one subject: a named user, a session that names no user, or the operator's own pages. A trace of the scope is filed under a key that `conversationScopeKey(agentId, subject)` builds:

| Subject | Call | Key |
|---|---|---|
| The user `bob` | `conversationScopeKey('aria', { kind: 'user', id: 'bob' })` | `c1:u:4:aria:3:bob;` |
| The session `bob` | `conversationScopeKey('aria', { kind: 'session', id: 'bob' })` | `c1:s:4:aria:3:bob;` |
| The operator | `conversationScopeKey('aria', { kind: 'operator' })` | `c1:o:4:aria:0:;` |

The form is `c1:<k>:<n>:<agentId>:<m>:<subjectId>;`. `c1` is the key's version, `<k>` is `u`, `s` or `o`, `<n>` and `<m>` are the lengths of the two ids in UTF-16 code units, and `;` closes the key. The ids are kept as given, with no encoding, case folding or Unicode normalisation, so `Alice` and `alice` are two subjects, and a user and a session of one id are two subjects. The lengths give every pair of ids one key, and no key is the start of another, whatever characters the ids hold. `parseConversationScopeKey(key)` returns `{ agentId, subject }` for a key the encoder wrote and `undefined` for any other string. An empty agent id, user id or session id is refused with a `TypeError`, and so is an id that holds a lone surrogate (half of a UTF-16 surrogate pair with no other half): the store writes text as UTF-8, where a lone surrogate becomes U+FFFD, so `'m\uD800'` would be stored, and matched, as `'m�'`, another subject. An id that holds a NUL is refused the same way, since Postgres stores no NUL in text. `parseConversationScopeKey` reads a string that holds either as no key, so `remember()` and `UserWikiStore` refuse it too.

A key is matched by equality only. `recall(query, { scope, scopeId })` and `recentTraces(sinceMs, { scope, scopeId })` select the scope id on the `scope_id` column, which the index `idx_memory_traces_brain_scope_id` serves, never by a prefix or a pattern and never by the metadata JSON.

`remember(content, { scope: 'conversation', scopeId })` refuses a scope id that is not such a key with a `TypeError` and stores nothing. The input schemas of the model-facing tools `memory_add` and `memory_search` do not list the scope.

The scope is read one key at a time, never as a whole:

- `recall(query, { scope: 'conversation' })` and `recentTraces(sinceMs, { scope: 'conversation' })` with no `scopeId` throw a `TypeError`.
- `recall(query)` and `recentTraces(sinceMs)` with no scope and no scope id read the whole brain, every subject's conversation traces among them. That is the host's own read of its store, as a SQL query of it would be; no turn, tool or prompt of a souled agent makes it. Pass the scope and a key to read one subject.
- `memory_search` (from `Memory.createTools()`) reads no trace of the scope, whatever its arguments, and answers a search that names the scope with an error result. The tool knows no subject; conversation memory is recalled by the runtime for the subject a turn serves.
- `Memory.consolidate()` and `memory_reflect` run the consolidation loop over every other scope: no conversation trace is pruned, merged with another, promoted or quoted into a derived insight. Each subject's traces are consolidated by the wiki compile, one scope at a time.
- A trace tagged `wiki` (a chunk of a wiki page) and one that is not are never duplicates of each other, so a message with the text of one of its scope's page chunks is stored as a trace of its own.

### `memory_scopes`

```sql
CREATE TABLE IF NOT EXISTS memory_scopes (
  brain_id        TEXT   NOT NULL,
  scope           TEXT   NOT NULL,   -- 'conversation'
  scope_id        TEXT   NOT NULL,   -- the key conversationScopeKey() built
  kind            TEXT   NOT NULL,   -- user | session | operator, read from the key
  agent_id        TEXT   NOT NULL,   -- the agent id, read from the key
  created_at      BIGINT NOT NULL,   -- Unix ms: the scope's first trace
  compiled_at     BIGINT,            -- Unix ms: the scope's last wiki compile; NULL before the first
  rebuild_sources TEXT,              -- a JSON array of trace ids the next compile reads by id, or NULL
  PRIMARY KEY (brain_id, scope, scope_id)
);
```

Each conversation scope has one row, written with the scope's first trace: in one transaction with the trace where the adapter has transactions, and before the trace where it has none. So `remember()` never stores a conversation trace under a scope the table does not name, and a subject's scopes are found by their rows without reading the traces. A scope of any other kind (`user`, `thread`, `persona`, `organization`) has no row.

`Memory.listScopes({ kind? })` returns the rows by scope id as `{ scopeId, kind, agentId, createdAt, compiledAt }`. An open, and an import that wrote traces, register each conversation scope that holds traces under a key and has no row, with the time of its oldest trace as `created_at`; traces filed under the scope with an id that is no key get no row. `Memory.deleteScope('conversation', key)` deletes the scope's row after its traces, unless the scope still holds a page row: the registry goes on naming a scope while any of its data remains.

`rebuild_sources` names the traces a deleted page is to be built again from: `Memory.addRebuildSources(scopeId, traceIds)` adds ids to the list, each once (a retention sweep with `pages: 'rebuild'`, a correction, and a person's deletion for another subject's page built from what the person said do), the scope's next compile reads the live ones by id beside the traces after its watermark, each trace once and oldest first, and clears the list once they have compiled. A scope whose list is not NULL has work for a compile even with no new trace.

`compiled_at` is the scope's wiki-compile watermark. `Memory.compileWiki({ reason?, scopes? })` compiles one user or session scope at a time, each into its own page store (`AttachedWiki.storeFor(scopeId)`): it reads the scope's traces stored after the watermark, oldest first, leaves out the scope's own page chunks, hands the rest to the compiler, and moves the watermark to the newest trace it read. A batch (500 traces) never ends inside a millisecond: the traces of the millisecond a batch would cut wait for the next one, and a millisecond more traces share than a batch holds is read whole. The read stops below a trace any facade of the same store in this process (one Brain coordination token) has stamped and is still storing (its embedding being made, say), and a conversation trace is stamped after the last compile read, so the watermark never passes a trace stored after the read. Before it moves, the watermark is checked against the store: a trace stored meanwhile under a time the batch spans (by an import, or a writer in another process) holds it just before that trace, and the watermark moves only from the value the compile started from, so an import that moved it back keeps its value. Page writes of one scope are ordered across the facades of one store in this process the same way. With no `scopes` it takes every user or session scope that holds a trace newer than its watermark; the operator's scope is never compiled. A scope whose compile throws keeps its watermark, and the other scopes go on: when the wiki's `compileSkipReasonOf(error)` names a reason (a spend budget's refusal is `'budget'`) the scope is skipped, and any other error is thrown once every scope has run. The wiki's `beforeScopeCompile(scopeId, traces)` can skip a scope or change the traces it compiles. Each reason a scope was skipped for is logged once a call as `memory.compile_skipped`, with no scope in the line.

### `memory_legacy_owner`

```sql
CREATE TABLE IF NOT EXISTS memory_legacy_owner (
  brain_id      TEXT   NOT NULL,
  agent_id      TEXT   NOT NULL,
  owner_key     TEXT   NOT NULL,   -- the conversation key of the user the agent's older memory is attributed to
  attributed_at BIGINT NOT NULL,   -- Unix ms
  PRIMARY KEY (brain_id, agent_id)
);
```

One row an agent at most: the user a souled agent's `legacyMemory` attributed the memory from before per-user scope to (`Memory.legacyOwner`, `setLegacyOwner`, `clearLegacyOwner`). The row is written once and never moved; that user's deletion removes it once the attributed memory is gone. The `sqlite` and `json` exports carry it (the JSON as `legacyOwners`), and their imports bring it back, so a restored store neither withholds that memory again nor keeps it from its owner's deletion: an owner comes in for an agent the brain records no owner of, an owner the brain records is never moved, and `Brain.importFromSqlite(file, { strategy: 'replace' })` keeps none the file lacks. The Markdown and Obsidian exports do not carry it.

### `memory_pages`

```sql
CREATE TABLE IF NOT EXISTS memory_pages (
  brain_id     TEXT   NOT NULL,
  scope        TEXT   NOT NULL,   -- 'conversation'
  scope_id     TEXT   NOT NULL,   -- the subject's key, kept as given
  page_id      TEXT   NOT NULL,   -- e.g. concepts/notes
  content      TEXT   NOT NULL,   -- the page: front matter (summary, updated, sources), then the body
  content_hash TEXT   NOT NULL,   -- SHA-256 of the body, hex
  chunk_ids    TEXT   NOT NULL,   -- JSON array: the ids of the page's chunks in memory_traces
  updated_at   BIGINT NOT NULL,   -- Unix ms
  PRIMARY KEY (brain_id, scope, scope_id, page_id)
);
```

A wiki page that belongs to one subject (a user, or a session) is a row here, never a file: two subjects' pages of one id are two rows, and each is read by its subject's key alone. `UserWikiStore`, built with `{ scopeId, pages: memory, chunk }`, reads and writes one subject's pages over the facade's row members:

| Member | Does |
|---|---|
| `Memory.readPageRow(scopeId, pageId)` | Returns the row as `{ pageId, content, contentHash, chunkIds, updatedAt }`, or `null` |
| `Memory.listPageRows(scopeId)` | Returns the scope's rows by page id |
| `Memory.writePageRow(scopeId, { pageId, content, contentHash, chunks?, keepChunksIfUnchanged? })` | Writes the row. With `chunks`, files each chunk as a trace under the scope's key with the tags `wiki` and `page:<id>`, lists the new chunk ids in the row, and deletes the page's old chunks for good; without, replaces the content and keeps the chunks. With `chunks` and `keepChunksIfUnchanged`, a stored row whose `contentHash` is the one given keeps its chunks |
| `Memory.reindexPageRow(scopeId, pageId, chunksOf)` | Files the page's chunks again from the text its row holds when the write runs (`chunksOf(content)`), keeps that text, and deletes the old chunks for good; returns `{ chunkIds, removed }`, or `null` when the scope holds no such page or `chunksOf` answers `null` |
| `Memory.deletePageRows(scopeId, pageId?)` | Deletes one page row or every page row of the scope, the chunks first, for good; returns `{ pages, chunks }` |

`writePageRow` writes the scope's registry row, the new chunks, the page row and the delete of the old chunks in one transaction where the adapter has them, so a write that fails leaves the page and its chunks as they were. Where the adapter has none, the statements run in that order, and the row never lists a chunk that is not stored. `writePageRow` and `deletePageRows` take the key of a user or of a session and refuse any other scope id with a `TypeError`; every member refuses a page id that is not a wiki page id (`isWikiPageId`). `UserWikiStore.writePage(page)` keeps the chunks of a page whose body did not change, compared with the row inside the write itself (`keepChunksIfUnchanged`), after the scope's earlier page writes on the facade have settled, so a write made while another one changes the page never keeps chunks of a body the row no longer holds; and `UserWikiStore.deleteAll()` deletes one subject's pages and chunks and nothing else. `Memory.deleteScope('conversation', key)` deletes the scope's traces, the chunks of its pages among them, and leaves the page rows and, while one remains, the scope's registry row: delete a subject's pages with `deleteAll()` first. A message stored under the scope while the call runs keeps the registry row too, and `remember` writes the row again once its trace is in, so no trace is left under a scope the registry does not name.

A facade makes the page writes and page deletes of one scope one after the other, so two writes of one page made at once leave the chunks of the page that is kept and no other's. Each write also replaces the row only while it holds the text and the chunk list the write read: when a writer in another process changed the row meanwhile, the write's statements are rolled back (where the adapter has no transaction, its new chunks are deleted) and it reads the row again and starts over, up to five times, after which it throws and keeps nothing. A writer's chunks are therefore never left unlisted by a row another writer replaced. `UserWikiStore.index({ force: true })` goes through `reindexPageRow`, so a page another write changed after the listing (its body, its summary or its sources) is chunked as that write left it, never written back as it was listed.

A compile of a scope, `deleteScope('conversation', key)` and `deletePageRows(key)` run one after the other across the facades of one store in this process: a delete made while the scope's compile runs waits for it and then finds the page it wrote, and a compile made while a delete runs waits for it and finds no deleted trace. Delete an account's pages and then its traces (`deleteAll()`, then `deleteScope`), and a compile that was running leaves nothing of them. `Memory.waitForScopeChanges(key)` resolves once the compiles and deletes of the scope started before it have settled, and runs nothing itself. Other processes are not ordered by it: give one process the compile of a store.

Both tables' columns are `TEXT` and `BIGINT`, so SQLite and Postgres hold them alike. SQLite compares a key byte for byte. Postgres compares it under the column's collation: a [deterministic collation](https://www.postgresql.org/docs/current/collation.html#COLLATION-NONDETERMINISTIC), which every predefined collation is, holds two strings equal only when their bytes are, so leave these columns on the database's default collation and give them no nondeterministic one.

---

## Deleting and restoring traces

`Memory.deleteScope(scope, scopeId, { turnUserId? })` and `Memory.deleteTraces(traceIds)` delete traces for good. The rows that name a trace go first, as the foreign keys require: its `retrieval_feedback` rows are deleted, and a `document_chunks` row it was filed from lets go of it (`trace_id` set to NULL) and keeps its text, which belongs to its document. Pass `{ documentChunks: 'delete' }` to `deleteTraces` to delete those chunks with their text, the pictures of those chunks and each document left with no chunk; a person's deletion and the retention sweep do. On an adapter with transactions those deletes share one, so a failure among them deletes none of them and a later call finds them again. `deleteScope` takes no such option: to delete a scope with its document chunks, delete its traces first (`Memory.tracesStoredBefore(scope, scopeId, beforeMs)` lists the ids of a scope's traces stored before a time, soft-deleted rows included and a wiki page's chunks left out), then the scope. The trace's knowledge-graph copy goes before its row: a graph that cannot delete the copies fails the call with every row kept, so a later call deletes them. Then the trace's row goes, with its memory-graph node and that node's edges, whichever facade on the Brain wrote them, a relation a host made to the node (`addRelation`) included. On SQLite the full-text index is rebuilt from the rows that remain; until a rebuild succeeds the index keeps the words of the deleted rows, so a rebuild that fails stays owed and `Memory.finishFullTextIndex()` runs it again (`{ fullText: 'rebuilt' | 'not owed' }`, and it throws what the rebuild throws). A person's deletion calls it once its deletes are done and names a rebuild that failed as `full-text index`, not reached, with `complete: false`. `deleteScope` takes every row filed under the scope (`scope_id`), soft-deleted rows included, and every knowledge-graph copy filed under it, a copy whose trace is already gone included (a graph that cannot delete those fails the call too, once the rows are gone, so a second call deletes the copies); with `turnUserId` it takes only the rows whose metadata names that user (`metadata.turnUserId`: a second user's trace on another user's session) and leaves the scope's other rows and copies. `deleteScope('conversation', key)` also deletes the scope's row of `memory_scopes`; with `turnUserId` the row stays, and it stays while the scope still holds a page row (`memory_pages`), which this call does not delete, or a trace stored while the call ran. For the conversation scope the call waits for a compile of the scope that is running, and a compile waits for it. Before it reads, it files the brain's rows that hold `''` while their metadata names a scope id, as an open does, so a row a release older than the column wrote after the facade opened goes too. An empty scope id or `turnUserId` is refused with a `TypeError`, so a caller's missing id never deletes the traces filed under no scope id or widens a user's delete to the whole scope. Both return `{ deleted }`, the number of rows deleted, so a call made again counts none. A cognitive `MemoryStore` over the same Brain stops recalling a deleted trace at its next read of the rows, and its cache keeps the trace's words until its own `deleteScope` or `deleteTraces` runs. `Memory.deleteTracesNamingUser(userId)` deletes every trace, under any scope, whose metadata names that user as `turnUserId`, and `Memory.tracesNamingUser(userId)` lists them, each as `{ id, scope, scopeId }`, live or soft-deleted. A person's deletion (`forgetUserMemory()`) reads that list first: under another user's or session's conversation scope it deletes each page compiled from one of those traces, whole, after naming the page's other sources in `rebuild_sources`, and then the traces; a page it could not delete keeps the scope's traces of the person, so the deletion made again finds the page by them. Once the traces are gone it waits for a compile of the scope that is running (`waitForScopeChanges`) and deletes the page that compile wrote from them. `Memory.rebuildVectorIndex()` rewrites the vector index file from the traces that are left, or removes the index files when none is left, and throws when the files could not be written or removed: a delete only marks a vector, so call it after deleting for good. Additions, removals, rebuilds and rewrites of the index run one after another, and a rewrite reads the traces inside its own step: a trace deleted while an earlier rewrite runs is not written back into the files, and a trace remembered while a rewrite runs is indexed once it ends. `Memory.finishErasure()` runs what deletes for good left owed in the files: on SQLite the full-text rebuild, owed from a delete until a rebuild succeeds; the index rewrite, owed from a delete until a rewrite succeeds; and the log's checkpoint (below), owed from a delete until a checkpoint empties the log, and run after a full-text rebuild it made. Nothing owed, nothing runs. It answers `{ fullText: 'rebuilt' | 'not owed', vectorIndex: 'rewritten' | 'not owed', log }` and throws what the first failed step throws, once every step was tried; what failed stays owed. The retention sweep calls it at its end, also when a scope failed, a correction once its deletes are done, and a re-application of the tombstones (`reapplyTombstones()`, which a souled agent's open and `agent.applyTombstones()` run) once its deletions are done, so a rewrite or a checkpoint an earlier sweep or deletion could not finish runs again, though the store holds nothing more of the subject.

`Memory.restoreTrace(traceId, snapshot)` writes back the row a snapshot holds, live again: content, tags, scope, scope id and metadata. `readTraceSnapshot(brain, brainId, traceId)` in `tracePersistence.ts`, exported with its `TraceSnapshot` type from the package root and `@framers/agentos/cognition/memory`, reads one, every column but the embedding, with the form its row was read in (`scopeIdForm`: `'encoded'` once a learning layer re-filed the brain, else `'plain'`); it reads the brain's record before and after the row, and reads the row again when a re-file committed between them. A snapshot read before the re-file is written under the encoded id, as the re-file wrote the row, since in a re-filed brain the plain form of an id that holds a `/` names a namespaced user (`team/ana` is user `ana` of namespace `team`); a snapshot of a row whose `scope_id` holds `''` while its metadata names a scope id (a release older than the column wrote it) is written under the encoded form of the metadata's id, in the column and the metadata, as the re-file files and moves such a row. On Postgres the restore of such a snapshot reads the brain's record under the lock a re-file takes, so a re-file another process makes meanwhile comes before it or after it. A row that still holds the snapshot's content keeps its embedding, so a `forget` taken back is recalled as before; a row that holds other content is written with no embedding, and the trace gets one when it is next written. The full-text index follows the restored words: SQLite rebuilds it, and Postgres re-indexes the restored row alone. A restore writes the row only, so a trace deleted for good gets back its row, not the memory-graph node or the HNSW entry its delete removed. `Memory.brainId` names the brain the facade reads and writes.

`remember(content, { metadata })` merges extra keys into the trace's stored metadata, under the keys the facade sets itself (`scopeId`, `content_hash`, `entities`, `decay`), which win. A trace whose metadata names a `turnUserId` is no duplicate of the same words filed under the same scope with another `turnUserId` or none: each user's words stay a trace of their own, so a delete of one user's traces leaves the other's. An import keeps them apart the same way, and a Markdown or Obsidian export writes the user into each such note's front matter, so the import files the note as that user's trace.

Forgotten subjects are recorded in one ledger, the table `agentos_learning_forgotten`, which the memory store and the learning layer share. A row holds a hash of a subject (SHA-256 over the canonical JSON `[namespace, kind, id]`, or HMAC-SHA-256 under a key the host supplies) and the time, never an id or any text. `ForgottenLedger` keeps a second copy of the table outside the store's database, and its `reconcile()` fills missing rows in both directions, so a store restored from a backup taken before a deletion still knows the deletion. Opening a ledger repairs an older copy from the primary after checking the markers; it does not copy tombstones back into the primary until `reconcile()`. `reapplyTombstones()` calls that, and then deletes again whatever the store holds of a forgotten subject (`Memory.listHeldSubjects()` names the subjects a store holds anything of). `souledAgent()` runs it at every open; a host that opens a store with a ledger itself calls it after each open. A store whose tombstones are keyed does not open without the key, and a store whose copy is missing does not open. Empty current or previous keys are refused. The copy must be a different database: the same adapter, or a second native SQLite connection to the primary file, is refused.

Beside the tombstones the table holds marker rows. Each has a `:` in its `hash`, which no tombstone has, and an empty `namespace`. `c1:copy` says the store has a copy. `k1:` and 16 hex characters names a key that wrote tombstones. `i1:identity` holds the ledger's identity in `forgotten_at`: 32 lowercase hex characters, 16 random bytes made once when the ledger is first created. It holds no hash, id or key, and it never changes. `s1:state` holds the ledger's state mark in `forgotten_at`: 64 lowercase hex characters, one unsigned 256-bit number. For these two rows `forgotten_at` is a value and not a time.

Opening compares the identity of the store with the identity of its copy. When they differ the store does not open (`LEDGER_IDENTITY_MISMATCH`): put the store's own current copy back. A side that holds one of the two rows without the other, or a malformed one, does not open (`LEDGER_STATE_INVALID`), and neither does a pair whose two sides hold one tombstone with a different namespace or time. A ledger made before these rows existed gains them at its next open and keeps every row it held. A store without the rows beside a copy that has them takes the copy's identity, state and tombstones when the copy already holds every tombstone and key marker of the store; the tombstones it takes are listed by the next `reconcile()`. A copy without them is repaired from its store on the same condition. Either is refused when it holds a tombstone or key marker the other side lacks. The ledger needs a storage adapter with transactions and a secure random source (`globalThis.crypto.getRandomValues`), and refuses without one (`LEDGER_UNAVAILABLE`). A refused open writes one `memory.ledger_refused` log line with the error's type and code, and nothing of the store.

The state mark rises every time a tombstone is written, a repeat for a subject already forgotten included. The new mark is the higher of the old mark and the current Unix millisecond shifted left by 192 bits, plus a random number from 1 to 2^192. A tombstone, the key marker it needs and the new mark are written in one transaction on each side, the copy first; each side's transaction takes the table's write lock with its first statement (on PostgreSQL `LOCK TABLE agentos_learning_forgotten IN SHARE ROW EXCLUSIVE MODE`), and the two transactions never nest. Opening raises an older copy's mark to the store's along with its rows. `reconcile()` fills missing rows in both directions and leaves both sides at the higher mark; it never lowers one. When it finds a tombstone that was written into one side without the ledger (a learning layer whose namespace the ledger does not read, or SQL by hand), it raises the mark once. A ledger with no copy has no second side to compare and does not see such a row. `ledger.readState()` brings both sides up to date and returns `{ identity, mark }`, and nothing else; on an open handle whose store or copy no longer holds the identity the open found, it and every write refuse with `LEDGER_IDENTITY_MISMATCH`. The ledger's calls on one handle run one at a time; across processes the locks order them. Give each part of a program that opens transactions on PostgreSQL its own adapter object, or run their transactions one at a time.

What the mark shows to someone who holds it. Its first 16 hex characters are the millisecond of the newest tombstone write, or of the ledger's creation. Two marks of one ledger that are equal mean no tombstone was written between them; two that differ mean at least one was. When tombstones are written while the clock is behind the mark (two in one millisecond, or a clock that was set back or ran ahead), the difference of two marks grows with the number of writes between them, so someone who holds both can estimate that number. The mark is not a count of people: repeats, sessions and the learning layer's own rows raise it too. Anyone who can read the ledger table can count its rows, so keep the ledger and its copy as confidential as the store.

An explicit vector-index rebuild keeps every surviving vector, including in a store below the automatic activation threshold. When the store reopens with an index, it refreshes that index from the live trace rows before recall, so additions since the last saved rewrite are included. A failed file removal leaves the initialized index usable while the caller repairs the file and retries deletion.

The forgotten-user ledger is database-wide: tombstones, key markers and copy markers are not partitioned by `brainId` or the soul's `agentId`. With `forgotten` configured, give each agent its own database (or its own PostgreSQL schema and ledger table), plus a separate tombstone copy outside what a restore replaces. An open refuses a copy that is the store's own database (the same native SQLite file, or on PostgreSQL the same database and schema through a second pool); it cannot tell two sql.js handles of one file apart. Different brain ids in the same ledger database share the forgetting decision and the count of other forgotten subjects. Learning namespaces do not isolate the store-wide tombstones.

Every SQLite memory store the library opens from a file path (`Memory.createSqlite`, `Brain.openSqlite`, the `souledAgent()` store, a `gmi()` `memory.store` path) and the tombstone copy are opened with `PRAGMA secure_delete = ON`, so a deleted row's bytes are overwritten in the page its delete writes. Such a store runs in write-ahead-log mode: the log keeps the pages written before the delete, and the store's file its older page, until a checkpoint moves the log into the file. `Memory.checkpointLog()` runs that checkpoint and empties the log (`{ log: 'emptied' }`; `'busy'` when another connection held it, `'none'` on PostgreSQL); a person's deletion calls it once its deletes are done, and names a log it could not empty in its report. There is no option to turn `secure_delete` off. A store on an adapter you pass (`Memory.createWithAdapter`) is opened by you: set the pragma yourself. On PostgreSQL a deleted row stays in the table file until `VACUUM` removes it; the schedule is yours. `openForgottenCopy(filePath)` opens a tombstone copy's file this way, making it when missing, and returns its adapter for `ForgottenLedger.open({ primary, copy })`.

---

## Export and backup

```ts
await mem.export('./backup.sqlite');        // SQLite copy (format from the extension, or { format: 'sqlite' })
await mem.export('./backup.json');          // JSON
await mem.export('./notes/', { format: 'markdown' });
await mem.export('./vault/', { format: 'obsidian' });
```

The `sqlite` export goes through [`Brain.exportToSqlite(targetPath)`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/store/Brain.ts), from a SQLite or a Postgres brain alike: it writes this brain's rows of every portable table to a new file, the registry of conversation scopes (`memory_scopes`), each subject's wiki pages (`memory_pages`) and the owner of each agent's older memory (`memory_legacy_owner`) with them, and throws when the target exists. A Postgres brain, and a SQLite file in WAL mode as `Brain.openSqlite` opens one, are read from one consistent view of the database; a brain on one connection, such as an in-memory SQLite database, is read statement by statement. Its `brain_meta` rows carry the brain's scope-id form record where the brain has one, read before the rows and again after them, and the export copies again when a re-file commits while it reads, so the file's record names the form its rows are in and an import of the file keeps the form ([A Brain's scope-id form](../MEMORY_OPERATIONS.md#a-brains-scope-id-form)).

An import of that file (`mem.importFrom('./backup.sqlite')`, or `Brain.importFromSqlite`) brings the pages and the registry back. A scope the brain already registers keeps its own row and compile watermark, and any other comes in with the file's, so its next compile does not read the same traces again; a message the import stores under a scope the brain had compiled past that message's time moves the scope's watermark back to just before it, so its next compile reads it. A message is never matched as a duplicate of a page chunk of the same text. A file whose `memory_scopes` or `memory_pages` table cannot be read is refused before anything is written, with the reason in `errors`, and a file whose rows of any table, the two tables among them, belong to more than one brain is refused as such (`Brain.importFromSqlite` throws, naming the brain ids, when its `brain_meta`, `memory_scopes` and `memory_pages` rows name more than one). A page the brain already holds, by scope and page id, is kept: the file's page is skipped, and so are that page's chunks. Any other page comes in with its chunks, written as traces of their own, and its row lists the ids they were written under. `Brain.importFromSqlite(file, { strategy: 'replace' })` empties both tables for the brain first, as it empties the portable tables. The JSON export carries the registry (`scopes`) and the pages (`pages`) beside the traces, and its import (`mem.importFrom('./backup.json')` or `mem.importFromString(text, 'json')`) brings them back by the same rules. The Markdown and Obsidian exports carry traces, the chunks of pages among them, and no page row and no registry row: use the `sqlite` or `json` format to move a store whose subjects have pages.

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
6. Registers each [conversation scope](#conversation-scopes) that holds traces and has no row in `memory_scopes`.
7. Seeds `brain_meta` with `schema_version` and `created_at` when absent.
8. Repairs the full-text index on SQLite when it is out of step with `memory_traces`.

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
| [`io/SqliteExporter.ts`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/io/SqliteExporter.ts) | One brain's rows to a new SQLite file, through `Brain.exportToSqlite` |

All paths are under `src/cognition/memory/`.
