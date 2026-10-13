import { describe, expect, it, vi } from 'vitest';
import { MeetingManager, type MeetingManagerConfig } from '../MeetingManager.js';
import { MeetingRoom } from '../MeetingRoom.js';
import type { ReserveResult } from '../stores/types.js';
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
});
