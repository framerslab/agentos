import { describe, expect, it, vi } from 'vitest';
import { MeetingManager, type MeetingManagerConfig } from '../MeetingManager.js';
import { MeetingRoom } from '../MeetingRoom.js';
import { CompositeMeetingEntitlement } from '../CompositeMeetingEntitlement.js';
import { InMemoryCompoundCreditStore } from '../../../../safety/runtime/CompoundCreditStore.js';
import { grantCreditLot } from '../../../../safety/runtime/CompoundCreditLedger.js';
import { fundedRun, TestMeetingBlocks } from './meeting-funding.contract.js';
import { harness } from './manager-harness.js';
import { mockEventContext } from '../providers/mock.js';

async function fixture() {
  const h = harness(); const credit = new InMemoryCompoundCreditStore(); const blocks = new TestMeetingBlocks();
  let eligible = true; let fenced = true; let selections = 0; let connectedMs = 0;
  await grantCreditLot(credit, { scopeId: 'account', kind: 'paid', fundingRef: 'payment', principalMicro: 100_000, at: h.clock.now() });
  const check = vi.fn(async () => eligible ? { ok: true as const, maxSeconds: 600 } : { ok: false as const });
  const entitlement = new CompositeMeetingEntitlement({ runs: h.stores.runs, credit, now: () => h.clock.now(), supplierDailyCapMicro: () => 1_000_000,
    blocks: () => blocks, check, close: async () => ({ connectedMs, fence: { mediaClosed: fenced, inferenceTerminated: fenced, evidence: fenced ? 'closed' : 'close-pending', observedAt: h.clock.now() } }) });
  const config: MeetingManagerConfig = { managerId: 'funded', stores: { ...h.stores, entitlement }, room: new MeetingRoom(h.rooms), reportUrlFor: (id, provider) => `https://example.test/${provider}/${id}`,
    creation: { withOwnerLock: (_owner, work) => work(), prepare: async (run) => { expect(run.funding).toBeDefined(); expect(run.fundingReservationId).toBeDefined(); },
      funding: async (_request, _context, runId) => { selections += 1; return fundedRun(runId).funding!; } },
    dispatchGuard: (_run, work) => work() };
  const manager = new MeetingManager(config); manager.registerProvider(h.provider);
  return { h, manager, config, credit, check, selections: () => selections, eligible: (value: boolean) => { eligible = value; }, fenced: (value: boolean) => { fenced = value; }, measured: (value: number) => { connectedMs = value; },
    request: { ...h.request, ownerRef: 'account', botName: 'Example notes', limits: { totalMs: 600_000 } } };
}

