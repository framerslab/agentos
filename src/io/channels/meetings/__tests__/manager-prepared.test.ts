import { describe, expect, it, vi } from 'vitest';
import { MeetingManager, type MeetingManagerConfig } from '../MeetingManager.js';
import { MeetingRoom } from '../MeetingRoom.js';
import { MockMeetingBotProvider } from '../providers/mock.js';
import type { DispatchAllowance, ReserveResult } from '../stores/types.js';
import { harness } from './manager-harness.js';

describe('prepared creation', () => {
  it.each(['insert', 'reserve', 'reserved', 'prepare_before', 'prepare', 'schedule', 'ready'] as const)('recovers after interruption at %s without dispatch before host preparation', async (stage) => {
    const h = harness();
    const holds = new Map<string, ReserveResult>();
    const prepared = new Set<string>();
    let fail = true;
    const stop = (name: string): void => { if (fail && stage === name) { fail = false; throw new Error('interrupted'); } };
    const insert = h.stores.runs.insert.bind(h.stores.runs);
    vi.spyOn(h.stores.runs, 'insert').mockImplementation(async (r) => { await insert(r); stop('insert'); });
    const update = h.stores.runs.update.bind(h.stores.runs);
    vi.spyOn(h.stores.runs, 'update').mockImplementation(async (id, patch, expected) => {
      const answer = await update(id, patch, expected);
      if (patch.reservationId) stop('reserved');
      if (patch.creationPending === false) stop('ready');
      return answer;
    });
    const schedule = h.stores.jobs.schedule.bind(h.stores.jobs);
    vi.spyOn(h.stores.jobs, 'schedule').mockImplementation(async (j) => { await schedule(j); stop('schedule'); });
    const entitlement = Object.assign(h.entitlement, {
      reserveOnce: async (input: Parameters<NonNullable<import('../stores/types.js').IEntitlementHook['reserveOnce']>>[0]): Promise<ReserveResult> => {
        const answer = holds.get(input.runId) ?? { ok: true as const, reservationId: input.runId, maxSeconds: 14_400 };
        holds.set(input.runId, answer); stop('reserve'); return answer;
      },
    });
    const config: MeetingManagerConfig = {
      managerId: 'prepared', stores: { ...h.stores, entitlement }, room: new MeetingRoom(h.rooms),
      reportUrlFor: (id, p) => `https://example.test/${p}/${id}`,
      creation: {
        withOwnerLock: (_owner, work) => work(),
        prepare: (run, context) => { expect(context).toBe('host-consent'); stop('prepare_before'); prepared.add(run.runId); stop('prepare'); return Promise.resolve(); },
      },
    };
    const first = new MeetingManager(config); first.registerProvider(h.provider);
    await expect(first.sendBotPrepared(h.request, 'host-consent')).rejects.toThrow('interrupted');
    expect(h.provider.dispatched.size).toBe(0);
    if (stage === 'prepare_before') {
      expect(prepared.size).toBe(0);
      expect(await h.stores.runs.list({})).toEqual([expect.objectContaining({ creationPending: true })]);
      const [pending] = await h.stores.runs.list({});
      if (!pending) throw new Error('pending run missing');
      expect(await h.stores.jobs.get(pending.runId)).toBeUndefined();
    }
    const again = new MeetingManager(config); again.registerProvider(h.provider);
    const replay = await again.sendBotPrepared(h.request, 'ignored-on-replay');
    expect(replay.ok && replay.repeated).toBe(true);
    if (!replay.ok) throw new Error('recovery failed');
    expect(prepared.has(replay.run.runId)).toBe(true);
    expect(holds.size).toBe(1);
    expect((await h.stores.runs.list({}))).toHaveLength(1);
    await again.tick();
    expect(h.provider.dispatched.size).toBe(1);
    expect(replay.run.creationPending).toBe(false);
    expect(replay.run.creationContext).toBeUndefined();
  });

  it('persists the reduced allowance before the provider sees the run', async () => {
    const h = harness();
    const entitlement = Object.assign(h.entitlement, { revalidateAllowance: () => Promise.resolve({ ok: true as const, maxSeconds: 600 }) });
    const manager = new MeetingManager({ managerId: 'allowance', stores: { ...h.stores, entitlement }, room: new MeetingRoom(h.rooms), reportUrlFor: (id, p) => `https://example.test/${p}/${id}` });
    manager.registerProvider(h.provider);
    const sent = await manager.sendBot(h.request);
    if (!sent.ok) throw new Error('send failed');
    await manager.tick();
    expect((await h.stores.runs.get(sent.run.runId))?.limits.totalMs).toBe(600_000);
    expect(h.provider.dispatched.get(sent.run.runId)?.run.limits.totalMs).toBe(600_000);
  });

  it('ends a creation its host cannot prepare within the dispatch retry window: failed as crashed, its hold released, nothing dispatched', async () => {
    const h = harness();
    const entitlement = Object.assign(h.entitlement, {
      reserveOnce: async (input: { runId: string }): Promise<ReserveResult> => ({ ok: true, reservationId: `hold-${input.runId}`, maxSeconds: 14_400 }),
    });
    let attempts = 0;
    const manager = new MeetingManager({
      managerId: 'stuck', stores: { ...h.stores, entitlement }, room: new MeetingRoom(h.rooms),
      reportUrlFor: (id, p) => `https://example.test/${p}/${id}`,
      creation: { withOwnerLock: (_owner, work) => work(), prepare: () => { attempts += 1; return Promise.reject(new Error('consent store unavailable')); } },
    });
    manager.registerProvider(h.provider);
    const seen: string[] = [];
    manager.on((e) => { seen.push(e.type); });
    await expect(manager.sendBotPrepared(h.request, 'host-consent')).rejects.toThrow('consent store unavailable');
    h.clock.advance(300_000); // the window's last moment: the pass tries again, and its reconcile gives the pending run no job
    await manager.tick();
    const [pending] = await h.stores.runs.list({});
    if (!pending) throw new Error('pending run missing');
    expect(pending).toMatchObject({ state: 'requested', creationPending: true, reservationId: `hold-${pending.runId}` });
    expect(attempts).toBe(2);
    expect(await h.stores.jobs.get(pending.runId)).toBeUndefined();
    h.clock.advance(1);
    await manager.tick();
    const ended = await h.stores.runs.get(pending.runId);
    expect(ended).toMatchObject({ state: 'failed', reason: 'crashed', billedSeconds: 0, creationPending: false });
    expect(ended?.creationContext).toBeUndefined();
    expect(attempts).toBe(2);
    expect(h.entitlement.released).toContain(`hold-${pending.runId}`);
    expect(h.provider.dispatched.size).toBe(0);
    expect(seen).toEqual(['bot:left', 'bot:done']);
  });

  it('refuses a run store that does not keep the creation fields, and ends the run before anything can dispatch it', async () => {
    const h = harness();
    const insert = h.stores.runs.insert.bind(h.stores.runs);
    // a store that writes only the columns it knows
    vi.spyOn(h.stores.runs, 'insert').mockImplementation(async (r) => {
      const { creationPending: _pending, creationContext: _context, ...known } = r;
      await insert(known);
    });
    let reserved = 0;
    let prepared = 0;
    const entitlement = Object.assign(h.entitlement, {
      reserveOnce: async (input: { runId: string }): Promise<ReserveResult> => { reserved += 1; return { ok: true, reservationId: input.runId, maxSeconds: 14_400 }; },
    });
    const manager = new MeetingManager({
      managerId: 'dropping', stores: { ...h.stores, entitlement }, room: new MeetingRoom(h.rooms),
      reportUrlFor: (id, p) => `https://example.test/${p}/${id}`,
      creation: { withOwnerLock: (_owner, work) => work(), prepare: () => { prepared += 1; return Promise.resolve(); } },
    });
    manager.registerProvider(h.provider);
    await expect(manager.sendBotPrepared(h.request, 'host-consent')).rejects.toThrow('prepared creation needs a run store that keeps creationPending and creationContext');
    expect(await h.stores.runs.list({})).toEqual([expect.objectContaining({ state: 'failed', reason: 'crashed' })]);
    await manager.tick();
    expect(h.provider.dispatched.size).toBe(0);
    expect(reserved).toBe(0);
    expect(prepared).toBe(0);
  });

  it('frees the hold of a creation whose end a cancel began before the hold was written on the run', async () => {
    const h = harness();
    // the cancel's end is held between its first write (cleanupPending) and its last, at the transcript's fence
    let enterFence: () => void = () => undefined;
    const atFence = new Promise<void>((resolve) => { enterFence = () => resolve(); });
    let openFence: () => void = () => undefined;
    const fenceOpen = new Promise<void>((resolve) => { openFence = () => resolve(); });
    const fence = h.stores.transcript.fence.bind(h.stores.transcript);
    vi.spyOn(h.stores.transcript, 'fence').mockImplementation(async (runId) => { enterFence(); await fenceOpen; await fence(runId); });
    let manager: MeetingManager | undefined;
    let cancelling: Promise<boolean> | undefined;
    let prepared = 0;
    const entitlement = Object.assign(h.entitlement, {
      reserveOnce: async (input: { runId: string }): Promise<ReserveResult> => {
        // the owner cancels the send while its hold is being taken
        cancelling = manager?.leaveBot(input.runId);
        await atFence;
        return { ok: true, reservationId: `hold-${input.runId}`, maxSeconds: 14_400 };
      },
    });
    manager = new MeetingManager({
      managerId: 'cancelled', stores: { ...h.stores, entitlement }, room: new MeetingRoom(h.rooms),
      reportUrlFor: (id, p) => `https://example.test/${p}/${id}`,
      creation: { withOwnerLock: (_owner, work) => work(), prepare: () => { prepared += 1; return Promise.resolve(); } },
    });
    manager.registerProvider(h.provider);
    const sent = await manager.sendBotPrepared(h.request, 'host-consent');
    openFence();
    expect(await cancelling).toBe(true);
    if (!sent.ok) throw new Error('send refused');
    expect(sent.repeated).toBe(false);
    const runId = sent.run.runId;
    expect(h.entitlement.released).toEqual([`hold-${runId}`]);
    expect(prepared).toBe(0);
    const ended = await h.stores.runs.get(runId);
    expect(ended).toMatchObject({ state: 'failed', reason: 'stopped_by_owner', billedSeconds: 0 });
    expect(ended?.creationPending).toBeFalsy();
    await manager.tick();
    expect(await h.stores.jobs.get(runId)).toBeUndefined();
    expect(h.provider.dispatched.size).toBe(0);
  });

  it('asks the grant again before a recovered dispatch sends another worker, and not for a bot that is out', async () => {
    const h = harness();
    const asked: string[] = [];
    const entitlement = Object.assign(h.entitlement, {
      revalidateAllowance: async (reservationId: string): Promise<DispatchAllowance> => { asked.push(reservationId); return { ok: true, maxSeconds: 900 }; },
    });
    let reservations = 0;
    vi.spyOn(h.entitlement, 'reserve').mockImplementation(async () => ({ ok: true, reservationId: `res-${++reservations}`, maxSeconds: 14_400 }));
    const manager = new MeetingManager({ managerId: 'recovering', stores: { ...h.stores, entitlement }, room: new MeetingRoom(h.rooms), reportUrlFor: (id, p) => `https://example.test/${p}/${id}` });
    manager.registerProvider(h.provider);
    const out = await manager.sendBot(h.request);
    const gone = await manager.sendBot({ ...h.request, idempotencyKey: 'k2' });
    if (!out.ok || !gone.ok) throw new Error('send failed');
    // a manager that stopped after it sent both bots and before it recorded either dispatch: one bot is out, the other never started
    for (const run of [out.run, gone.run]) {
      await h.stores.runs.update(run.runId, { state: 'dispatching', dispatchedAt: h.clock.now(), dispatch: { roomName: `bot-${run.runId}`, workerTokenHash: MockMeetingBotProvider.hash('t') } }, 'requested');
      await h.stores.jobs.lease('stopped-manager', h.clock.now(), 1);
    }
    h.provider.alive.set(out.run.runId, 5);
    h.clock.advance(10);
    await manager.tick();
    expect(asked).toEqual(['res-2']);
    expect(h.provider.dispatched.has(out.run.runId)).toBe(false);
    expect(await h.stores.jobs.get(out.run.runId)).toMatchObject({ dispatched: true, leaseHolder: 'recovering' });
    expect((await h.stores.runs.get(gone.run.runId))?.limits.totalMs).toBe(900_000);
    expect(h.provider.dispatched.get(gone.run.runId)?.run.limits.totalMs).toBe(900_000);
  });

  it('sends nothing the host\'s dispatch guard does not admit, and offers the dispatch again once its lease runs out', async () => {
    const h = harness();
    let admit = false;
    const offered: string[] = [];
    const manager = new MeetingManager({
      managerId: 'guarded', stores: h.stores, room: new MeetingRoom(h.rooms), reportUrlFor: (id, p) => `https://example.test/${p}/${id}`,
      dispatchGuard: async (run, work) => { offered.push(run.runId); if (admit) await work(); },
    });
    manager.registerProvider(h.provider);
    const sent = await manager.sendBot(h.request);
    if (!sent.ok) throw new Error('send failed');
    await manager.tick();
    expect(offered).toEqual([sent.run.runId]);
    expect(h.provider.dispatched.size).toBe(0);
    expect(await h.stores.runs.get(sent.run.runId)).toMatchObject({ state: 'requested' });
    admit = true;
    h.clock.advance(59_999); // the lease the guard did not admit still holds
    await manager.tick();
    expect(offered).toHaveLength(1);
    h.clock.advance(1);
    await manager.tick();
    expect(offered).toEqual([sent.run.runId, sent.run.runId]);
    expect(h.provider.dispatched.has(sent.run.runId)).toBe(true);
    expect((await h.stores.runs.get(sent.run.runId))?.state).toBe('dispatching');
  });
});
