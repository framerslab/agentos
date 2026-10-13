import { describe, it, expect, vi } from 'vitest';
import { harness } from './manager-harness.js';
import { FencedError } from '../stores/types.js';
import { MockMeetingBotProvider, mockEventContext } from '../providers/mock.js';

async function joined(h: ReturnType<typeof harness>, key = 'k1', keep: 'none' | 'account' = 'none') {
  const r = await h.manager.sendBot({ ...h.request, idempotencyKey: key, keep });
  const runId = r.ok ? r.run.runId : '';
  await h.manager.tick();
  await h.report(runId, 'joining');
  await h.report(runId, 'in_call', { participantCount: 2 });
  await h.report(runId, 'notice_posted');
  await h.report(runId, 'monitor_heartbeat', {}, h.clock.now() + 1); // the monitor's first observation after the notice opens capture
  return runId;
}

describe('the stop command and the purge sequence', () => {
  it('fences, suspends, leaves, purges every store, deletes the room and leaves a content-free record', async () => {
    const h = harness();
    const runId = await joined(h);
    await h.stores.transcript.append({ runId, seq: 1, turnId: `${runId}:1`, at: 1, text: 'a sentence' });
    const purged: string[] = [];
    h.manager.addPurgeHook(async (id) => { purged.push(id); });
    await h.report(runId, 'chat_message', { text: 'ok, STOP TAKING NOTES now', sender: 'Sam' });
    expect(h.provider.commands.get(runId)?.slice(1)).toEqual([{ name: 'suspendCapture' }, { name: 'leave', reason: 'stopped_by_participant' }]);
    await expect(h.stores.transcript.append({ runId, seq: 2, turnId: `${runId}:2`, at: 2, text: 'late' })).rejects.toBeInstanceOf(FencedError);
    expect((await h.stores.runs.get(runId))?.state).toBe('purging');
    await h.report(runId, 'left', { reason: 'stopped_by_participant', seconds: 90 });
    await h.report(runId, 'done', { seconds: 90 });
    await h.manager.tick();
    const run = await h.stores.runs.get(runId);
    expect(run).toMatchObject({ state: 'done', reason: 'stopped_by_participant', meetingUrl: '', botName: '', stopPhrase: '', billedSeconds: 90 });
    expect(run?.dispatch).toBeUndefined();
    expect(await h.stores.transcript.read(runId, 0)).toEqual([]);
    expect((await h.stores.events.read(runId, 0)).filter((e) => e.type === 'bot:chat_message')[0]).toMatchObject({ purged: true });
    expect(purged).toEqual([runId]);
    expect(h.rooms.deleted).toEqual([`bot-${runId}`]);
    expect(h.entitlement.settled).toEqual([['res-1', 90]]);
    expect(h.seen.map((e) => e.type).slice(-2)).toEqual(['bot:purged', 'bot:done']);
    const late = await h.report(runId, 'chat_message', { text: 'after', sender: 'x' }, 999);
    expect(late.applied).toBe(0);
  });
  it('kills a bot that does not leave, and retries a purge step until it resolves', async () => {
    const h = harness();
    const runId = await joined(h);
    let tries = 0;
    h.manager.addPurgeHook(async () => { tries += 1; if (tries < 3) throw new Error('not yet'); });
    await h.manager.purgeRun(runId, 'stopped_by_owner');
    h.clock.advance(30_001);
    await h.manager.tick();
    expect(h.provider.commands.get(runId)?.at(-1)).toEqual({ name: 'kill' });
    for (let i = 0; i < 3; i++) await h.manager.tick(); // the hook fails twice, then resolves
    expect(tries).toBe(3);
    expect(await h.stores.runs.get(runId)).toMatchObject({ state: 'done', reason: 'stopped_by_owner' });
  });
  it('kills a bot that does not leave when another manager, or this one after a restart, runs the limits', async () => {
    const h = harness();
    const purged = await joined(h);
    const leaving = await joined(h, 'k2');
    await h.manager.purgeRun(purged, 'stopped_by_owner');
    await h.manager.leaveBot(leaving, 'stopped_by_owner');
    const restarted = h.peer('m2'); // nothing of the first manager's memory
    h.clock.advance(30_001);
    await restarted.tick();
    expect(h.provider.commands.get(purged)?.at(-1)).toEqual({ name: 'kill' });
    expect(h.provider.commands.get(leaving)?.at(-1)).toEqual({ name: 'kill' });
    await restarted.tick();
    expect(await h.stores.runs.get(purged)).toMatchObject({ state: 'done', reason: 'stopped_by_owner', botName: '' });
    expect(await h.stores.runs.get(leaving)).toMatchObject({ state: 'done', reason: 'stopped_by_owner' });
  });
});

