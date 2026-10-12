import { describe, it, expect } from 'vitest';
import {
  canTransition,
  contentFreeRun,
  DEFAULT_RUN_LIMITS,
  isBilledEnd,
  RUN_TRANSITIONS,
  TERMINAL_RUN_STATES,
  type MeetingRunRecord,
  type MeetingRunState,
} from '../types.js';

const run = (): MeetingRunRecord => ({
  runId: 'r1',
  ownerRef: 'acct_1',
  providerName: 'mock',
  platform: 'google_meet',
  state: 'left',
  keep: 'none',
  meetingUrl: 'https://meet.google.com/abc-defg-hij',
  botName: "Dana's notes",
  notice: { text: 'the notice', version: '1', lateArrivalText: 'the short notice' },
  stopPhrase: 'stop please',
  limits: DEFAULT_RUN_LIMITS,
  requestedAt: 1,
  joinAt: 1,
  joinedAt: 2,
  captureStartedAt: 3,
  leftAt: 4,
  reason: 'stopped_by_participant',
  billedSeconds: 2,
  consentRecordId: 'c1',
});

describe('meeting run states', () => {
  it('every state reaches done or failed, and no terminal state leaves', () => {
    for (const state of Object.keys(RUN_TRANSITIONS) as MeetingRunState[]) {
      if (TERMINAL_RUN_STATES.has(state)) expect(RUN_TRANSITIONS[state]).toEqual([]);
      else expect(RUN_TRANSITIONS[state].some((s) => s === 'failed' || s === 'purging' || s === 'done')).toBe(true);
    }
  });
  it('allows the ordinary path and refuses a backward step', () => {
    const path: MeetingRunState[] = ['requested', 'scheduled', 'dispatching', 'joining', 'waiting_room', 'in_call_notice_pending', 'in_call', 'leaving', 'left', 'done'];
    for (let i = 1; i < path.length; i++) expect(canTransition(path[i - 1], path[i])).toBe(true);
    expect(canTransition('in_call', 'joining')).toBe(false);
    expect(canTransition('done', 'purging')).toBe(false);
    expect(canTransition('in_call', 'in_call')).toBe(true); // idempotent
  });
  it('purging is reachable from every non-terminal state, and a bot that leaves on its own reaches left from every state after dispatch', () => {
    for (const state of Object.keys(RUN_TRANSITIONS) as MeetingRunState[]) {
      if (TERMINAL_RUN_STATES.has(state)) continue;
      expect(canTransition(state, 'purging'), state).toBe(true);
    }
    for (const state of ['dispatching', 'joining', 'waiting_room', 'in_call_notice_pending', 'in_call', 'leaving'] as const) expect(canTransition(state, 'left'), state).toBe(true);
    expect(canTransition('requested', 'left')).toBe(false);
    expect(canTransition('scheduled', 'left')).toBe(false);
  });
});

describe('billing and the content-free record', () => {
  it('bills a run that captured and ended by a stop, and never one that never captured or that ended for an unbilled reason', () => {
    expect(isBilledEnd({ ...run(), reason: 'stopped_by_participant' })).toBe(true);
    expect(isBilledEnd({ ...run(), reason: 'crashed' })).toBe(true);
    expect(isBilledEnd({ ...run(), reason: 'crashed', captureStartedAt: undefined })).toBe(false);
    for (const reason of ['not_admitted', 'notice_failed', 'stop_monitor_failed', 'permission_denied', 'no_capacity'] as const) {
      expect(isBilledEnd({ ...run(), reason, captureStartedAt: undefined })).toBe(false);
      // the fixture's run captured (captureStartedAt 3), so here the reason alone keeps it unbilled
      expect(isBilledEnd({ ...run(), reason }), reason).toBe(false);
    }
  });
  it('keeps only the id, the platform, the times, the reason, the seconds, the notice version and the consent id', () => {
    const free = contentFreeRun({ ...run(), dispatch: { roomName: 'bot-r1', workerTokenHash: 'not-a-real-hash' } });
    expect(free.meetingUrl).toBe('');
    expect(free.botName).toBe('');
    expect(free.notice).toEqual({ text: '', version: '1', lateArrivalText: '' });
    expect(free.stopPhrase).toBe('');
    expect(free.dispatch).toBeUndefined();
    expect(free.consentRecordId).toBe('c1');
    expect(free.billedSeconds).toBe(2);
    expect(free.leftAt).toBe(4);
  });
});