describe('funded manager lifecycle', () => {
  it.each([0, 30])('publishes and charges the acknowledged 31 seconds when the earlier report was %i', async (reported) => {
    const f = await fixture(); const sent = await f.manager.sendBotPrepared(f.request, 'context'); if (!sent.ok) throw new Error('admission failed');
    await f.manager.tick(); const id = sent.run.runId;
    await f.h.stores.runs.update(id, { state: 'in_call', captureStartedAt: f.h.clock.now(), monitorSeenAt: f.h.clock.now(), reportedSeconds: reported });
    f.measured(31000); f.h.clock.advance(31000);
    const events: Array<{ type: string; data?: unknown }> = []; f.manager.on((event) => { events.push(event); });
    const left = mockEventContext(id, 'left', { seconds: reported, reason: 'ended' }, f.h.clock.now(), f.h.provider.tokenOf(id));
    expect((await f.manager.processProviderEvent('mock', left)).applied).toBe(1);
    const run = await f.h.stores.runs.get(id); expect(run).toMatchObject({ state: 'done', billedSeconds: 31, fundingSettlement: { connectedMs: 31000, billedSeconds: 31, unbilled: false }, fundingCleanup: { complete: true } });
    const terminal = events.filter((event) => event.type === 'bot:done'); expect(terminal).toHaveLength(1); expect(terminal[0]?.data).toMatchObject({ billedSeconds: 31 });
    expect((await f.credit.withTransaction((tx) => tx.listHolds({ scopeId: 'account' })))[0]).toMatchObject({ chargedMicro: 155, supplierSettledMicro: 62 });
    await f.manager.processProviderEvent('mock', left); expect(events.filter((event) => event.type === 'bot:done')).toHaveLength(1);
  });
  it('accepts final cumulative usage after leaving without permitting fresh dispatch', async () => {
    const f = await fixture(); const sent = await f.manager.sendBotPrepared(f.request, 'context'); if (!sent.ok) throw new Error('admission failed');
    await f.manager.tick(); const id = sent.run.runId;
    await f.h.stores.runs.update(id, { state: 'leaving', captureStartedAt: f.h.clock.now(), reportedSeconds: 10, reason: 'stopped_by_owner' });
    const usage = mockEventContext(id, 'usage', { seconds: 12 }, f.h.clock.now() + 1, f.h.provider.tokenOf(id));
    expect((await f.manager.processProviderEvent('mock', usage)).applied).toBe(1);
    expect((await f.h.stores.runs.get(id))?.reportedSeconds).toBe(12);
    expect(await f.config.stores.entitlement.checkRun?.(id, 'dispatch')).toEqual({ ok: false });
    await expect(f.config.stores.entitlement.meter(`meeting-funding:${id}`, 11)).rejects.toThrow('usage refused');
    expect((await f.h.stores.runs.get(id))?.reportedSeconds).toBe(12);
  });
  it('does not reclose completed history and runs safety passes while pending close is stalled', async () => {
    const f = await fixture(); const complete = fundedRun('historical');
    complete.state = 'done'; complete.fundingCleanup = { unbilled: true, complete: true }; complete.fundingSettlement = { connectedMs: 0, billedSeconds: 0, unbilled: true };
    await f.h.stores.runs.insert(complete);
    const pending = fundedRun('pending'); pending.state = 'left'; pending.fundingCleanup = { unbilled: true, complete: false }; await f.h.stores.runs.insert(pending);
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const recover = vi.spyOn(f.config.stores.entitlement, 'recover').mockImplementation(async () => gate);
    const scan = vi.spyOn(f.h.stores.runs, 'listFundingPending');
    const sent = await f.manager.sendBotPrepared(f.request, 'context'); if (!sent.ok) throw new Error('admission failed');
    try {
      await f.manager.tick(); expect(f.h.provider.dispatched.size).toBe(1); expect(recover).toHaveBeenCalledExactlyOnceWith('pending');
      expect(scan).toHaveBeenCalledWith(64, undefined); await f.manager.tick(); expect(recover).toHaveBeenCalledOnce();
    } finally { release(); await gate; }
  });
  it('persists before reservation and preparation, then recovers without selecting a new source', async () => {
    const f = await fixture(); const prepare = f.config.creation!.prepare;
    let lost = true;
    f.config.creation!.prepare = async (run, context) => { await prepare(run, context); if (lost) { lost = false; throw new Error('preparation response lost'); } };
    await expect(f.manager.sendBotPrepared(f.request, 'host-context')).rejects.toThrow('preparation response lost');
    expect(f.h.provider.dispatched.size).toBe(0);
    const restarted = new MeetingManager(f.config); restarted.registerProvider(f.h.provider);
    const recovered = await restarted.sendBotPrepared(f.request, 'ignored-context');
    expect(recovered.ok).toBe(true); expect(f.selections()).toBe(1);
    await restarted.tick();
    expect(f.h.provider.dispatched.size).toBe(1);
    expect(await f.credit.withTransaction((tx) => tx.listHolds({ scopeId: 'account' }))).toHaveLength(1);
  });

  it('revalidates scheduled dispatch against persisted funding without creating a worker', async () => {
    const f = await fixture();
    const sent = await f.manager.sendBotPrepared({ ...f.request, joinAt: f.h.clock.now() + 1_000 }, 'context');
    if (!sent.ok) throw new Error('admission failed');
    f.eligible(false); f.h.clock.advance(1_000);
    await f.manager.tick();
    expect(f.h.provider.dispatched.size).toBe(0);
    expect((await f.h.stores.runs.get(sent.run.runId))?.state).toBe('failed');
    expect((await f.credit.withTransaction((tx) => tx.listHolds({ scopeId: 'account' })))[0]?.chargedMicro).toBe(0);
  });

  it('stops an active run on heartbeat refusal and keeps failed fencing pending', async () => {
    const f = await fixture(); const sent = await f.manager.sendBotPrepared(f.request, 'context');
    if (!sent.ok) throw new Error('admission failed');
    await f.manager.tick();
    await f.h.stores.runs.update(sent.run.runId, { state: 'in_call', captureStartedAt: f.h.clock.now(), monitorSeenAt: f.h.clock.now() });
    f.eligible(false); f.fenced(false);
    await f.manager.tick();
    expect((await f.h.stores.runs.get(sent.run.runId))?.state).toBe('leaving');
    await f.h.stores.runs.update(sent.run.runId, { state: 'left', leftAt: f.h.clock.now(), cleanupPending: true, reportedSeconds: 0 });
    await f.manager.tick();
    expect((await f.h.stores.runs.get(sent.run.runId))?.state).toBe('left');
    f.fenced(true); await f.manager.tick();
    expect((await f.h.stores.runs.get(sent.run.runId))?.state).toBe('done');
    expect(f.check.mock.calls.length).toBeGreaterThan(1);
  });

  it('rejects legacy creation only when a funding selector is configured', async () => {
    const f = await fixture();
    await expect(f.manager.sendBot(f.request)).rejects.toThrow('funded creation requires sendBotPrepared');
    expect((await f.h.manager.sendBot({ ...f.h.request, botName: 'Example notes' })).ok).toBe(true);
  });
});