describe('the limits, the meter and the ends', () => {
  it('leaves after ten minutes in the waiting room, unbilled', async () => {
    const h = harness();
    const r = await h.manager.sendBot(h.request);
    const runId = r.ok ? r.run.runId : '';
    await h.manager.tick();
    await h.report(runId, 'joining');
    await h.report(runId, 'waiting_room');
    h.clock.advance(600_001);
    await h.manager.tick();
    expect(h.provider.commands.get(runId)).toEqual([{ name: 'leave', reason: 'not_admitted' }]);
    await h.report(runId, 'left', { reason: 'not_admitted', seconds: 601 });
    expect(await h.stores.runs.get(runId)).toMatchObject({ state: 'done', reason: 'not_admitted', billedSeconds: 0 });
    expect(h.entitlement.released).toEqual(['res-1']);
    expect(h.entitlement.settled).toEqual([]);
  });
  it('counts the waiting room from the bot\'s arrival in it, not from the dispatch', async () => {
    const h = harness();
    const r = await h.manager.sendBot(h.request);
    const runId = r.ok ? r.run.runId : '';
    await h.manager.tick();
    await h.report(runId, 'joining');
    h.clock.advance(60_000); // the bot takes a minute to reach the waiting room
    await h.report(runId, 'waiting_room');
    h.clock.advance(540_001); // ten minutes after the dispatch, nine in the waiting room
    await h.manager.tick();
    expect(h.provider.commands.get(runId) ?? []).toEqual([]);
    h.clock.advance(60_000);
    await h.manager.tick();
    expect(h.provider.commands.get(runId)).toEqual([{ name: 'leave', reason: 'not_admitted' }]);
  });
  it('suspends capture when the monitor goes quiet, resumes on a heartbeat, and ends when it stays quiet', async () => {
    const h = harness();
    const runId = await joined(h);
    h.clock.advance(30_001);
    await h.manager.tick();
    expect(h.provider.commands.get(runId)?.at(-1)).toEqual({ name: 'suspendCapture' });
    await h.report(runId, 'monitor_heartbeat');
    expect(h.provider.commands.get(runId)?.at(-1)).toEqual({ name: 'startCapture' });
    h.clock.advance(30_001);
    await h.manager.tick();
    h.clock.advance(30_001);
    await h.manager.tick();
    expect(h.provider.commands.get(runId)?.at(-1)).toEqual({ name: 'leave', reason: 'stop_monitor_failed' });
  });
  it('ends a run whose stop monitor never reports after the notice, once the window and the recovery wait have passed', async () => {
    const h = harness();
    const r = await h.manager.sendBot(h.request);
    const runId = r.ok ? r.run.runId : '';
    await h.manager.tick();
    await h.report(runId, 'joining');
    await h.report(runId, 'in_call', { participantCount: 2 });
    await h.report(runId, 'notice_posted'); // no heartbeat follows: capture stays closed
    h.clock.advance(60_000);
    await h.manager.tick();
    expect(h.provider.commands.get(runId) ?? []).toEqual([]);
    h.clock.advance(1);
    await h.manager.tick();
    expect(h.provider.commands.get(runId)).toEqual([{ name: 'leave', reason: 'stop_monitor_failed' }]);
    await h.report(runId, 'left', { seconds: 61 });
    expect(await h.stores.runs.get(runId)).toMatchObject({ state: 'done', reason: 'stop_monitor_failed', billedSeconds: 0 });
  });
  it('a capture one manager suspended is resumed by the manager that hears the monitor recover, after a restart too', async () => {
    const h = harness();
    const runId = await joined(h);
    h.clock.advance(30_001);
    await h.manager.tick();
    expect(h.provider.commands.get(runId)?.at(-1)).toEqual({ name: 'suspendCapture' });
    const other = h.peer('m2'); // another process, or this one restarted: nothing of the suspension in its memory
    await other.processProviderEvent('mock', mockEventContext(runId, 'monitor_heartbeat', {}, h.clock.now(), h.provider.tokenOf(runId)));
    expect(h.provider.commands.get(runId)?.at(-1)).toEqual({ name: 'startCapture' });
    h.clock.advance(30_001);
    await h.manager.tick(); // quiet again: suspended again, not ended on the clock of the first suspension
    expect(h.provider.commands.get(runId)?.at(-1)).toEqual({ name: 'suspendCapture' });
  });
  it('leaves when alone for five minutes, at four hours, and when the page is away', async () => {
    const h = harness();
    const runId = await joined(h);
    await h.report(runId, 'participant_left', { participantRef: 'p', participantCount: 0 });
    h.clock.advance(300_001);
    await h.report(runId, 'monitor_heartbeat');
    await h.manager.tick();
    expect(h.provider.commands.get(runId)?.at(-1)).toEqual({ name: 'leave', reason: 'alone' });
    const r2 = await h.manager.sendBot({ ...h.request, idempotencyKey: 'k2', limits: { pageAwayMs: 120_000 } });
    const id2 = r2.ok ? r2.run.runId : '';
    await h.manager.tick();
    await h.report(id2, 'joining');
    await h.report(id2, 'in_call', { participantCount: 2 });
    await h.report(id2, 'notice_posted');
    await h.report(id2, 'monitor_heartbeat', {}, h.clock.now() + 1);
    h.clock.advance(120_001);
    await h.report(id2, 'monitor_heartbeat');
    await h.manager.tick();
    expect(h.provider.commands.get(id2)?.at(-1)).toEqual({ name: 'leave', reason: 'page_away' });
    await h.manager.pageSeen(id2);
    const r3 = await h.manager.sendBot({ ...h.request, idempotencyKey: 'k3' });
    const id3 = r3.ok ? r3.run.runId : '';
    await h.manager.tick();
    await h.report(id3, 'joining');
    await h.report(id3, 'in_call', { participantCount: 2 });
    await h.report(id3, 'notice_posted');
    await h.report(id3, 'monitor_heartbeat', {}, h.clock.now() + 1);
    h.clock.advance(14_400_001);
    await h.report(id3, 'monitor_heartbeat');
    await h.manager.tick();
    expect(h.provider.commands.get(id3)?.at(-1)).toEqual({ name: 'leave', reason: 'cap' });
  });
  it('the alone limit is the run\'s: a restarted manager ends a run left alone, and a manager that missed a participant joining does not', async () => {
    const h = harness();
    const runId = await joined(h);
    await h.report(runId, 'participant_left', { participantRef: 'p', participantCount: 0 });
    const restarted = h.peer('m2');
    h.clock.advance(300_001);
    await h.report(runId, 'monitor_heartbeat');
    await restarted.tick();
    expect(h.provider.commands.get(runId)?.at(-1)).toEqual({ name: 'leave', reason: 'alone' });
    const id2 = await joined(h, 'k2');
    await h.report(id2, 'participant_left', { participantRef: 'p', participantCount: 0 });
    // the report that someone joined reaches the other manager
    await restarted.processProviderEvent('mock', mockEventContext(id2, 'participant_joined', { participantRef: 'q', participantCount: 1 }, h.clock.now(), h.provider.tokenOf(id2)));
    h.clock.advance(300_001);
    await h.report(id2, 'monitor_heartbeat');
    await h.manager.tick();
    expect(h.provider.commands.get(id2)?.some((c) => c.name === 'leave')).toBe(false);
  });
  it('meters usage, settles at done, drops the turns of a run that is not kept, and bills a crash after capture', async () => {
    const h = harness();
    const runId = await joined(h);
    await h.report(runId, 'usage', { seconds: 60 });
    await h.report(runId, 'usage', { seconds: 120 }, h.clock.now() + 1);
    expect(h.entitlement.metered).toEqual([['res-1', 60], ['res-1', 120]]);
    await h.stores.transcript.append({ runId, seq: 1, turnId: `${runId}:1`, at: 1, text: 'kept while live' });
    await h.report(runId, 'crashed', { seconds: 130 });
    expect(await h.stores.runs.get(runId)).toMatchObject({ state: 'done', reason: 'crashed', billedSeconds: 130 });
    expect(h.entitlement.settled).toEqual([['res-1', 130]]);
    expect(await h.stores.transcript.read(runId, 0)).toEqual([]);
  });
  it('reconciles: a dispatched run whose worker has no container is ended as crashed', async () => {
    const h = harness();
    const runId = await joined(h);
    h.provider.alive.clear();
    h.clock.advance(60_000);
    await h.manager.tick();
    expect(await h.stores.runs.get(runId)).toMatchObject({ state: 'done', reason: 'crashed' });
  });
  it('leaveBot leaves and keeps the data; a scheduled run can be cancelled before dispatch', async () => {
    const h = harness();
    const runId = await joined(h);
    await h.stores.transcript.append({ runId, seq: 1, turnId: `${runId}:1`, at: 1, text: 'kept' });
    await h.manager.leaveBot(runId, 'stopped_by_owner');
    await h.report(runId, 'left', { reason: 'stopped_by_owner', seconds: 10 });
    expect((await h.stores.transcript.read(runId, 0)).length).toBe(0); // keep: 'none' drops at done
    const r = await h.manager.sendBot({ ...h.request, idempotencyKey: 'k2', keep: 'account', joinAt: h.clock.now() + 100_000 });
    const id2 = r.ok ? r.run.runId : '';
    await h.manager.purgeRun(id2, 'stopped_by_owner');
    expect(await h.stores.jobs.cancel(id2)).toBe('missing');
    expect((await h.stores.runs.get(id2))?.state).toBe('done');
  });
  it('a cancel that lands while the dispatch is in flight becomes a leave with the cancel\'s reason', async () => {
    const h = harness();
    const r = await h.manager.sendBot(h.request);
    const runId = r.ok ? r.run.runId : '';
    h.provider.beforeDispatch = async () => {
      await h.manager.leaveBot(runId, 'stopped_by_owner');
    };
    await h.manager.tick();
    expect(h.provider.commands.get(runId)).toEqual([{ name: 'leave', reason: 'stopped_by_owner' }]);
    expect(await h.stores.runs.get(runId)).toMatchObject({ state: 'leaving', reason: 'stopped_by_owner' });
  });
  it('a dispatch that fails for a moment is tried again after the pause, never in the same tick', async () => {
    const h = harness();
    const r = await h.manager.sendBot(h.request);
    const runId = r.ok ? r.run.runId : '';
    h.provider.dispatchError = new Error('worker unreachable');
    await h.manager.tick();
    expect(h.provider.dispatched.size).toBe(0);
    expect((await h.stores.runs.get(runId))?.state).toBe('dispatching');
    h.provider.dispatchError = undefined;
    await h.manager.tick();
    expect(h.provider.dispatched.size).toBe(0); // not due again yet
    h.clock.advance(15_000);
    await h.manager.tick();
    expect(h.provider.dispatched.size).toBe(1);
    expect((await h.stores.runs.get(runId))?.state).toBe('dispatching');
  });
  it('a run left in dispatching by a dead manager is recovered: the bot is out, or it is dispatched again', async () => {
    const h = harness();
    const r = await h.manager.sendBot(h.request);
    const runId = r.ok ? r.run.runId : '';
    // a manager that died after the provider started the bot and before markDispatched: the run says dispatching, the job's lease has expired
    await h.stores.runs.update(runId, { state: 'dispatching', dispatchedAt: h.clock.now(), dispatch: { roomName: `bot-${runId}`, workerTokenHash: MockMeetingBotProvider.hash('t') } }, 'requested');
    await h.stores.jobs.lease('dead-manager', h.clock.now(), 1);
    h.clock.advance(10);
    h.provider.alive.set(runId, 5);
    await h.manager.tick();
    expect((await h.stores.jobs.get(runId))?.dispatched).toBe(true);
    expect(h.provider.dispatched.size).toBe(0); // the bot was out: not dispatched a second time
    const r2 = await h.manager.sendBot({ ...h.request, idempotencyKey: 'k2' });
    const id2 = r2.ok ? r2.run.runId : '';
    await h.stores.runs.update(id2, { state: 'dispatching', dispatchedAt: h.clock.now(), dispatch: { roomName: `bot-${id2}`, workerTokenHash: MockMeetingBotProvider.hash('t') } }, 'requested');
    await h.stores.jobs.lease('dead-manager', h.clock.now(), 1);
    h.clock.advance(10);
    await h.manager.tick();
    expect(h.rooms.deleted).toContain(`bot-${id2}`); // the old room gone
    expect(h.provider.dispatched.has(id2)).toBe(true); // dispatched again
    expect((await h.stores.jobs.get(id2))?.dispatched).toBe(true);
  });
  it('a kept run that is done can be purged later: the content goes, the row stays content-free', async () => {
    const h = harness();
    const runId = await joined(h, 'k1', 'account');
    await h.stores.transcript.append({ runId, seq: 1, turnId: `${runId}:1`, at: 1, text: 'kept' });
    await h.manager.leaveBot(runId, 'stopped_by_owner');
    await h.report(runId, 'left', { reason: 'stopped_by_owner', seconds: 10 });
    expect((await h.stores.transcript.read(runId, 0)).length).toBe(1);
    expect((await h.stores.runs.get(runId))?.botName).toBe("Dana's notes");
    expect(await h.manager.purgeRun(runId)).toBe(true);
    expect(await h.stores.transcript.read(runId, 0)).toEqual([]);
    expect(await h.stores.runs.get(runId)).toMatchObject({ state: 'done', botName: '', purgedAt: expect.any(Number) });
    expect(h.seen.at(-1)?.type).toBe('bot:purged');
  });
  it('a settle that throws keeps the run in left and is retried on the next tick; done is written after it', async () => {
    const h = harness();
    const runId = await joined(h);
    let fails = 1;
    h.entitlement.settleThrows = () => fails-- > 0;
    await h.report(runId, 'left', { reason: 'ended', seconds: 30 });
    expect(await h.stores.runs.get(runId)).toMatchObject({ state: 'left', cleanupPending: true });
    await h.manager.tick();
    expect(await h.stores.runs.get(runId)).toMatchObject({ state: 'done', billedSeconds: 30 });
    expect(h.entitlement.settled).toEqual([['res-1', 30]]);
  });
  it('a content report that arrives behind the fence is stored nowhere and forwarded to no one', async () => {
    const h = harness();
    const runId = await joined(h);
    await h.manager.purgeRun(runId, 'stopped_by_owner');
    const before = (await h.stores.events.read(runId, 0)).length;
    const late = await h.report(runId, 'chat_message', { text: 'late words', sender: 'x' });
    expect(late.applied).toBe(0);
    expect((await h.stores.events.read(runId, 0)).length).toBe(before);
    expect(h.seen.some((e) => e.type === 'bot:chat_message' && e.data?.text === 'late words')).toBe(false);
  });
  it('a cancel during a failing dispatch ends the run and frees its reservation', async () => {
    const h = harness();
    const sent = await h.manager.sendBot(h.request);
    const runId = sent.ok ? sent.run.runId : '';
    h.provider.beforeDispatch = async () => {
      await h.manager.leaveBot(runId, 'stopped_by_owner');
      throw new Error('reply failed');
    };
    await h.manager.tick();
    expect(await h.stores.runs.get(runId)).toMatchObject({ state: 'failed', reason: 'stopped_by_owner' });
    expect(await h.stores.jobs.get(runId)).toBeUndefined();
    expect(h.entitlement.released).toEqual(['res-1']);
  });
  it('crash cannot overwrite a purge between its read and update', async () => {
    const h = harness();
    const runId = await joined(h, 'k1', 'account');
    const update = h.stores.runs.update.bind(h.stores.runs);
    let raced = false;
    vi.spyOn(h.stores.runs, 'update').mockImplementation(async (id, patch, expected) => {
      if (!raced && patch.state === 'left') {
        raced = true;
        await h.manager.purgeRun(id);
      }
      return update(id, patch, expected);
    });
    await h.report(runId, 'crashed', { seconds: 30 });
    expect(await h.stores.runs.get(runId)).toMatchObject({ state: 'purging', reason: 'stopped_by_owner' });
    await h.manager.tick();
    expect(await h.stores.runs.get(runId)).toMatchObject({ state: 'done', botName: '' });
  });
  it('fail cannot overwrite a purge between its read and update', async () => {
    const h = harness();
    const sent = await h.manager.sendBot(h.request);
    const runId = sent.ok ? sent.run.runId : '';
    const update = h.stores.runs.update.bind(h.stores.runs);
    let raced = false;
    vi.spyOn(h.stores.runs, 'update').mockImplementation(async (id, patch, expected) => {
      if (!raced && patch.cleanupPending && patch.state === undefined) {
        raced = true;
        await update(id, { state: 'purging', reason: 'declined' }, 'requested');
        await h.stores.transcript.fence(id);
        await h.stores.events.fence(id);
        await h.stores.outbox.purgeContent(id);
      }
      return update(id, patch, expected);
    });
    await h.manager.leaveBot(runId);
    expect(await h.stores.runs.get(runId)).toMatchObject({ state: 'purging', reason: 'declined' });
  });
  it('done from leaving passes through left, fences late finals and drops unkept content', async () => {
    const h = harness();
    const runId = await joined(h);
    const sink = h.manager.transcriptSink(runId);
    await sink.appendNext({ runId, at: 1, text: 'before' });
    await h.manager.leaveBot(runId);
    await h.report(runId, 'done', { seconds: 5 });
    expect(await h.stores.runs.get(runId)).toMatchObject({ state: 'done' });
    expect(h.seen.map((e) => e.type).slice(-2)).toEqual(['bot:left', 'bot:done']);
    expect(await sink.appendNext({ runId, at: 2, text: 'late' })).toBeUndefined();
    expect(await h.stores.transcript.read(runId, 0)).toEqual([]);
    expect(await h.stores.transcript.isFenced(runId)).toBe(true);
  });
  it('sink instances continue one run sequence and emit every transcript once', async () => {
    const h = harness();
    const runId = await joined(h);
    const first = h.manager.transcriptSink(runId);
    expect((await first.appendNext({ runId, at: 1, text: 'one' }))?.turnId).toBe(`${runId}:1`);
    const second = h.manager.transcriptSink(runId);
    expect((await second.appendNext({ runId, at: 2, text: 'two' }))?.turnId).toBe(`${runId}:2`);
    expect((await h.stores.transcript.read(runId, 0)).map((t) => t.seq)).toEqual([1, 2]);
    expect(h.seen.filter((e) => e.type === 'bot:transcript').map((e) => e.data?.seq)).toEqual([1, 2]);
  });
  it('the outbox refuses new content as soon as purge is fenced, before the bot leaves', async () => {
    const h = harness();
    const runId = await joined(h);
    await h.manager.purgeRun(runId);
    await h.stores.outbox.enqueue({ id: 'late', runId, eventId: 'late', type: 'bot:transcript', destinationRef: 'h', payload: 'late' }, h.clock.now());
    expect(await h.stores.outbox.listByRun(runId)).toEqual([]);
    expect((await h.stores.runs.get(runId))?.state).toBe('purging');
  });
  it('forgets unkept and purged terminal stores only after the grace, while kept runs remain', async () => {
    const h = harness();
    const runId = await joined(h);
    await h.report(runId, 'left', { seconds: 2 });
    const kept = await joined(h, 'k2', 'account');
    await h.report(kept, 'left', { seconds: 2 });
    const purged = await joined(h, 'k3', 'account');
    await h.manager.purgeRun(purged);
    await h.report(purged, 'left', { seconds: 2 });
    await h.manager.tick();
    h.clock.advance(172_799_999);
    await h.manager.tick();
    expect(await h.stores.runs.get(runId)).toBeDefined();
    h.clock.advance(1);
    await h.manager.tick();
    expect(await h.stores.runs.get(runId)).toBeUndefined();
    expect(await h.stores.runs.get(purged)).toBeUndefined();
    expect(await h.stores.events.read(runId, 0)).toEqual([]);
    expect(await h.stores.transcript.isFenced(runId)).toBe(false);
    expect(await h.stores.jobs.get(runId)).toBeUndefined();
    expect(await h.stores.outbox.listByRun(runId)).toEqual([]);
    expect(await h.stores.runs.get(kept)).toBeDefined();
    expect(await h.manager.transcriptSink(runId).appendNext({ runId, at: 3, text: 'late after eviction' })).toBeUndefined();
  });
  it('the transcript sink writes the turn and the manager records bot:transcript; behind the fence it drops the turn', async () => {
    const h = harness();
    const runId = await joined(h);
    const sink = h.manager.transcriptSink(runId);
    await sink.appendNext({ runId, at: 5, text: 'we start at nine' });
    expect((await h.stores.transcript.read(runId, 0)).map((t) => t.text)).toEqual(['we start at nine']);
    expect(h.seen.at(-1)).toMatchObject({ type: 'bot:transcript', data: { seq: 1, text: 'we start at nine' } });
    await h.manager.purgeRun(runId, 'stopped_by_owner');
    await sink.appendNext({ runId, at: 6, text: 'late' });
    expect(await h.stores.transcript.read(runId, 0)).toEqual([]);
    expect(h.seen.filter((e) => e.type === 'bot:transcript').length).toBe(1);
  });
});

