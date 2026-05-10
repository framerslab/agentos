---
title: 'SQLite Brain Storage'
sidebar_position: 25
description: 'Single brain.sqlite per agent — 12-table schema, WAL mode, FTS5 hybrid search, embedding BLOBs, and backup strategies.'
---

> Every agent stores its entire memory in a single `brain.sqlite` file. The schema mirrors cognitive science models: Tulving's memory taxonomy, Collins & Quillian's semantic network, and Hebbian reinforcement signals.

---

## Overview

The `Brain` class manages a single WAL-mode SQLite database that contains all memory subsystem data. One file holds everything an agent has ever learned, ingested, or been told:

```
~/.agentos/agents/{name}/brain.sqlite
```

### Design Choices

| Choice | Rationale |
|--------|-----------|
| **Single file** | Zero infrastructure, trivially portable, works offline |
| **WAL mode** | Concurrent reads during writes (multi-subsystem access) |
| **FTS5 with Porter tokenizer** | Fast full-text search with morphological stemming |
| **Embeddings as BLOBs** | Raw Float32Array buffers, no external vector DB needed |
| **JSON columns** | Schema flexibility for tags, emotions, metadata without sacrificing query-ability (SQLite json_extract) |
| **Foreign keys ON** | Referential integrity across the 12-table schema |

---

## 12-Table Schema

All 12 tables live in a single `brain.sqlite` file, grouped into six categories:

| Category | Tables |
|---|---|
| **Memory Traces** | `memory_traces` · `memory_traces_fts` (FTS5) |
| **Knowledge Graph** | `knowledge_nodes` · `knowledge_edges` |
| **Document Ingestion** | `documents` · `document_chunks` · `document_images` |
| **Conversations** | `conversations` · `messages` |
| **Maintenance** | `consolidation_log` · `retrieval_feedback` |
| **Meta / Archive** | `brain_meta` · `archived_traces` · `archive_access_log` |

### Table Details

#### `brain_meta`

Key-value store for schema versioning, agent identity, and embedding configuration.

