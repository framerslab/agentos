---
title: Storage & Scaling
description: Storage adapter quickstart + four-tier scaling path (SQLite → HNSW sidecar → Postgres+pgvector → Qdrant). Covers `@framers/sql-storage-adapter` (better-sqlite3, sql.js, Postgres, Supabase, Capacitor, IndexedDB), cloud backups, and migrations across billions of vectors.
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

1. **Storage adapter** — `@framers/sql-storage-adapter`, the uniform [`StorageAdapter`](https://github.com/framerslab/sql-storage-adapter/blob/master/src/core/contracts/index.ts) interface that every AgentOS persistence path runs on (cognitive memory, agency memory, archive). Covers six concrete backends, the contract, cloud backups, and cross-backend migrations.
2. **Scaling path** — the four-tier progression from a single SQLite file (1K vectors) through an HNSW sidecar (500K), Postgres + pgvector (10M), to Qdrant (1B+). Each tier transition is a single `MigrationEngine.migrate()` call.

---

## Storage adapter quickstart

`@framers/sql-storage-adapter` is the storage layer used by every AgentOS persistence path (cognitive memory, agency memory, SQL storage archive). It exposes one `createDatabase()` factory that returns a uniform [`StorageAdapter`](https://github.com/framerslab/sql-storage-adapter/blob/master/src/core/contracts/index.ts) interface backed by `better-sqlite3`, `sql.js`, IndexedDB, Capacitor SQLite, Postgres, or Supabase. Application code is identical across all six. The runtime auto-detects the right backend per environment, or picks it explicitly via the `type` option.

This page covers the public API: how to pick a backend, the [`StorageAdapter`](https://github.com/framerslab/sql-storage-adapter/blob/master/src/core/contracts/index.ts) contract, cloud backups, cross-backend migrations, and how AgentOS memory subsystems consume it.

## What you get

| Backend | When it runs | Bundle / install cost |
|---|---|---|
| `better-sqlite3` | Node, when the native binding installs cleanly | Native build (~5 MB) — fastest in-process SQLite available |
| `sql.js` | Node fallback when `better-sqlite3` won't build; also runs in workers | ~1 MB WASM, pure-JS — slower than `better-sqlite3` but boring to deploy |
| `indexeddb` | Browser, when `sql.js` isn't loaded | Built into every browser; persistent across reloads |
| `capacitor-sqlite` | iOS / Android via Capacitor | Native plugin; uses the OS SQLite |
| `postgres` | Server-side production | `pg` driver; full PG capabilities (FTS, JSONB, GIN indexes) |
| `supabase` | Edge / Postgres-via-REST | Supabase's Postgres + Auth + row-level security; no direct TCP needed |

All six speak the same [`StorageAdapter`](https://github.com/framerslab/sql-storage-adapter/blob/master/src/adapters/baseStorageAdapter.ts) interface. The application code is unchanged.

## Three-line quickstart

```ts
import { createDatabase } from '@framers/sql-storage-adapter';

const db = await createDatabase({
  type: 'sqlite',          // or 'postgres', 'supabase', 'capacitor', 'sqljs', 'indexeddb'
  connection: './agentos.db',
});

await db.exec('CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, body TEXT)');
await db.run('INSERT INTO notes (id, body) VALUES (?, ?)', ['n1', 'hello']);
const rows = await db.all('SELECT * FROM notes');
```

Swap `type: 'sqlite'` for `type: 'postgres'` with a Postgres URL, redeploy, the rest of the code is the same.

## Picking the right backend

Backend selection guidance:

- **Single-process Node service on a single machine** → `better-sqlite3`. Microsecond reads, WAL mode handles concurrent connections inside the process. Avoid for any setup where two processes ever write to the same file simultaneously.
- **Multi-instance Node service, real users** → `postgres`. The driver pools connections, schema migrations cross instances cleanly, and Postgres FTS via [`PostgresFts`](https://github.com/framerslab/sql-storage-adapter/blob/master/src/fts/PostgresFts.ts) outranks SQLite FTS5 on anything past a few hundred MB.
- **Mobile (iOS/Android via Capacitor)** → `capacitor-sqlite`. Native bindings, hits the OS SQLite, encrypted-at-rest support via SQLCipher if you need it.
- **Browser playground / extension** → `sqljs` + `indexeddb`. The runtime auto-falls back here when no native binding is available. Loads ~1 MB of WASM lazily.
- **Edge / Cloudflare Workers / Supabase project** → `supabase`. Uses the REST data layer + row-level security; no TCP needed, works on Workers.
- **Electron app with both renderer + main process** → `electron` subpath. Routes queries through IPC so the renderer doesn't open a duplicate handle.

`createDatabase()` with `type: 'auto'` (the default if you omit `type`) walks this list and picks the first backend whose runtime check passes. For most apps you should pass the type explicitly so the deployment doesn't silently drift between dev and prod.

## The contract

Every adapter implements the same [`StorageAdapter`](https://github.com/framerslab/sql-storage-adapter/blob/master/src/adapters/baseStorageAdapter.ts) interface:

```ts
interface StorageAdapter {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number; lastInsertRowid: number | bigint }>;
  get<T = unknown>(sql: string, params?: unknown[]): Promise<T | undefined>;
  all<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
  transaction<T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
```

That's it. No ORM, no query builder, no proprietary dialect. The SQL you write is the SQL the underlying engine sees, with one caveat: parameter placeholders are normalized to `?` on the way in and rewritten to `$1, $2…` for Postgres / Supabase by [`parameterUtils`](https://github.com/framerslab/sql-storage-adapter/blob/master/src/shared/parameterUtils.ts). Always use `?`; never hardcode `$1` or the Postgres dialect-specific form.

For dialect-specific bits (FTS5 vs `tsvector`, JSON vs JSONB, AUTOINCREMENT vs SERIAL), the package ships [`SqliteDialect`](https://github.com/framerslab/sql-storage-adapter/blob/master/src/dialects/SqliteDialect.ts) and [`PostgresDialect`](https://github.com/framerslab/sql-storage-adapter/blob/master/src/dialects/PostgresDialect.ts) — abstractions over the differences that matter (FTS, blob encoding, identifier quoting). Most application code never touches them.

## Cloud backups

Postgres has its own backup story (managed-service snapshots, `pg_dump`, WAL archiving). For the SQLite-family backends, this package ships an opinionated backup manager that pushes compressed snapshots to S3, R2, or any S3-compatible store:

```ts
import { createCloudBackupManager } from '@framers/sql-storage-adapter';
import { S3Client } from '@aws-sdk/client-s3';

const s3 = new S3Client({ region: 'auto', endpoint: process.env.R2_ENDPOINT });
const backup = createCloudBackupManager(db, s3, process.env.BACKUP_BUCKET!, {
  interval: 60 * 60 * 1000,   // hourly
  maxBackups: 168,            // keep one week
  options: { compression: 'gzip' },
});

backup.start();
```

The backup runs at the cadence you set, compresses with gzip (usually 40–60% smaller), and prunes anything past `maxBackups` so you don't accumulate forever. Restores go through `backup.restore(timestamp)`. The source lives in [`features/backup/cloudBackup.ts`](https://github.com/framerslab/sql-storage-adapter/blob/master/src/features/backup/cloudBackup.ts).

R2 is the right default if you're price-sensitive — same API as S3, no egress fees, runs in Cloudflare's global mesh.

## Migrating between backends

The migration story is also boring on purpose. Export from one adapter, import into another:

```ts
import { exportToJson, importFromJson } from '@framers/sql-storage-adapter';

const sqliteDb = await createDatabase({ type: 'sqlite', connection: './dev.db' });
const dump = await exportToJson(sqliteDb, { tables: ['conversations', 'memory_traces'] });

const pgDb = await createDatabase({
  type: 'postgres',
  connection: process.env.DATABASE_URL!,
});
await importFromJson(pgDb, dump);
```

The exporter walks each table, paginates by primary key, serializes blobs through the [`NodeBlobCodec`](https://github.com/framerslab/sql-storage-adapter/blob/master/src/codecs/NodeBlobCodec.ts) (or the browser codec when running there), and writes a streaming JSON file. The importer replays it inside one transaction per table, so a failed migration leaves the destination in a clean state.

For zero-downtime migrations on a running production cluster, mirror writes to both databases for a window, run the export against the old one at a quiescent point, then cut traffic over and roll the old one offline.

## Wiring into AgentOS

The AgentOS [`Brain`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/store/Brain.ts) and [`CognitiveMemoryManager`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/CognitiveMemoryManager.ts) both accept a `StorageAdapter` directly:

```ts
import { createDatabase } from '@framers/sql-storage-adapter';
import { CognitiveMemoryManager } from '@framers/agentos';

const storage = await createDatabase({
  type: process.env.DATABASE_URL ? 'postgres' : 'sqlite',
  connection: process.env.DATABASE_URL || './db_data/memory.db',
});

const memory = new CognitiveMemoryManager({ storage });
await memory.initialize();
```

Same pattern wires the [`SqlStorageMemoryArchive`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/archive/SqlStorageMemoryArchive.ts) (the gist/rehydrate store) and the [`AgencyMemoryManager`](https://github.com/framerslab/agentos/blob/master/src/agents/agency/AgencyMemoryManager.ts) (shared memory across multi-agent agencies). One adapter, one connection pool, every memory subsystem shares it.

## Troubleshooting

**`Error: better-sqlite3 native binding not found`** — Node can't load the native binding. Either install the build toolchain (`xcode-select --install` on macOS, `build-essential` on Debian) and re-run `pnpm install --force`, or let the resolver fall back to `sql.js` by removing the explicit `type: 'sqlite-native'`. The pure-JS path is slower but works everywhere.

**`SQLITE_BUSY: database is locked`** — Two writers fighting for the same file. WAL mode is already on by default; the actual cause is usually a forgotten `await` on a transaction. Audit transaction lifecycles before tuning `PRAGMA busy_timeout`. If you're running multi-process under SQLite, that's the bug — move to Postgres.

**`relation "X" does not exist` on Postgres after Suite migrated** — Identifier case. SQLite is case-insensitive on table names, Postgres folds unquoted identifiers to lowercase. Either keep all identifiers lowercase, or quote everything consistently in both dialects.

**Capacitor SQLite fails on first iOS launch** — The plugin needs the `CapacitorSQLite.initializeSQLCipher()` call before the first `createDatabase()`. Wrap your AgentOS initialization in `Capacitor.isNativePlatform() ? await initSQLCipher() : null` to gate it.

**Supabase queries hang on edge runtime** — You're hitting the connection pool, not the data API. Use the REST data path that the `supabase` adapter ships, not the pooled `pg` driver. The package's adapter handles this; if you've manually constructed a `pg.Client`, swap to the Supabase JS client.

## See also

- [Memory System Overview](/features/memory-system-overview) — how the storage layer plugs into the cognitive memory pipeline
- [Cognitive Memory](/features/cognitive-memory) — what runs on top of the adapter (encoding, decay, retrieval)
- [Postgres Backend](/features/postgres-backend) — Postgres-specific tuning (FTS, JSONB, GIN indexes)
- [Client-Side Storage](/features/client-side-storage) — browser deployment with `sql.js` + IndexedDB
- [`@framers/sql-storage-adapter` README](https://github.com/framerslab/sql-storage-adapter) — full API reference + per-adapter notes
- [`baseStorageAdapter.ts`](https://github.com/framerslab/sql-storage-adapter/blob/master/src/adapters/baseStorageAdapter.ts) — the `StorageAdapter` contract

---

## Scaling path: SQLite → Postgres → Qdrant



`Memory.create()` currently opens the SQLite-backed standalone memory facade. The Postgres, Qdrant, and Pinecone material below applies to the lower-level RAG/vector-store layer and migration tooling while the high-level memory facade remains SQLite-backed.

> **CLI coming soon.** Migrations today run through the [`MigrationEngine`](https://github.com/framerslab/agentos/blob/master/src/cognition/rag/migration/MigrationEngine.ts) programmatic API shown below. A first-party `agentos` migration CLI is planned alongside the [Wunderland](https://wunderland.sh) control plane.

---

### The Four-Tier Scaling Path

```
SQLite brute-force (0 → 1K vectors)
  │  Zero config, automatic
  │  HNSW index auto-builds at 1K vectors
  ▼
SQLite + HNSW sidecar (1K → 500K vectors)
  │  Still zero infra — brain.sqlite + brain.hnsw
  │  O(log n) ANN search via hnswlib
  │  MigrationEngine.migrate({ from: sqlite, to: postgres })
  ▼
Postgres + pgvector (500K → 10M vectors)
  │  Multi-tenant, managed DB, native HNSW indexes
  │  RRF hybrid search in single SQL query
  │  MigrationEngine.migrate({ from: postgres, to: qdrant })
  ▼
Qdrant (10M → 1B+ vectors)
     Dedicated vector infra, sharding, quantization
```

The first transition (brute-force → HNSW sidecar) is **automatic** — no user action needed. Each subsequent step is a single `MigrationEngine.migrate()` call.

---

### Tier 1: SQLite (Default)

Every agent starts here. Zero infrastructure, zero configuration.

```typescript
const mem = await Memory.create(); // Defaults to SQLite at tmpdir
// or
const mem = await Memory.createSqlite({
  path: './brain.sqlite',
  embed: async (text) => yourEmbeddingFunction(text),
});
```

**What you get:**
- Single `brain.sqlite` file — copy it anywhere, agent has all its memories
- FTS5 hybrid search (BM25 + vector similarity with RRF fusion)
- Knowledge graph via recursive CTEs
- Binary blob embeddings (~50% smaller than JSON)
- SQL-level metadata filtering via `json_extract()`
- HNSW sidecar auto-builds when trace count exceeds 1,000

**When to scale up:**
- Query latency exceeds 200ms (typically at 100K+ vectors)
- Need multi-tenant isolation (multiple agents sharing a DB)
- Need concurrent write access (SQLite is single-writer)

---

### Tier 2: Postgres + pgvector

For Postgres-backed retrieval today, use the lower-level vector-store path.

```typescript
import { PostgresVectorStore } from '@framers/agentos';

const store = new PostgresVectorStore({
  id: 'agent-memory',
  type: 'postgres',
  connectionString: 'postgresql://postgres:password@localhost:5432/agent_memory',
});

await store.initialize();
await store.createCollection('agent_memory', 1536);
```

The standalone `Memory` facade does not yet open a Postgres brain directly.

### Auto-Setup

```typescript
import { MigrationEngine } from '@framers/agentos';

// Auto-provisions Docker Postgres + pgvector, then migrates SQLite → Postgres.
await MigrationEngine.migrate({
  from: { type: 'sqlite', path: './brain.sqlite' },
  to:   { type: 'postgres', autoSetup: true },
});
```

This will:
1. Check if Docker is running
2. Pull `postgres:16` image
3. Run container with pgvector extension
4. Create database and install pgvector
5. Migrate all data from SQLite
6. Save config to `~/.agentos/vector-store.json`

### Manual Setup

```typescript
// If you already have Postgres running:
await MigrationEngine.migrate({
  from: { type: 'sqlite', path: './brain.sqlite' },
  to:   { type: 'postgres', connectionString: 'postgresql://user:pass@host:5432/db' },
});
```

### What you get:
- Native HNSW indexes via pgvector (sub-10ms ANN at 1M+ vectors)
- RRF hybrid search in a single SQL CTE (vector + tsvector BM25)
- JSONB metadata filtering with GIN indexes
- Multi-tenant schema isolation (`agent_{id}` schemas)
- Connection pooling via `pg.Pool`
- Works with any managed Postgres (Neon, Supabase, RDS, Aiven)

---

### Tier 3: Qdrant

Purpose-built for extreme vector scale.

```typescript
import { MigrationEngine } from '@framers/agentos';

// Auto-provisions Docker Qdrant
await MigrationEngine.migrate({
  from: { type: 'sqlite', path: './brain.sqlite' },
  to:   { type: 'qdrant', autoSetup: true },
});

// Or connect to existing Qdrant
await MigrationEngine.migrate({
  from: { type: 'sqlite', path: './brain.sqlite' },
  to:   { type: 'qdrant', url: 'http://localhost:6333' },
});

// Or Qdrant Cloud — picked up from env when url/apiKey are not passed
// QDRANT_URL=https://abc123.us-east4-0.gcp.cloud.qdrant.io:6333
// QDRANT_API_KEY=your-api-key
await MigrationEngine.migrate({
  from: { type: 'sqlite', path: './brain.sqlite' },
  to:   { type: 'qdrant' },
});
```

### What you get:
- On-disk HNSW with sharding (billions of vectors)
- Scalar/binary quantization for memory efficiency
- Server-side RRF hybrid search (dense + sparse vectors)
- Collection-per-agent isolation
- Horizontal scaling across nodes

---

### Tier 4: Pinecone (Cloud)

Optional managed-cloud backend for teams that do not want to run Qdrant or Postgres themselves.

```typescript
import { PineconeVectorStore } from '@framers/agentos';

const store = new PineconeVectorStore({
  id: 'pinecone-prod',
  type: 'pinecone',
  apiKey: process.env.PINECONE_API_KEY!,
  indexHost: 'https://my-index-abc123.svc.aped-1234.pinecone.io',
  namespace: 'agent-memory',
});
```

**Pros:** Zero ops, SSO + SOC 2, scales to billions, generous free tier.
**Cons:** Not open source, not self-hostable, data leaves your infra.

Use Pinecone when managed-cloud convenience matters more than self-hosting. For the default production OSS path, use Qdrant.

Migration from Pinecone to self-hosted:
```typescript
await MigrationEngine.migrate({
  from: { type: 'pinecone', apiKey: process.env.PINECONE_API_KEY!, indexHost: '...' },
  to:   { type: 'qdrant',  url: 'http://localhost:6333' },
});
```

---

### Migration

```typescript
import { MigrationEngine } from '@framers/agentos';

// SQLite → Postgres (most common)
await MigrationEngine.migrate({
  from: { type: 'sqlite',   path: './brain.sqlite' },
  to:   { type: 'postgres', connectionString: process.env.DATABASE_URL! },
});

// SQLite → Qdrant
await MigrationEngine.migrate({
  from: { type: 'sqlite', path: './brain.sqlite' },
  to:   { type: 'qdrant', autoSetup: true },
});

// Postgres → Qdrant (scale-up)
await MigrationEngine.migrate({
  from: { type: 'postgres', connectionString: process.env.DATABASE_URL! },
  to:   { type: 'qdrant',   url: process.env.QDRANT_URL! },
});

// Pinecone → SQLite (bring data home)
await MigrationEngine.migrate({
  from: { type: 'pinecone', apiKey: process.env.PINECONE_API_KEY!, indexHost: '...' },
  to:   { type: 'sqlite',   path: './brain.sqlite' },
});

// Dry run (count rows, don't write)
await MigrationEngine.migrate({
  from:    { type: 'sqlite',   path: './brain.sqlite' },
  to:      { type: 'postgres', connectionString: process.env.DATABASE_URL! },
  dryRun:  true,
});
```

### Full programmatic example with progress

```typescript
import { MigrationEngine } from '@framers/agentos';

const result = await MigrationEngine.migrate({
  from: { type: 'sqlite', path: './brain.sqlite' },
  to: { type: 'postgres', connectionString: 'postgresql://...' },
  batchSize: 1000,
  onProgress: (done, total, table) => {
    console.log(`${table}: ${done}/${total}`);
  },
});

console.log(`Migrated ${result.totalRows} rows in ${result.durationMs}ms`);
```

### What gets migrated:
- Memory traces (with embeddings)
- Knowledge graph nodes + edges
- Documents + chunks
- Consolidation history
- Retrieval feedback signals

---

### Backend Comparison

| Feature | SQLite | Postgres | Qdrant | Pinecone |
|---------|--------|----------|--------|----------|
| **Scale** | 0–500K vectors | 500K–10M | 10M–1B+ | 10M–1B+ |
| **Setup** | Zero | Docker or managed | Docker or managed | Cloud only |
| **Self-hosted** | Yes (file) | Yes | Yes | No |
| **Open source** | Yes | Yes | Yes (Apache 2.0) | No |
| **HNSW ANN** | Via sidecar | Native pgvector | Native | Native |
| **Hybrid search** | FTS5 + RRF | tsvector + RRF | Sparse + RRF | Dense only* |
| **Knowledge graph** | Recursive CTEs | Recursive CTEs | Sidecar SQLite | Not supported |
| **Metadata filtering** | json_extract() | JSONB GIN | Payload filters | Metadata filters |
| **Multi-tenant** | One file per agent | Schema isolation | Collection isolation | Namespace isolation |
| **Offline** | Yes | If self-hosted | If self-hosted | No |
| **Cost** | Free | Free (self) / $25+ | Free (self) / $25+ | Free tier / $70+ |

*Pinecone supports sparse vectors for hybrid search but requires a separate sparse encoder.

---

### Docker Auto-Setup Details

The `--auto-setup` flag handles everything:

1. **Checks if backend is already running** (health check endpoint)
2. **Checks environment variables** (`QDRANT_URL`, `DATABASE_URL`)
3. **Checks Docker** (`docker info`)
4. **Checks for existing container** (`docker inspect agentos-qdrant`)
5. **Starts stopped container** or **pulls and runs new one**
6. **Waits for health check** (polls every 500ms, 15s timeout)
7. **Saves config** to `~/.agentos/vector-store.json`

If Docker isn't installed, you get a clear error with install instructions.

For cloud deployments, just set environment variables — Docker is skipped entirely:

```bash
# Qdrant Cloud
export QDRANT_URL=https://abc123.cloud.qdrant.io:6333
export QDRANT_API_KEY=your-key

# Managed Postgres (Neon, Supabase, etc.)
export DATABASE_URL=postgresql://user:pass@host:5432/db
```
