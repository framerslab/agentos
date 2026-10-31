/**
 * The outbox over the library's SQL key-value store, on a SQL adapter: the suite a backend's test file registers with
 * its own way of opening the database. Each `open` opens the same database again, so what one connection held is
 * read through the next. Not a test file itself: Outbox.sql.test.ts runs it on better-sqlite3 and
 * Outbox.sql.browser.test.ts on the IndexedDB adapter.
 */
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import { createSqlKeyValueStore } from '@framers/sql-storage-adapter/kv';
import { afterEach, describe, expect, it } from 'vitest';

import { Outbox, type OutboxEntry } from '../Outbox.js';

/**
 * Registers the suite.
 * @param backend - The adapter's name, for the suite's title.
 * @param open - Opens the backend's database; every call opens the same one.
 */
export function outboxOverSqlStore(backend: string, open: () => Promise<StorageAdapter>): void {
  describe(`Outbox over the SQL key-value store on ${backend}`, () => {
    const opened: StorageAdapter[] = [];

    /** An open adapter the suite closes after the test. */
    const adapter = async (): Promise<StorageAdapter> => {
      const db = await open();
      opened.push(db);
      return db;
    };

    afterEach(async () => {
      for (const db of opened.splice(0)) await db.close();
    });

    it('holds changes in a table, sends them in order, keeps a retry with its backoff and removes what is done or dropped', async () => {
      let now = 1_000;
      const store = await createSqlKeyValueStore(await adapter(), { table: 'agentos_outbox_order' });
      const outbox = new Outbox(store, { prefix: 'o/', now: () => now, backoffMs: (attempts) => attempts * 10_000 });
      await outbox.add('update', { field: 'title' });
      now += 1;
      await outbox.add('update', { field: 'tags' });
      now += 1;
      await outbox.add('delete', { id: 's1' });
      const seen: string[] = [];
      const answers = ['done', 'retry'] as const;
      const result = await outbox.flush(async (sent: OutboxEntry) => {
        seen.push(sent.kind + ':' + JSON.stringify(sent.payload));
        return answers[seen.length - 1] ?? 'done';
      });
      expect(seen).toEqual(['update:{"field":"title"}', 'update:{"field":"tags"}']);
      expect(result).toEqual({ sent: 1, dropped: 0, waiting: 2 });
      const [head] = await outbox.pending();
      expect(head.attempts).toBe(1);
      expect(head.nextAt).toBe(now + 10_000);
      expect((await outbox.flush(async () => 'done')).sent).toBe(0);
      now += 10_000;
      expect(await outbox.flush(async (due) => (due.kind === 'delete' ? 'drop' : 'done'))).toEqual({ sent: 1, dropped: 1, waiting: 0 });
      expect(await outbox.pending()).toEqual([]);
      expect(await store.keys('')).toEqual([]);
    });

    it('gives a payload back as the structured clone gives it: a date, bytes and nested values', async () => {
      const store = await createSqlKeyValueStore(await adapter(), { table: 'agentos_outbox_values' });
      const outbox = new Outbox(store, { now: () => 7 });
      const payload = {
        title: 'Budget',
        tags: ['a', 'b'],
        when: new Date(1_700_000_000_000),
        bytes: new Uint8Array([1, 2, 3]),
        nested: { n: 1.5, none: null, list: [[1], [2, [3]]] },
      };
      const added = await outbox.add('update', payload, 'n1');
      const [held] = await outbox.pending();
      expect(held).toEqual({ ...added, payload });
      expect(held.payload).toEqual(payload);
      expect(await outbox.waitingFor('n1')).toBe(true);
      expect(await outbox.waitingFor('n2')).toBe(false);
    });

    it('refuses a value holding a Blob with a DataCloneError before anything is written: the key keeps what it held and the outbox holds nothing', async () => {
      const store = await createSqlKeyValueStore(await adapter(), { table: 'agentos_outbox_host_objects' });
      /** The name of the error `call` rejected with, or null when it resolved. */
      const refusal = (call: Promise<unknown>): Promise<unknown> =>
        call.then(
          () => null,
          (error: unknown) => (error as { name?: unknown }).name,
        );
      await store.set('k', 'before');
      expect(await refusal(store.set('k', { photo: new Blob(['x']) }))).toBe('DataCloneError');
      expect(await store.get('k')).toBe('before');
      const outbox = new Outbox(store, { prefix: 'o/', now: () => 0 });
      expect(await refusal(outbox.add('upload', { photo: new Blob(['x']) }, 'p1'))).toBe('DataCloneError');
      expect(await outbox.pending()).toEqual([]);
      expect(await store.keys('')).toEqual(['k']);
    });

    it('reads through a second connection what the first held, and what the second sent is gone for a third', async () => {
      const table = 'agentos_outbox_shared';
      const first = await open();
      const held = await (async (): Promise<OutboxEntry> => {
        try {
          const store = await createSqlKeyValueStore(first, { table });
          return await new Outbox(store, { now: () => 0 }).add('update', { id: 'n1' }, 'n1');
        } finally {
          await first.close();
        }
      })();
      const second = await open();
      try {
        const outbox = new Outbox(await createSqlKeyValueStore(second, { table }), { now: () => 0 });
        expect(await outbox.pending()).toEqual([held]);
        expect(await outbox.flush(async () => 'done')).toEqual({ sent: 1, dropped: 0, waiting: 0 });
      } finally {
        await second.close();
      }
      const third = await open();
      try {
        expect(await new Outbox(await createSqlKeyValueStore(third, { table })).pending()).toEqual([]);
      } finally {
        await third.close();
      }
    });
  });
}
