import { describe, it, expect, vi } from 'vitest';
import { harness } from './manager-harness.js';
import { MeetingManager } from '../MeetingManager.js';
import { MeetingRoom } from '../MeetingRoom.js';

/** A run in the call with capture open. */
async function joined(h: ReturnType<typeof harness>, key = 'k1'): Promise<string> {
  const r = await h.manager.sendBot({ ...h.request, idempotencyKey: key });
  const runId = r.ok ? r.run.runId : '';
  await h.manager.tick();
  await h.report(runId, 'joining');
  await h.report(runId, 'in_call', { participantCount: 2 });
  await h.report(runId, 'notice_posted');
  await h.report(runId, 'monitor_heartbeat', {}, h.clock.now() + 1);
  return runId;
}

describe('a worker the manager cannot reach', () => {
  it('a leave whose command fails still arms the kill; thirty seconds on the run is killed, ended and settled', async () => {
    const h = harness({ usageSilenceMs: 120_000 });
    const runId = await joined(h);
    await h.report(runId, 'usage', { seconds: 60 });
    h.provider.commandError = new Error('scheduler unreachable');
    expect(await h.manager.leaveBot(runId, 'stopped_by_owner')).toBe(true);
    expect((await h.stores.runs.get(runId))?.state).toBe('leaving');
    h.clock.advance(30_001);
    await h.manager.tick();
    expect(h.provider.commands.get(runId)?.at(-1)).toEqual({ name: 'kill' });
    expect(await h.stores.runs.get(runId)).toMatchObject({ state: 'done', reason: 'stopped_by_owner' });
    expect(h.entitlement.settled.length).toBe(1);
  });

  it('a purge whose commands fail is fenced at once and completes after the kill', async () => {
    const h = harness({ usageSilenceMs: 120_000 });
    const runId = await joined(h);
    h.provider.commandError = new Error('scheduler unreachable');
    expect(await h.manager.purgeRun(runId, 'stopped_by_owner')).toBe(true);
    expect((await h.stores.runs.get(runId))?.state).toBe('purging');
    h.clock.advance(30_001);
    await h.manager.tick(); // the kill, and the bot taken as gone
    await h.manager.tick(); // the purge's steps
    expect((await h.stores.runs.get(runId))?.state).toBe('done');
    expect(h.rooms.deleted).toEqual([`bot-${runId}`]);
  });

  it('a run a restart left in leaving is armed from the new manager\'s first tick and killed thirty seconds on', async () => {
    const h = harness({ usageSilenceMs: 120_000 });
    const runId = await joined(h);
    await h.manager.leaveBot(runId, 'stopped_by_owner');
    const again = new MeetingManager({ managerId: 'm2', stores: h.stores, room: new MeetingRoom(h.rooms), reportUrlFor: (id, p) => `https://product.test/events/${p}/${id}` });
    again.registerProvider(h.provider);
    await again.tick();
    expect((await h.stores.runs.get(runId))?.state).toBe('leaving');
    h.clock.advance(30_001);
    await again.tick();
    expect(h.provider.commands.get(runId)?.at(-1)).toEqual({ name: 'kill' });
    expect((await h.stores.runs.get(runId))?.state).toBe('done');
  });

  it.each(['alive', 'unreachable'] as const)('ends at durable usage after exactly two silent minutes with the provider %s', async (mode) => {
    const h = harness({ usageSilenceMs: 120_000 });
    const runId = await joined(h);
    await h.report(runId, 'usage', { seconds: 60 });
    const heard = h.clock.now();
    if (mode === 'unreachable') h.provider.usageError = new Error('unreachable');
    const again = new MeetingManager({ managerId: 'm2', stores: h.stores, room: new MeetingRoom(h.rooms), usageSilenceMs: 120_000, reportUrlFor: (id, p) => `https://product.test/events/${p}/${id}` });
    again.registerProvider(h.provider);
    h.clock.advance(119_999);
    await h.report(runId, 'monitor_heartbeat');
    await again.reconcile();
    expect((await h.stores.runs.get(runId))?.state).toBe('in_call');
    h.clock.advance(1);
    await again.reconcile();
    expect(await h.stores.runs.get(runId)).toMatchObject({ state: 'done', reason: 'crashed', leftAt: heard, billedSeconds: 60, lastUsageAt: heard, reportedSeconds: 60 });
    expect(h.entitlement.settled).toHaveLength(1);
  });

  it('includes a dispatching run without a dispatched job and releases its unused hold', async () => {
    const h = harness({ usageSilenceMs: 120_000 });
    const sent = await h.manager.sendBot(h.request);
    if (!sent.ok) throw new Error('send failed');
    await h.stores.runs.update(sent.run.runId, { state: 'dispatching', dispatchedAt: h.clock.now() });
    const at = h.clock.now();
    const again = new MeetingManager({ managerId: 'm2', stores: h.stores, room: new MeetingRoom(h.rooms), usageSilenceMs: 120_000, reportUrlFor: (id, p) => `https://product.test/events/${p}/${id}` });
    again.registerProvider(h.provider);
    h.clock.advance(120_000);
    await again.reconcile();
    expect(await h.stores.runs.get(sent.run.runId)).toMatchObject({ state: 'done', reason: 'crashed', leftAt: at, billedSeconds: 0 });
    expect(h.entitlement.released).toEqual(['res-1']);
  });

  it('kills the worker a dispatch starts after the silence ended its run while the provider was answering', async () => {
    const h = harness({ usageSilenceMs: 120_000 });
    const sent = await h.manager.sendBot(h.request);
    if (!sent.ok) throw new Error('send failed');
    const runId = sent.run.runId;
    let commandsBefore = -1;
    h.provider.beforeDispatch = async () => {
      // the provider takes the threshold to answer, and the upkeep ends the run meanwhile, before its worker exists
      h.clock.advance(120_000);
      await h.manager.reconcile();
      commandsBefore = h.provider.commands.get(runId)?.length ?? 0;
    };
    await h.manager.tick();
    expect(await h.stores.runs.get(runId)).toMatchObject({ state: 'done', reason: 'crashed' });
    expect(h.provider.alive.has(runId)).toBe(true); // the provider started the worker after the run ended
    expect(commandsBefore).toBeGreaterThanOrEqual(0);
    expect(h.provider.commands.get(runId)?.slice(commandsBefore)).toEqual([{ name: 'kill' }]);
  });

  it('keeps a run whose usage report is taken after the pass read it as silent, and sends its worker no kill', async () => {
    const h = harness({ usageSilenceMs: 120_000 });
    const runId = await joined(h);
    h.clock.advance(120_000);
    const list = h.stores.runs.list.bind(h.stores.runs);
    vi.spyOn(h.stores.runs, 'list').mockImplementation(async (filter) => {
      const listed = await list(filter);
      // the worker's report is taken after the pass read the row, whose silence as read has reached the threshold
      if (filter.states?.includes('in_call')) await h.report(runId, 'usage', { seconds: 60 });
      return listed;
    });
    await h.manager.reconcile();
    expect(h.provider.commands.get(runId)?.some((c) => c.name === 'kill')).toBe(false);
    expect(await h.stores.runs.get(runId)).toMatchObject({ state: 'in_call', lastUsageAt: h.clock.now(), reportedSeconds: 60 });
  });

  it('a duplicate usage event and stop-monitor heartbeats cannot extend the usage clock', async () => {
    const h = harness({ usageSilenceMs: 120_000 });
    const runId = await joined(h);
    const at = h.clock.now();
    await h.report(runId, 'usage', { seconds: 60 }, at);
    h.clock.advance(90_000);
    await h.report(runId, 'usage', { seconds: 60 }, at);
    await h.report(runId, 'usage', { seconds: 30 }, at - 30_000); // an older report that arrives late
    await h.report(runId, 'monitor_heartbeat');
    expect(await h.stores.runs.get(runId)).toMatchObject({ lastUsageAt: at, reportedSeconds: 60 });
    await h.report(runId, 'usage', { seconds: 90 }, h.clock.now());
    expect(await h.stores.runs.get(runId)).toMatchObject({ lastUsageAt: h.clock.now(), reportedSeconds: 90 });
  });

  it('of two usage reports applied at once, the older one never writes its time or a smaller total over the newer one\'s', async () => {
    const h = harness({ usageSilenceMs: 120_000 });
    const runId = await joined(h);
    const older = h.clock.now();
    h.clock.advance(60_000);
    const newer = h.clock.now();
    const append = h.stores.events.append.bind(h.stores.events);
    let raced = false;
    vi.spyOn(h.stores.events, 'append').mockImplementation(async (event) => {
      if (!raced && event.type === 'bot:usage' && event.at === older) {
        raced = true;
        // the newer report is taken whole while the older one is between its read of the run and its write
        await h.report(runId, 'usage', { seconds: 120 }, newer);
      }
      return append(event);
    });
    await h.report(runId, 'usage', { seconds: 60 }, older);
    expect(raced).toBe(true);
    expect(await h.stores.runs.get(runId)).toMatchObject({ lastUsageAt: newer, lastUsageSourceAt: newer, reportedSeconds: 120 });
  });

  it('keeps on the done row the total a done report gave after a left report that gave none, the total it settled', async () => {
    const h = harness();
    const runId = await joined(h);
    h.clock.advance(60_000);
    let fails = 1;
    h.entitlement.settleThrows = () => fails-- > 0;
    await h.report(runId, 'left', { reason: 'ended' }); // no total: the cleanup bills the time in the call, and its settle fails
    expect((await h.stores.runs.get(runId))?.state).toBe('left');
    await h.report(runId, 'done', { seconds: 90 });
    expect(h.entitlement.settled).toEqual([['res-1', 90]]);
    expect(await h.stores.runs.get(runId)).toMatchObject({ state: 'done', billedSeconds: 90, reportedSeconds: 90 });
  });

  it('refuses a usage silence that is not a finite number of milliseconds above zero', () => {
    const h = harness();
    for (const usageSilenceMs of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
      expect(() => new MeetingManager({ managerId: 'm2', stores: h.stores, room: new MeetingRoom(h.rooms), usageSilenceMs, reportUrlFor: (id, p) => `https://product.test/events/${p}/${id}` }), String(usageSilenceMs)).toThrow(RangeError);
    }
  });
});
