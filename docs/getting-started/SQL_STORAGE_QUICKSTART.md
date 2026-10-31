---
title: Storage & Scaling
description: The @framers/sql-storage-adapter quickstart (better-sqlite3, sql.js, IndexedDB, Capacitor, Postgres, Supabase, Electron), cloud backups and data migration, AgentOS's conversation storage adapters, and the path for a memory brain from a SQLite file to Postgres or Qdrant with MigrationEngine.
keywords:
  - agentos sql storage
  - sql-storage-adapter
  - better-sqlite3
  - postgres adapter
  - supabase agent storage
  - capacitor sqlite
  - sql.js indexeddb
  - cross platform agent storage
  - cloud backup s3
  - schema migrations
  - memory scaling
  - hnsw sidecar
  - pgvector
  - qdrant migration
---

# Storage & Scaling

This page covers two layers:

1. **Storage adapter**: [`@framers/sql-storage-adapter`](https://github.com/framerslab/sql-storage-adapter) and its [`StorageAdapter`](https://github.com/framerslab/sql-storage-adapter/blob/master/src/core/contracts/index.ts) interface. AgentOS's SQL-backed stores run on it: the memory facade's `Brain`, `SqlVectorStore`, `SqlStorageMemoryArchive`, `ConversationManager` persistence, `SqlTaskOutcomeTelemetryStore` and `SqlSpendMeter`; `PostgresVectorStore` does too when it is given a PostgreSQL adapter.
2. **Scaling path**: a memory brain starts as one SQLite file, with an HNSW index file beside it, and moves to Postgres or Qdrant through `MigrationEngine.migrate()`.

---

## Storage adapter quickstart

```ts
import { createDatabase } from '@framers/sql-storage-adapter';

const db = await createDatabase({ type: 'sqlite', file: './agentos.db' });

await db.exec('CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, body TEXT)');
await db.run('INSERT INTO notes (id, body) VALUES (?, ?)', ['n1', 'hello']);
const rows = await db.all('SELECT * FROM notes');
```

For Postgres, pass `type: 'postgres'` with the URL: `createDatabase({ type: 'postgres', url: process.env.DATABASE_URL })`. Without `type` or `priority`, `createDatabase()` picks by runtime alone, sql.js in a browser or Deno and better-sqlite3 then sql.js in Node, so a `url` given without `type: 'postgres'` opens SQLite in Node.

## Backends

| Adapter | Opened with | Notes |
|---|---|---|
| better-sqlite3 | `createDatabase({ type: 'sqlite', file })`; `type: 'memory'` opens `:memory:` | Node, native module; the adapter turns on WAL mode |
| sql.js | `createDatabase({ type: 'browser' })` | SQLite compiled to WebAssembly; the Node fallback when better-sqlite3 does not load |
| IndexedDB | `createDatabase({ priority: ['indexeddb', 'sqljs'], indexedDb: { dbName } })` | browser; sql.js with its database kept in IndexedDB |
| Capacitor SQLite | `createDatabase({ type: 'mobile', mobile })` | iOS and Android through the Capacitor SQLite plugin |
| Postgres | `createDatabase({ type: 'postgres', url })`, or `postgres: { host, database, user, password, ssl }` | the `pg` driver with a connection pool |
| Supabase | `const db = new SupabaseAdapter(); await db.open({ connectionString })` | a Supabase database over the `pg` driver; `createDatabase()` does not build it |
| Electron | `createElectronMainAdapter({ filePath })` and `createElectronRendererAdapter()` from `@framers/sql-storage-adapter/electron` | the database in the main process, reached from the renderer over IPC |

Pass `type` explicitly in production, so a deployment does not switch adapters when a native module fails to load.

## The contract

Every adapter implements [`StorageAdapter`](https://github.com/framerslab/sql-storage-adapter/blob/master/src/core/contracts/index.ts):

```ts
interface StorageAdapter {
  readonly kind: string;
  readonly capabilities: ReadonlySet<StorageCapability>;
  open(options?: StorageOpenOptions): Promise<void>;
  run(statement: string, parameters?: StorageParameters): Promise<{ changes: number; lastInsertRowid?: string | number | null }>;
  get<T = unknown>(statement: string, parameters?: StorageParameters): Promise<T | null>;
  all<T = unknown>(statement: string, parameters?: StorageParameters): Promise<T[]>;
  exec(script: string): Promise<void>;
  transaction<T>(fn: (trx: StorageAdapter) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  batch?(operations: BatchOperation[]): Promise<BatchResult>;
}
```

`createDatabase()` opens the adapter before it returns it. The SQL you pass reaches the engine as written, except placeholders: write `?`, and the Postgres adapter rewrites each to `$1`, `$2` and so on. For the parts that differ between engines (full-text search, blob encoding, identifier quoting) the package exports [`SqliteDialect`](https://github.com/framerslab/sql-storage-adapter/blob/master/src/dialects/SqliteDialect.ts), [`PostgresDialect`](https://github.com/framerslab/sql-storage-adapter/blob/master/src/dialects/PostgresDialect.ts), `SqliteFts5` and `PostgresFts`.

## Cloud backups

`createCloudBackupManager(adapter, s3Client, bucket, config)` backs up any adapter to an S3-compatible bucket (S3, R2, MinIO) through an `@aws-sdk/client-s3` client:

```ts
import { createCloudBackupManager } from '@framers/sql-storage-adapter';
import { S3Client } from '@aws-sdk/client-s3';

const s3 = new S3Client({ region: 'auto', endpoint: process.env.R2_ENDPOINT });
const backup = createCloudBackupManager(db, s3, process.env.BACKUP_BUCKET!, {
  interval: 60 * 60 * 1000, // hourly
  maxBackups: 168,          // keep a week of hourly backups
  options: { compression: 'gzip', format: 'json' },
});

backup.start();
```

`start()` backs up every `interval` milliseconds and `stop()` ends the schedule; `backupNow()` runs one backup and returns its object key. Compression is off unless `options.compression` is `'gzip'`. With `maxBackups` set, older backups past that count are deleted. `listBackups()` lists the keys and `restore(key)` loads one into the adapter. Source: [`features/backup/cloudBackup.ts`](https://github.com/framerslab/sql-storage-adapter/blob/master/src/features/backup/cloudBackup.ts).

## Moving data between adapters

```ts
import { createDatabase, exportAsJSON, importFromJSON, migrateAdapters } from '@framers/sql-storage-adapter';

const sqliteDb = await createDatabase({ type: 'sqlite', file: './dev.db' });
const pgDb = await createDatabase({ type: 'postgres', url: process.env.DATABASE_URL! });

// Copy every table from one adapter to the other.
await migrateAdapters(sqliteDb, pgDb);

// Or through a JSON document you can store or inspect.
const json = await exportAsJSON(sqliteDb, { tables: ['notes'] });
await importFromJSON(pgDb, json);
```

The export reads each table in pages of `batchSize` rows (default 1000) and holds the whole document in memory. The import inserts one row at a time, in batches of `batchSize` rows (default 100), with no transaction around a table or the whole import. With the default `onConflict: 'error'`, a row that fails ends that table's import: the rows inserted before it stay, the error goes into the result's `errors` with `success: false`, and the import goes on with the next table, so a failed import can leave a partial copy. `'replace'` and `'ignore'` write SQLite statements (`INSERT OR REPLACE`, `INSERT OR IGNORE`) and skip a failing row without an error; Postgres rejects those statements, so into Postgres both options skip every row.

## Wiring into AgentOS

The memory facade opens a brain on any adapter:

```ts
import { createDatabase } from '@framers/sql-storage-adapter';
import { Memory } from '@framers/agentos';

const storage = await createDatabase({ type: 'sqlite', file: './db_data/memory.db' });
const memory = await Memory.createWithAdapter(storage, { brainId: 'support-agent' });

// Postgres: Memory.createPostgres(process.env.DATABASE_URL!, { brainId: 'support-agent' })
```

[`SqlStorageMemoryArchive`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/archive/SqlStorageMemoryArchive.ts) takes an adapter, its storage features and a brain id. `CognitiveMemoryManager` does not take an adapter: its `initialize()` takes a vector store, a knowledge graph, an embedding manager and a working memory. [`AgencyMemoryManager`](https://github.com/framerslab/agentos/blob/master/src/agents/agency/AgencyMemoryManager.ts) takes a vector store manager.

## Conversation storage

[`IStorageAdapter`](https://github.com/framerslab/agentos/blob/master/src/core/storage/IStorageAdapter.ts) keeps conversations and their messages. AgentOS has two implementations, both exported from `@framers/agentos`:

| Class | Keeps its data in | For |
|---|---|---|
| [`InMemoryStorageAdapter`](https://github.com/framerslab/agentos/blob/master/src/core/storage/InMemoryStorageAdapter.ts) | the process's memory, emptied by `close()` | tests, and sessions that keep nothing |
| [`SqlStorageAdapter`](https://github.com/framerslab/agentos/blob/master/src/core/storage/SqlStorageAdapter.ts) | a `conversations` and a `messages` table, on any backend the resolver opens: better-sqlite3, sql.js, IndexedDB, Capacitor SQLite or PostgreSQL | everything else |

```ts
import { SqlStorageAdapter } from '@framers/agentos';

const storage = new SqlStorageAdapter({
  priority: ['postgres'],
  postgres: { connectionString: process.env.DATABASE_URL },
  segment: 'agentos',       // the tables in a schema of their own
  messageRetentionDays: 90, // 0, the default, keeps every message
});
await storage.initialize();

const now = Date.now();
await storage.createConversation({ id: 'c1', userId: 'u1', createdAt: now, lastActivity: now });
await storage.storeMessage({ id: 'm1', conversationId: 'c1', role: 'user', content: 'hello', timestamp: now });
const newestTwenty = await storage.getMessages('c1', { order: 'desc', limit: 20 });
```

`SqlStorageAdapter` takes the resolver's options (`filePath`, `priority`, `postgres`, `segment`, `strict`, `quiet`) and two of its own:

- `enableAutoMigration`, `true` by default: `initialize()` creates the tables and their indexes, adds the columns added since a database was made, and on PostgreSQL widens INTEGER timestamp columns to BIGINT. With `false` it creates nothing, and the host provides the tables.
- `messageRetentionDays`, `0` by default: above 0, `initialize()` and every `storeMessage()` delete the messages older than that many days. Conversations stay. With `enableAutoMigration: false`, the `messages` table has to exist before `initialize()`.

The two classes behave alike, and [one suite](https://github.com/framerslab/agentos/blob/master/src/core/storage/__tests__/storageAdapter.contract.ts) runs against the in-memory adapter and against `SqlStorageAdapter` on sql.js, better-sqlite3 and PostgreSQL:

- Timestamps are milliseconds. The SQL tables hold them in BIGINT columns: PostgreSQL's INTEGER stops at 2147483647 ([numeric types](https://www.postgresql.org/docs/current/datatype-numeric.html)).
- `listConversations()` puts the most recent activity first, and `getMessages()` the oldest message first unless `order: 'desc'`. Both take `limit`, `offset` or both.
- `storeMessage()` refuses a message whose conversation does not exist or whose id is taken, and sets the conversation's `lastActivity` to the message's `timestamp`.
- `deleteConversation()` deletes the conversation's messages with it. `SqlStorageAdapter` deletes both in one transaction and does not lean on the table's foreign key: SQLite enforces one only on a connection that turns foreign keys on, which better-sqlite3 does and sql.js, IndexedDB and Capacitor do not.
- A usage of zero tokens reads back as zero. `getConversationTokenUsage()` sums the counts, and reports cache tokens only when a message reported them.
- What the in-memory adapter holds is its own copy: changing an object passed in or handed back changes nothing stored. Metadata and tool calls go through JSON in both classes, so a `Date` comes back as a string.

`ConversationManager`'s persistence also makes a table named `conversations`, with other columns, so the two cannot share one database's tables: give `SqlStorageAdapter` a `segment`, or a database of its own.

## ConversationManager persistence

[`ConversationManager`](https://github.com/framerslab/agentos/blob/master/src/core/conversation/ConversationManager.ts) keeps the runtime's conversation contexts. `AgentOS.initialize()` hands it the host's storage adapter; without one, or with `conversationManagerConfig.persistenceEnabled: false`, conversations live in memory only.

```ts
import { resolveStorageAdapter } from '@framers/sql-storage-adapter';
import { ConversationManager } from '@framers/agentos';

const db = await resolveStorageAdapter({ filePath: './conversations.db' });

// AgentOS.initialize() does this with the host's storageAdapter.
const conversations = new ConversationManager();
await conversations.initialize({ persistenceEnabled: true }, undefined, db);

const context = await conversations.getOrCreateConversationContext('conv-1', 'user-1');
// ... the runtime adds the turn's messages to the context ...
await conversations.saveConversation(context);

// A restarted process on the same database:
const restarted = new ConversationManager();
await restarted.initialize({ persistenceEnabled: true }, undefined, db);
const again = await restarted.getConversation('conv-1');
```

- `initialize()` creates the `conversations` and `conversation_messages` tables and brings a database an earlier version made up to date: it adds the `content_type`, `name`, `thinking_blocks`, `summarized_count` and `seq` columns, and on PostgreSQL widens INTEGER timestamp columns to BIGINT. A millisecond time does not fit PostgreSQL's INTEGER, so such a table refused every save.
- `saveConversation()` writes the conversation and its messages in one transaction. A conversation evicted from memory (`maxActiveConversationsInMemory`) and every conversation still in memory at `shutdown()` are saved first. `getOrCreateConversationContext()` and `getConversation()` load a conversation that is not in memory.
- A message reads back with its role, content, time, tool calls, tool call id, name, thinking blocks, summarized count, metadata and the voice fields (`audioUrl`, `audioTranscript`, `voiceSettings`, `multimodalData`). Text reads back as text, so a tool result that holds JSON stays a string; null content and an array of content parts read back as they were. A row an earlier version wrote has no `content_type` and reads back as that version read it: text that starts and ends with braces or brackets is parsed when it parses.
- Messages come back oldest first; messages that share a millisecond come back in the order the conversation had them.
- Times read back as numbers on every backend; PostgreSQL's driver reads a BIGINT as a string.
- A conversation with no user is stored with an empty `user_id` and reads back without one.
- `appendOnlyPersistence: true` inserts each row once and never updates or deletes one: a message rewritten in memory keeps its first text on disk, `deleteConversation()` throws, and the last-active time is the newest message's. A host that runs a sealed provenance profile turns it on.
- Without it, a save rewrites each message, and `deleteConversation()` deletes the conversation's messages with it, on SQLite connections that leave foreign keys off too.

The table is the conversation's record: a message that leaves the history in memory, cut by `maxHistoryLengthMessages` or folded into a summary, keeps its row and comes back on load. `getHistory()` then returns the messages a trim to `maxHistoryLengthMessages` keeps: the first `messagesToKeepVerbatimHead`, the summary right after them and the last summary after them, and the newest, with a tool round they reach into whole. A summary sorts by its own time, which is later than the messages it replaced and the messages it was placed before, so on load it follows them.

[One suite](https://github.com/framerslab/agentos/blob/master/src/core/conversation/__tests__/ConversationManager.persistence.test.ts) runs this on sql.js, better-sqlite3 and PostgreSQL.

## Troubleshooting

**`better-sqlite3` does not load**: install the build tools (`xcode-select --install` on macOS, `build-essential` on Debian) and reinstall. With `type: 'sqlite'` there is no fallback; without `type`, Node falls back to sql.js.

**`SQLITE_BUSY: database is locked`**: SQLite takes one writer at a time. Look for a transaction that is never awaited, and move processes that write to the same file onto Postgres.

**`relation "X" does not exist` on Postgres**: Postgres folds unquoted identifiers to lower case. Keep identifiers in lower case, or quote them the same way everywhere.

## See also

- [Memory System Overview](../MEMORY_SYSTEM_OVERVIEW.md): how storage fits into the memory pipeline
- [Cognitive Memory](../memory/COGNITIVE_MEMORY.md): what runs on top of the stores
- [Postgres Backend](../memory/POSTGRES_BACKEND.md), [Qdrant Backend](../memory/QDRANT_BACKEND.md) and [Pinecone Backend](../memory/PINECONE_BACKEND.md): the vector stores
- [Client-Side Storage](../memory/CLIENT_SIDE_STORAGE.md): browser deployment with sql.js and IndexedDB
- [`@framers/sql-storage-adapter` README](https://github.com/framerslab/sql-storage-adapter): the package reference

---

## Scaling path: SQLite, Postgres, Qdrant

### SQLite (the default)

```typescript
import { Memory } from '@framers/agentos';

const tmp = await Memory.create(); // a SQLite file in the temp directory
const mem = await Memory.createSqlite('./brain.sqlite', {
  embed: async (text) => yourEmbeddingFunction(text),
});
```

A brain is one `brain.sqlite` file. With the optional `hnswlib-node` package installed, the facade keeps an HNSW index beside it, one file per brain, named `<database file name>.<digest>.hnsw` (the digest is of the file name and the brain id, so brains sharing a file or a directory never share an index). It loads the index at start, and builds it when `remember()` stores a trace with an embedding and the brain then holds at least 1,000 traces of its own (deleted traces excluded, with or without embeddings), or after an import; the build indexes each of the brain's traces that has an embedding. A `brain.hnsw` file, the one index of every brain in a directory that earlier versions wrote, is not read. Without the package, recall runs without the index.

### Postgres

`Memory.createPostgres(connectionString, { brainId })` opens a brain in Postgres. For the vector-store layer, `PostgresVectorStore` (from `@framers/agentos/cognition/rag`) uses pgvector, on its own pool, a pool of yours or an open PostgreSQL adapter, whose transactions it can join; see [Postgres Backend](../memory/POSTGRES_BACKEND.md#an-adapter-you-own-and-its-transactions).

### Qdrant and Pinecone

`QdrantVectorStore` and `PineconeVectorStore` (from `@framers/agentos/cognition/rag`) are vector stores for the retrieval layer; see [Qdrant Backend](../memory/QDRANT_BACKEND.md) and [Pinecone Backend](../memory/PINECONE_BACKEND.md). A brain's tables can be copied into Qdrant with `MigrationEngine`.

---

### Migration

[`MigrationEngine.migrate()`](https://github.com/framerslab/agentos/blob/master/src/cognition/rag/migration/MigrationEngine.ts) (from `@framers/agentos/cognition/rag`) copies a brain's tables from one backend to another:

```typescript
import { MigrationEngine } from '@framers/agentos/cognition/rag';

// SQLite to Postgres
const result = await MigrationEngine.migrate({
  from: { type: 'sqlite', path: './brain.sqlite' },
  to: { type: 'postgres', connectionString: process.env.DATABASE_URL! },
  batchSize: 1000,
  onProgress: (done, total, table) => console.log(`${table}: ${done}/${total}`),
});
console.log(`Migrated ${result.totalRows} rows in ${result.durationMs} ms`, result.errors);

// SQLite to Qdrant: vectors to Qdrant, the other tables to a SQLite sidecar file
await MigrationEngine.migrate({
  from: { type: 'sqlite', path: './brain.sqlite' },
  to: {
    type: 'qdrant',
    url: 'http://localhost:6333',
    apiKey: process.env.QDRANT_API_KEY,
    sidecarPath: './brain-sidecar.sqlite',
  },
});

// Pinecone to SQLite (Pinecone is a source only); collectionPrefix is the namespace
await MigrationEngine.migrate({
  from: {
    type: 'pinecone',
    url: 'https://my-index-abc123.svc.aped-1234.pinecone.io',
    apiKey: process.env.PINECONE_API_KEY!,
    collectionPrefix: 'my-namespace',
  },
  to: { type: 'sqlite', path: './brain.sqlite' },
});

// Count rows without writing
await MigrationEngine.migrate({
  from: { type: 'sqlite', path: './brain.sqlite' },
  to: { type: 'postgres', connectionString: process.env.DATABASE_URL! },
  dryRun: true,
});
```

- A backend is `{ type: 'sqlite' | 'postgres' | 'qdrant' | 'pinecone' }` with `path` (SQLite), `connectionString` (Postgres), or `url` and `apiKey` (Qdrant, Pinecone), plus `sidecarPath` for Qdrant and `collectionPrefix` for Pinecone. The engine reads no environment variable and provisions nothing: every backend must be running and named in the call.
- A Qdrant target writes `memory_traces` and `document_chunks` as Qdrant collections of those names and every other table into the SQLite file at `sidecarPath`. Without `sidecarPath`, each of those other tables fails and lands in `errors`. A Qdrant source reads the same two collections, plus the sidecar's tables when `sidecarPath` is set.
- Pinecone is a source only; a Pinecone target throws. The source reads one namespace, the `collectionPrefix` value as given (default: the default namespace, `''`), into the `memory_traces` table. Pass the exact namespace: when the index stats do not list it, the row count is the whole index's vector count. Each batch lists the namespace's first `batchSize` vector IDs and sends no pagination token, so a namespace with more vectors than `batchSize` migrates only that first page, written again for each batch and counted again in `totalRows`.
- The result is `{ tablesProcessed, totalRows, durationMs, verified, errors }`. An error in one table is collected in `errors`, and the other tables still migrate.
- From SQLite and Postgres the engine copies the brain tables that exist: `brain_meta`, `memory_traces`, `knowledge_nodes`, `knowledge_edges`, `documents`, `document_chunks`, `document_images`, `consolidation_log`, `retrieval_feedback`, `conversations` and `messages`.

### Docker setup helpers

`QdrantSetup.detect(config?)` and `PostgresSetup.detect(config?)` (from `@framers/agentos/cognition/rag`) find or start a local backend and return `{ status, url, containerName, source, error }`:

1. With `config.url`, or else `QDRANT_URL` / `DATABASE_URL`, set, the helper checks that backend and returns its URL when it answers.
2. Otherwise, with Docker available, a stopped container named `wunderland-qdrant` or `wunderland-postgres` is started, or a new one is pulled and run (`qdrant/qdrant:latest`, `postgres:16`; `imageTag` changes the tag).
3. The helper waits for the backend to answer, polling every 500 ms for Qdrant.

They write no configuration file, and `MigrationEngine` does not call them: pass the returned `url` to the migration. The `postgres` image ships without the pgvector extension, so on a container the helper started, creating the `vector` extension fails; run an image that includes it (such as [`pgvector/pgvector`](https://github.com/pgvector/pgvector#docker)) and pass its URL.
