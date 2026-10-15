import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { FakeClock } from '../stores/memory.js';
import { DuplicateIdempotencyKeyError, FencedError, type IRunStore, type IJobStore, type ITranscriptStore, type IEventStore, type IOutbox, type OutboxDelivery } from '../stores/types.js';
import type { MeetingRunRecord } from '../types.js';

/** The stores one contract case runs against, made fresh for each case, and how to close them. */
export interface ContractStores {
  runs: IRunStore & Required<Pick<IRunStore, 'updateWith'>>;
  jobs: IJobStore;
  transcript: ITranscriptStore & Required<Pick<ITranscriptStore, 'appendNext'>>;
  events: IEventStore;
  outbox: IOutbox & Required<Pick<IOutbox, 'sendClaimed'>>;
  close?: () => Promise<void>;
}

/** The same cases run against fresh memory stores or a fresh Postgres table prefix before every case. */
export function meetingStoreContract(name: string, make: () => Promise<ContractStores>): void {
  describe(name, () => {
    let stores: ContractStores;
    beforeEach(async () => { stores = await make(); });
    afterEach(async () => { await stores?.close?.(); });
    describe('jobs', () => {
      it('leases a due job to one taker only, and renews or expires the lease', async () => {
        const jobs = stores.jobs;
        await jobs.schedule({ runId: 'r1', dispatchAt: 100 });
        expect(await jobs.lease('m1', 50, 1000)).toBeUndefined(); // not due
        const a = await jobs.lease('m1', 100, 1000);
        const b = await jobs.lease('m2', 100, 1000);
        expect(a?.runId).toBe('r1');
        expect(b).toBeUndefined();
        expect(await jobs.renew('r1', 'm2', 500, 1000)).toBe(false);
        expect(await jobs.renew('r1', 'm1', 500, 1000)).toBe(true);
        expect(await jobs.lease('m2', 1400, 1000)).toBeUndefined(); // lease runs to 1500
        expect((await jobs.lease('m2', 1501, 1000))?.leaseHolder).toBe('m2'); // expired: taken over
      });
      it('cancels a job that has not dispatched, and reports one that has', async () => {
        const jobs = stores.jobs;
        await jobs.schedule({ runId: 'r1', dispatchAt: 0 });
        await jobs.schedule({ runId: 'r2', dispatchAt: 0 });
        await jobs.lease('m1', 0, 1000);
        expect(await jobs.markDispatched('r1', 'm1', 'w1')).toEqual({ recorded: true, cancelled: false });
        expect(await jobs.cancel('r1')).toBe('already_dispatched');
        expect(await jobs.cancel('r2')).toBe('cancelled');
        expect(await jobs.cancel('r9')).toBe('missing');
        expect(await jobs.lease('m1', 0, 1000)).toBeUndefined(); // r2 cancelled, r1 leased
      });
      it('a cancel during a live lease is learned at markDispatched, and a release moves the due time', async () => {
        const jobs = stores.jobs;
        await jobs.schedule({ runId: 'r1', dispatchAt: 0 });
        await jobs.lease('m1', 0, 1000);
        expect(await jobs.cancel('r1')).toBe('cancelled');
        expect(await jobs.markDispatched('r1', 'm1', 'w1')).toEqual({ recorded: true, cancelled: true });
        await jobs.schedule({ runId: 'r2', dispatchAt: 0 });
        await jobs.lease('m1', 0, 1000);
        expect(await jobs.release('r2', 'm1', 15_000)).toBe(true);
        expect(await jobs.lease('m1', 14_999, 1000)).toBeUndefined();
        expect((await jobs.lease('m1', 15_000, 1000))?.runId).toBe('r2');
      });
      it('records a dispatch and releases a lease only for the lease holder: not for one whose lease another took, nor for a job that is gone', async () => {
        const jobs = stores.jobs;
        await jobs.schedule({ runId: 'r1', dispatchAt: 0 });
        await jobs.lease('m1', 0, 1000);
        expect((await jobs.lease('m2', 1001, 1000))?.leaseHolder).toBe('m2'); // m1's dispatch outlived its lease
        expect(await jobs.release('r1', 'm1', 50_000)).toBe(false);
        expect(await jobs.markDispatched('r1', 'm1', 'w1')).toEqual({ recorded: false, cancelled: false });
        expect(await jobs.get('r1')).toMatchObject({ dispatchAt: 0, leaseHolder: 'm2', leaseExpiresAt: 2001, dispatched: false });
        expect(await jobs.lease('m3', 1500, 1000)).toBeUndefined(); // m2's lease still holds
        expect(await jobs.markDispatched('r1', 'm2', 'w2')).toEqual({ recorded: true, cancelled: false });
        expect((await jobs.get('r1'))?.workerId).toBe('w2');
        expect(await jobs.release('r9', 'm1', 0)).toBe(false);
        expect(await jobs.markDispatched('r9', 'm1', 'w1')).toEqual({ recorded: false, cancelled: false });
      });
    });

    describe('transcript', () => {
      it('appends in order, refuses after the fence, and purges the turns but keeps the fence', async () => {
        const t = stores.transcript;
        await t.append({ runId: 'r1', seq: 1, turnId: 'r1:1', at: 1, text: 'one' });
        await t.append({ runId: 'r1', seq: 2, turnId: 'r1:2', at: 2, text: 'two' });
        expect((await t.read('r1', 1)).map((x) => x.text)).toEqual(['two']);
        await t.fence('r1');
        await expect(t.append({ runId: 'r1', seq: 3, turnId: 'r1:3', at: 3, text: 'late' })).rejects.toBeInstanceOf(FencedError);
        await t.purge('r1');
        expect(await t.read('r1', 0)).toEqual([]);
        expect(await t.isFenced('r1')).toBe(true);
      });
    });

    describe('events', () => {
      it('numbers events per run, drops a repeated id, purges payloads of content events only, and stores nothing of a content event behind the fence', async () => {
        const e = stores.events;
        expect(await e.append({ eventId: 'a', runId: 'r1', type: 'bot:in_call', at: 1 })).toEqual({ inserted: true, seq: 1 });
        expect(await e.append({ eventId: 'b', runId: 'r1', type: 'bot:chat_message', at: 2, data: { text: 'hi' } })).toEqual({ inserted: true, seq: 2 });
        expect(await e.append({ eventId: 'r2-a', runId: 'r2', type: 'bot:in_call', at: 2 })).toEqual({ inserted: true, seq: 1 }); // another run counts from one
        expect(await e.append({ eventId: 'a', runId: 'r1', type: 'bot:in_call', at: 1 })).toEqual({ inserted: false, seq: 1 });
        await e.fence('r1');
        await e.purgePayloads('r1');
        expect(await e.append({ eventId: 'c', runId: 'r1', type: 'bot:chat_message', at: 3, data: { text: 'late' } })).toEqual({ inserted: true, seq: 3 });
        const all = await e.read('r1', 0);
        expect(all[1]).toMatchObject({ type: 'bot:chat_message', purged: true });
        expect(all[1].data).toBeUndefined();
        expect(all[2]).toMatchObject({ type: 'bot:chat_message', purged: true });
        expect(all[2].data).toBeUndefined();
        expect(all[0].purged).toBeUndefined();
      });
      it('keeps its own copy of a payload: neither the appended object nor one a read answered changes the stored event', async () => {
        const e = stores.events;
        const data = { text: 'hi' };
        await e.append({ eventId: 'a', runId: 'r1', type: 'bot:chat_message', at: 1, data });
        data.text = 'changed after the append';
        const [first] = await e.read('r1', 0);
        expect(first.data).toEqual({ text: 'hi' });
        if (first.data) first.data.text = 'changed by a reader';
        expect((await e.read('r1', 0))[0].data).toEqual({ text: 'hi' });
      });
    });

    describe('outbox', () => {
      it('backs off and gives up after a day, and a purge empties the payload', async () => {
        const clock = new FakeClock(0);
        const o = stores.outbox;
        await o.enqueue({ id: 'd1', runId: 'r1', destinationRef: 'hook-1', eventId: 'e1', type: 'bot:transcript', payload: '{"text":"x"}' }, clock.now());
        expect((await o.due(0)).map((d) => d.id)).toEqual(['d1']);
        await o.markFailed('d1', 0);
        expect(await o.due(4_999)).toEqual([]);
        expect((await o.due(5_000)).length).toBe(1);
        await o.enqueue({ id: 'd2', runId: 'r1', destinationRef: 'hook-1', eventId: 'e2', type: 'bot:chat_message', payload: '{"text":"y"}' }, clock.now());
        await o.markDelivered('d2');
        await o.purgeContent('r1');
        const rows = await o.listByRun('r1');
        for (const d of rows) {
          expect(d.payload).toBe('');
          expect(d.type).toBe('bot:purged');
          expect(d.purged).toBe(true);
        }
        expect(rows.find((d) => d.id === 'd2')?.state).toBe('delivered');
        for (let i = 0; i < 20; i++) await o.markFailed('d1', 86_400_000 + i);
        expect((await o.listByRun('r1')).find((d) => d.id === 'd1')?.state).toBe('dead');
      });
      it('a failure reported after the destination took a delivery, or after it was given up, changes nothing', async () => {
        const o = stores.outbox;
        await o.enqueue({ id: 'd1', runId: 'r1', destinationRef: 'hook-1', eventId: 'e1', type: 'bot:done', payload: '{}' }, 0);
        await o.markDelivered('d1');
        await o.markFailed('d1', 10); // a sender that lost the race reports its attempt late
        const delivered = (await o.listByRun('r1')).find((d) => d.id === 'd1');
        expect(delivered).toMatchObject({ state: 'delivered', attempts: 0, nextAt: 0 });
        expect(delivered?.firstAttemptAt).toBeUndefined();
        expect(await o.due(10)).toEqual([]);
        await o.enqueue({ id: 'd2', runId: 'r1', destinationRef: 'hook-1', eventId: 'e2', type: 'bot:done', payload: '{}' }, 0);
        await o.markFailed('d2', 0);
        await o.markFailed('d2', 86_400_000); // a day after the first failure: given up
        await o.markFailed('d2', 86_400_001);
        expect((await o.listByRun('r1')).find((d) => d.id === 'd2')).toMatchObject({ state: 'dead', attempts: 2 });
      });
      it('after a purge refuses a content delivery for the run and takes a content-free one', async () => {
        const o = stores.outbox;
        await o.purgeContent('r1');
        await o.enqueue({ id: 'd1', runId: 'r1', destinationRef: 'hook-1', eventId: 'e1', type: 'bot:transcript', payload: '{"text":"late"}' }, 0);
        await o.enqueue({ id: 'd2', runId: 'r1', destinationRef: 'hook-1', eventId: 'e2', type: 'bot:done', payload: '{"billedSeconds":0}' }, 0);
        await o.enqueue({ id: 'd3', runId: 'r2', destinationRef: 'hook-1', eventId: 'e3', type: 'bot:transcript', payload: '{"text":"another run"}' }, 0);
        const rows = await o.listByRun('r1');
        expect(rows.map((d) => d.id)).toEqual(['d2']);
        expect(rows[0]).toMatchObject({ type: 'bot:done', payload: '{"billedSeconds":0}', purged: false });
        expect((await o.listByRun('r2')).map((d) => d.id)).toEqual(['d3']);
      });
      it('a purge empties the content deliveries of the run and leaves a content-free one as it was', async () => {
        const o = stores.outbox;
        await o.enqueue({ id: 'd1', runId: 'r1', destinationRef: 'hook-1', eventId: 'e1', type: 'bot:transcript', payload: '{"text":"x"}' }, 0);
        await o.enqueue({ id: 'd2', runId: 'r1', destinationRef: 'hook-1', eventId: 'e2', type: 'bot:done', payload: '{"billedSeconds":90}' }, 0);
        await o.purgeContent('r1');
        const rows = await o.listByRun('r1');
        expect(rows.find((d) => d.id === 'd1')).toMatchObject({ type: 'bot:purged', payload: '', purged: true });
        expect(rows.find((d) => d.id === 'd2')).toMatchObject({ type: 'bot:done', payload: '{"billedSeconds":90}', purged: false, state: 'pending' });
      });
      it('sendClaimed sends a delivery as it stands now, skips one no longer pending, and a purge of the run aborts the send', async () => {
        const o = stores.outbox;
        const delivery = (id: string, runId: string) => ({ id, runId, destinationRef: 'hook-1', eventId: id, type: 'bot:transcript' as const, payload: '{"text":"x"}' });
        await o.enqueue(delivery('d1', 'r1'), 0);
        await o.enqueue(delivery('d2', 'r2'), 0);
        const [d1, d2] = await o.due(0);
        await o.purgeContent('r1');
        const sent: OutboxDelivery[] = [];
        const record = async (fresh: OutboxDelivery): Promise<void> => { sent.push(fresh); };
        // the row `due` returned still carries the content; the send gets the emptied one
        expect(await o.sendClaimed(d1!, record)).toBe(true);
        expect(sent).toEqual([expect.objectContaining({ id: 'd1', type: 'bot:purged', payload: '', purged: true })]);
        await o.markDelivered('d1');
        expect(await o.sendClaimed(d1!, record)).toBe(false);
        expect(await o.sendClaimed({ ...d2!, id: 'gone' }, record)).toBe(false);
        expect(sent).toHaveLength(1);
        let signal: AbortSignal | undefined;
        expect(await o.sendClaimed(d2!, async (fresh, s) => {
          signal = s;
          expect(fresh.payload).toBe('{"text":"x"}');
          await o.purgeContent('r2');
          s.throwIfAborted();
        })).toBe(false);
        expect(signal?.aborted).toBe(true);
        await expect(o.sendClaimed(d2!, async () => { throw new Error('refused'); })).rejects.toThrow('refused');
      });

      it('a mail delivery is due until its expiry, dies at it, is held without an attempt, and is never replayed', async () => {
        const o = stores.outbox;
        if (!o.markDead || !o.holdUntil || !o.cancel) throw new Error("the library's stores implement the mail methods");
        const now = 1_000;
        await o.enqueue({ id: 'm1', runId: 'r5', destinationRef: 'mail:1', eventId: 'r5:notes', type: 'bot:done', payload: 'sealed', kind: 'mail', expiresAt: now + 86_400_000 }, now);
        expect((await o.due(now)).map((d) => d.id)).toEqual(['m1']);
        expect((await o.listByRun('r5'))[0]).toMatchObject({ kind: 'mail', expiresAt: now + 86_400_000, state: 'pending' });
        await o.holdUntil('m1', now + 3_600_000);
        expect(await o.due(now + 1)).toEqual([]);
        expect((await o.listByRun('r5'))[0]).toMatchObject({ attempts: 0, nextAt: now + 3_600_000 });
        expect((await o.due(now + 3_600_000)).map((d) => d.id)).toEqual(['m1']);
        expect(await o.due(now + 86_400_000)).toEqual([]);
        await o.markFailed('m1', now + 86_400_000);
        expect((await o.listByRun('r5'))[0]?.state).toBe('dead');
        await o.replay('m1', now + 86_400_001);
        expect((await o.listByRun('r5'))[0]?.state).toBe('dead');
      });

      it('an event delivery keeps its kind and its backoff, and markDead, cancel and a purge end mail deliveries', async () => {
        const o = stores.outbox;
        if (!o.markDead || !o.holdUntil || !o.cancel) throw new Error("the library's stores implement the mail methods");
        await o.enqueue({ id: 'e6', runId: 'r6', destinationRef: 'w1', eventId: 'r6:left', type: 'bot:left', payload: '{}' }, 1_000);
        expect((await o.listByRun('r6'))[0]).toMatchObject({ kind: 'event', state: 'pending' });
        expect((await o.listByRun('r6'))[0]?.expiresAt).toBeUndefined();
        await o.enqueue({ id: 'm6', runId: 'r6', destinationRef: 'mail:1', eventId: 'r6:notes', type: 'bot:done', payload: 'sealed', kind: 'mail', expiresAt: 90_000 }, 1_000);
        await o.enqueue({ id: 'm7', runId: 'r6', destinationRef: 'mail:2', eventId: 'r6:notes', type: 'bot:done', payload: 'sealed', kind: 'mail', expiresAt: 90_000 }, 1_000);
        await o.enqueue({ id: 'm8', runId: 'r6', destinationRef: 'mail:3', eventId: 'r6:notes', type: 'bot:done', payload: 'sealed', kind: 'mail', expiresAt: 90_000 }, 1_000);
        await o.markDead('m6');
        await o.cancel('r6', 'mail:2');
        const states = Object.fromEntries((await o.listByRun('r6')).map((d) => [d.id, d.state]));
        expect(states).toEqual({ e6: 'pending', m6: 'dead', m7: 'dead', m8: 'pending' });
        await o.purgeContent('r6');
        const after = (await o.listByRun('r6')).find((d) => d.id === 'm8');
        expect(after).toMatchObject({ payload: '', purged: true, state: 'dead', kind: 'mail' });
        expect((await o.listByRun('r6')).find((d) => d.id === 'e6')).toMatchObject({ type: 'bot:left', payload: '{}' });
        await o.enqueue({ id: 'm9', runId: 'r6', destinationRef: 'mail:4', eventId: 'r6:notes', type: 'bot:done', payload: 'sealed', kind: 'mail', expiresAt: 90_000 }, 2_000);
        expect((await o.listByRun('r6')).find((d) => d.id === 'm9')).toBeUndefined();
      });
    });

    describe('runs', () => {
      it('updates only from the expected state', async () => {
        const r = stores.runs;
        await r.insert({ runId: 'r1', ownerRef: 'a', providerName: 'mock', platform: 'google_meet', state: 'requested', keep: 'none', meetingUrl: 'u', botName: 'b', notice: { text: 'n', version: '1', lateArrivalText: 's' }, stopPhrase: 'stop', limits: { waitingRoomMs: 1, aloneMs: 1, totalMs: 1 }, requestedAt: 0, joinAt: 0, billedSeconds: 0, idempotencyKey: 'k' });
        expect(await r.update('r1', { state: 'joining' }, 'scheduled')).toBeUndefined();
        expect((await r.update('r1', { state: 'dispatching' }, ['requested', 'scheduled']))?.state).toBe('dispatching');
        expect((await r.findByIdempotencyKey('a', 'k'))?.runId).toBe('r1');
        expect(await r.findByIdempotencyKey('b', 'k')).toBeUndefined();
      });
      it('makes one run per owner and idempotency key', async () => {
        const r = stores.runs;
        const run: MeetingRunRecord = { runId: 'idem-1', ownerRef: 'owner-a', providerName: 'mock', platform: 'google_meet', state: 'requested', keep: 'none', meetingUrl: 'u', botName: 'b', notice: { text: 'n', version: '1', lateArrivalText: 's' }, stopPhrase: 'stop', limits: { waitingRoomMs: 1, aloneMs: 1, totalMs: 1 }, requestedAt: 0, joinAt: 0, billedSeconds: 0, idempotencyKey: 'same-key' };
        await r.insert(run);
        await expect(r.insert({ ...run, runId: 'idem-2' })).rejects.toBeInstanceOf(DuplicateIdempotencyKeyError); // a second send with the key makes no second run
        await r.insert({ ...run, runId: 'idem-3', ownerRef: 'owner-b' }); // the key is the owner's own
        await r.insert({ ...run, runId: 'idem-4', idempotencyKey: undefined });
        await r.insert({ ...run, runId: 'idem-5', idempotencyKey: undefined }); // runs sent without a key never collide
        expect(await r.get('idem-2')).toBeUndefined();
        expect((await r.findByIdempotencyKey('owner-a', 'same-key'))?.runId).toBe('idem-1');
        expect((await r.findByIdempotencyKey('owner-b', 'same-key'))?.runId).toBe('idem-3');
      });
      it('keeps the manager\'s timers on the row, and clears one a patch gives as undefined', async () => {
        const r = stores.runs;
        await r.insert({ runId: 'r1', ownerRef: 'a', providerName: 'mock', platform: 'google_meet', state: 'leaving', keep: 'none', meetingUrl: 'u', botName: 'b', notice: { text: 'n', version: '1', lateArrivalText: 's' }, stopPhrase: 'stop', limits: { waitingRoomMs: 1, aloneMs: 1, totalMs: 1 }, requestedAt: 0, joinAt: 0, billedSeconds: 0 });
        await r.update('r1', { leaveCommandedAt: 5, captureSuspendedAt: 6, aloneSince: 7 }, 'leaving');
        expect(await r.get('r1')).toMatchObject({ leaveCommandedAt: 5, captureSuspendedAt: 6, aloneSince: 7 });
        await r.update('r1', { captureSuspendedAt: undefined, aloneSince: undefined });
        const cleared = await r.get('r1');
        expect(cleared?.leaveCommandedAt).toBe(5);
        expect(cleared?.captureSuspendedAt).toBeUndefined();
        expect(cleared?.aloneSince).toBeUndefined();
      });
      it('decides an updateWith patch on the row as the store holds it, and writes nothing when the patch is none', async () => {
        const r = stores.runs;
        await r.insert({ runId: 'r1', ownerRef: 'a', providerName: 'mock', platform: 'google_meet', state: 'in_call', keep: 'none', meetingUrl: 'u', botName: 'b', notice: { text: 'n', version: '1', lateArrivalText: 's' }, stopPhrase: 'stop', limits: { waitingRoomMs: 1, aloneMs: 1, totalMs: 1 }, requestedAt: 0, joinAt: 0, billedSeconds: 0 });
        await r.update('r1', { reportedSeconds: 60, lastUsageSourceAt: 5 });
        // a patch decided on an older read would lower the total: decided on the stored row, it keeps the larger one
        expect(await r.updateWith('r1', (current) => ({ reportedSeconds: Math.max(current.reportedSeconds ?? 0, 30) }))).toMatchObject({ state: 'in_call', reportedSeconds: 60 });
        expect(await r.updateWith('r1', (current) => (current.lastUsageSourceAt !== undefined && current.lastUsageSourceAt >= 5 ? undefined : { lastUsageSourceAt: 5, state: 'left' }))).toBeUndefined();
        expect(await r.get('r1')).toMatchObject({ state: 'in_call', reportedSeconds: 60, lastUsageSourceAt: 5 });
        expect(await r.updateWith('r1', () => ({ state: 'left', leftAt: 7 }))).toMatchObject({ state: 'left', leftAt: 7, reportedSeconds: 60 });
        expect(await r.updateWith('r9', () => ({ reportedSeconds: 1 }))).toBeUndefined();
      });
    });

    describe('shared contracts', () => {
      const run = (id: string, requestedAt = 1): MeetingRunRecord => ({
        runId: id, ownerRef: 'owner', providerName: 'mock', platform: 'google_meet', state: 'requested', keep: 'none',
        meetingUrl: 'u', botName: 'Notes', notice: { text: 'n', version: '1', lateArrivalText: 's' }, stopPhrase: 'stop',
        limits: { waitingRoomMs: 1, aloneMs: 1, totalMs: 1 }, requestedAt, joinAt: 1, billedSeconds: 0,
      });
      it('schedule preserves a live lease, dispatch and cancellation while moving only the due time', async () => {
        const j = stores.jobs;
        await j.schedule({ runId: 'r1', dispatchAt: 0 });
        await j.lease('m1', 0, 1000);
        await j.schedule({ runId: 'r1', dispatchAt: 10 });
        expect(await j.get('r1')).toMatchObject({ dispatchAt: 10, leaseHolder: 'm1', leaseExpiresAt: 1000 });
        await j.markDispatched('r1', 'm1', 'w1');
        await j.schedule({ runId: 'r1', dispatchAt: 20 });
        expect(await j.get('r1')).toMatchObject({ dispatched: true, workerId: 'w1', dispatchAt: 20 });
        await j.schedule({ runId: 'r2', dispatchAt: 0 });
        await j.cancel('r2');
        await j.schedule({ runId: 'r2', dispatchAt: 30 });
        expect(await j.get('r2')).toMatchObject({ cancelled: true, dispatchAt: 30 });
        expect(await j.lease('m2', 2000, 1000)).toBeUndefined();
      });
      it('numbered append keeps the first copy and appendNext continues under concurrent writers', async () => {
        const t = stores.transcript;
        await t.append({ runId: 'r1', seq: 4, turnId: 'r1:4', at: 1, text: 'first' });
        await t.append({ runId: 'r1', seq: 4, turnId: 'r1:4', at: 2, text: 'duplicate' });
        const added = await Promise.all(['next', 'last'].map((text) => t.appendNext({ runId: 'r1', at: 3, text })));
        expect(added.map((turn) => turn.seq).sort((a, b) => a - b)).toEqual([5, 6]);
        const read = await t.read('r1', 0);
        expect(read[0].text).toBe('first');
        expect(read.slice(1).map((turn) => turn.text).sort()).toEqual(['last', 'next']);
        await t.fence('r1');
        await expect(t.appendNext({ runId: 'r1', at: 4, text: 'late' })).rejects.toBeInstanceOf(FencedError);
      });
      it('enqueue keeps the first delivery and its retry state; reads order by nextAt then id', async () => {
        const o = stores.outbox;
        const delivery = (id: string) => ({ id, runId: 'r1', destinationRef: 'h', eventId: id, type: 'bot:done' as const, payload: id });
        await o.enqueue(delivery('later'), 30);
        await o.enqueue(delivery('first'), 10);
        await o.enqueue(delivery('middle'), 20);
        expect((await o.due(100)).map((d) => d.id)).toEqual(['first', 'middle', 'later']);
        expect((await o.listByRun('r1')).map((d) => d.id)).toEqual(['first', 'middle', 'later']);
        await o.markFailed('first', 100);
        const before = (await o.listByRun('r1')).find((d) => d.id === 'first');
        await o.enqueue({ ...delivery('first'), payload: 'replacement' }, 0);
        expect((await o.listByRun('r1')).find((d) => d.id === 'first')).toEqual(before);
        await o.enqueue(delivery('a'), 30);
        expect((await o.due(100)).map((d) => d.id)).toEqual(['middle', 'a', 'later']);
      });
      it('list defaults to 500, [] applies no state filter and limit zero returns no rows', async () => {
        for (let i = 0; i < 501; i++) await stores.runs.insert(run(`r${i.toString().padStart(3, '0')}`, i));
        expect(await stores.runs.list({})).toHaveLength(500);
        expect(await stores.runs.list({ states: [] })).toHaveLength(500);
        expect(await stores.runs.list({ limit: 0 })).toEqual([]);
        expect((await stores.runs.list({ limit: 2 })).map((r) => r.runId)).toEqual(['r500', 'r499']);
      });
    });
  });
}
