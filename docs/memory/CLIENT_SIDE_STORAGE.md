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

## A Page's Own Records

```typescript
import { Outbox, namespaced, openIndexedDbStore, reconcileList } from '@framers/agentos/core/storage/browser';

const root = await openIndexedDbStore({ dbName: 'notes-app', storeName: 'kv' });
const store = namespaced(root, 'account-1/');

await store.set('notes/n1', { title: 'Budget', text: 'Hiring opens in May.' });
await store.keys('notes/'); // ['notes/n1']

const outbox = new Outbox(store);
await outbox.add('update', { id: 'n1', title: 'Budget review' }, 'n1');
await outbox.flush(async (entry) => {
  const response = await fetch('/api/notes/update', { method: 'POST', body: JSON.stringify(entry.payload) });
  if (response.ok) return 'done';
  return response.status === 404 ? 'drop' : 'retry';
});

const held = new Set((await outbox.pending()).map((entry) => entry.subject));
const next = reconcileList(
  [{ id: 'n1', version: 3, pending: held.has('n1') }],
  { items: [{ id: 'n1', version: 4 }, { id: 'n2', version: 1 }], deleted: [], complete: false },
);
// next.fetch is ['n1', 'n2'], next.remove is []
```

`@framers/agentos/core/storage/browser` is for a page that keeps records of its own on the device and sends some of them to a server. Its key-value store is the one in [`@framers/sql-storage-adapter/kv`](https://github.com/framerslab/sql-storage-adapter), re-exported under the names below: that module's IndexedDB store is AgentOS's own code moved there unchanged (the same database, object store, version and upgrade handling), so a page's existing keys are read where they are, and AgentOS opens no IndexedDB itself. The kv module imports no adapter, so a page that loads it loads neither sql.js nor pg, and nothing here imports a Node module.

- `openIndexedDbStore({ dbName, storeName, version })` opens one object store with out-of-line keys, at `version` (1 unless given). A database that exists at that version is opened as it is, so a database another page made is read in place; the object store is made only when the open upgrades the database. When the browser refuses the database (no `indexedDB`, an `open` that throws or fails, a database above `version`, or an upgrade that waits for another tab), it answers a `MemoryKeyValueStore`, whose `memoryOnly` is `true`. An upgrade that waited for another tab still has its turn once that tab closes the database, and is aborted then, so the database stays as it was and no connection is left open.
- A store has `get`, `set`, `delete`, `keys(prefix)` and `deletePrefix(prefix)`. Values are copied with the structured clone, in memory as in IndexedDB, so a value read back is a copy. `keys` answers the keys in order. Over IndexedDB, `keys` and `deletePrefix` read the keys from `prefix` to `prefix` followed by U+FFFF, so keep keys to characters below U+FFFF.
- `namespaced(store, prefix)` answers a store whose keys all begin with `prefix`, given back without it, so two accounts on one browser never read each other's keys as long as neither prefix begins with the other: end each with a character the ids never hold, as `account-1/` does, since the keys under `anna` are among those under `ann` while `ann/` and `anna/` never meet. Each call makes a new store object.
- `Outbox` keeps each change as a value of the store under its prefix (`outbox/` unless given), with its `kind`, `payload`, `subject`, `attempts`, `createdAt` and `nextAt`, ordered by the time it was added. `flush(send)` sends the due changes in order and answers `{ sent, dropped, waiting }`: `done` and `drop` remove a change; `retry`, or a `send` that throws, keeps it until its backoff has passed (2 seconds after the first retry, doubling to at most 5 minutes, unless `backoffMs` says otherwise) and ends the flush there, so a later change never passes an earlier one. `waiting` counts every change the store holds when the flush ends, one added while it ran among them. One flush runs at a time for a store object and prefix: a flush asked for during another starts when that one ends. So a `send` never waits for a flush of its own outbox, which would start only when the flush running that `send` ends: the `send` returns, and the next flush sends the rest. `namespaced` makes a new store object at each call, so make the outboxes of one prefix over one namespaced store: outboxes over two hold the same changes and take no turns, as two tabs do. A change can reach the server twice (a confirmation lost on the way, or the page open in two tabs). Two tabs take no turns with each other, so between them the order can break too: one tab can send an earlier change after the other has sent a later one, and a retry in one tab puts back a change the other has already sent, to be sent again after the later one. Make every change safe to apply twice and out of order, or let one tab flush at a time. An entry's `createdAt` is the device's clock when it was held, so it cannot order every change: two tabs can hold changes in the same millisecond, and a clock set back gives a later change an earlier time; a server that must refuse a stale change compares a version it assigns itself. `waitingFor(subject)` says whether a change about a subject is held. Each call reads every held change, so for a list, read `pending()` once and take the subjects from it, as the example does.
- `createSqlKeyValueStore(adapter, { table })` answers the same store over a SQL table on any adapter of the library: `IndexedDbAdapter` in a browser, SQLite on a phone or a desktop, PostgreSQL on a server. The table, with a `key` and a `value` column, is made when it is missing; the adapter must be open, and the store never closes it. It keeps each value as text and gives it back as the structured clone gives it, so `Outbox` runs over either store. Text cannot hold a host object, so a value holding a `Blob`, a `File`, an `ImageData`, a `CryptoKey` or one of the other host objects its [value codec](https://github.com/framerslab/sql-storage-adapter/blob/master/src/features/kv/valueCodec.ts) names is refused with a `DataCloneError` before anything is written: the key keeps what it held, and an outbox's `add` holds nothing. IndexedDB keeps a `Blob`, a `File`, an `ImageData` and a `CryptoKey`, so a value that holds one belongs in the IndexedDB store.

  ```typescript
  import { IndexedDbAdapter } from '@framers/sql-storage-adapter/indexeddb';
  import { Outbox, createSqlKeyValueStore } from '@framers/agentos/core/storage/browser';

  const db = new IndexedDbAdapter({ dbName: 'notes-app', durability: 'commit' });
  await db.open();
  const store = await createSqlKeyValueStore(db, { table: 'notes_kv' });
  const outbox = new Outbox(store);
  ```

- `reconcileList(local, server)` compares the server's list with the device's copies. `fetch` holds the ids the server names that the device lacks or holds at a lower version; `remove` holds the ids the device holds that the server does not name, when the server lists them as deleted or its list is `complete`. An entry whose `pending` is true is never removed.

The library's browser entry, `@framers/agentos/cognition/library/browser`, exports the same names beside the lexical index a page searches with ([Library Index](../features/LIBRARY_INDEX.md#on-a-device)).

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
