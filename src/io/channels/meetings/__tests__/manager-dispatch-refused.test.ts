import { describe, it, expect } from 'vitest';
import { harness } from './manager-send-dispatch.test.js';
import { DispatchRefusedError, NoCapacityError } from '../MeetingManager.js';
import { mockEventContext } from '../providers/mock.js';

describe('a dispatch the provider refuses for good', () => {
  it("ends the run at once with the provider's reason, unbilled, its room deleted, its job removed, and never tries again", async () => {
    const h = harness();
    const r = await h.manager.sendBot(h.request);
    const runId = r.ok ? r.run.runId : '';
    h.provider.dispatchError = new DispatchRefusedError('permission_denied', 'not_allowed');
    await h.manager.tick();
    expect(await h.stores.runs.get(runId)).toMatchObject({ state: 'failed', reason: 'permission_denied', billedSeconds: 0, meetingUrl: '', botName: '' });
    expect(h.rooms.deleted).toContain(`bot-${runId}`);
    expect(await h.stores.jobs.get(runId)).toBeUndefined();
    expect(h.entitlement.released).toEqual(['res-1']);
    expect(h.entitlement.settled).toEqual([]);
    expect(h.seen.find((e) => e.type === 'bot:left')).toMatchObject({ data: { reason: 'permission_denied', message: 'not_allowed' } });
    h.provider.dispatchError = undefined;
    h.clock.advance(60_000);
    await h.manager.tick();
    expect(h.provider.dispatched.size).toBe(0);
  });

  it('keeps NoCapacityError as a refusal whose reason is no_capacity', async () => {
    const error = new NoCapacityError();
    expect(error).toBeInstanceOf(DispatchRefusedError);
    expect(error).toMatchObject({ name: 'NoCapacityError', reason: 'no_capacity', message: 'no worker has a free slot' });
    const h = harness();
    const r = await h.manager.sendBot(h.request);
    h.provider.dispatchError = error;
    await h.manager.tick();
    expect(await h.stores.runs.get(r.ok ? r.run.runId : '')).toMatchObject({ state: 'failed', reason: 'no_capacity' });
  });

  it('still retries a dispatch that failed for another reason', async () => {
    const h = harness();
    const r = await h.manager.sendBot(h.request);
    h.provider.dispatchError = new Error('worker unreachable');
    await h.manager.tick();
    // A transient dispatch failure keeps the run eligible for the next retry.
    expect((await h.stores.runs.get(r.ok ? r.run.runId : ''))?.state).toBe('dispatching');
    expect(h.seen.some((e) => e.type === 'bot:left')).toBe(false);
  });
});

describe('a report that arrives while the dispatch is in flight', () => {
  it("keeps the worker's id and the provider's reference on the run, and marks the job dispatched", async () => {
    const h = harness();
    const r = await h.manager.sendBot(h.request);
    const runId = r.ok ? r.run.runId : '';
    h.provider.beforeDispatch = async (input) => {
      // the worker reports before the provider's call returns
      await h.manager.processProviderEvent('mock', mockEventContext(runId, 'joining', {}, h.clock.now(), input.workerToken));
    };
    await h.manager.tick();
    const run = await h.stores.runs.get(runId);
    expect(run?.state).toBe('joining');
    expect(run?.dispatch).toMatchObject({ roomName: `bot-${runId}`, workerId: 'mock-worker', providerRunRef: `mock-${runId}` });
    expect((await h.stores.jobs.get(runId))?.dispatched).toBe(true);
    // the run had already moved on: no late bot:dispatching after bot:joining
    expect(h.seen.map((e) => e.type)).toEqual(['bot:requested', 'bot:joining']);
  });

  it('turns a cancel that landed in the same window into a leave', async () => {
    const h = harness();
    const r = await h.manager.sendBot(h.request);
    const runId = r.ok ? r.run.runId : '';
    h.provider.beforeDispatch = async (input) => {
      await h.manager.processProviderEvent('mock', mockEventContext(runId, 'joining', {}, h.clock.now(), input.workerToken));
      // the job's cancel flag is set while the run is no longer waiting: only the dispatcher can act on it
      await h.stores.jobs.cancel(runId);
    };
    await h.manager.tick();
    expect(h.provider.commands.get(runId)).toEqual([{ name: 'leave', reason: 'stopped_by_owner' }]);
    expect(await h.stores.runs.get(runId)).toMatchObject({ state: 'leaving', reason: 'stopped_by_owner' });
  });
});

describe("a leave report's code word", () => {
  it('reaches bot:left beside the reason, and a report without one carries the reason alone', async () => {
    const h = harness();
    const r = await h.manager.sendBot(h.request);
    const runId = r.ok ? r.run.runId : '';
    await h.manager.tick();
    await h.report(runId, 'joining');
    await h.report(runId, 'left', { reason: 'permission_denied', seconds: 0, message: 'host_did_not_allow' });
    expect(h.seen.find((e) => e.type === 'bot:left')?.data).toEqual({ reason: 'permission_denied', message: 'host_did_not_allow' });
    const plain = harness();
    const second = await plain.manager.sendBot(plain.request);
    const secondId = second.ok ? second.run.runId : '';
    await plain.manager.tick();
    await plain.report(secondId, 'joining');
    await plain.report(secondId, 'left', { reason: 'ended', seconds: 5 });
    expect(plain.seen.find((e) => e.type === 'bot:left')?.data).toEqual({ reason: 'ended' });
  });
});