describe('a step that fails, or a race, on the way out', () => {
  it('a run whose purge keeps failing holds back neither the limits nor the reconcile of the other runs', async () => {
    const h = harness();
    const first = await joined(h, 'k1'); // the oldest: the limits reach it last, the reconcile first
    h.clock.advance(1);
    const failing = await joined(h, 'k2');
    h.clock.advance(1);
    const last = await joined(h, 'k3'); // the newest: the limits reach it first, the reconcile last
    await h.manager.purgeRun(failing);
    await h.report(failing, 'left', { reason: 'stopped_by_owner', seconds: 5 });
    const remove = h.stores.jobs.remove.bind(h.stores.jobs);
    vi.spyOn(h.stores.jobs, 'remove').mockImplementation(async (id) => {
      if (id === failing) throw new Error('job store unavailable');
      return remove(id);
    });
    h.provider.alive.delete(last); // its container is gone
    h.clock.advance(60_000); // every stop monitor quiet, and a reconcile due
    await expect(h.manager.tick()).rejects.toThrow('job store unavailable');
    expect(h.provider.commands.get(first)?.at(-1)).toEqual({ name: 'suspendCapture' });
    expect(await h.stores.runs.get(last)).toMatchObject({ state: 'done', reason: 'crashed' });
    expect((await h.stores.runs.get(failing))?.state).toBe('purging');
  });
  it('a purge that lands as a dispatcher takes the run still tells the bot that is out to leave, and kills it', async () => {
    const h = harness();
    const sent = await h.manager.sendBot(h.request);
    const runId = sent.ok ? sent.run.runId : '';
    const update = h.stores.runs.update.bind(h.stores.runs);
    let raced = false;
    vi.spyOn(h.stores.runs, 'update').mockImplementation(async (id, patch, expected) => {
      if (!raced && patch.state === 'purging') {
        raced = true;
        // between the purge's read and its fence a dispatcher took the run, wrote its dispatch record and started the bot
        await update(id, { state: 'dispatching', dispatchedAt: h.clock.now(), dispatch: { roomName: `bot-${id}`, workerTokenHash: MockMeetingBotProvider.hash('t') } }, 'requested');
      }
      return update(id, patch, expected);
    });
    await h.manager.purgeRun(runId, 'stopped_by_owner');
    expect(h.provider.commands.get(runId)).toEqual([{ name: 'suspendCapture' }, { name: 'leave', reason: 'stopped_by_owner' }]);
    h.clock.advance(30_001);
    await h.manager.tick();
    expect(h.provider.commands.get(runId)?.at(-1)).toEqual({ name: 'kill' });
    await h.manager.tick();
    expect(await h.stores.runs.get(runId)).toMatchObject({ state: 'done', reason: 'stopped_by_owner', botName: '' });
    expect(h.rooms.deleted).toContain(`bot-${runId}`);
  });
  it('a purge whose commands do not reach the bot still kills it after the wait and ends with its room deleted', async () => {
    const h = harness();
    const runId = await joined(h);
    const command = vi.spyOn(h.provider, 'command').mockRejectedValue(new Error('worker unreachable'));
    expect(await h.manager.purgeRun(runId, 'stopped_by_owner')).toBe(true);
    expect((await h.stores.runs.get(runId))?.state).toBe('purging');
    h.clock.advance(30_001);
    await h.manager.tick();
    expect(command).toHaveBeenLastCalledWith(runId, { name: 'kill' });
    await h.manager.tick();
    expect(await h.stores.runs.get(runId)).toMatchObject({ state: 'done', reason: 'stopped_by_owner', botName: '' });
    expect(h.rooms.deleted).toContain(`bot-${runId}`);
  });
  it('a leave whose command does not reach the bot is followed by the kill', async () => {
    const h = harness();
    const runId = await joined(h);
    vi.spyOn(h.provider, 'command').mockRejectedValueOnce(new Error('worker unreachable'));
    expect(await h.manager.leaveBot(runId)).toBe(true);
    h.clock.advance(30_001);
    await h.manager.tick();
    expect(h.provider.commands.get(runId)?.at(-1)).toEqual({ name: 'kill' });
    expect(await h.stores.runs.get(runId)).toMatchObject({ state: 'done', reason: 'stopped_by_owner' });
  });
  it('a cancel that finds the run already dispatched is a leave from the state the run is in now', async () => {
    const h = harness();
    const sent = await h.manager.sendBot(h.request);
    const runId = sent.ok ? sent.run.runId : '';
    const cancel = h.stores.jobs.cancel.bind(h.stores.jobs);
    vi.spyOn(h.stores.jobs, 'cancel').mockImplementationOnce(async (id) => {
      await h.manager.tick(); // a dispatcher takes the run between the owner's read and the cancel, and the bot is out
      return cancel(id);
    });
    expect(await h.manager.leaveBot(runId, 'stopped_by_owner')).toBe(true);
    expect(h.provider.commands.get(runId)).toEqual([{ name: 'leave', reason: 'stopped_by_owner' }]);
    expect(await h.stores.runs.get(runId)).toMatchObject({ state: 'leaving', reason: 'stopped_by_owner' });
  });
  it('a cancel during a dispatch whose manager stopped is a leave once the lease has run out, whether or not the bot has reported', async () => {
    const h = harness();
    const ids: string[] = [];
    for (const key of ['k1', 'k2']) {
      const sent = await h.manager.sendBot({ ...h.request, idempotencyKey: key });
      const id = sent.ok ? sent.run.runId : '';
      // a manager that stopped after the provider started the bot and before it recorded the dispatch
      await h.stores.runs.update(id, { state: 'dispatching', dispatchedAt: h.clock.now(), dispatch: { roomName: `bot-${id}`, workerTokenHash: MockMeetingBotProvider.hash('t') } }, 'requested');
      await h.stores.jobs.lease('stopped-manager', h.clock.now(), 1);
      ids.push(id);
    }
    h.clock.advance(10);
    for (const id of ids) expect(await h.manager.leaveBot(id, 'stopped_by_owner')).toBe(true);
    // the bot that manager started for the first run reports, and its run moves on; the second run's bot never does
    await h.manager.processProviderEvent('mock', mockEventContext(ids[0], 'joining', {}, h.clock.now(), 't'));
    await h.manager.tick();
    for (const id of ids) {
      expect(h.provider.commands.get(id)).toEqual([{ name: 'leave', reason: 'stopped_by_owner' }]);
      expect(await h.stores.runs.get(id)).toMatchObject({ state: 'leaving', reason: 'stopped_by_owner' });
    }
    h.clock.advance(30_001);
    await h.manager.tick();
    for (const id of ids) expect(await h.stores.runs.get(id)).toMatchObject({ state: 'done', reason: 'stopped_by_owner', billedSeconds: 0 });
  });
  it('a purge whose last write to the run store fails leaves no done row holding the run\'s content', async () => {
    const h = harness();
    const runId = await joined(h);
    await h.manager.purgeRun(runId, 'stopped_by_owner');
    await h.report(runId, 'left', { reason: 'stopped_by_owner', seconds: 20 });
    vi.spyOn(h.stores.runs, 'replace').mockRejectedValueOnce(new Error('run store unavailable'));
    await h.manager.tick().catch(() => undefined); // a pass that throws is the next pass's to retry
    expect(await h.manager.purgeRun(runId)).toBe(true); // the product's one purge path, tried again
    await h.manager.tick();
    expect(await h.stores.runs.get(runId)).toMatchObject({ state: 'done', meetingUrl: '', botName: '', stopPhrase: '', notice: { text: '', lateArrivalText: '' }, purgedAt: expect.any(Number) });
    expect(h.seen.filter((e) => e.type === 'bot:purged')).toHaveLength(1);
  });
});

