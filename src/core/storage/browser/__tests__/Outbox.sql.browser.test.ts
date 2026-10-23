/**
 * The outbox over the library's SQL key-value store on the IndexedDB adapter, in Chromium and in WebKit: sql.js runs in
 * the page and its database image is stored in the browser's IndexedDB, so what one connection held the next reads.
 * sql.js's WebAssembly is served by the test server from the folder the `sqlJsDist` command resolves
 * (vitest.browser.config.ts); sql.js is the adapter's dependency, not this package's, so the test cannot import it.
 */
import { IndexedDbAdapter } from '@framers/sql-storage-adapter/indexeddb';
import { commands } from 'vitest/browser';

import { outboxOverSqlStore } from './outboxOverSql.js';

declare module 'vitest/browser' {
  interface BrowserCommands {
    /** The absolute path of sql.js's dist folder on the test server, which Vite serves under `/@fs/`. */
    sqlJsDist: () => Promise<string>;
  }
}

const dist = await commands.sqlJsDist();

/** Where sql.js finds its files: Vite serves a file under the project as `/@fs/<its absolute path>`. */
const sqlJsConfig = { locateFile: (file: string): string => `/@fs${dist}/${file}` };

/** A database name no other test uses; every open of the suite opens this one. */
const dbName = `agentos-outbox-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

outboxOverSqlStore('IndexedDbAdapter', async () => {
  const adapter = new IndexedDbAdapter({ dbName, sqlJsConfig, durability: 'commit' });
  await adapter.open();
  return adapter;
});
