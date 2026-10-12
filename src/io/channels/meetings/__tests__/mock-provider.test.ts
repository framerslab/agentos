import { describe, it, expect } from 'vitest';
import { MockMeetingBotProvider, mockEventContext } from '../providers/mock.js';
import { DEFAULT_RUN_LIMITS, type MeetingRunRecord } from '../types.js';
import { hashWorkerToken } from '../signing.js';

const run = (dispatch?: MeetingRunRecord['dispatch']): MeetingRunRecord => ({
  runId: 'r1', ownerRef: 'a', providerName: 'mock', platform: 'google_meet', state: 'dispatching', keep: 'none',
  meetingUrl: 'https://meet.google.com/abc-defg-hij', botName: 'Notes', notice: { text: 'n', version: '1', lateArrivalText: 's' },
  stopPhrase: 'stop', limits: DEFAULT_RUN_LIMITS, requestedAt: 0, joinAt: 0, billedSeconds: 0, dispatch,
});

describe('MockMeetingBotProvider', () => {
  it('declares a chat-stop browser bot', () => {
    const p = new MockMeetingBotProvider();
    expect(p.capabilities).toEqual({ joinsAsParticipant: true, postsChat: true, readsChat: true, audioPath: 'livekit_room', recordsAudio: false, transcribes: false, keeps: 'nothing', stopPath: 'chat' });
  });
  it('verifies a report by the run token it was dispatched with, and refuses another', async () => {
    const p = new MockMeetingBotProvider();
    const { workerId } = await p.dispatch({ run: run(), room: { url: 'ws://lk', name: 'bot-r1', publishToken: 't' }, workerToken: 'tok-1', reportUrl: 'http://product/events' });
    expect(workerId).toBe('mock-worker');
    const good = mockEventContext('r1', 'in_call', {}, 10, 'tok-1');
    const bad = mockEventContext('r1', 'in_call', {}, 10, 'tok-2');
    const r = run({ roomName: 'bot-r1', workerTokenHash: hashWorkerToken('tok-1') });
    expect(p.verifyEvent(good, r).valid).toBe(true);
    expect(p.verifyEvent(bad, r).valid).toBe(false);
    expect(p.verifyEvent(good, undefined).valid).toBe(false);
  });
  it('parses the normalised event with a stable id, and gives another report of the same type and time another id', () => {
    const p = new MockMeetingBotProvider();
    const ctx = mockEventContext('r1', 'chat_message', { text: 'hello', sender: 'Sam' }, 5, 'tok');
    const parsed = p.parseEvent(ctx);
    expect(parsed.events).toEqual([{ eventId: expect.stringMatching(/^mock:r1:chat_message:5:[0-9a-f]{12}$/), runId: 'r1', type: 'chat_message', at: 5, data: { text: 'hello', sender: 'Sam' } }]);
    expect(p.parseEvent(ctx).events[0].eventId).toBe(parsed.events[0].eventId);
    const other = p.parseEvent(mockEventContext('r1', 'chat_message', { text: 'goodbye', sender: 'Sam' }, 5, 'tok'));
    expect(other.events[0].eventId).not.toBe(parsed.events[0].eventId);
  });
  it('records commands per run', async () => {
    const p = new MockMeetingBotProvider();
    await p.command('r1', { name: 'postChat', text: 'the short notice' });
    await p.command('r1', { name: 'leave', reason: 'stopped_by_participant' });
    expect(p.commands.get('r1')).toEqual([{ name: 'postChat', text: 'the short notice' }, { name: 'leave', reason: 'stopped_by_participant' }]);
  });
});
