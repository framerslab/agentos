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

- persists conversations in the tables `conversations` and `conversation_messages`, which `ConversationManager` creates, unless `conversationManagerConfig.persistenceEnabled` is `false`; with `conversationManagerConfig.tablePrefix` the tables are `<prefix>conversations` and `<prefix>conversation_messages`, which a host sets before the runtime first starts on an adapter that also holds a memory Brain (whose own `conversations` table has other columns; the runtime refuses an adapter where the Brain made that table first, naming the option);
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
- `createSqlKeyValueStore(adapter, { table })` answers the same store over a SQL table on any adapter of the library: `IndexedDbAdapter` in a browser, SQLite on a phone or a desktop, PostgreSQL on a server. The table, with a `key` and a `value` column, is made when it is missing; the adapter must be open, and the store never closes it. It keeps each value as text and gives it back as the structured clone gives it, so `Outbox` runs over either store. Text cannot hold a host object, so a value holding a `Blob`, a `File`, an `ImageData`, a `CryptoKey` or one of the other host objects its [value codec](https://github.com/framerslab/sql-storage-adapter/blob/master/src/features/kv/valueCodec.ts) names is refused with a `DataCloneError` before anything is written: the key keeps what it held, and an outbox's `add` holds nothing. IndexedDB keeps a `Blob`, a `File`, an `ImageData` and a `CryptoKey`, so a value that holds one belongs in the IndexedDB store. In a browser, open `IndexedDbAdapter` with `crossTab: true` under an outbox, as the example does: each write is then stored before it resolves, and each statement first loads what another tab has stored. Without `crossTab`, each tab keeps its own copy of the database in memory and stores the whole copy over what another tab stored, so a change one tab's outbox held is gone once another tab stores its copy; and unless `durability` is `'commit'`, a write resolves before it is stored, at the next save (every 5 seconds unless `saveIntervalMs` says otherwise). sql.js loads its WebAssembly from the address `sqlJsConfig.locateFile` answers, so serve the files of sql.js's `dist` folder and answer their address: without `locateFile`, sql.js asks for the file relative to the page or its script, where a bundled app serves nothing unless it is set up to.

  ```typescript
  import { IndexedDbAdapter } from '@framers/sql-storage-adapter/indexeddb';
  import { Outbox, createSqlKeyValueStore } from '@framers/agentos/core/storage/browser';

  const db = new IndexedDbAdapter({
    dbName: 'notes-app',
    crossTab: true,
    // The files of sql.js's dist folder, which the app serves under /sql.js/.
    sqlJsConfig: { locateFile: (file: string) => `/sql.js/${file}` },
  });
  await db.open();
  const store = await createSqlKeyValueStore(db, { table: 'notes_kv' });
  const outbox = new Outbox(store);
  ```

- `reconcileList(local, server)` compares the server's list with the device's copies. `fetch` holds the ids the server names that the device lacks or holds at a lower version; `remove` holds the ids the device holds that the server does not name, when the server lists them as deleted or its list is `complete`. An entry whose `pending` is true is never removed.
- `openRunOwner(options)`, also at its own subpath, `@framers/agentos/core/storage/browser/runs`, keeps a page's long runs (an import, an export, an upload) above its views: one owner a page per account. A run is a job the page writes: a `key` of 64 lowercase hexadecimal characters that names the job across tabs and attempts (a hash of what was chosen, made by the page), what it counts (`unit`), what was chosen in a form the page's `isChosen` check allows, and `run(context)`. `start(job)` takes a Web Lock named for the job (`webRunLocks()`) and answers `{ refused: 'another-tab' }` at once while another tab holds it; otherwise it writes the run's record under `keyPrefix` before the job's first write and runs the job. The record holds fourteen fields, and `isRunRecord` refuses any other: the counts (`total`, `pending`, `applied`, `skipped`, `failed`), each item's index and state (with a name for a failed item alone), the state, the cut mark, the phase and two times. No file's contents, pasted text or title reaches it through the owner, but its strings are the page's (`kind`, `way`, a failed item's name, and whatever `isChosen` lets `chosen` hold, such as a file's name in the example), so keep anything sensitive out of them. `context.counts`, `item` and `phase` change the run in memory; the record follows at most once a second, at once when the page is hidden away, and at the end, and every write after the first changes a record that exists and never makes one. Every content write goes through `context.write(work)`, which runs `work` under the record's lock (the page's `locks` and `lockName`, the lock it takes to change or delete the record itself) only while the record exists with no cut mark, and answers `{ fenced: true }` otherwise. A `BroadcastChannel` named by the page carries each run's counts with the account's id, and a beat every two seconds while the run lives: another tab draws the run as `watched`, and reads a live record as `cut` only once its lock is free, never on silence. A reload or a closed tab lets the lock go, so the next load reads the run as cut and the page offers to finish it (`finish(id, job)`, under the cut record's id). With no channel, every owner reads the records once a second, so it follows another tab's run and finds one started later, and stops a run of its own whose record another tab's account stop deleted or marked; a start in another tab that writes its record after the stop's second listing is neither fenced nor in that stop's answer, so its `{ complete: true }` does not cover it. `stop(id)` stops the run after the item in hand; `continueRun(id, job)` starts the next attempt under the same lock; `shown(id)` deletes a finished, stopped or failed record once its end is drawn (another tab's failed record under its run lock, so a finish meanwhile is refused), while an unsaved export's waits for `saved(id)` or `dismiss(id)`; `hide(id)` stops drawing another tab's run in this page alone. `stopAccount(cut)` is for a removal, which deletes every record of the account, and for a sign-out or a session's end, which marks every live one: it does that under each record's lock first, so a write in flight lands before it and every later write is refused, then stops the account's runs in this tab and, through the channel, in every other, and waits for their locks. It lists the records a second time after its message and fences every one again, so the record of a run another tab started between the first listing and the message is deleted or marked too, and so is one whose mark a finish in a tab that has not heard the stop cleared meanwhile, and every tab that hears the stop deletes or marks its own runs' records as well. The whole stop answers within ten seconds: the store's listings, the waits for the records' locks and for the runs' locks, this owner's starts still taking their locks or writing their records, and the last read of the rows after a sign-out or a session's end share them. A write whose `work` has not returned by then keeps its record's lock, and that record is deleted or marked once it returns. The stop answers `{ complete: true }` once the store listed the records and every record of the account was deleted or marked, this owner's starts in flight among them, and `{ complete: false }` when the store refused a listing, a read, a deletion or a mark (a start's included, whenever that start settled while the stop ran), or a listing had not answered by the ten seconds, or a write or a start of this owner was still in flight then (a write of a run kept in memory alone, which holds no record lock, among them); the last read of the rows redraws them and leaves the answer as it is; the runs are stopped all the same, and calling `stopAccount` again tries once more. The answer speaks for the records alone: a job that does not end when its `context.signal` aborts, or keeps working outside `context.write` (a network request in flight, say), can still be running when the stop answers `{ complete: true }`, so a job ends at its abort and the page does not read the answer as the end of that work. `records()` is no such check: it lists the records the store let it read, with the runs this owner holds whether their records remain or not. A start still waiting for its lock when the account stops, or made while the stop runs, is fenced from its start, even when the stop has ended by the time its lock is granted. A tab that hears another tab's stop counts that stop as running for the ten seconds after its message, the longest it runs, so a start made there meanwhile is fenced from its start as well and that tab deletes or marks its record, though the stop's second listing had already read the records (a deletion or a mark the store refuses there is not in the stopping tab's answer). A finish takes the cut run's own lock as well as its new job's, refuses a record it cannot find or read (its read under the record's lock included), one another tab removed meanwhile, one another tab finished under another key since this page read it, and one whose cut mark changed since then (another tab's sign-out, say) (that record is drawn again as stored, so a second finish takes its current key's lock), starting nothing in their place, and goes on from the record's counts and items as stored, so another tab's finish and cut since this page read it are kept; a page that drew the run as ended draws its new attempt as running and counts its end; `dismiss` holds the run's lock while it deletes the record, and it and `shown` keep a record another tab finished under another key since this page read it, drawn as stored, and keep the row for another try when the store refuses the deletion (`dismiss` answers `{ refused: 'another-tab' }` then). `snapshot()` and `subscribe` give the runs as drawn, at most four changes a second; `subscribeEnds` is called once at each run's end and never at a count, with two exceptions: a run the account's stop or a dismissal fenced calls it at no end, nor does one they reach while its last record write is in flight, and with no channel a run watched in another tab calls it only when its record turns failed or unsaved, so its finish, stop or cut there is not heard. When the store refuses the run's first record, the run goes on in memory (`snapshot().unavailable`) and the account's stop still reaches it; when it refuses one read of the gate, that write is fenced by the run's state in memory and the next write reads the record again. The owner opens no database, writes no log line and holds no word a person reads.

  Three limits follow from what a page can know. The one-job rule across tabs needs the browser's Web Locks: where `navigator.locks` is missing or refuses the request, `webRunLocks()` keeps the names in the page alone, so two tabs can start the same job, and record locks built on `navigator.locks`, as in the example, fail too, which leaves the run in memory alone. And the write gate checks the record only when the store answers: when the run's first record could not be written, or one read or the record lock fails, that write is fenced by the run's state in this tab alone (the account's stop made here or heard on the channel, a dismissal, its own cut), so a stop in another tab whose message has not reached this tab does not fence it, and that stop's answer does not cover such a write in flight here. And the records reach every tab only through a store the tabs share: when the browser refuses the database, `openIndexedDbStore` answers a `MemoryKeyValueStore` whose `memoryOnly` is `true`, and each tab then keeps records of its own. A stop in another tab neither lists them nor, with no channel, reaches the runs they belong to, and its `{ complete: true }` speaks for the records of its own store alone; with the channel, every tab that hears the stop still stops its runs and deletes or marks its own records. A page whose store is `memoryOnly` cannot count on another tab's stop without the channel.

  ```typescript
  import { namespaced, openIndexedDbStore } from '@framers/agentos/core/storage/browser';
  import { openRunOwner, webRunLocks } from '@framers/agentos/core/storage/browser/runs';

  /** What a run may record as chosen: a file's name, size and time, every key named, nothing else (never the file itself). */
  const isChosenFile = (chosen: unknown): boolean => {
    if (typeof chosen !== 'object' || chosen === null || Object.keys(chosen).join() !== 'file') return false;
    const file: unknown = (chosen as { file: unknown }).file;
    if (typeof file !== 'object' || file === null || Object.getPrototypeOf(file) !== Object.prototype) return false;
    const { name, size, lastModified, ...rest } = file as Record<string, unknown>;
    return typeof name === 'string' && typeof size === 'number' && typeof lastModified === 'number' && Object.keys(rest).length === 0;
  };

  const store = namespaced(await openIndexedDbStore({ dbName: 'notes-app', storeName: 'kv' }), 'account-1/');
  const owner = openRunOwner({
    store,
    keyPrefix: 'runs/',
    account: 'account-1',
    locks: { request: (name, work) => navigator.locks.request(name, work) },
    lockName: (key) => `notes-app-record-${key}`,
    runLocks: webRunLocks(),
    lockPrefix: 'notes-app-run-',
    isChosen: isChosenFile,
    channel: 'notes-app-runs',
  });

  const started = await owner.start({
    key: jobKey, // the page's hash of what was chosen
    kind: 'import', way: 'file', unit: 'notes', network: false, total: notes.length,
    chosen: { file: { name: file.name, size: file.size, lastModified: file.lastModified } },
    async run(context) {
      for (const [index, note] of notes.entries()) {
        if (context.signal.aborted) return { ended: 'stopped', counts: context.record().counts };
        // saveNote writes the note under its own id, so writing it again changes nothing.
        const wrote = await context.write(async () => { await saveNote(note); return true; });
        if (wrote !== true) return { ended: 'fenced', counts: context.record().counts };
        context.counts({ applied: index + 1, pending: notes.length - index - 1 });
      }
      return { ended: 'finished', counts: context.record().counts };
    },
  });
  // started is { id } or { refused: 'another-tab' }
  ```

  The record follows the counts at most once a second, so it can trail the content writes, and a run cut by a reload or a closed tab may not have written its last counts: a finish or a next attempt goes on from the counts as stored and can repeat the writes made since. Keep a job's content writes repeatable, such as a write keyed by the item's own id as `saveNote` is above, or keep a checkpoint of the content in the same write; the example goes over every note on each attempt, which such writes allow.

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