```sql
CREATE TABLE brain_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

Standard keys: `schema_version`, `created_at`, `embedding_dimension`.

#### `memory_traces`

Core memory trace table implementing Tulving's unified trace model.

```sql
CREATE TABLE memory_traces (
  id              TEXT    PRIMARY KEY,
  type            TEXT    NOT NULL,      -- episodic | semantic | procedural | prospective
  scope           TEXT    NOT NULL,      -- thread | user | persona | organization
  content         TEXT    NOT NULL,
  embedding       BLOB,                 -- Raw Float32Array (little-endian)
  strength        REAL    NOT NULL DEFAULT 1.0,  -- Ebbinghaus retrievability R in [0,1]
  created_at      INTEGER NOT NULL,     -- Unix ms
  last_accessed   INTEGER,              -- Unix ms of last retrieval
  retrieval_count INTEGER NOT NULL DEFAULT 0,
  tags            TEXT    NOT NULL DEFAULT '[]',  -- JSON array
  emotions        TEXT    NOT NULL DEFAULT '{}',  -- JSON PAD state at encoding
  metadata        TEXT    NOT NULL DEFAULT '{}',  -- JSON (contentHash, entities, etc.)
  deleted         INTEGER NOT NULL DEFAULT 0      -- Soft-delete flag
);
```

#### `memory_traces_fts`

FTS5 virtual table for full-text search with Porter stemming. Uses the external content mechanism so content is not duplicated on disk.

```sql
CREATE VIRTUAL TABLE memory_traces_fts USING fts5(
  content,
  tags,
  content='memory_traces',
  content_rowid='rowid',
  tokenize='porter ascii'
);
```

#### `knowledge_nodes`

Semantic network nodes representing entities and concepts.

```sql
CREATE TABLE knowledge_nodes (
  id         TEXT    PRIMARY KEY,
  type       TEXT    NOT NULL,
  label      TEXT    NOT NULL,
  properties TEXT    NOT NULL DEFAULT '{}',  -- JSON
  embedding  BLOB,
  confidence REAL    NOT NULL DEFAULT 1.0,
  source     TEXT    NOT NULL DEFAULT '{}',  -- JSON provenance
  created_at INTEGER NOT NULL
);
```

#### `knowledge_edges`

Typed relationships between knowledge nodes.

```sql
CREATE TABLE knowledge_edges (
  id            TEXT    PRIMARY KEY,
  source_id     TEXT    NOT NULL REFERENCES knowledge_nodes(id),
  target_id     TEXT    NOT NULL REFERENCES knowledge_nodes(id),
  type          TEXT    NOT NULL,
  weight        REAL    NOT NULL DEFAULT 1.0,
  bidirectional INTEGER NOT NULL DEFAULT 0,
  metadata      TEXT    NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL
);
```

#### `documents`

Ingested document registry with SHA-256 content hashes for idempotent re-ingestion.

```sql
CREATE TABLE documents (
  id           TEXT    PRIMARY KEY,
  path         TEXT    NOT NULL,
  format       TEXT    NOT NULL,
  title        TEXT,
  content_hash TEXT    NOT NULL,
  chunk_count  INTEGER NOT NULL DEFAULT 0,
  metadata     TEXT    NOT NULL DEFAULT '{}',
  ingested_at  INTEGER NOT NULL
);
```

#### `document_chunks`

Contiguous text passages extracted from parent documents, linked to memory traces.

```sql
CREATE TABLE document_chunks (
  id           TEXT    PRIMARY KEY,
  document_id  TEXT    NOT NULL REFERENCES documents(id),
  trace_id     TEXT    REFERENCES memory_traces(id),
  content      TEXT    NOT NULL,
  chunk_index  INTEGER NOT NULL,
  page_number  INTEGER,
  embedding    BLOB
);
```

#### `document_images`

Visual assets extracted from documents (figures, diagrams).

```sql
CREATE TABLE document_images (
  id          TEXT    PRIMARY KEY,
  document_id TEXT    NOT NULL REFERENCES documents(id),
  chunk_id    TEXT    REFERENCES document_chunks(id),
  data        BLOB    NOT NULL,
  mime_type   TEXT    NOT NULL,
  caption     TEXT,
  page_number INTEGER,
  embedding   BLOB
);
```

#### `consolidation_log`

Audit trail for offline consolidation runs.

```sql
CREATE TABLE consolidation_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at      INTEGER NOT NULL,
  pruned      INTEGER NOT NULL DEFAULT 0,
  merged      INTEGER NOT NULL DEFAULT 0,
  derived     INTEGER NOT NULL DEFAULT 0,
  compacted   INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0
);
```

#### `retrieval_feedback`

Hebbian reinforcement signals --- tracks which retrieved traces were used vs ignored by the LLM.

```sql
CREATE TABLE retrieval_feedback (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id   TEXT    NOT NULL REFERENCES memory_traces(id),
  signal     TEXT    NOT NULL,   -- 'used' | 'ignored'
  query      TEXT,
  created_at INTEGER NOT NULL
);
```

#### `conversations` and `messages`

Lightweight conversational buffer for episodic memory encoding.

```sql
CREATE TABLE conversations (
  id         TEXT    PRIMARY KEY,
  title      TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  metadata   TEXT    NOT NULL DEFAULT '{}'
);

CREATE TABLE messages (
  id              TEXT    PRIMARY KEY,
  conversation_id TEXT    NOT NULL REFERENCES conversations(id),
  role            TEXT    NOT NULL,    -- 'user' | 'assistant' | 'system' | 'tool'
  content         TEXT    NOT NULL,
  created_at      INTEGER NOT NULL,
  metadata        TEXT    NOT NULL DEFAULT '{}'
);
```

---

## FTS5 Hybrid Search

The `memory_traces_fts` table enables BM25-ranked full-text search across trace content and tags:

```sql
-- BM25-ranked search
SELECT mt.*, fts.rank
FROM memory_traces_fts fts
JOIN memory_traces mt ON mt.rowid = fts.rowid
WHERE memory_traces_fts MATCH ?
  AND mt.deleted = 0
ORDER BY fts.rank
LIMIT ?;
```

The Porter tokenizer handles morphological stemming: a query for `"deploy"` also matches `"deployment"`, `"deployed"`, `"deploying"`.

Natural language queries are automatically converted to FTS5 syntax by `buildNaturalLanguageFtsQuery()`.

---

## Embedding Storage

Embeddings are stored as raw `BLOB` columns containing little-endian `Float32Array` data. The dimension is tracked in `brain_meta`:

```ts
brain.setMeta('embedding_dimension', '1536');
```

### Dimension Compatibility Check

At construction time, `Brain.checkEmbeddingCompat(dimensions)` compares the requested dimension against the stored value. A mismatch produces a warning --- vector similarity searches may return incorrect results when dimensions don't match.

### When to Re-index

If you switch embedding providers (e.g., from OpenAI `text-embedding-3-small` at 1536 dimensions to Cohere at 1024 dimensions), call `reindex()` to re-embed all traces:

```ts
const mem = await Memory.createSqlite({
  path: './brain.sqlite',
  embeddings: {
    provider: 'cohere',
    model: 'embed-english-v3.0',
    dimensions: 1024,
  },
});

