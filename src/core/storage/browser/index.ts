/**
 * @fileoverview A page's storage: the key-value store, the outbox and list reconciliation. The key-value store is the
 * library's, `@framers/sql-storage-adapter/kv`, under the names it has always had here: that module's IndexedDB store
 * is this folder's own code moved there unchanged (the same database, object store, version and upgrade handling), so
 * a page's keys stay where they are, and AgentOS opens no IndexedDB itself. The module imports no adapter, so a page
 * that loads it loads neither sql.js nor pg. Node-free and DOM-free but for IndexedDB, which the store reaches only
 * when it is opened.
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
  type KeyValueStore,
  type IndexedDbStoreOptions,
  type SqlKeyValueStoreOptions,
} from '@framers/sql-storage-adapter/kv';
export { Outbox, type OutboxEntry, type OutboxOptions, type OutboxSend } from './Outbox.js';
export { reconcileList, type CachedEntry, type ServerList } from './reconcile.js';
