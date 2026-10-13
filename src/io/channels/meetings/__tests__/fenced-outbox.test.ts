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

  it('scrubs pending and delivered content at ordinary completion with keep none', async () => {
    const h = harness();
    const outbox = new FencedOutbox(h.stores.outbox, new MemoryDeliveryFence());
    const manager = new MeetingManager({ managerId: 'cleanup', stores: { ...h.stores, outbox }, room: new MeetingRoom(h.rooms), scrubUnkeptOutbox: true, reportUrlFor: (id, p) => `https://example.test/${p}/${id}` });
    manager.registerProvider(h.provider);
    const sent = await manager.sendBot(h.request);
    if (!sent.ok) throw new Error('send failed');
    const id = sent.run.runId;
    await outbox.enqueue({ ...row, runId: id }, h.clock.now());
    await outbox.enqueue({ ...row, runId: id, id: 'delivered' }, h.clock.now());
    await outbox.markDelivered('delivered');
    await h.stores.transcript.append({ runId: id, seq: 1, turnId: `${id}:1`, at: 1, text: 'content-marker' });
    await h.stores.events.append({ eventId: 'chat', runId: id, type: 'bot:chat_message', at: 1, data: { text: 'content-marker' } });
    await h.stores.runs.update(id, { state: 'left', leftAt: h.clock.now(), cleanupPending: true });
    await manager.tick();
    expect((await h.stores.runs.get(id))?.state).toBe('done');
    const snapshot = JSON.stringify({
      run: await h.stores.runs.get(id),
      outbox: await outbox.listByRun(id),
      turns: await h.stores.transcript.read(id, 0),
      events: await h.stores.events.read(id, 0),
    });
    expect(snapshot).not.toContain('content-marker');
    expect((await outbox.listByRun(id)).every((d) => d.payload === '')).toBe(true);
  });

  it('leaves the outbox to its retries when the host turns the completion scrub off', async () => {
    const h = harness();
    const outbox = new FencedOutbox(h.stores.outbox, new MemoryDeliveryFence());
    const manager = new MeetingManager({ managerId: 'retries', stores: { ...h.stores, outbox }, room: new MeetingRoom(h.rooms), scrubUnkeptOutbox: false, reportUrlFor: (id, p) => `https://example.test/${p}/${id}` });
    manager.registerProvider(h.provider);
    const sent = await manager.sendBot(h.request);
    if (!sent.ok) throw new Error('send failed');
    const id = sent.run.runId;
    await outbox.enqueue({ ...row, runId: id }, h.clock.now());
    await h.stores.transcript.append({ runId: id, seq: 1, turnId: `${id}:1`, at: 1, text: 'content-marker' });
    await h.stores.runs.update(id, { state: 'left', leftAt: h.clock.now(), cleanupPending: true });
    await manager.tick();
    expect((await h.stores.runs.get(id))?.state).toBe('done');
    // the delivery pending at completion still goes to its destination; the stored transcript is dropped all the same
    expect(await outbox.listByRun(id)).toEqual([expect.objectContaining({ id: 'd1', payload: row.payload, state: 'pending', purged: false })]);
    expect(await h.stores.transcript.read(id, 0)).toEqual([]);
  });

  it('lets the manager forget an unkept run of memory stores after the grace, its fence with it', async () => {
    const h = harness();
    const fence = new MemoryDeliveryFence();
    const outbox = new FencedOutbox(h.stores.outbox, fence);
    const manager = new MeetingManager({ managerId: 'evicts', stores: { ...h.stores, outbox }, room: new MeetingRoom(h.rooms), reportUrlFor: (id, p) => `https://example.test/${p}/${id}` });
    manager.registerProvider(h.provider);
    const sent = await manager.sendBot(h.request);
    if (!sent.ok) throw new Error('send failed');
    const id = sent.run.runId;
    await outbox.enqueue({ ...row, runId: id }, h.clock.now());
    await outbox.markDelivered('d1');
    await h.stores.runs.update(id, { state: 'left', leftAt: h.clock.now(), cleanupPending: true });
    await manager.tick();
    expect((await h.stores.runs.get(id))?.state).toBe('done');
    expect(await fence.isFenced(id)).toBe(true);
    h.clock.advance(172_800_000);
    await manager.tick();
    expect(await h.stores.runs.get(id)).toBeUndefined();
    expect(await outbox.listByRun(id)).toEqual([]);
    expect(await fence.isFenced(id)).toBe(false);
  });
});
