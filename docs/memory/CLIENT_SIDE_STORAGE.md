# Client-Side Storage for AgentOS

The full runtime keeps its data in a `StorageAdapter` from [`@framers/sql-storage-adapter`](https://github.com/framerslab/sql-storage-adapter), passed as `storageAdapter` in the AgentOS config. The adapter package runs SQLite in Node, Electron and Capacitor apps and in browsers (sql.js, with IndexedDB for persistence), so the same runtime code stores to a local file or to the browser.

---

## Quick Start

```bash
npm install @framers/agentos @framers/sql-storage-adapter
```

```typescript
import { resolveStorageAdapter } from '@framers/sql-storage-adapter';
import { AgentOS } from '@framers/agentos';

// Picks an adapter for the runtime and opens it: Capacitor on a native
// Capacitor platform; IndexedDB then sql.js in a browser; Postgres first when
// DATABASE_URL is set; otherwise better-sqlite3, IndexedDB, then sql.js.
const storageAdapter = await resolveStorageAdapter();

const agentos = await AgentOS.create({ storageAdapter });
```

With a `storageAdapter`, the runtime:

- persists conversations in the tables `conversations` and `conversation_messages`, which `ConversationManager` creates, unless `conversationManagerConfig.persistenceEnabled` is `false`;
- hands the adapter to SQL vector-store providers that name no adapter of their own, unless `ragConfig.bindToStorageAdapter` is `false`;
- wraps it so its writes go through the provenance hooks, when the provenance extension is active;
- uses it for the self-improvement tools' storage.

`initialize(config)` throws unless the config has a `storageAdapter` or a `prisma` client. `AgentOS.create()` sets `prisma` to AgentOS's built-in stub (`PrismaClient` from `src/core/storage/prismaClient.ts`), which answers every model call with a warning, so pass a `storageAdapter` for data you want kept.

---

## Platform Adapters

### Web (Browser)

```typescript
import { IndexedDbAdapter } from '@framers/sql-storage-adapter';

const storageAdapter = new IndexedDbAdapter({
  dbName: 'agentos-workbench', // default 'app-db'
  autoSave: true,              // default true
  saveIntervalMs: 5000,        // default 5000
});
await storageAdapter.open();
```

The adapter runs SQLite through sql.js (WebAssembly) and saves the database to IndexedDB. Pass `sqlJsConfig: { locateFile }` when the WebAssembly file is served from your own path. The browser sets the storage quota.

`IndexedDbAdapter` can export and import the whole database as SQLite file bytes:

```typescript
const bytes = storageAdapter.exportDatabase(); // Uint8Array
const link = document.createElement('a');
link.href = URL.createObjectURL(new Blob([bytes], { type: 'application/x-sqlite3' }));
link.download = 'agentos-backup.db';
link.click();

const file = await fileInput.files[0].arrayBuffer();
await storageAdapter.importDatabase(new Uint8Array(file));
```

These two methods belong to `IndexedDbAdapter`; for other adapters, use `exportAsJSON()` and `importFromJSON()` from the same package ([Storage & Scaling](../getting-started/SQL_STORAGE_QUICKSTART.md#moving-data-between-adapters)).

### Desktop (Electron)

```typescript
import { createElectronMainAdapter } from '@framers/sql-storage-adapter/electron';
import path from 'node:path';
import { app } from 'electron';

const storageAdapter = createElectronMainAdapter({
  filePath: path.join(app.getPath('userData'), 'agentos.db'),
});
await storageAdapter.open();
```

The main-process adapter uses better-sqlite3; `createElectronRendererAdapter()` reaches it from a renderer over IPC. Outside Electron, `new BetterSqliteAdapter(filePath)` opens the same kind of file.

To fall back to sql.js when better-sqlite3 does not load, give the resolver an order:

```typescript
import { resolveStorageAdapter } from '@framers/sql-storage-adapter';

const storageAdapter = await resolveStorageAdapter({
  priority: ['better-sqlite3', 'sqljs'],
  filePath: './db_data/agentos.sqlite3',
});
```

Without `priority`, the resolver reads the `STORAGE_ADAPTER` environment variable (for example `STORAGE_ADAPTER=sqljs`) before its own order. Its default file is `db_data/app.sqlite3` under the working directory.

### Mobile (Capacitor)

```typescript
import { CapacitorSqliteAdapter } from '@framers/sql-storage-adapter';

const storageAdapter = new CapacitorSqliteAdapter({ database: 'agentos-mobile' });
await storageAdapter.open();
```

The adapter uses the `@capacitor-community/sqlite` plugin. In a WebView without Capacitor, use `IndexedDbAdapter`.

---

## Syncing a Local Database

The adapter package has two sync layers:

- `createSyncManager({ primary, remote, sync })`, from the package root, keeps a local database and a remote one in step. `sync.mode` is `manual` (the default), `auto`, `periodic` (with `interval`), `realtime` or `on-reconnect`; `sync.conflictStrategy` is `last-write-wins` (the default), `local-wins`, `remote-wins`, `merge` or `keep-both`.
- `createCrossPlatformSync({ localAdapter, endpoint, tables, ... })`, from `@framers/sql-storage-adapter/sync`, syncs a local adapter with a sync server at `endpoint` over WebSocket or HTTP.

See the [sql-storage-adapter repository](https://github.com/framerslab/sql-storage-adapter) for their options.

---

## Choosing an Adapter

| Platform | Adapter |
|---------|-----------|
| Browser | `IndexedDbAdapter` (sql.js in memory, saved to IndexedDB) |
| Electron | `createElectronMainAdapter()` (better-sqlite3 in the main process) |
| Node | `createDatabase({ type: 'sqlite', file })` or `new BetterSqliteAdapter(file)` |
| Capacitor | `CapacitorSqliteAdapter` |
| A shared server database | `createDatabase({ type: 'postgres', url })` |

---

## Troubleshooting

### "IndexedDB quota exceeded"

Export the database, then delete old rows, for example older messages:

```typescript
const backup = storageAdapter.exportDatabase();
await storageAdapter.run('DELETE FROM conversation_messages WHERE timestamp < ?', [cutoffMs]);
```

### "better-sqlite3 failed to build"

Install the native build tools (`xcode-select --install` on macOS; `python3` and `build-essential` on Debian and Ubuntu), or resolve with `priority: ['better-sqlite3', 'sqljs']` so sql.js takes over.

### "Storage not persisting across page refresh"

With `autoSave` on (the default), `IndexedDbAdapter` saves changed data to IndexedDB every `saveIntervalMs`. With `autoSave: false`, it saves only on `close()` and `importDatabase()`, so changes made since the last `close()` are lost when the page unloads first.

---

## Next Steps

- [Storage & Scaling](../getting-started/SQL_STORAGE_QUICKSTART.md): the adapter API, backups and migrations
- [Platform strategy](https://github.com/framerslab/sql-storage-adapter/blob/master/PLATFORM_STRATEGY.md) in the sql-storage-adapter repository