// Re-embed all traces with the new model
await mem.reindex();
```

---

## Custom Paths

By default, agents store their brain at:

```
~/.agentos/agents/{seedId}/brain.sqlite
```

You can override this with any path:

```ts
const mem = await Memory.createSqlite({ path: '/data/custom-brain.sqlite' });
```

The parent directory must already exist; the SQLite file is created if absent.

---

## Backup Strategies

### SQLite Export (VACUUM INTO)

The `SqliteExporter` uses SQLite's `VACUUM INTO` command to produce a clean, defragmented copy of the brain database:

```ts
await mem.export('./backup.sqlite', { format: 'sqlite' });
```

This is the recommended backup approach because:
- The output is a fully self-contained SQLite file.
- `VACUUM INTO` creates a clean copy even while the source is being written to (WAL mode).
- The backup file is defragmented and can be smaller than the original.

### Scheduled Backups

For production agents, schedule periodic backups:

```ts
// Backup every 6 hours
setInterval(async () => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  await mem.export(`./backups/brain-${timestamp}.sqlite`, { format: 'sqlite' });
}, 6 * 60 * 60 * 1000);
```

### JSON/Markdown Backups

For human-reviewable or version-controllable backups:

```ts
// JSON (programmatic, includes all metadata)
await mem.export('./backup.json', { format: 'json' });

// Markdown (human-readable, git-friendly)
await mem.export('./backup-md/', { format: 'markdown' });

// Obsidian (for knowledge management)
await mem.export('./vault/', { format: 'obsidian' });
```

---

## Initialization Sequence

When `Brain.openSqlite()` is called:

1. **Open** (or create) the SQLite file at `dbPath`.
2. **Enable WAL** journal mode for concurrent read access.
3. **Enable foreign keys** (OFF by default in SQLite).
4. **Execute DDL** --- all 12 `CREATE TABLE IF NOT EXISTS` statements.
5. **Create FTS5** virtual table for full-text search.
6. **Seed brain_meta** with `schema_version` and `created_at` if absent.

```ts
const brain = await Brain.openSqlite('/path/to/agent/brain.sqlite');

// Direct DB access for subsystems
const row = await brain.get('SELECT * FROM memory_traces WHERE id = ?', [id]);

// Meta helpers
await brain.setMeta('last_sync', Date.now().toString());
const ver = await brain.getMeta('schema_version'); // '1'

await brain.close();
```

---

## Health Monitoring

The `Memory.health()` method returns a snapshot of the brain's statistics:

```ts
const health = await mem.health();
console.log(`Total traces: ${health.totalTraces}`);
console.log(`Active traces: ${health.activeTraces}`);
console.log(`Avg strength: ${health.avgStrength.toFixed(2)}`);
console.log(`Graph nodes: ${health.graphNodes}`);
console.log(`Graph edges: ${health.graphEdges}`);
console.log(`Docs ingested: ${health.documentsIngested}`);
console.log(`Last consolidation: ${health.lastConsolidation}`);
```

```ts
interface MemoryHealth {
  totalTraces: number;
  activeTraces: number;
  avgStrength: number;
  weakestTraceStrength: number;
  graphNodes: number;
  graphEdges: number;
  lastConsolidation: string | null;
  tracesPerType: Record<string, number>;
  tracesPerScope: Record<string, number>;
  documentsIngested: number;
}
```

---

## Source Files

| File | Purpose |
|------|---------|
| `memory/archive/SqlStorageMemoryArchive.ts` | IMemoryArchive impl (cold storage for verbatim content) |
| `memory/store/Brain.ts` | Unified SQLite connection, DDL, meta helpers (includes archive DDL) |
| `memory/store/SqlKnowledgeGraph.ts` | IKnowledgeGraph over SQLite tables |
| `memory/store/SqlMemoryGraph.ts` | IMemoryGraph with spreading activation |
| `memory/store/tracePersistence.ts` | FTS5 query builder, trace serialisation, hash utilities |
