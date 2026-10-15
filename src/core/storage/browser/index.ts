/**
 * @fileoverview A page's storage: the key-value store, the outbox and list reconciliation. Node-free and DOM-free
 * but for IndexedDB, which the store reaches only when it is opened.
 * @module agentos/core/storage/browser
 */

export { MemoryKeyValueStore, namespaced, type KeyValueStore } from './KeyValueStore.js';
export { IndexedDbKeyValueStore, openIndexedDbStore, type IndexedDbStoreOptions } from './IndexedDbKeyValueStore.js';
export { idb } from './idb.js';
export { Outbox, type OutboxEntry, type OutboxOptions, type OutboxSend } from './Outbox.js';
export { reconcileList, type CachedEntry, type ServerList } from './reconcile.js';
