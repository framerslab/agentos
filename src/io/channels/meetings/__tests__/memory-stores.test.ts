import { describe, it, expect } from 'vitest';
import { InMemoryEntitlementHook, InMemoryEventStore, InMemoryJobStore, InMemoryOutbox, InMemoryRunStore, InMemoryTranscriptStore } from '../stores/memory.js';
import { meetingStoreContract } from './store-contract.js';

meetingStoreContract('in-memory meeting stores', async () => ({
  runs: new InMemoryRunStore(), jobs: new InMemoryJobStore(), transcript: new InMemoryTranscriptStore(),
  events: new InMemoryEventStore(), outbox: new InMemoryOutbox(),
}));

describe('InMemoryEntitlementHook', () => {
  it('caps and repeats a reservation, meters a total, settles once and forgets', async () => {
    const hook = new InMemoryEntitlementHook(1000);
    const input = { runId: 'r1', ownerRef: 'a', platform: 'google_meet' as const, maxSeconds: 2000 };
    const result = await hook.reserve(input);
    expect(result).toEqual({ ok: true, reservationId: 'reservation:r1', maxSeconds: 1000 });
    expect(await hook.reserve(input)).toEqual(result);
    expect(await hook.revalidate('reservation:r1')).toBe(true);
    await hook.meter('reservation:r1', 100);
    await hook.meter('reservation:r1', 50);
    expect(hook.get('reservation:r1')?.metered).toBe(100);
    await hook.settle('reservation:r1', 120);
    await hook.settle('reservation:r1', 140);
    await hook.release('reservation:r1');
    expect(hook.get('reservation:r1')).toMatchObject({ settled: 120, released: false });
    expect(await hook.revalidate('reservation:r1')).toBe(false);
    await hook.forget('r1');
    expect(hook.get('reservation:r1')).toBeUndefined();
  });
  it('releases once, refuses an empty allowance and does not settle a released reservation', async () => {
    const hook = new InMemoryEntitlementHook();
    const input = { runId: 'r1', ownerRef: 'a', platform: 'google_meet' as const, maxSeconds: 1000 };
    await hook.reserve(input);
    await hook.release('reservation:r1');
    await hook.release('reservation:r1');
    await hook.settle('reservation:r1', 100);
    expect(hook.get('reservation:r1')).toMatchObject({ released: true });
    expect(hook.get('reservation:r1')?.settled).toBeUndefined();
    expect(await hook.revalidate('reservation:r1')).toBe(false);
    expect(await new InMemoryEntitlementHook(0).reserve(input)).toMatchObject({ ok: false, reason: 'allowance' });
  });
});

describe('whole-run eviction', () => {
  it('forgets rows, counters, dedup ids and fences from every memory store', async () => {
    const transcript = new InMemoryTranscriptStore();
    const events = new InMemoryEventStore();
    const outbox = new InMemoryOutbox();
    const jobs = new InMemoryJobStore();
    const runs = new InMemoryRunStore();
    await runs.insert({ runId: 'r1', ownerRef: 'a', providerName: 'mock', platform: 'google_meet', state: 'done', keep: 'none', meetingUrl: '', botName: '', notice: { text: '', version: '1', lateArrivalText: '' }, stopPhrase: '', limits: { waitingRoomMs: 1, aloneMs: 1, totalMs: 1 }, requestedAt: 0, joinAt: 0, doneAt: 1, billedSeconds: 0 });
    await transcript.appendNext({ runId: 'r1', at: 1, text: 'one' });
    await transcript.fence('r1');
    await events.append({ runId: 'r1', eventId: 'e1', at: 1, type: 'bot:done' });
    await events.fence('r1');
    await outbox.enqueue({ id: 'd1', runId: 'r1', eventId: 'e1', type: 'bot:done', destinationRef: 'h', payload: '{}' }, 0);
    await outbox.purgeContent('r1');
    await jobs.schedule({ runId: 'r1', dispatchAt: 0 });
    for (const store of [transcript, events, outbox, jobs, runs]) await store.forget('r1');
    expect(await runs.get('r1')).toBeUndefined();
    expect(await jobs.get('r1')).toBeUndefined();
    expect(await transcript.isFenced('r1')).toBe(false);
    expect(await events.read('r1', 0)).toEqual([]);
    expect(await outbox.listByRun('r1')).toEqual([]);
    expect((await transcript.appendNext({ runId: 'r1', at: 2, text: 'fresh' })).seq).toBe(1);
    expect(await events.append({ runId: 'r1', eventId: 'e1', at: 2, type: 'bot:chat_message', data: { text: 'fresh' } })).toEqual({ inserted: true, seq: 1 });
    expect((await events.read('r1', 0))[0].data).toEqual({ text: 'fresh' });
    await outbox.enqueue({ id: 'd1', runId: 'r1', eventId: 'e1', type: 'bot:transcript', destinationRef: 'h', payload: 'fresh' }, 0);
    expect((await outbox.listByRun('r1'))[0].payload).toBe('fresh');
  });
});
