import { describe, expect, it } from 'vitest';

import { MemoryKeyValueStore } from '../index.js';
import { Outbox, type OutboxEntry } from '../Outbox.js';

describe('Outbox', () => {
  it('sends in order, removes what is done or dropped, and stops at the first that must wait', async () => {
    let now = 1_000;
    const outbox = new Outbox(new MemoryKeyValueStore(), { prefix: 'o/', now: () => now, backoffMs: (attempts) => attempts * 10_000 });
    await outbox.add('update', { field: 'title' });
    now += 1;
    await outbox.add('update', { field: 'tags' });
    now += 1;
    await outbox.add('delete', { id: 's1' });
    const seen: string[] = [];
    const answers = ['done', 'retry'] as const;
    const result = await outbox.flush(async (entry: OutboxEntry) => {
      seen.push(entry.kind + ':' + JSON.stringify(entry.payload));
      return answers[seen.length - 1] ?? 'done';
    });
    expect(seen).toEqual(['update:{"field":"title"}', 'update:{"field":"tags"}']);
    expect(result).toEqual({ sent: 1, dropped: 0, waiting: 2 });
    const [head] = await outbox.pending();
    expect(head.attempts).toBe(1);
    expect(head.nextAt).toBe(now + 10_000);
    expect((await outbox.flush(async () => 'done')).sent).toBe(0);
    now += 10_000;
    expect(await outbox.flush(async (entry) => (entry.kind === 'delete' ? 'drop' : 'done'))).toEqual({ sent: 1, dropped: 1, waiting: 0 });
    expect(await outbox.pending()).toEqual([]);
  });

  it('treats a send that throws as one to try again', async () => {
    const outbox = new Outbox(new MemoryKeyValueStore(), { now: () => 0 });
    await outbox.add('update', {});
    expect(await outbox.flush(async () => { throw new Error('offline'); })).toEqual({ sent: 0, dropped: 0, waiting: 1 });
  });

  it('says whether something about a subject waits', async () => {
    const outbox = new Outbox(new MemoryKeyValueStore(), { now: () => 0 });
    await outbox.add('update', { id: 's1' }, 's1');
    expect(await outbox.waitingFor('s1')).toBe(true);
    expect(await outbox.waitingFor('s2')).toBe(false);
  });

  it('keeps the order of changes held in one millisecond by two outboxes over one store', async () => {
    const store = new MemoryKeyValueStore();
    const first = new Outbox(store, { now: () => 5 });
    const second = new Outbox(store, { now: () => 5 });
    await first.add('update', { n: 1 });
    await second.add('update', { n: 2 });
    await first.add('update', { n: 3 });
    await second.add('update', { n: 4 });
    expect((await first.pending()).map((entry) => entry.payload)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]);
  });

  it('runs one flush at a time for a store and prefix, so a change is sent once and in order', async () => {
    const store = new MemoryKeyValueStore();
    const outbox = new Outbox(store, { now: () => 0 });
    await outbox.add('update', { n: 1 });
    await outbox.add('update', { n: 2 });
    const sent: unknown[] = [];
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = outbox.flush(async (entry) => {
      sent.push(entry.payload);
      await held;
      return 'done';
    });
    // A second outbox over the same store and prefix holds the same changes, so its flush waits for the first.
    const second = new Outbox(store, { now: () => 0 }).flush(async (entry) => {
      sent.push(entry.payload);
      return 'done';
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toEqual([{ n: 1 }]);
    release();
    expect(await first).toEqual({ sent: 2, dropped: 0, waiting: 0 });
    expect(await second).toEqual({ sent: 0, dropped: 0, waiting: 0 });
    expect(sent).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('counts a change held while a send was on its way among those still waiting', async () => {
    const outbox = new Outbox(new MemoryKeyValueStore(), { now: () => 0 });
    await outbox.add('update', { n: 1 });
    const result = await outbox.flush(async () => {
      // A change made while this one is on its way: the flush read its entries before it, so the next flush sends it.
      await outbox.add('update', { n: 2 });
      return 'done';
    });
    expect(result).toEqual({ sent: 1, dropped: 0, waiting: 1 });
    expect((await outbox.pending()).map((entry) => entry.payload)).toEqual([{ n: 2 }]);
  });
});
