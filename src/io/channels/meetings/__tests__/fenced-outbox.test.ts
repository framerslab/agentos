import { describe, expect, it } from 'vitest';
import { InMemoryOutbox } from '../stores/memory.js';
import { FencedOutbox, MemoryDeliveryFence } from '../stores/fenced-outbox.js';
import { OutboxDispatcher } from '../delivery.js';
import { MeetingManager } from '../MeetingManager.js';
import { MeetingRoom } from '../MeetingRoom.js';
import { mockEventContext } from '../providers/mock.js';
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

  it('takes a delivery for a run while a send of that run waits for its destination', async () => {
    const outbox = new FencedOutbox(new InMemoryOutbox(), new MemoryDeliveryFence());
    await outbox.enqueue(row, 0);
    const reached = deferred();
    const answer = deferred();
    const dispatcher = new OutboxDispatcher({
      outbox, clock: { now: () => 10_000 },
      resolve: async () => ({ url: 'https://example.test/hook', secret: 'test' }),
      send: async () => { reached.resolve(); await answer.promise; return { status: 204 }; },
    });
    const sending = dispatcher.deliverDue();
    await reached.promise;
    // the destination has not answered yet: the enqueue waits for no send of its run
    await outbox.enqueue({ ...row, id: 'd2', eventId: 'e2' }, 0);
    expect((await outbox.listByRun('r1')).map((d) => [d.id, d.state])).toEqual([['d1', 'pending'], ['d2', 'pending']]);
    answer.resolve();
    expect(await sending).toEqual({ delivered: 1, failed: 0 });
  });

  it('sends a delivery once when a second pass takes it while the first is still sending it', async () => {
    const outbox = new FencedOutbox(new InMemoryOutbox(), new MemoryDeliveryFence());
    await outbox.enqueue(row, 0);
    const reached = deferred();
    const answer = deferred();
    const bodies: string[] = [];
    let calls = 0;
    const dispatcher = new OutboxDispatcher({
      outbox, clock: { now: () => 10_000 },
      resolve: async () => ({ url: 'https://example.test/hook', secret: 'test' }),
      send: async (r) => {
        calls += 1;
        if (calls === 1) {
          reached.resolve();
          await answer.promise;
        }
        bodies.push(r.body);
        return { status: 204 };
      },
    });
    const first = dispatcher.deliverDue();
    await reached.promise;
    // a pass that starts while the first one is still sending d1 leaves d1 to it
    expect(await dispatcher.deliverDue()).toEqual({ delivered: 0, failed: 0 });
    answer.resolve();
    expect(await first).toEqual({ delivered: 1, failed: 0 });
    expect(bodies).toEqual([row.payload]);
  });

  it('resolves a purge only once the send it cancelled has ended', async () => {
    const outbox = new FencedOutbox(new InMemoryOutbox(), new MemoryDeliveryFence());
    await outbox.enqueue(row, 0);
    const reached = deferred();
    const closed = deferred();
    const steps: string[] = [];
    const dispatcher = new OutboxDispatcher({
      outbox, clock: { now: () => 10_000 },
      resolve: async () => ({ url: 'https://example.test/hook', secret: 'test' }),
      send: async (r) => {
        reached.resolve();
        await new Promise<void>((resolve) => r.signal?.addEventListener('abort', () => resolve(), { once: true }));
        // the cancelled request takes a moment to close its connection
        await closed.promise;
        steps.push('send ended');
        r.signal?.throwIfAborted();
        return { status: 204 };
      },
    });
    const sending = dispatcher.deliverDue();
    await reached.promise;
    const purging = outbox.purgeContent('r1').then(() => { steps.push('purged'); });
    // a purge that did not wait would finish here, before the send has ended
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    closed.resolve();
    await purging;
    expect(await sending).toEqual({ delivered: 0, failed: 0 });
    expect(steps).toEqual(['send ended', 'purged']);
  });

  it('holds a purge that a send of its own run waits for, as its documentation says: the send is aborted and neither ends', async () => {
    const outbox = new FencedOutbox(new InMemoryOutbox(), new MemoryDeliveryFence());
    await outbox.enqueue(row, 0);
    const [due] = await outbox.due(0);
    if (!due) throw new Error('nothing due');
    const called = deferred();
    const signals: AbortSignal[] = [];
    const ended: string[] = [];
    // what the documentation forbids: the send's own callback waits for a purge of its run, which waits for that send
    void outbox.sendClaimed(due, async (_fresh, signal) => {
      signals.push(signal);
      const purging = outbox.purgeContent('r1').then(() => { ended.push('purge'); });
      called.resolve();
      await purging;
    }).then(() => { ended.push('send'); });
    await called.promise;
    // a bounded wait: a purge that did not wait for the send that called it would have ended within it
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(ended).toEqual([]);
    expect(signals.map((s) => s.aborted)).toEqual([true]);
    // the purge waits for its run's sends before it scrubs, so the run's content is still stored
    expect(JSON.stringify(await outbox.listByRun('r1'))).toContain('content-marker');
  });

  it("carries out a participant's stop while a delivery of the run waits for its destination", async () => {
    const h = harness();
    const outbox = new FencedOutbox(h.stores.outbox, new MemoryDeliveryFence());
    const manager = new MeetingManager({ managerId: 'stopper', stores: { ...h.stores, outbox }, room: new MeetingRoom(h.rooms), destinationsFor: async () => ['h1'], reportUrlFor: (id, p) => `https://example.test/${p}/${id}` });
    manager.registerProvider(h.provider);
    const report = (runId: string, type: Parameters<typeof mockEventContext>[1], data: Parameters<typeof mockEventContext>[2] = {}, at = h.clock.now()) =>
      manager.processProviderEvent('mock', mockEventContext(runId, type, data, at, h.provider.tokenOf(runId)));
    const sent = await manager.sendBot(h.request);
    if (!sent.ok) throw new Error('send failed');
    const id = sent.run.runId;
    await manager.tick();
    await report(id, 'joining');
    await report(id, 'in_call', { participantCount: 2 });
    await report(id, 'notice_posted');
    await report(id, 'monitor_heartbeat', {}, h.clock.now() + 1);
    const reached = deferred();
    const dispatcher = new OutboxDispatcher({
      outbox, clock: h.clock, batch: 1,
      resolve: async () => ({ url: 'https://example.test/hook', secret: 'test' }),
      // a destination that holds the request until the send is cancelled
      send: async (r) => {
        reached.resolve();
        await new Promise<void>((resolve) => r.signal?.addEventListener('abort', () => resolve(), { once: true }));
        r.signal?.throwIfAborted();
        return { status: 204 };
      },
    });
    const sending = dispatcher.deliverDue();
    await reached.promise;
    await report(id, 'chat_message', { text: 'please stop taking notes', sender: 'participant-1' });
    // the stop's own delivery did not wait for the send under way: the fence is up and the bot is told at once
    expect((await h.stores.runs.get(id))?.state).toBe('purging');
    expect(h.provider.commands.get(id)?.slice(-2)).toEqual([{ name: 'suspendCapture' }, { name: 'leave', reason: 'stopped_by_participant' }]);
    expect(await sending).toEqual({ delivered: 0, failed: 0 });
    expect(JSON.stringify(await outbox.listByRun(id))).not.toContain('please stop taking notes');
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
