/**
 * The outbox over the library's SQL key-value store on the IndexedDB adapter, in Chromium and in WebKit: sql.js runs in
 * the page and its database image is stored in the browser's IndexedDB, so what one connection held the next reads.
 * sql.js's WebAssembly is served by the test server from the folder the `sqlJsDist` command resolves
 * (vitest.browser.config.ts); sql.js is the adapter's dependency, not this package's, so the test cannot import it.
 *
 * Every connection here is opened as docs/memory/CLIENT_SIDE_STORAGE.md opens the adapter under an outbox, so the
 * page's recipe is the one these tests hold: keep `documented` and that example alike.
 */
import { IndexedDbAdapter, type IndexedDbAdapterOptions } from '@framers/sql-storage-adapter/indexeddb';
import { createSqlKeyValueStore } from '@framers/sql-storage-adapter/kv';
import { describe, expect, it } from 'vitest';
import { commands } from 'vitest/browser';

import { Outbox } from '../Outbox.js';
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

/** A database name no other test uses. */
const unique = (name: string): string => `${name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** The adapter's options as docs/memory/CLIENT_SIDE_STORAGE.md gives them, with the test server's sql.js files. */
const documented = (dbName: string): IndexedDbAdapterOptions => ({ dbName, sqlJsConfig, crossTab: true });

/** The one database every open of the shared suite opens. */
const dbName = unique('agentos-outbox');

outboxOverSqlStore('IndexedDbAdapter', async () => {
  const adapter = new IndexedDbAdapter(documented(dbName));
  await adapter.open();
  return adapter;
});

describe('the outbox over the IndexedDB adapter, opened as the client storage page opens it', () => {
  it('keeps the change each of two tabs holds: each tab and a third connection read both', async () => {
    const options = documented(unique('agentos-outbox-tabs'));
    const table = 'notes_kv';
    // Two tabs of one page: two connections, each opened before either writes, as two tabs loaded at once are.
    const tabA = new IndexedDbAdapter(options);
    const tabB = new IndexedDbAdapter(options);
    await tabA.open();
    await tabB.open();
    try {
      const outboxA = new Outbox(await createSqlKeyValueStore(tabA, { table }), { now: () => 1 });
      const outboxB = new Outbox(await createSqlKeyValueStore(tabB, { table }), { now: () => 2 });
      const a = await outboxA.add('update', { id: 'a' }, 'a');
      const b = await outboxB.add('update', { id: 'b' }, 'b');

      const third = new IndexedDbAdapter(options);
      await third.open();
      try {
        expect(await new Outbox(await createSqlKeyValueStore(third, { table })).pending()).toEqual([a, b]);
      } finally {
        await third.close();
      }
      expect(await outboxA.pending()).toEqual([a, b]);
      expect(await outboxB.pending()).toEqual([a, b]);
    } finally {
      await tabA.close();
      await tabB.close();
    }
  });
});