describe('a report whose application fails, and the worker\'s retry of it', () => {
  it('a stop whose purge fails is carried out on the retry of its report, and the message reaches the handlers once', async () => {
    const h = harness();
    const runId = await joined(h);
    const update = h.stores.runs.update.bind(h.stores.runs);
    let refused = false;
    vi.spyOn(h.stores.runs, 'update').mockImplementation(async (id, patch, expected) => {
      if (!refused && patch.state === 'purging') {
        refused = true;
        throw new Error('run store unavailable');
      }
      return update(id, patch, expected);
    });
    const stop = mockEventContext(runId, 'chat_message', { text: 'please stop taking notes', sender: 'participant-1' }, h.clock.now(), h.provider.tokenOf(runId));
    await expect(h.manager.processProviderEvent('mock', stop)).rejects.toThrow('run store unavailable');
    expect((await h.stores.runs.get(runId))?.state).toBe('in_call');
    expect(await h.manager.processProviderEvent('mock', stop)).toEqual({ accepted: true, applied: 1 });
    expect((await h.stores.runs.get(runId))?.state).toBe('purging');
    expect(h.provider.commands.get(runId)?.slice(-2)).toEqual([{ name: 'suspendCapture' }, { name: 'leave', reason: 'stopped_by_participant' }]);
    expect(h.seen.filter((e) => e.type === 'bot:chat_message')).toHaveLength(1);
  });
  it('a stop goes ahead when the message\'s delivery fails, and the delivery\'s error is still raised', async () => {
    let failing = false;
    const h = harness({
      destinationsFor: async () => {
        if (failing) throw new Error('destinations unavailable');
        return ['hook-1'];
      },
    });
    const runId = await joined(h);
    failing = true;
    await expect(h.report(runId, 'chat_message', { text: 'stop taking notes', sender: 'participant-1' })).rejects.toThrow('destinations unavailable');
    expect((await h.stores.runs.get(runId))?.state).toBe('purging');
    expect(h.provider.commands.get(runId)?.slice(-2)).toEqual([{ name: 'suspendCapture' }, { name: 'leave', reason: 'stopped_by_participant' }]);
  });
  it('a report whose delivery failed is enqueued for its destination when the worker sends it again', async () => {
    let failing = false;
    const h = harness({
      destinationsFor: async () => {
        if (failing) throw new Error('destinations unavailable');
        return ['hook-1'];
      },
    });
    const runId = await joined(h);
    const message = mockEventContext(runId, 'chat_message', { text: 'the agenda first', sender: 'participant-1' }, h.clock.now(), h.provider.tokenOf(runId));
    failing = true;
    await expect(h.manager.processProviderEvent('mock', message)).rejects.toThrow('destinations unavailable');
    failing = false;
    expect(await h.manager.processProviderEvent('mock', message)).toEqual({ accepted: true, applied: 0 });
    const deliveries = (await h.stores.outbox.listByRun(runId)).filter((d) => d.type === 'bot:chat_message');
    expect(deliveries).toHaveLength(1);
    expect(JSON.parse(deliveries[0].payload)).toMatchObject({ type: 'bot:chat_message', data: { text: 'the agenda first', sender: 'participant-1' } });
  });
});

