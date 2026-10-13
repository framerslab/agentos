import { describe, it, expect, vi } from 'vitest';
import { MockMeetingBotProvider, mockEventContext } from '../providers/mock.js';
import { harness } from './manager-harness.js';

describe('sendBot', () => {
  it('reserves, inserts the run, schedules the job and repeats on the same idempotency key', async () => {
    const h = harness();
    const a = await h.manager.sendBot(h.request);
    const b = await h.manager.sendBot(h.request);
    expect(a.ok && !a.repeated).toBe(true);
    expect(b.ok && b.repeated && b.run.runId === (a.ok ? a.run.runId : '')).toBe(true);
    expect((await h.stores.jobs.get(a.ok ? a.run.runId : ''))?.dispatchAt).toBe(1_000_000);
    expect(h.seen.map((e) => e.type)).toEqual(['bot:requested']);
  });
  it('two sends racing on one key answer one run and release the losing reservation', async () => {
    const h = harness();
    let reserved = 0;
    vi.spyOn(h.entitlement, 'reserve').mockImplementation(async () => ({ ok: true, reservationId: `res-${++reserved}`, maxSeconds: 14_400 }));
    const results = await Promise.all([h.manager.sendBot(h.request), h.manager.sendBot(h.request)]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(new Set(results.map((r) => r.ok ? r.run.runId : '')).size).toBe(1);
    expect(results.filter((r) => r.ok && r.repeated)).toHaveLength(1);
    expect(await h.stores.runs.list({})).toHaveLength(1);
    expect(h.entitlement.released).toHaveLength(1);
    expect(h.seen.filter((e) => e.type === 'bot:requested')).toHaveLength(1);
  });
  it('refuses a link that is not the platform, a paused platform and a reservation under ten minutes', async () => {
    const h = harness();
    expect(await h.manager.sendBot({ ...h.request, meetingUrl: 'https://example.com/x' })).toMatchObject({ ok: false, reason: 'invalid_url' });
    h.manager.pausePlatform('google_meet');
    expect(await h.manager.sendBot(h.request)).toMatchObject({ ok: false, reason: 'platform_paused' });
    h.manager.resumePlatform('google_meet');
    h.entitlement.reserveAnswer = { ok: true, reservationId: 'res-2', maxSeconds: 599 };
    expect(await h.manager.sendBot({ ...h.request, idempotencyKey: 'k2' })).toMatchObject({ ok: false, reason: 'allowance' });
    expect(h.entitlement.released).toEqual(['res-2']);
  });
  it('schedules a later run and revalidates it at dispatch', async () => {
    const h = harness();
    const r = await h.manager.sendBot({ ...h.request, joinAt: 1_600_000 });
    expect(r.ok && r.run.state).toBe('scheduled');
    await h.manager.tick();
    expect(h.provider.dispatched.size).toBe(0);
    h.clock.set(1_600_000);
    h.entitlement.revalidateAnswer = false;
    await h.manager.tick();
    const run = await h.stores.runs.get(r.ok ? r.run.runId : '');
    expect(run).toMatchObject({ state: 'failed', reason: 'allowance' });
    expect(h.entitlement.released).toEqual(['res-1']);
    expect(h.provider.dispatched.size).toBe(0);
  });
  it('keeps the default of a limit given as undefined, and refuses a limit or a join time that is not a finite number before anything is reserved', async () => {
    const h = harness();
    const reserve = vi.spyOn(h.entitlement, 'reserve');
    const sent = await h.manager.sendBot({ ...h.request, limits: { totalMs: undefined, waitingRoomMs: undefined, aloneMs: 120_000 } });
    expect(sent.ok && sent.run.limits).toEqual({ waitingRoomMs: 600_000, aloneMs: 120_000, totalMs: 14_400_000 });
    expect(reserve).toHaveBeenLastCalledWith(expect.objectContaining({ maxSeconds: 14_400 }));
    await expect(h.manager.sendBot({ ...h.request, idempotencyKey: 'k2', limits: { totalMs: Number.NaN } })).rejects.toThrow(RangeError);
    await expect(h.manager.sendBot({ ...h.request, idempotencyKey: 'k3', limits: { waitingRoomMs: -1 } })).rejects.toThrow(RangeError);
    await expect(h.manager.sendBot({ ...h.request, idempotencyKey: 'k4', joinAt: Number.NaN })).rejects.toThrow(RangeError);
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(await h.stores.runs.list({})).toHaveLength(1);
  });
  it('refuses a reservation whose answer is not a number, and releases it', async () => {
    const h = harness();
    h.entitlement.reserveAnswer = { ok: true, reservationId: 'res-nan', maxSeconds: Number.NaN };
    expect(await h.manager.sendBot(h.request)).toMatchObject({ ok: false, reason: 'allowance' });
    expect(h.entitlement.released).toEqual(['res-nan']);
    expect(await h.stores.runs.list({})).toEqual([]);
  });
  it('answers a repeated send with its run even when the platform was paused in between', async () => {
    const h = harness();
    const first = await h.manager.sendBot(h.request);
    h.manager.pausePlatform('google_meet');
    const again = await h.manager.sendBot(h.request);
    expect(again.ok && again.repeated && again.run.runId === (first.ok ? first.run.runId : '')).toBe(true);
    expect(await h.manager.sendBot({ ...h.request, idempotencyKey: 'k2' })).toMatchObject({ ok: false, reason: 'platform_paused' });
  });
  it('leaves no run waiting without its job: reconcile gives a send whose job could not be stored its job, and ends a run a cancel left without one', async () => {
    const h = harness();
    vi.spyOn(h.stores.jobs, 'schedule').mockRejectedValueOnce(new Error('job store unavailable'));
    await expect(h.manager.sendBot(h.request)).rejects.toThrow('job store unavailable');
    const [stored] = await h.stores.runs.list({});
    expect(await h.stores.jobs.get(stored.runId)).toBeUndefined();
    const again = await h.manager.sendBot(h.request);
    expect(again.ok && again.repeated && again.run.runId === stored.runId).toBe(true);
    // a cancel that stopped after it removed the job: the run still waits, with the cancel's reason on it
    const later = await h.manager.sendBot({ ...h.request, idempotencyKey: 'k2', joinAt: h.clock.now() + 3_600_000 });
    const laterId = later.ok ? later.run.runId : '';
    await h.stores.runs.update(laterId, { reason: 'stopped_by_owner' }, 'scheduled');
    await h.stores.jobs.remove(laterId);
    await h.manager.tick(); // the pass's reconcile gives the first run its job and ends the second
    await h.manager.tick(); // the job is due: the run is dispatched
    expect(h.provider.dispatched.has(stored.runId)).toBe(true);
    expect((await h.stores.runs.get(stored.runId))?.state).toBe('dispatching');
    expect(await h.stores.runs.get(laterId)).toMatchObject({ state: 'failed', reason: 'stopped_by_owner' });
    expect(h.provider.dispatched.has(laterId)).toBe(false);
  });
});

describe('dispatch and the interlock', () => {
  it('mints the room and the token at dispatch, and starts capture only after the notice is confirmed and the monitor is healthy', async () => {
    const h = harness();
    const r = await h.manager.sendBot(h.request);
    const runId = r.ok ? r.run.runId : '';
    await h.manager.tick();
    const d = h.provider.dispatched.get(runId)!;
    expect(h.rooms.created).toEqual([`bot-${runId}`]);
    expect(d.room).toEqual({ url: 'wss://lk.test', name: `bot-${runId}`, publishToken: `jwt:bot-${runId}:bot:pub` });
    expect(d.reportUrl).toBe(`https://product.test/events/mock/${runId}`);
    expect((await h.stores.runs.get(runId))?.dispatch?.workerTokenHash).toBe(MockMeetingBotProvider.hash(d.workerToken));
    expect((await h.stores.runs.get(runId))?.meetingUrl).toBe(h.request.meetingUrl);
    await h.report(runId, 'joining');
    await h.report(runId, 'waiting_room');
    await h.report(runId, 'in_call', { participantCount: 2 });
    expect((await h.stores.runs.get(runId))?.state).toBe('in_call_notice_pending');
    expect(h.provider.commands.get(runId) ?? []).toEqual([]);
    await h.report(runId, 'notice_posted');
    expect((await h.stores.runs.get(runId))?.state).toBe('in_call');
    expect(h.provider.commands.get(runId) ?? []).toEqual([]); // the notice alone opens nothing: the stop monitor must report after it
    await h.report(runId, 'monitor_heartbeat', {}, h.clock.now() + 1);
    expect(h.provider.commands.get(runId)).toEqual([{ name: 'startCapture' }]);
    await h.report(runId, 'monitor_heartbeat', {}, h.clock.now() + 2);
    expect(h.provider.commands.get(runId)).toEqual([{ name: 'startCapture' }]); // once, not on every heartbeat
    expect(h.seen.map((e) => e.type)).toEqual(['bot:requested', 'bot:dispatching', 'bot:joining', 'bot:waiting_room', 'bot:in_call', 'bot:notice_posted', 'bot:capture_started']);
  });
  it('refuses capture_started before admission, before the notice, and with a stale monitor', async () => {
    const h = harness();
    const result = await h.manager.sendBot(h.request);
    const id = result.ok ? result.run.runId : '';
    await h.manager.tick();
    expect((await h.report(id, 'capture_started')).applied).toBe(0);
    await h.report(id, 'joining');
    await h.report(id, 'in_call', { participantCount: 2 });
    expect((await h.report(id, 'capture_started', {}, h.clock.now() + 1)).applied).toBe(0);
    await h.report(id, 'notice_posted');
    expect((await h.report(id, 'capture_started', {}, h.clock.now() + 2)).applied).toBe(0);
    expect((await h.stores.runs.get(id))?.captureStartedAt).toBeUndefined();
    await h.report(id, 'monitor_heartbeat');
    h.clock.advance(30_001);
    expect((await h.report(id, 'capture_started')).applied).toBe(0);
    expect(h.seen.filter((e) => e.type === 'bot:error')).toHaveLength(4);
  });
  it('a heartbeat from before the notice does not open capture', async () => {
    const h = harness();
    h.clock.set(10);
    const r = await h.manager.sendBot(h.request);
    const runId = r.ok ? r.run.runId : '';
    await h.manager.tick();
    await h.report(runId, 'joining');
    await h.report(runId, 'in_call', { participantCount: 2 }, 10);
    await h.report(runId, 'monitor_heartbeat', {}, 11);
    await h.report(runId, 'notice_posted', {}, 12);
    expect(h.provider.commands.get(runId) ?? []).toEqual([]);
    await h.report(runId, 'monitor_heartbeat', {}, 13);
    expect(h.provider.commands.get(runId)).toEqual([{ name: 'startCapture' }]);
  });
  it('a worker clock that runs ahead keeps a quiet stop monitor counted healthy for at most one heartbeat interval more', async () => {
    const h = harness();
    const ahead = 3_600_000; // the worker's clock runs an hour ahead of the manager's
    const r = await h.manager.sendBot(h.request);
    const runId = r.ok ? r.run.runId : '';
    await h.manager.tick();
    await h.report(runId, 'joining', {}, h.clock.now() + ahead);
    await h.report(runId, 'in_call', { participantCount: 2 }, h.clock.now() + ahead);
    await h.report(runId, 'notice_posted', {}, h.clock.now() + ahead);
    await h.report(runId, 'monitor_heartbeat', {}, h.clock.now() + ahead + 1);
    expect(h.provider.commands.get(runId)).toEqual([{ name: 'startCapture' }]);
    h.clock.advance(40_000); // the monitor's window and one interval more, with no heartbeat since
    await h.manager.tick();
    expect(h.provider.commands.get(runId)?.at(-1)).toEqual({ name: 'suspendCapture' });
  });
  it('refuses a report with another token, and drops a repeated report', async () => {
    const h = harness();
    const r = await h.manager.sendBot(h.request);
    const runId = r.ok ? r.run.runId : '';
    await h.manager.tick();
    const bad = await h.manager.processProviderEvent('mock', mockEventContext(runId, 'in_call', {}, 1, 'wrong'));
    expect(bad).toMatchObject({ accepted: false });
    await h.report(runId, 'joining', {}, 5);
    await h.report(runId, 'joining', {}, 5);
    expect(h.seen.filter((e) => e.type === 'bot:joining').length).toBe(1);
  });
  it('stores each report once, as the event it becomes: the event store holds what the handlers received, under the same numbers', async () => {
    const h = harness();
    const r = await h.manager.sendBot(h.request);
    const runId = r.ok ? r.run.runId : '';
    await h.manager.tick();
    await h.report(runId, 'joining');
    await h.report(runId, 'in_call', { participantCount: 1 });
    await h.report(runId, 'notice_posted');
    await h.report(runId, 'monitor_heartbeat', {}, h.clock.now() + 1);
    await h.report(runId, 'capture_started', {}, h.clock.now() + 1);
    await h.report(runId, 'participant_joined', { participantRef: 'p2', participantCount: 2 });
    await h.report(runId, 'participant_joined', { participantRef: 'p2', participantCount: 2 }); // the same report again
    await h.report(runId, 'chat_message', { text: 'hello', sender: 'Sam' });
    await h.report(runId, 'usage', { seconds: 60 });
    await h.report(runId, 'crashed', { seconds: 70 });
    const stored = await h.stores.events.read(runId, 0);
    expect(stored.map((e) => [e.seq, e.type])).toEqual(h.seen.map((e) => [e.seq, e.type]));
    expect(stored.map((e) => e.type)).toEqual(['bot:requested', 'bot:dispatching', 'bot:joining', 'bot:in_call', 'bot:notice_posted', 'bot:capture_started', 'bot:participant_joined', 'bot:chat_message', 'bot:usage', 'bot:left', 'bot:done']);
    expect(h.provider.commands.get(runId)?.filter((c) => c.name === 'postChat')).toHaveLength(1);
  });
  it('re-posts the short notice to a late arrival and ends a run that never confirms its notice', async () => {
    const h = harness();
    const r = await h.manager.sendBot(h.request);
    const runId = r.ok ? r.run.runId : '';
    await h.manager.tick();
    await h.report(runId, 'joining');
    await h.report(runId, 'in_call', { participantCount: 1 });
    await h.report(runId, 'notice_posted');
    await h.report(runId, 'monitor_heartbeat');
    await h.report(runId, 'participant_joined', { participantRef: 'p2', participantCount: 2 });
    expect(h.provider.commands.get(runId)).toEqual([{ name: 'startCapture' }, { name: 'postChat', text: 'the short notice' }]);
    const r2 = await h.manager.sendBot({ ...h.request, idempotencyKey: 'k9' });
    const id2 = r2.ok ? r2.run.runId : '';
    await h.manager.tick();
    await h.report(id2, 'joining');
    await h.report(id2, 'in_call', { participantCount: 1 });
    h.clock.advance(30_001);
    await h.manager.tick();
    expect(h.provider.commands.get(id2)).toEqual([{ name: 'leave', reason: 'notice_failed' }]);
    expect((await h.stores.runs.get(id2))?.state).toBe('leaving');
  });
  it('answers a report it cannot parse with a fixed error that repeats none of the report', async () => {
    const h = harness();
    const r = await h.manager.sendBot(h.request);
    const runId = r.ok ? r.run.runId : '';
    await h.manager.tick();
    const ctx = { ...mockEventContext(runId, 'chat_message', {}, h.clock.now(), h.provider.tokenOf(runId)), body: 'what someone said in the call' };
    expect(await h.manager.processProviderEvent('mock', ctx)).toEqual({ accepted: false, error: 'unparseable', applied: 0 });
  });
  it('a room that cannot be made fails the dispatch: tried again after the pause, and ended once the retry window has passed', async () => {
    const h = harness();
    const r = await h.manager.sendBot(h.request);
    const runId = r.ok ? r.run.runId : '';
    h.rooms.createError = new Error('room service unavailable');
    await h.manager.tick();
    expect((await h.stores.runs.get(runId))?.state).toBe('dispatching');
    expect(await h.stores.jobs.get(runId)).toMatchObject({ dispatchAt: h.clock.now() + 15_000, dispatched: false });
    expect((await h.stores.jobs.get(runId))?.leaseHolder).toBeUndefined();
    h.clock.advance(300_001);
    await h.manager.tick();
    expect(await h.stores.runs.get(runId)).toMatchObject({ state: 'failed', reason: 'crashed' });
    expect(h.entitlement.released).toEqual(['res-1']);
    expect(h.provider.dispatched.size).toBe(0);
  });
  it('a step of the pass that throws holds back no other: the limits are enforced in the same pass, and the error is thrown after it', async () => {
    const h = harness();
    const first = await h.manager.sendBot(h.request);
    const firstId = first.ok ? first.run.runId : '';
    await h.manager.tick();
    await h.report(firstId, 'joining');
    await h.report(firstId, 'waiting_room');
    await h.manager.sendBot({ ...h.request, idempotencyKey: 'k2', joinAt: h.clock.now() + 600_001 });
    vi.spyOn(h.entitlement, 'revalidate').mockRejectedValue(new Error('billing unavailable'));
    h.clock.advance(600_001);
    await expect(h.manager.tick()).rejects.toThrow('billing unavailable');
    expect(h.provider.commands.get(firstId)).toEqual([{ name: 'leave', reason: 'not_admitted' }]);
  });
  it('a cancel during the dispatch is a leave even when the bot reported before the dispatch returned', async () => {
    const h = harness();
    const r = await h.manager.sendBot(h.request);
    const runId = r.ok ? r.run.runId : '';
    h.provider.beforeDispatch = async (input) => {
      await h.manager.leaveBot(runId, 'stopped_by_owner');
      await h.manager.processProviderEvent('mock', mockEventContext(runId, 'joining', {}, h.clock.now(), input.workerToken));
    };
    await h.manager.tick();
    expect(h.provider.commands.get(runId)).toEqual([{ name: 'leave', reason: 'stopped_by_owner' }]);
    expect(await h.stores.runs.get(runId)).toMatchObject({ state: 'leaving', reason: 'stopped_by_owner' });
  });
  it('a cancel that lands while a stopped dispatch is recovered is a leave from the state the bot has reported since', async () => {
    const h = harness();
    const r = await h.manager.sendBot(h.request);
    const runId = r.ok ? r.run.runId : '';
    // a manager that stopped after the provider started the bot and before it recorded the dispatch
    await h.stores.runs.update(runId, { state: 'dispatching', dispatchedAt: h.clock.now(), dispatch: { roomName: `bot-${runId}`, workerTokenHash: MockMeetingBotProvider.hash('t') } }, 'requested');
    await h.stores.jobs.lease('stopped-manager', h.clock.now(), 1);
    h.clock.advance(10);
    h.provider.alive.set(runId, 5);
    const usage = h.provider.usage.bind(h.provider);
    vi.spyOn(h.provider, 'usage').mockImplementationOnce(async (input) => {
      await h.manager.leaveBot(runId, 'stopped_by_owner');
      await h.manager.processProviderEvent('mock', mockEventContext(runId, 'joining', {}, h.clock.now(), 't'));
      return usage(input);
    });
    await h.manager.tick();
    expect(h.provider.commands.get(runId)).toEqual([{ name: 'leave', reason: 'stopped_by_owner' }]);
    expect(await h.stores.runs.get(runId)).toMatchObject({ state: 'leaving', reason: 'stopped_by_owner' });
  });
});
