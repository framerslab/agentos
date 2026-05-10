---
title: SQL Storage Quickstart
description: One storage adapter for AgentOS that runs on better-sqlite3, sql.js, Postgres, Supabase, Capacitor SQLite, and IndexedDB — automatic backend detection, schema parity, cloud backups
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
---

# SQL Storage Quickstart

`@framers/sql-storage-adapter` is the storage layer used by every AgentOS persistence path (cognitive memory, agency memory, SQL storage archive). It exposes one `createDatabase()` factory that returns a uniform `StorageAdapter` interface backed by `better-sqlite3`, `sql.js`, IndexedDB, Capacitor SQLite, Postgres, or Supabase. Application code is identical across all six. The runtime auto-detects the right backend per environment, or picks it explicitly via the `type` option.

This page covers the public API: how to pick a backend, the `StorageAdapter` contract, cloud backups, cross-backend migrations, and how AgentOS memory subsystems consume it.

## What you get

| Backend | When it runs | Bundle / install cost |
|---|---|---|
| `better-sqlite3` | Node, when the native binding installs cleanly | Native build (~5 MB) — fastest in-process SQLite available |
| `sql.js` | Node fallback when `better-sqlite3` won't build; also runs in workers | ~1 MB WASM, pure-JS — slower than `better-sqlite3` but boring to deploy |
| `indexeddb` | Browser, when `sql.js` isn't loaded | Built into every browser; persistent across reloads |
| `capacitor-sqlite` | iOS / Android via Capacitor | Native plugin; uses the OS SQLite |
| `postgres` | Server-side production | `pg` driver; full PG capabilities (FTS, JSONB, GIN indexes) |
| `supabase` | Edge / Postgres-via-REST | Supabase's Postgres + Auth + row-level security; no direct TCP needed |

All six speak the same [`StorageAdapter`](https://github.com/framersai/agentos/blob/master/packages/sql-storage-adapter/src/adapters/baseStorageAdapter.ts) interface. The application code is unchanged.

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
- **Multi-instance Node service, real users** → `postgres`. The driver pools connections, schema migrations cross instances cleanly, and Postgres FTS via [`PostgresFts`](https://github.com/framersai/agentos/blob/master/packages/sql-storage-adapter/src/fts/PostgresFts.ts) outranks SQLite FTS5 on anything past a few hundred MB.
- **Mobile (iOS/Android via Capacitor)** → `capacitor-sqlite`. Native bindings, hits the OS SQLite, encrypted-at-rest support via SQLCipher if you need it.
- **Browser playground / extension** → `sqljs` + `indexeddb`. The runtime auto-falls back here when no native binding is available. Loads ~1 MB of WASM lazily.
- **Edge / Cloudflare Workers / Supabase project** → `supabase`. Uses the REST data layer + row-level security; no TCP needed, works on Workers.
- **Electron app with both renderer + main process** → `electron` subpath. Routes queries through IPC so the renderer doesn't open a duplicate handle.

`createDatabase()` with `type: 'auto'` (the default if you omit `type`) walks this list and picks the first backend whose runtime check passes. For most apps you should pass the type explicitly so the deployment doesn't silently drift between dev and prod.

## The contract

Every adapter implements the same [`StorageAdapter`](https://github.com/framersai/agentos/blob/master/packages/sql-storage-adapter/src/adapters/baseStorageAdapter.ts) interface:

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

That's it. No ORM, no query builder, no proprietary dialect. The SQL you write is the SQL the underlying engine sees, with one caveat: parameter placeholders are normalized to `?` on the way in and rewritten to `$1, $2…` for Postgres / Supabase by [`parameterUtils`](https://github.com/framersai/agentos/blob/master/packages/sql-storage-adapter/src/shared/parameterUtils.ts). Always use `?`; never hardcode `$1` or the Postgres dialect-specific form.

For dialect-specific bits (FTS5 vs `tsvector`, JSON vs JSONB, AUTOINCREMENT vs SERIAL), the package ships [`SqliteDialect`](https://github.com/framersai/agentos/blob/master/packages/sql-storage-adapter/src/dialects/SqliteDialect.ts) and [`PostgresDialect`](https://github.com/framersai/agentos/blob/master/packages/sql-storage-adapter/src/dialects/PostgresDialect.ts) — abstractions over the differences that matter (FTS, blob encoding, identifier quoting). Most application code never touches them.

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

The backup runs at the cadence you set, compresses with gzip (usually 40–60% smaller), and prunes anything past `maxBackups` so you don't accumulate forever. Restores go through `backup.restore(timestamp)`. The source lives in [`features/backup/cloudBackup.ts`](https://github.com/framersai/agentos/blob/master/packages/sql-storage-adapter/src/features/backup/cloudBackup.ts).

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

The exporter walks each table, paginates by primary key, serializes blobs through the [`NodeBlobCodec`](https://github.com/framersai/agentos/blob/master/packages/sql-storage-adapter/src/codecs/NodeBlobCodec.ts) (or the browser codec when running there), and writes a streaming JSON file. The importer replays it inside one transaction per table, so a failed migration leaves the destination in a clean state.

For zero-downtime migrations on a running production cluster, mirror writes to both databases for a window, run the export against the old one at a quiescent point, then cut traffic over and roll the old one offline.

## Wiring into AgentOS

The AgentOS [`Brain`](https://github.com/framersai/agentos/blob/master/src/memory/Brain.ts) and [`CognitiveMemoryManager`](https://github.com/framersai/agentos/blob/master/src/memory/CognitiveMemoryManager.ts) both accept a `StorageAdapter` directly:

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

Same pattern wires the [`SqlStorageMemoryArchive`](https://github.com/framersai/agentos/blob/master/src/memory/archive/SqlStorageMemoryArchive.ts) (the gist/rehydrate store) and the [`AgencyMemoryManager`](https://github.com/framersai/agentos/blob/master/src/memory/AgencyMemoryManager.ts) (shared memory across multi-agent agencies). One adapter, one connection pool, every memory subsystem shares it.

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
- [`@framers/sql-storage-adapter` README](https://github.com/framersai/agentos/tree/master/packages/sql-storage-adapter) — full API reference + per-adapter notes
- [`baseStorageAdapter.ts`](https://github.com/framersai/agentos/blob/master/packages/sql-storage-adapter/src/adapters/baseStorageAdapter.ts) — the `StorageAdapter` contract