describe('the purge\'s last events', () => {
  it('a purge whose last events fail to go out stays purging, and the next pass sends them and writes done', async () => {
    let failing = false;
    const h = harness({
      destinationsFor: async () => {
        if (failing) throw new Error('destinations unavailable');
        return ['hook-1'];
      },
    });
    const runId = await joined(h);
    await h.manager.purgeRun(runId, 'stopped_by_owner');
    await h.report(runId, 'left', { reason: 'stopped_by_owner', seconds: 20 });
    failing = true;
    await expect(h.manager.tick()).rejects.toThrow('destinations unavailable');
    expect((await h.stores.runs.get(runId))?.state).toBe('purging');
    failing = false;
    await h.manager.tick();
    expect(await h.stores.runs.get(runId)).toMatchObject({ state: 'done', botName: '', billedSeconds: 20, purgedAt: expect.any(Number) });
    const ids = (await h.stores.outbox.listByRun(runId)).map((d) => d.id);
    expect(ids).toEqual(expect.arrayContaining([`${runId}:bot:purged@hook-1`, `${runId}:bot:done@hook-1`]));
    expect(h.seen.filter((e) => e.type === 'bot:done')).toHaveLength(1);
  });
});

describe('an event on its way when the fence goes up', () => {
  it('a transcript stored behind a fence that went up on its way reaches the handlers without its words', async () => {
    const h = harness();
    const runId = await joined(h);
    const append = h.stores.events.append.bind(h.stores.events);
    vi.spyOn(h.stores.events, 'append').mockImplementation(async (event) => {
      // the purge's fence goes up between the manager's check of the run and the store's write of the event
      if (event.type === 'bot:transcript') await h.manager.purgeRun(runId, 'stopped_by_owner');
      return append(event);
    });
    expect(await h.manager.recordTranscript({ runId, seq: 1, turnId: `${runId}:1`, at: 5, text: 'words after the stop' })).toBe(true);
    const transcript = h.seen.find((e) => e.type === 'bot:transcript');
    expect(transcript).toBeDefined();
    expect(transcript?.data).toBeUndefined();
    expect((await h.stores.events.read(runId, 0)).find((e) => e.type === 'bot:transcript')).toMatchObject({ purged: true });
  });
});
