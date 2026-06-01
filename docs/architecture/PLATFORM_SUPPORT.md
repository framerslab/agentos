# AgentOS Platform Support

AgentOS integrates with the [SQL Storage Adapter](https://github.com/framerslab/sql-storage-adapter) as its primary persistence interface. This enables a single codebase to run across Cloud (PostgreSQL), Desktop (Electron with [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3)), Mobile ([Capacitor SQLite](https://github.com/capacitor-community/sqlite)), and Browser/Edge ([`sql.js`](https://github.com/sql-js/sql.js) fallback).

- Storage adapter overview: [`packages/sql-storage-adapter/README.md`](https://github.com/framerslab/sql-storage-adapter/blob/master/README.md).
- Storage adapter internals: [`packages/sql-storage-adapter/ARCHITECTURE.md`](https://github.com/framerslab/sql-storage-adapter/blob/master/ARCHITECTURE.md).
- Platform strategy: [`PLATFORM_STRATEGY.md`](https://github.com/framerslab/sql-storage-adapter/blob/master/PLATFORM_STRATEGY.md).

## Defaults

- SaaS (Cloud): prefer PostgreSQL via `DATABASE_URL` — [`postgresAdapter`](https://github.com/framerslab/sql-storage-adapter/blob/master/src/adapters/postgresAdapter.ts).
- Desktop: prefer [`betterSqliteAdapter`](https://github.com/framerslab/sql-storage-adapter/blob/master/src/adapters/betterSqliteAdapter.ts), fallback to [`sqlJsAdapter`](https://github.com/framerslab/sql-storage-adapter/blob/master/src/adapters/sqlJsAdapter.ts).
- Mobile: prefer [`capacitorSqliteAdapter`](https://github.com/framerslab/sql-storage-adapter/blob/master/src/adapters/capacitorSqliteAdapter.ts).
- Browser: [`sqlJsAdapter`](https://github.com/framerslab/sql-storage-adapter/blob/master/src/adapters/sqlJsAdapter.ts) only, with [`indexedDbAdapter`](https://github.com/framerslab/sql-storage-adapter/blob/master/src/adapters/indexedDbAdapter.ts) export/import for persistence.

## AgentOS Usage

- Use [`createDatabase()`](https://github.com/framerslab/sql-storage-adapter/blob/master/src/core/database.ts) from [`@framers/sql-storage-adapter`](https://github.com/framerslab/sql-storage-adapter) in AgentOS services. Returns a uniform [`StorageAdapter`](https://github.com/framerslab/sql-storage-adapter/blob/master/src/core/contracts/index.ts) regardless of backend.
- Branch optional features by adapter capabilities ([`AdapterCapabilities`](https://github.com/framerslab/sql-storage-adapter/blob/master/src/core/contracts/index.ts)): JSON / arrays / streaming only when supported.
- Degrade gracefully (hide orgs/billing where unsupported, provide export/import when no cloud backup).

## Source files

| Surface | Repo | Path |
|---|---|---|
| [`createDatabase()`](https://github.com/framerslab/sql-storage-adapter/blob/master/src/core/database.ts) | `framerslab/sql-storage-adapter` | `src/core/database.ts` |
| [`StorageAdapter` contract](https://github.com/framerslab/sql-storage-adapter/blob/master/src/core/contracts/index.ts) | `framerslab/sql-storage-adapter` | `src/core/contracts/index.ts` |
| [`postgresAdapter`](https://github.com/framerslab/sql-storage-adapter/blob/master/src/adapters/postgresAdapter.ts) | `framerslab/sql-storage-adapter` | `src/adapters/postgresAdapter.ts` |
| [`betterSqliteAdapter`](https://github.com/framerslab/sql-storage-adapter/blob/master/src/adapters/betterSqliteAdapter.ts) | `framerslab/sql-storage-adapter` | `src/adapters/betterSqliteAdapter.ts` |
| [`sqlJsAdapter`](https://github.com/framerslab/sql-storage-adapter/blob/master/src/adapters/sqlJsAdapter.ts) | `framerslab/sql-storage-adapter` | `src/adapters/sqlJsAdapter.ts` |
| [`capacitorSqliteAdapter`](https://github.com/framerslab/sql-storage-adapter/blob/master/src/adapters/capacitorSqliteAdapter.ts) | `framerslab/sql-storage-adapter` | `src/adapters/capacitorSqliteAdapter.ts` |
| [`indexedDbAdapter`](https://github.com/framerslab/sql-storage-adapter/blob/master/src/adapters/indexedDbAdapter.ts) | `framerslab/sql-storage-adapter` | `src/adapters/indexedDbAdapter.ts` |
| [`supabase` adapter](https://github.com/framerslab/sql-storage-adapter/blob/master/src/adapters/supabase.ts) | `framerslab/sql-storage-adapter` | `src/adapters/supabase.ts` |
| [Adapter tree (all backends)](https://github.com/framerslab/sql-storage-adapter/tree/master/src/adapters) | `framerslab/sql-storage-adapter` | `src/adapters/` |


