import { describe, expect, it } from 'vitest';
import { InMemoryOutbox } from '../stores/memory.js';
import { FencedOutbox, MemoryDeliveryFence } from '../stores/fenced-outbox.js';
import { OutboxDispatcher } from '../delivery.js';
import { MeetingManager } from '../MeetingManager.js';
import { MeetingRoom } from '../MeetingRoom.js';
import { harness } from './manager-harness.js';

const row = { id: 'd1', eventId: 'e1', runId: 'r1', destinationRef: 'h1', type: 'bot:transcript' as const, payload: '{"text":"content-marker"}' };

/** A promise and the function that resolves it, as `Promise.withResolvers` gives them (an ES2024 method the library's lib setting does not declare). */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve };
}

describe('fenced delivery', () => {
  it('re-reads the row after destination resolution was blocked', async () => {
    const outbox = new FencedOutbox(new InMemoryOutbox(), new MemoryDeliveryFence());
    await outbox.enqueue(row, 0);
    const reached = deferred();
    const resume = deferred();
    const bodies: string[] = [];
    const dispatcher = new OutboxDispatcher({
      outbox, resolve: async () => { reached.resolve(); await resume.promise; return { url: 'https://example.test/hook', secret: 'test' }; },
      send: async (r) => { bodies.push(r.body); return { status: 204 }; },
    });
    const sending = dispatcher.deliverDue();
    await reached.promise;
    await outbox.purgeContent('r1');
    resume.resolve();
    await sending;
    expect(bodies).toEqual([JSON.stringify({ id: 'e1', type: 'bot:purged', runId: 'r1' })]);
  });

  it('aborts a send waiting before its first byte, then retries only a content-free record', async () => {
    const outbox = new FencedOutbox(new InMemoryOutbox(), new MemoryDeliveryFence());
    await outbox.enqueue(row, 0);
    const reached = deferred();
    const bodies: string[] = [];
    const dispatcher = new OutboxDispatcher({
      outbox, clock: { now: () => 10_000 },
      resolve: async () => ({ url: 'https://example.test/hook', secret: 'test' }),
      send: async (r) => {
        reached.resolve();
        if (!r.signal) throw new Error('missing cancellation');
        await new Promise<void>((resolve) => r.signal?.addEventListener('abort', () => resolve(), { once: true }));
        r.signal.throwIfAborted();
        bodies.push(r.body);
        return { status: 204 };
      },
    });
    const sending = dispatcher.deliverDue();
    await reached.promise;
    await outbox.purgeContent('r1');
    await sending;
    expect(bodies).toEqual([]);
    expect(await outbox.listByRun('r1')).toEqual([expect.objectContaining({ payload: '', purged: true })]);
    await outbox.enqueue({ ...row, id: 'd2' }, 0);
    expect(JSON.stringify(await outbox.listByRun('r1'))).not.toContain('content-marker');
    await outbox.replay('d1', 0);
    const retry = new OutboxDispatcher({ outbox, resolve: async () => ({ url: 'https://example.test/hook', secret: 'test' }), send: async (r) => { bodies.push(r.body); return { status: 204 }; } });
    await retry.deliverDue();
    expect(bodies).toHaveLength(2);
    expect(bodies.every((body) => !body.includes('content-marker'))).toBe(true);
  });

  it('aborts a send in flight as soon as the manager purges its run, before the bot has left', async () => {
    const h = harness();
    const outbox = new FencedOutbox(h.stores.outbox, new MemoryDeliveryFence());
    const manager = new MeetingManager({ managerId: 'purger', stores: { ...h.stores, outbox }, room: new MeetingRoom(h.rooms), reportUrlFor: (id, p) => `https://example.test/${p}/${id}` });
    manager.registerProvider(h.provider);
    const sent = await manager.sendBot(h.request);
    if (!sent.ok) throw new Error('send failed');
    const id = sent.run.runId;
    await manager.tick();
    expect(h.provider.dispatched.has(id)).toBe(true);
    await outbox.enqueue({ ...row, runId: id }, h.clock.now());
    const reached = deferred();
    const bodies: string[] = [];
    const dispatcher = new OutboxDispatcher({
      outbox, clock: h.clock,
      resolve: async () => ({ url: 'https://example.test/hook', secret: 'test' }),
      send: async (r) => {
        reached.resolve();
        await new Promise<void>((resolve) => r.signal?.addEventListener('abort', () => resolve(), { once: true }));
        r.signal?.throwIfAborted();
        bodies.push(r.body);
        return { status: 204 };
      },
    });
    const sending = dispatcher.deliverDue();
    await reached.promise;
    expect(await manager.purgeRun(id)).toBe(true);
    // the bot was told to leave and has not reported leaving: the send was cancelled without waiting for its exit
    expect((await h.stores.runs.get(id))?.state).toBe('purging');
    expect(h.provider.commands.get(id)).toEqual([{ name: 'suspendCapture' }, { name: 'leave', reason: 'stopped_by_owner' }]);
    expect(await sending).toEqual({ delivered: 0, failed: 0 });
    expect(bodies).toEqual([]);
    expect(await outbox.listByRun(id)).toEqual([expect.objectContaining({ payload: '', purged: true })]);
  });
});
