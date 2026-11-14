/**
 * @fileoverview A page's storage: the key-value store, the outbox, list reconciliation and the run owner (`runs.ts`,
 * also its own subpath, `@framers/agentos/core/storage/browser/runs`). The key-value store is the
 * library's, `@framers/sql-storage-adapter/kv`, under the names it has always had here: that module's IndexedDB store
 * is this folder's own code moved there unchanged (the same database, object store, version and upgrade handling), so
 * a page's keys stay where they are, and AgentOS opens no IndexedDB itself. The module imports no adapter, so a page
 * that loads it loads neither sql.js nor pg. Node-free and DOM-free but for IndexedDB, which the store reaches only
 * when it is opened, the Web Storage a caller hands `WebStorageKeyValueStore` (a tab's `sessionStorage`), and the Web
 * Locks, `BroadcastChannel` and page events the run owner reaches where the page has them.
 * @module agentos/core/storage/browser
 */

// One statement: the library is the one module this entry reaches outside the repository, and a test counts them.
export {
  MemoryKeyValueStore,
  namespaced,
  IndexedDbKeyValueStore,
  openIndexedDbStore,
  idb,
  createSqlKeyValueStore,
  WebStorageKeyValueStore,
  StorageFullError,
  type KeyValueStore,
  type IndexedDbStoreOptions,
  type SqlKeyValueStoreOptions,
} from '@framers/sql-storage-adapter/kv';
export { Outbox, type OutboxEntry, type OutboxOptions, type OutboxSend } from './Outbox.js';
export { reconcileList, type CachedEntry, type ServerList } from './reconcile.js';
export {
  openRunOwner,
  webRunLocks,
  isRunRecord,
  runLockName,
  type RunRecord,
  type RunCounts,
  type RunUnit,
  type RunItemState,
  type RunState,
  type RunCut,
  type RunPhase,
  type RunItem,
  type RunJob,
  type RunContext,
  type RunEnd,
  type RunOwner,
  type RunOwnerOptions,
  type RunLocks,
  type RunRead,
  type RunStatus,
  type RunsSnapshot,
  type RunMessage,
  type RunChannel,
} from './runs.js';
